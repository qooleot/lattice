import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps, peersExcludingParent } from '../src/cli.js';
import { subscriptionsModel, paidImpliesExactConjunct, amountPaidAtMostTotalConjunct, activePaidInFullCandidate } from './fixtures.js';
import type { AggregateDef, DomainModel } from '../src/ast/domain.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';
import type { SessionState, TrackedCandidate } from '../src/engine/session.js';

const inertDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 0 }), quint: async () => ({ violated: false, ms: 0 }) };

// Deep-clone subscriptionsModel and strip `settle`'s authored `requires` (mirrors
// strengthen.integration.test.ts's stripSettleGuard) — genuinely violates the `paidExact` invariant
// below (paid ⇒ amountPaid == totalDue) since nothing forces it anymore, giving `strengthen` a real
// CTI to re-close via a guard on `settle`.
function stripSettleGuard(m: DomainModel): DomainModel {
  const variant = structuredClone(m);
  const invoice = (variant.aggregates as AggregateDef[]).find(a => a.name === 'Invoice')!;
  const settle = invoice.machine!.transitions.find(t => t.name === 'settle')!;
  delete settle.requires;
  return variant;
}

const paidExactCandidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
  body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
};

// A witness whose last-trace-step region move is Invoice.settlement open->paid (evaluate.ts's
// CaseEntity shape, region state keyed '<region>.state') — ctiTransition (pure JS, exercised for
// real here, not stubbed) resolves this to the `settle` transition, same worked example as
// strengthen.test.ts's `ctiTransition` describe block.
const ctiWitness = {
  entities: [{ type: 'Invoice', id: 'i1', fields: { 'settlement.state': 'paid', amountPaid: 3, totalDue: 5 } }],
  trace: [[{ type: 'Invoice', id: 'i1', fields: { 'settlement.state': 'open', amountPaid: 3, totalDue: 5 } }]],
};

// Scripts BOTH `quint` (probe-permit consistency checks, §8.5 step 3a) and `quintVerify` (the
// reachability probe + probe-forbid closes-checks, step 1 and 3b) by call order — mirrors
// cli-classify.test.ts's scriptedDeps pattern, extended to cover strengthenInvariant's two distinct
// solver entry points. guardVariants generates {eq, le, ge} in that fixed order (strengthen.ts), so:
//   quintVerify call order: [reachability, closes-eq, closes-le, closes-ge]
//   quint call order:       [consistent-eq, consistent-le, consistent-ge]
// All three variants are consistent; only `eq` closes the CTI ⇒ a single survivor ⇒ auto-adopt.
function scriptedDeps() {
  let qi = 0, qvi = 0;
  const quintResults = [{ violated: true }, { violated: true }, { violated: true }];             // eq, le, ge all consistent
  const quintVerifyResults = [
    { violated: true, witness: ctiWitness },   // reachability: CTI confirmed
    { violated: false },                       // closes-eq: closed (violated:false ⇒ closes)
    { violated: true },                        // closes-le: does NOT close
    { violated: true },                        // closes-ge: does NOT close
  ];
  const calls: { fn: 'quint' | 'quintVerify' }[] = [];
  const deps: any = {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => { calls.push({ fn: 'quint' }); return { ...quintResults[qi++]!, ms: 0 }; },
    quintVerify: async () => { calls.push({ fn: 'quintVerify' }); return { ...quintVerifyResults[qvi++]!, ms: 0 }; },
  };
  return { deps, calls };
}

async function setup(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-strengthen-'));
  const modelFile = join(dir, 'm.json');
  writeFileSync(modelFile, JSON.stringify(stripSettleGuard(subscriptionsModel)));
  await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
  await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
    { id: 'pe', name: 'paidExact', prior: 1, source: 'seed', candidate: paidExactCandidate },
  ])], inertDeps);

  // Adopt paidExact directly (skip elicitation), same pattern as cli-classify.test.ts's setup.
  const stateFile = join(dir, 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const c = st.candidates.find((c: any) => c.inv.id === 'pe');
  c.status = 'adopted';
  writeFileSync(stateFile, JSON.stringify(st));
  const ledgerFile = join(dir, 'ledger.jsonl');
  writeFileSync(ledgerFile, JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: c.inv, provenance: 'test' }) + '\n');
  return dir;
}

// Robustness follow-up: peersExcludingParent must exclude the parent invariant by ID, not by object
// reference — a fast unit check independent of the real-quint multi-conjunct strengthen test below
// (which proves the exclusion end-to-end but would not distinguish an id-based from a
// reference-based implementation).
describe('peersExcludingParent', () => {
  it('excludes the parent invariant by id, keeps other adopted candidates', () => {
    const mk = (id: string, aggregate: string): TrackedCandidate => ({
      status: 'adopted',
      inv: { id, name: id, prior: 1, source: 'seed',
        candidate: { kind: 'statePredicate', aggregate, body: { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } } },
    });
    const parent = mk('parent', 'Widget');
    const peer = mk('peer', 'Widget');
    const notAdopted: TrackedCandidate = { ...mk('declined', 'Widget'), status: 'active' };
    const s: SessionState = {
      model: null, candidates: [parent, peer, notAdopted], phase: 'converged',
      regenAttempts: 0, alternativeAttempts: 0, probesAsked: { forbid: false, permit: false },
      pendingWitnesses: {}, witnessSeq: 0,
    };
    const peers = peersExcludingParent(s, parent.inv);
    expect(peers).toEqual([peer.inv.candidate]);
    // parent's candidate object, even if structurally re-cloned (e.g. a JSON round-trip mid-command),
    // must never survive — the exclusion is by id, not by `===` on the candidate object.
    const clonedParentInv: CandidateInvariant = JSON.parse(JSON.stringify(parent.inv));
    expect(peersExcludingParent(s, clonedParentInv)).toEqual([peer.inv.candidate]);
  });
});

describe('engine strengthen CLI', () => {
  it('missing --name is rejected before touching the model', async () => {
    const r: any = await runCommand(['strengthen', '--session', '/nonexistent'], inertDeps);
    expect(r).toEqual({ error: 'missing-arg', arg: 'name' });
  });

  it('--name naming a non-adopted invariant returns not-found, never a silent no-op', async () => {
    const dir = await setup();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'noSuchInvariant'], inertDeps);
    expect(r.error).toBe('unknown-invariant');
    expect(r.name).toBe('noSuchInvariant');
  });

  it('auto-adopt: runs the engine, adopts the winning guard, and appends a ledger entry', async () => {
    const dir = await setup();
    const { deps, calls } = scriptedDeps();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], deps);

    expect(r.strengthened).toMatchObject({
      kind: 'auto-adopt',
      guard: { transition: 'settle', predicate: { op: 'eq' } },
    });
    // 1 reachability + 3 consistency + 3 closes-check calls = 4 quintVerify, 3 quint.
    expect(calls.filter((c) => c.fn === 'quintVerify')).toHaveLength(4);
    expect(calls.filter((c) => c.fn === 'quint')).toHaveLength(3);

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guardCandidate = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guardCandidate).toBeDefined();
    expect(guardCandidate.status).toBe('adopted');
    expect(guardCandidate.inv.candidate).toMatchObject({
      kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
      predicate: { kind: 'cmp', op: 'eq' },
    });

    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const adoptedGuardEntries = ledger.filter((e: any) => e.kind === 'adopted' && e.invariant.candidate.kind === 'guard');
    expect(adoptedGuardEntries).toHaveLength(1);
    expect(adoptedGuardEntries[0].provenance).toMatch(/^strengthen /);
  });

  // Item 2 (Task 6): interactive ≥2-survivor guard CHOICE. Scripts the strengthen probes (by call
  // order, like scriptedDeps above) so eq + le both close the CTI and separate ⇒ two survivors ⇒
  // `distinguish`. `quint` always returns a witness so separatingWitness yields a CaseState.
  //   quintVerify order: [reachability(CTI+witness), closes-eq(closes), closes-le(closes), closes-ge(open)]
  // Extra quintVerify calls (from the `--choose` reclassify pass, which runs AFTER the strengthen
  // probes) fall past the array ⇒ default {violated:false} ⇒ harmless (entailed) — this suite proves
  // wiring, not reclassify verdicts.
  function distinguishDeps() {
    let qvi = 0;
    const quintVerifyResults = [
      { violated: true, witness: ctiWitness },   // reachability: CTI confirmed
      { violated: false },                       // closes-eq: closes
      { violated: false },                       // closes-le: closes
      { violated: true },                        // closes-ge: does NOT close
    ];
    const deps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 0 }),
      quint: async () => ({ violated: true, witness: ctiWitness, ms: 0 }),
      quintVerify: async () => ({ ...(quintVerifyResults[qvi++] ?? { violated: false }), ms: 0 }),
    };
    return { deps };
  }

  it('distinguish: ≥2 survivors render as named guard choices with separating witness tables', async () => {
    const dir = await setup();
    const { deps } = distinguishDeps();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], deps);

    expect(r.strengthened.kind).toBe('distinguish');
    expect(r.strengthened.survivors).toEqual([
      { name: 'guard_settle_eq', op: 'eq', transition: 'settle' },
      { name: 'guard_settle_le', op: 'le', transition: 'settle' },
    ]);
    expect(r.strengthened.witnesses.length).toBeGreaterThanOrEqual(1);
    expect(typeof r.strengthened.witnesses[0].table).toBe('string');
    expect(r.strengthened.witnesses[0].table.length).toBeGreaterThan(0);

    // A distinguish render must NOT adopt anything — the author still has to choose.
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(st.candidates.some((c: any) => c.inv.candidate.kind === 'guard')).toBe(false);
  });

  // Fix: the distinguish render must echo which conjunct it targeted. Without this, a caller
  // replying `--choose <op>` with no `--conjunct` silently re-defaults to conjunct '0' — for a
  // multi-conjunct invariant that's a DIFFERENT survivor set than the one just shown. Passing an
  // explicit `--conjunct` here (even on this single-conjunct fixture) proves the value flows
  // through to the top-level `conjunct` field on the response.
  it('distinguish render echoes the targeted conjunct so a --choose follow-up can re-pass it', async () => {
    const dir = await setup();
    const { deps } = distinguishDeps();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact', '--conjunct', '0'], deps);

    expect(r.strengthened.kind).toBe('distinguish');
    expect(r.conjunct).toBe('0');
  });

  it('--choose adopts the named surviving variant and returns an auto-adopt with `chose`', async () => {
    const dir = await setup();
    const { deps } = distinguishDeps();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact', '--choose', 'le'], deps);

    expect(r.chose).toBe('le');
    expect(r.strengthened).toMatchObject({ kind: 'auto-adopt', guard: { transition: 'settle', predicate: { op: 'le' } } });

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guard = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guard?.status).toBe('adopted');
    expect(guard.inv.id).toBe('guard-Invoice-settle-le');
    expect(guard.inv.name).toBe('guard_settle_le');

    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const adoptedGuardEntries = ledger.filter((e: any) => e.kind === 'adopted' && e.invariant.candidate.kind === 'guard');
    expect(adoptedGuardEntries).toHaveLength(1);
    expect(adoptedGuardEntries[0].provenance).toMatch(/^strengthen-chose /);
  });

  it('--choose naming a non-surviving op returns invalid-arg without adopting', async () => {
    const dir = await setup();
    const { deps } = distinguishDeps();
    // `ge` was pruned (did not close the CTI) ⇒ not a survivor.
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact', '--choose', 'ge'], deps);
    expect(r).toMatchObject({ error: 'invalid-arg', arg: 'choose' });

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(st.candidates.some((c: any) => c.inv.candidate.kind === 'guard')).toBe(false);
  });

  it('a non auto-adopt Resolution (e.g. no-transition) is surfaced without mutating adopted candidates', async () => {
    const dir = await setup();
    // A reachability probe that reports no violation ⇒ 'no-transition' (nothing to strengthen) —
    // the engine returns after its very first quintVerify call, no further probes.
    const deps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 0 }),
      quint: async () => ({ violated: false, ms: 0 }),
      quintVerify: async () => ({ violated: false, ms: 0 }),
    };
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], deps);
    expect(r.strengthened.kind).toBe('no-transition');

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(st.candidates.some((c: any) => c.inv.candidate.kind === 'guard')).toBe(false);
  });

  // Carried fix (v): guard-adopt idempotence. Running `strengthen` on the same invariant twice must
  // not adopt a second copy of the same guard candidate (same id) — the second auto-adopt is a no-op
  // on the candidate set (it still returns the Resolution).
  it('re-running strengthen does not adopt a duplicate guard (idempotence)', async () => {
    const dir = await setup();
    const first = scriptedDeps();
    const r1: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], first.deps);
    expect(r1.strengthened.kind).toBe('auto-adopt');

    const second = scriptedDeps();
    const r2: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], second.deps);
    expect(r2.strengthened.kind).toBe('auto-adopt');   // still resolves, just no new adoption

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guards = st.candidates.filter((c: any) => c.inv.candidate.kind === 'guard');
    expect(guards).toHaveLength(1);
    expect(guards[0].inv.id).toBe('guard-Invoice-settle-eq');

    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const adoptedGuardEntries = ledger.filter((e: any) => e.kind === 'adopted' && e.invariant.candidate.kind === 'guard');
    expect(adoptedGuardEntries).toHaveLength(1);   // only the first run appended a ledger entry
  });
});

// Scripts quint/quintVerify by the probe's `invariant` NAME + emission FINGERPRINT (not raw call
// order) so the sequence is robust to the many intervening probes the bulk `classify` command runs
// (4 NonNegative template invariants classify first, plus method-guard + guard-analysis sweeps).
//   - `q_peersImpliesI` on the paidExact emission (references amountPaid, totalDue, and the "paid"
//     state) = the classify reachability for paidExact: violated first (a real CTI), entailed on the
//     masking reclassify after the guard is adopted. On any OTHER invariant's emission ⇒ not violated
//     (those classify entailed, so the hook only fires for paidExact).
//   - `q_inv` = strengthen step-1 CTI + step-3b closes-checks (CTI, then eq-closes/le-open/ge-open ⇒
//     single survivor eq ⇒ auto-adopt). `q_I`/`q_methodGuard`/`q_not_stuck`/`q_not_reach` ⇒ inert.
//   - deps.quint (strengthen 3a consistency) ⇒ all three variants consistent.
function hookDeps() {
  let peersI = 0, qInv = 0;
  const paidExactScript = [{ violated: true, witness: ctiWitness }, { violated: false }];
  const qInvScript = [{ violated: true, witness: ctiWitness }, { violated: false }, { violated: true }, { violated: true }];
  // Fingerprint paidExact by the invariant-UNDER-TEST `val q_I` line only (its `paid ⇒
  // amountPaid==totalDue` body). A whole-source check would also match every NonNegative invariant,
  // since the shared machine names every field/state AND paidExact rides along as a `peerK` val when
  // those are the target. The NonNegative q_I compares a field to 0, never `amountPaid == totalDue`.
  const isPaidExact = (src: string) =>
    (src.split('\n').find(l => l.trimStart().startsWith('val q_I ')) ?? '').includes('x.amountPaid == x.totalDue');
  const deps: any = {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => ({ violated: true, ms: 0 }),
    quintVerify: async (em: any, opts: any) => {
      if (opts.invariant === 'q_peersImpliesI') {
        if (!isPaidExact(em.source)) return { violated: false, ms: 0 };   // other classifiable invariants ⇒ entailed
        return { ...paidExactScript[Math.min(peersI++, paidExactScript.length - 1)]!, ms: 0 };
      }
      if (opts.invariant === 'q_inv') return { ...qInvScript[Math.min(qInv++, qInvScript.length - 1)]!, ms: 0 };
      return { violated: false, ms: 0 };   // q_I consecution, q_methodGuard, q_not_stuck/q_not_reach
    },
  };
  return { deps };
}

// WIRING-ONLY (scripted solver): this proves the hook PLUMBING — a `violated` invariant fires the
// hook, the winning guard is adopted idempotently with the right id/provenance, the §7.2 reclassify
// pass is invoked over that invariant, and its result is surfaced under `autoStrengthened`. It does
// NOT prove that the adopted guard actually rides into the classify machine and flips the verdict:
// the reclassify verdict here is SCRIPTED by call-order (hookDeps returns `entailed` on the second
// paidExact reachability probe regardless of whether the guard reached the machine). The real-quint
// proof of the §8.4 masking behavior — that the guard channel makes paidExact reclassify `entailed`
// on Apalache — lives in cli-strengthen.integration.test.ts (I-1). Do not read this as masking proof.
describe('engine classify interactive strengthening hook (bulk, scripted wiring)', () => {
  it('auto-strengthens a violated invariant: adopts the guard, invokes the reclassify pass, surfaces it', async () => {
    const dir = await setup();
    const { deps } = hookDeps();
    const r: any = await runCommand(['classify', '--session', dir], deps);

    // paidExact classifies violated → the hook auto-adopts a `settle` guard.
    expect(r.classified.find((c: any) => c.invariant === 'paidExact').verdict).toBe('violated');
    expect(r.autoStrengthened).toHaveLength(1);
    expect(r.autoStrengthened[0]).toMatchObject({
      invariant: 'paidExact', guard: 'guard_settle_eq',
      resolution: { kind: 'auto-adopt', guard: { transition: 'settle', predicate: { op: 'eq' } } },
    });
    // Wiring assertion (scripted, NOT masking proof): the broadened §7.2 reclassify pass (item 1)
    // re-ran for every adopted invariant over Invoice (the guard's aggregate) — paidExact plus the
    // four nonNegativeInvoice* implied invariants matchTemplates adopts (via impliedInvariants) for
    // subscriptionsModel's four Money fields (licenseFeeAmount/usageAmount/totalDue/amountPaid) —
    // and their (scripted) verdicts are surfaced. Real masking proof: I-1 integ.
    const reclassifiedNames = r.autoStrengthened[0].reclassified.map((e: any) => e.invariant).sort();
    expect(reclassifiedNames).toEqual([
      'nonNegativeInvoiceAmountPaid', 'nonNegativeInvoiceLicenseFeeAmount',
      'nonNegativeInvoiceTotalDue', 'nonNegativeInvoiceUsageAmount', 'paidExact',
    ]);
    expect(r.autoStrengthened[0].reclassified.every((e: any) => e.verdict === 'entailed')).toBe(true);
    expect(r.autoStrengthened[0].reclassified.find((e: any) => e.invariant === 'paidExact').pinnedBy)
      .toEqual(expect.any(Array));

    // The guard is now adopted in the session, with the same id the `strengthen` command mints.
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guard = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guard?.status).toBe('adopted');
    expect(guard.inv.id).toBe('guard-Invoice-settle-eq');

    // Ledger notes the auto-adoption with an `auto-strengthen` provenance (reversible, attributable).
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const autoEntry = ledger.find((e: any) => e.kind === 'adopted' && e.invariant.candidate.kind === 'guard');
    expect(autoEntry.provenance).toMatch(/^auto-strengthen /);
  });

  it('is gated to bulk: `--name` classify never runs the hook (no autoStrengthened key)', async () => {
    const dir = await setup();
    const { deps } = hookDeps();
    const r: any = await runCommand(['classify', '--session', dir, '--name', 'paidExact'], deps);
    expect(r.autoStrengthened).toBeUndefined();
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(st.candidates.some((c: any) => c.inv.candidate.kind === 'guard')).toBe(false);
  });
});

// Task 2 (item 1): design §7.2 aggregate-scope broadening — a guard adopted while masking-reclassifying
// one invariant can ALSO mask a SIBLING invariant over the SAME aggregate, whose verdict then goes
// stale unless it's swept into the same reclassify pass. Extends `setup()`'s session with two more
// adopted invariants: `amountPaidAtMostTotal` (Invoice — the SAME aggregate as paidExact's `settle`
// guard, so it must reclassify too) and `activePaidInFull` (Subscription — a DIFFERENT aggregate,
// which must NOT be swept in). `init`'s matchTemplates also adopts 4 nonNegativeInvoice* implied
// invariants (subscriptionsModel's four Money fields on Invoice) — harmless here (hookDeps' fingerprint
// entails anything whose q_I body isn't paidExact's), so assertions below check inclusion, not an exact set.
async function setupWithAggregateSibling(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-strengthen-siblings-'));
  const modelFile = join(dir, 'm.json');
  writeFileSync(modelFile, JSON.stringify(stripSettleGuard(subscriptionsModel)));
  await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
  await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
    { id: 'pe', name: 'paidExact', prior: 1, source: 'seed', candidate: paidExactCandidate },
    { id: 'apamt', name: 'amountPaidAtMostTotal', prior: 1, source: 'seed', candidate: amountPaidAtMostTotalConjunct },
    { id: 'apif', name: 'activePaidInFull', prior: 1, source: 'seed', candidate: activePaidInFullCandidate },
  ])], inertDeps);

  const stateFile = join(dir, 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const ledgerLines: string[] = [];
  for (const id of ['pe', 'apamt', 'apif']) {
    const c = st.candidates.find((c: any) => c.inv.id === id);
    c.status = 'adopted';
    ledgerLines.push(JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: c.inv, provenance: 'test' }));
  }
  writeFileSync(stateFile, JSON.stringify(st));
  writeFileSync(join(dir, 'ledger.jsonl'), ledgerLines.join('\n') + '\n');
  return dir;
}

describe('engine classify interactive strengthening hook: aggregate-scoped reclassify (item 1, scripted wiring)', () => {
  it("broadens the masking reclassify to every adopted invariant over the guard's aggregate, not just the strengthened one", async () => {
    const dir = await setupWithAggregateSibling();
    const { deps } = hookDeps();
    const r: any = await runCommand(['classify', '--session', dir], deps);

    expect(r.classified.find((c: any) => c.invariant === 'paidExact').verdict).toBe('violated');
    expect(r.autoStrengthened).toHaveLength(1);
    expect(r.autoStrengthened[0]).toMatchObject({ invariant: 'paidExact', guard: 'guard_settle_eq' });

    // Broadened §7.2 scope (item 1): `amountPaidAtMostTotal` is ALSO over Invoice (the guard's
    // aggregate) and must reclassify alongside the strengthened invariant — previously the hook
    // passed only `[r.invariant]` (paidExact alone) to classifyOnApply, so the sibling's verdict
    // went stale.
    const reclassifiedNames = r.autoStrengthened[0].reclassified.map((e: any) => e.invariant);
    expect(reclassifiedNames).toContain('paidExact');
    expect(reclassifiedNames).toContain('amountPaidAtMostTotal');
    // `activePaidInFull` is over Subscription, a DIFFERENT aggregate — must NOT be swept in.
    expect(reclassifiedNames).not.toContain('activePaidInFull');
  });
});

// E2E finding #2: strengthening is per-CONJUNCT, not per-invariant. Reassemble the committed
// Never_Overpaid_And_Paid_Exact as the `and` of its two committed conjunct fixtures (same
// reassembly as classify.integration.test.ts / strengthen.integration.test.ts's E2E #2 block):
// conjunct 0 = amountPaid<=totalDue (not guard-forced), conjunct 1 = paid ⇒ amountPaid==totalDue
// (guard-forced by settle, stripped here so it's genuinely violated).
const neverOverpaidAndPaidExact: Candidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  body: { kind: 'and', args: [
    (amountPaidAtMostTotalConjunct as Extract<Candidate, { kind: 'statePredicate' }>).body,
    (paidImpliesExactConjunct as Extract<Candidate, { kind: 'statePredicate' }>).body,
  ] },
};

async function setupMulti(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-strengthen-multi-'));
  const modelFile = join(dir, 'm.json');
  writeFileSync(modelFile, JSON.stringify(stripSettleGuard(subscriptionsModel)));
  await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
  await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
    { id: 'noape', name: 'neverOverpaidAndPaidExact', prior: 1, source: 'seed', candidate: neverOverpaidAndPaidExact },
  ])], inertDeps);

  const stateFile = join(dir, 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const c = st.candidates.find((c: any) => c.inv.id === 'noape');
  c.status = 'adopted';
  writeFileSync(stateFile, JSON.stringify(st));
  const ledgerFile = join(dir, 'ledger.jsonl');
  writeFileSync(ledgerFile, JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: c.inv, provenance: 'test' }) + '\n');
  return dir;
}

// Scripts the bulk `classify` command's two PER-CONJUNCT probes so only conjunct 1 (paid ⇒ ==)
// classifies violated, and strengthenInvariant's own probes (mirrors hookDeps' qInvScript) resolve
// it to a single eq survivor. Fingerprints conjunct 1's `q_peersImpliesI`/`q_I` probe by the same
// `x.amountPaid == x.totalDue` substring hookDeps uses for paidExact — conjunct 0's body is a bare
// `<=` cmp and never contains that substring, and neither do the template NonNegative invariants
// `init` auto-adopts (matchTemplates), so this can't false-positive on them.
function multiHookDeps() {
  let peersI = 0, qInv = 0;
  const conjunct1Script = [{ violated: true, witness: ctiWitness }, { violated: false }];
  const qInvScript = [{ violated: true, witness: ctiWitness }, { violated: false }, { violated: true }, { violated: true }];
  const isConjunct1 = (src: string) =>
    (src.split('\n').find(l => l.trimStart().startsWith('val q_I ')) ?? '').includes('x.amountPaid == x.totalDue');
  const deps: any = {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => ({ violated: true, ms: 0 }),
    quintVerify: async (em: any, opts: any) => {
      if (opts.invariant === 'q_peersImpliesI') {
        if (!isConjunct1(em.source)) return { violated: false, ms: 0 };   // conjunct 0 + template invariants ⇒ not violated
        return { ...conjunct1Script[Math.min(peersI++, conjunct1Script.length - 1)]!, ms: 0 };
      }
      if (opts.invariant === 'q_inv') return { ...qInvScript[Math.min(qInv++, qInvScript.length - 1)]!, ms: 0 };
      return { violated: false, ms: 0 };   // q_I consecution, q_methodGuard, q_not_stuck/q_not_reach
    },
  };
  return { deps };
}

// WIRING-ONLY (scripted solver): proves the hook targets the VIOLATED CONJUNCT of a multi-conjunct
// invariant, not the whole `and`-bodied invariant (which strengthenInvariant can never auto-adopt —
// invariantCmp returns null on an `and` body; see strengthen.integration.test.ts's E2E #2 "the bug"
// test). Real-quint proof that the fix actually auto-adopts (and that peersExcludingParent's parent-
// candidate exclusion is load-bearing) is the real-quint test below.
describe('engine classify interactive strengthening hook — multi-conjunct (bulk, scripted wiring, E2E #2)', () => {
  it('strengthens only the violated conjunct, tagging autoStrengthened with its index', async () => {
    const dir = await setupMulti();
    const { deps } = multiHookDeps();
    const r: any = await runCommand(['classify', '--session', dir], deps);

    const classifiedForInv = r.classified.filter((c: any) => c.invariant === 'neverOverpaidAndPaidExact');
    expect(classifiedForInv).toHaveLength(2);
    expect(classifiedForInv.find((c: any) => c.conjunct === '0').verdict).not.toBe('violated');
    expect(classifiedForInv.find((c: any) => c.conjunct === '1').verdict).toBe('violated');

    // Only ONE strengthening attempt (for conjunct '1'), not one for the whole invariant.
    expect(r.autoStrengthened).toHaveLength(1);
    expect(r.autoStrengthened[0]).toMatchObject({
      invariant: 'neverOverpaidAndPaidExact', conjunct: '1', guard: 'guard_settle_eq',
      resolution: { kind: 'auto-adopt', guard: { transition: 'settle', predicate: { op: 'eq' } } },
    });

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guard = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guard?.status).toBe('adopted');
    expect(guard.inv.id).toBe('guard-Invoice-settle-eq');
  });
});

// REAL QUINT (not scripted): proves the actual production path — `strengthen --name
// neverOverpaidAndPaidExact --conjunct 1` through runCommand with realDeps — genuinely auto-adopts
// the settle==totalDue guard. This is the test that catches the peer-exclusion pitfall found while
// implementing E2E #2: `neverOverpaidAndPaidExact` stays ADOPTED (present in adoptedConstraints(s))
// while strengthening conjunct 1 alone, and since the parent's `and` body tautologically implies its
// own conjunct 1, leaving it in strengthenInvariant's peers makes the CTI probe vacuously
// unviolated (confirmed: without peersExcludingParent's parent-candidate exclusion this reports
// `no-transition` instead of `auto-adopt`). A scripted test can't catch this — the scripted
// quintVerify above answers whatever the fingerprint dispatches to regardless of what peers actually
// got emitted into the Quint source.
describe('engine strengthen CLI — multi-conjunct (real quint, E2E #2)', () => {
  it('strengthen --name neverOverpaidAndPaidExact --conjunct 1 auto-adopts settle==totalDue', async () => {
    const dir = await setupMulti();
    const r: any = await runCommand(
      ['strengthen', '--session', dir, '--name', 'neverOverpaidAndPaidExact', '--conjunct', '1'], realDeps);

    expect(r.conjunct).toBe('1');
    expect(r.strengthened).toMatchObject({
      kind: 'auto-adopt',
      guard: { transition: 'settle', predicate: { op: 'eq' } },
    });

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guard = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guard?.status).toBe('adopted');
    expect(guard.inv.id).toBe('guard-Invoice-settle-eq');
  }, 240_000);
});
