import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, inferRenameSpec } from '../src/cli.js';
import { appendLedger } from '../src/engine/session.js';
import { traceAModel, traceDModel, invoiceLinesModel, sumCandidate, someStatePredicateOnInvoice } from './fixtures.js';
import type { CaseState } from '../src/engine/evaluate.js';

const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p2', fields: { family: 'f1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const fakeDeps: any = { alloy: async () => ({ sat: true, instances: [dpsf], ms: 3 }), quint: async () => ({ violated: false, ms: 3 }) };

describe('engine CLI', () => {
  it('drives init → propose → next-question → verdict end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const modelFile = join(dir, 'model.json');
    writeFileSync(modelFile, JSON.stringify(traceAModel));

    const init: any = await runCommand(['init', '--session', dir, '--model', modelFile], fakeDeps);
    expect(init.adopted.length).toBeGreaterThan(0);          // templates fired (NoOrphan at least)
    expect(init.seeds.length).toBeGreaterThan(0);            // unique-per-ref seeds

    const cands = [
      { id: 'H1', name: 'perCustomer', prior: 0.35, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'perPlan', prior: 0.4, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] } }
    ];
    const prop: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(cands)], fakeDeps);
    expect(prop.registered).toBe(2);

    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    expect(q.type).toBe('question');
    expect(q.table).toContain('| Subscription |');

    const v: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'forbid'], fakeDeps);
    expect(v.pruned).toContain('H2');

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.find((c: any) => c.id === 'H1').status).toBe('active');
  });

  it('rejects out-of-grammar proposals with diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = [{ id: 'X', name: 'x', prior: 0.5, source: 'seed',
      candidate: { kind: 'unique', aggregate: 'Nope', whileStates: { region: 'R', states: ['S'] }, by: [['f']] } }];
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('out-of-grammar');
    expect(r.diagnostics[0].code).toBe('unknown-aggregate');
  });

  it('undecided verdicts park an open decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'h2', prior: 0.4, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['plan']] } }
    ])], fakeDeps);
    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    const r: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'undecided', '--topic', 'family-policy', '--note', 'experts disagree'], fakeDeps);
    expect(r.parked).toBe(true);
    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.openDecisions).toBe(1);
  });

  it('regenerate in alternatives phase runs checkDistinct before admit — equivalent candidate is rejected without admitting and bumps alternativeAttempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Force the session straight into the alternatives phase with a sole active survivor H1.
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    writeFileSync(stateFile, JSON.stringify(st));

    // checkDistinct calls deps.alloy for a 'distinguish' query between the survivor and the new
    // candidate; returning sat:false (UNSAT) means no distinguishing witness exists ⇒ equivalent.
    const equivalentDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };

    const alt = { id: 'A1', name: 'a1', prior: 0.6, source: 'alternative',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } };
    const r: any = await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(alt)], equivalentDeps);

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/equivalent/i);
    expect(r.attemptsLeft).toBe(1);

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st2.alternativeAttempts).toBe(1);
    // The equivalent candidate must NOT have been admitted as a new tracked candidate.
    expect(st2.candidates.find((c: any) => c.id === 'A1')).toBeUndefined();
  });

  it('next-question returning converged marks the sole survivor adopted and appends a ledger adopted entry with elicited provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Drive the session to the brink of convergence: sole active survivor, both probes already
    // asked, alternativeAttempts already exhausted (2) — next-question should return converged.
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    // Seed a verdict ledger entry so we can check provenance references it. The witness must
    // contain a Subscription entity (H1's aggregate) — per-candidate anchoring (Task 13) only
    // credits verdicts whose witness actually bears on this candidate's aggregate.
    const ledgerFile = join(dir, 'ledger.jsonl');
    writeFileSync(ledgerFile, JSON.stringify({ kind: 'verdict', at: 't', witnessId: 'w1',
      witness: { entities: [{ type: 'Subscription', id: 's1', fields: {} }] }, salient: [], judge: 'forbid', question: '' }) + '\n');

    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    expect(q.type).toBe('converged');

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    const h1 = st2.candidates.find((c: any) => c.id === 'H1');
    expect(h1.status).toBe('adopted');

    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const adoptedEntry = ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H1');
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry.provenance).toContain('w1');
  });

  it('next-question returning converged with zero verdicts parks the survivor as an unanchored-survivor open decision instead of adopting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Drive the session to the brink of convergence: sole active survivor, both probes already
    // asked, alternativeAttempts already exhausted (2) — next-question should return converged.
    // Crucially, the ledger has NO verdict entries (probes returned UNSAT, alternatives exhausted
    // without ever getting a judged case) — the survivor must not be silently adopted.
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    // sat:false deps ⇒ no witnesses were ever produced for this candidate; UNSAT throughout.
    const unsatDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };

    const q: any = await runCommand(['next-question', '--session', dir], unsatDeps);
    expect(q.type).toBe('converged');
    expect(q.warning).toBe('unanchored-survivor-parked');

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    const h1 = st2.candidates.find((c: any) => c.id === 'H1');
    expect(h1.status).toBe('parked');

    const ledgerFile = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const openDecision = ledger.find((e: any) => e.kind === 'open-decision' && e.topic === 'unanchored-survivor');
    expect(openDecision).toBeDefined();
    // Template auto-adopts at init (e.g. refsResolveSubscription) are unrelated and expected; the
    // elicited survivor H1 specifically must never get an 'adopted' ledger entry.
    expect(ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H1')).toBeUndefined();
  });

  // Task 13: per-candidate anchoring — a verdict only vets a candidate if its witness contains an
  // instance of THAT candidate's aggregate. A session-wide "has any verdict at all" check (the old
  // hasVerdicts) would wrongly let an unrelated verdict vouch for this one.
  it('a candidate that converged with no anchoring verdict is PARKED even when the session has verdicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Seed an unrelated verdict — foreign aggregate (Customer, not Subscription) — before the
    // journal-shaped candidate is even proposed.
    appendLedger(dir, { kind: 'verdict', at: new Date().toISOString(), witnessId: 'w1', judge: 'permit', salient: [],
      question: 'q', witness: { entities: [{ type: 'Customer', id: 'c1', fields: {} }] } });

    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'agent-j', name: 'perCustomer', prior: 0.5, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Drive to the brink of convergence: sole active survivor, both probes already asked,
    // alternativeAttempts already exhausted (2).
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    const unsatDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };
    const q: any = await runCommand(['next-question', '--session', dir], unsatDeps);
    expect(q.type).toBe('converged');
    expect(q.warning).toBe('unanchored-survivor-parked');

    const s: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(s.candidates.find((c: any) => c.id === 'agent-j').status).toBe('parked');

    const ledgerFile = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    expect(ledger.some((e: any) => e.kind === 'open-decision' && e.topic === 'unanchored-survivor')).toBe(true);
  });

  it('adoption provenance cites only anchoring witnesses, never the whole session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // w1: foreign aggregate (Customer) — must never be cited in provenance.
    appendLedger(dir, { kind: 'verdict', at: new Date().toISOString(), witnessId: 'w1', judge: 'permit', salient: [],
      question: 'q', witness: { entities: [{ type: 'Customer', id: 'c1', fields: {} }] } });

    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'agent-j', name: 'perCustomer', prior: 0.5, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // w2: anchors — Subscription aggregate, judged after the candidate was registered.
    appendLedger(dir, { kind: 'verdict', at: new Date().toISOString(), witnessId: 'w2', judge: 'forbid', salient: [],
      question: 'q', witness: { entities: [{ type: 'Subscription', id: 's1', fields: {} }] } });

    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    const unsatDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };
    const q: any = await runCommand(['next-question', '--session', dir], unsatDeps);
    expect(q.type).toBe('converged');

    const ledgerFile = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const adoptedEntry = ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'agent-j');
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry.provenance).toBe('elicited (w2)');   // w1 (foreign aggregate) not cited
  });

  // Source-gated pre-registration agreement (the review that motivated per-candidate anchoring
  // found the AGREEMENT arm of anchorsCandidate trusted every source alike). admit() (hypothesis.ts)
  // runs ledgerConflicts against the whole ledger before accepting a regen/alternative candidate —
  // that check is what makes the candidate's agreement with an old verdict a proven guarantee
  // (golden trace A). registerCandidates() (the `propose`/`init` path) never runs that check, so a
  // cold-proposed candidate's agreement with an old verdict is coincidental.
  it('a seed-sourced survivor that coincidentally agrees with a pre-registration verdict is parked, not adopted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Recorded well before H1 is proposed. dpsf holds two active subscriptions sharing a customer
    // — the human forbade it, and H1 (unique by customer) rules the same witness 'forbid' too:
    // agreement, but this verdict was never checked against H1 at admission time.
    appendLedger(dir, { kind: 'verdict', at: '2020-01-01T00:00:00.000Z', witnessId: 'w0', judge: 'forbid',
      salient: [], question: 'q', witness: dpsf });

    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    const unsatDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };
    const q: any = await runCommand(['next-question', '--session', dir], unsatDeps);
    expect(q.type).toBe('converged');
    expect(q.warning).toBe('unanchored-survivor-parked');

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st2.candidates.find((c: any) => c.id === 'H1').status).toBe('parked');

    const ledgerFile = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    expect(ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H1')).toBeUndefined();
  });

  it('a regen-sourced survivor that agrees with a pre-registration verdict IS adopted citing it — admit() already vetted it against the whole ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Same pre-registration verdict and same shape as the seed case above, but this candidate is
    // admitted through `regenerate`: admit() already checked it against every ledger verdict
    // (ledgerConflicts) before accepting it, so its agreement here is a proven guarantee.
    appendLedger(dir, { kind: 'verdict', at: '2020-01-01T00:00:00.000Z', witnessId: 'w0', judge: 'forbid',
      salient: [], question: 'q', witness: dpsf });

    const rg: any = await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
      { id: 'H3', name: 'h3', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } })], fakeDeps);
    expect(rg.ok).toBe(true);

    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    const unsatDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };
    const q: any = await runCommand(['next-question', '--session', dir], unsatDeps);
    expect(q.type).toBe('converged');
    expect(q.warning).toBeUndefined();

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st2.candidates.find((c: any) => c.id === 'H3').status).toBe('adopted');

    const ledgerFile = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const adoptedEntry = ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H3');
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry.provenance).toBe('elicited (w0)');
  });

  it('emit writes prose + code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const out: any = await runCommand(['emit', '--session', dir, '--out', dir], fakeDeps);
    expect(existsSync(join(dir, 'spec.prose.md'))).toBe(true);
    expect(readFileSync(join(dir, 'spec.lat'), 'utf8')).toContain('context Billing {');
    // spec.lat, spec.prose.md, spec.diagrams.md, diagrams/CD_Billing.mmd, diagrams/SD_Subscription_Access.mmd
    expect(out.written.length).toBe(5);
    expect(existsSync(join(dir, 'spec.diagrams.md'))).toBe(true);
    expect(existsSync(join(dir, 'diagrams', 'CD_Billing.mmd'))).toBe(true);
    expect(existsSync(join(dir, 'diagrams', 'SD_Subscription_Access.mmd'))).toBe(true);
  });

  it('emit lists an adopted implied-shape rule once in prose even with jumbled key order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-dedup-'));
    const model = {
      context: 'Dedup', enums: [], values: [], events: [], entities: [], services: [],
      aggregates: [{ kind: 'aggregate', name: 'Box', fields: [
        { name: 'boxId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] }] }],
    };
    writeFileSync(join(dir, 'm.json'), JSON.stringify(model));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    // jumble the stored adopted candidate's key order so raw JSON.stringify comparison would differ
    const statePath = join(dir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const adoptedEntry = state.candidates.find((c: any) => c.status === 'adopted' && c.inv.candidate.kind === 'statePredicate');
    const reorder = (o: any): any => Array.isArray(o) ? o.map(reorder)
      : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).reverse().map(k => [k, reorder(o[k])])) : o;
    adoptedEntry.inv.candidate = reorder(adoptedEntry.inv.candidate);
    writeFileSync(statePath, JSON.stringify(state));
    // init template-adopts nonNegativeBoxAmount whose candidate matches the implied rule
    const r: any = await runCommand(['emit', '--session', dir, '--out', dir], fakeDeps);
    expect(r.written).toBeDefined();
    const prose = readFileSync(join(dir, 'spec.prose.md'), 'utf8');
    const hits = prose.split('\n').filter(l => l.includes('amount') && l.includes('never') === false && l.includes('≥ 0'));
    expect(hits.length).toBe(1);
  });

  it('rejects an invalid --judge without touching state or ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'h2', prior: 0.4, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['plan']] } }
    ])], fakeDeps);
    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);

    const beforeLedgerCount = ((await runCommand(['status', '--session', dir], fakeDeps)) as any).ledgerCount;

    const r: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'bogus'], fakeDeps);
    expect(r.error).toBe('invalid-judge');
    expect(r.allowed).toEqual(['permit', 'forbid', 'undecided']);

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.find((c: any) => c.id === 'H1').status).toBe('active');
    expect(st.candidates.find((c: any) => c.id === 'H2').status).toBe('active');
    expect(st.ledgerCount).toBe(beforeLedgerCount);
  });

  it('propose rejects unsolvable candidate kinds (terminal/monotonic/leadsTo/refsResolve) as not-elicitable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = [
      { id: 'T1', name: 't1', prior: 0.5, source: 'seed', candidate: { kind: 'terminal', aggregate: 'Subscription', region: 'Access', state: 'Ended' } },
      { id: 'M1', name: 'm1', prior: 0.5, source: 'seed', candidate: { kind: 'monotonic', aggregate: 'Subscription', field: ['grace'] } }
    ];
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('not-elicitable');
    expect(r.kinds).toEqual(['terminal', 'monotonic']);
    expect(r.hint).toMatch(/template-adopted/);

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.some((c: any) => c.id === 'T1' || c.id === 'M1')).toBe(false);
  });

  it('regenerate rejects an unsolvable candidate kind as not-elicitable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = { id: 'R1', name: 'r1', candidate: { kind: 'refsResolve', aggregate: 'Subscription' } };
    const r: any = await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('not-elicitable');
    expect(r.kinds).toEqual(['refsResolve']);
  });

  it('sumOverCollection is proposable (design §8: elicitable kind)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(invoiceLinesModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const cands = [
      { id: 'S1', name: 'lineTotalsMatch', prior: 0.5, source: 'seed', candidate: sumCandidate }
    ];
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(cands)], fakeDeps);
    expect(r.error).toBeUndefined();
    expect(r.registered).toBe(1);

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.find((c: any) => c.id === 'S1').status).toBe('active');
  });

  it('regenerate does not reject sumOverCollection as not-elicitable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(invoiceLinesModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'S1', name: 'lineTotalsMatch', prior: 0.5, source: 'seed', candidate: sumCandidate }
    ])], fakeDeps);
    const rg: any = await runCommand(['regenerate', '--session', dir,
      '--candidate', JSON.stringify({ id: 'S2', name: 's2', candidate: sumCandidate })], fakeDeps);
    expect(rg.error).not.toBe('not-elicitable');
  });

  it('status counts guard findings from the ledger, by finding kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Active', boundedN: 6, provenance: 'test' });
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'unreachable',
      owner: 'Subscription', region: 'Access', state: 'Ended', boundedN: 6, provenance: 'test' });

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.guardFindings).toEqual({ stuck: 1, unreachable: 1 });
  });

  it('status dedupes repeated guard-finding ledger entries for the same site, keeping only the latest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Same owner/region/state/finding appended twice (e.g. two `classify` runs on the same model)
    // must count once, not twice — guard-finding entries are append-only like `classified` entries.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Active', boundedN: 6, provenance: 'test' });
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Active', boundedN: 6, provenance: 'test' });

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.guardFindings).toEqual({ stuck: 1, unreachable: 0 });
  });

  it('status counts only guard findings from the LATEST classify run (item 3b — clearing)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Run 1 (earlier stamp): two sites flagged stuck.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Active', boundedN: 6, provenance: 'test', run: '2026-01-01T00:00:00.000Z' });
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Ended', boundedN: 6, provenance: 'test', run: '2026-01-01T00:00:00.000Z' });
    appendLedger(dir, { kind: 'guard-sweep', at: new Date().toISOString(), run: '2026-01-01T00:00:00.000Z' });

    // Run 2 (later stamp, e.g. after a model edit + re-classify): the Active site cleared (no
    // longer flagged); the Ended site is still stuck.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Ended', boundedN: 6, provenance: 'test', run: '2026-02-01T00:00:00.000Z' });
    appendLedger(dir, { kind: 'guard-sweep', at: new Date().toISOString(), run: '2026-02-01T00:00:00.000Z' });

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    // Only the LATEST run's findings count: the cleared Active site is gone, the still-present
    // Ended site is counted once.
    expect(st.guardFindings).toEqual({ stuck: 1, unreachable: 0 });
  });

  it('status resolves the latest classify run purely from guard-sweep markers, even when that run found nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Run 1: one stuck finding.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Subscription', region: 'Access', state: 'Active', boundedN: 6, provenance: 'test', run: '2026-01-01T00:00:00.000Z' });
    appendLedger(dir, { kind: 'guard-sweep', at: new Date().toISOString(), run: '2026-01-01T00:00:00.000Z' });

    // Run 2: a full clean sweep — no guard-finding entries at all, only the sweep marker. Without
    // the sweep marker anchoring "latest run", status would keep counting run 1's stale finding.
    appendLedger(dir, { kind: 'guard-sweep', at: new Date().toISOString(), run: '2026-02-01T00:00:00.000Z' });

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.guardFindings).toEqual({ stuck: 0, unreachable: 0 });
  });

  it('status counts method-guard verdicts from the ledger, by verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    appendLedger(dir, { kind: 'method-guard', at: new Date().toISOString(), service: 'Billing', method: 'settle',
      verdict: 'consistent', provenance: 'test' });
    appendLedger(dir, { kind: 'method-guard', at: new Date().toISOString(), service: 'Billing', method: 'finalize',
      verdict: 'weaker-than-guard', provenance: 'test' });

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.methodGuards).toEqual({ consistent: 1, 'weaker-than-guard': 1 });
  });

  it('status dedupes repeated method-guard ledger entries for the same service::method, keeping only the latest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);

    // Same service::method appended twice (e.g. two `classify` runs on the same model) — the later
    // (differing) verdict must supersede the earlier one, not add to its count.
    appendLedger(dir, { kind: 'method-guard', at: new Date().toISOString(), service: 'Billing', method: 'settle',
      verdict: 'consistent', provenance: 'test' });
    appendLedger(dir, { kind: 'method-guard', at: new Date().toISOString(), service: 'Billing', method: 'settle',
      verdict: 'stronger-than-guard', provenance: 'test' });

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.methodGuards).toEqual({ 'stronger-than-guard': 1 });
  });

  it('explain surfaces guard-findings scoped to the invariant\'s own aggregate, excluding findings on other aggregates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceDModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'nonNegativeTotal', prior: 0.5, source: 'seed', candidate: someStatePredicateOnInvoice }
    ])], fakeDeps);

    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    const h1 = st.candidates.find((c: any) => c.inv.id === 'H1');
    h1.status = 'adopted';
    writeFileSync(stateFile, JSON.stringify(st));
    // explain's `current` resolution walks `adopted` ledger entries.
    appendLedger(dir, { kind: 'adopted', at: new Date().toISOString(), invariant: h1.inv, provenance: 'test' });

    // A finding on the Invoice aggregate this invariant is about — must be surfaced.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Invoice', region: 'settlement', state: 'open', boundedN: 6, provenance: 'test' });
    // A finding on an unrelated (Subscription) aggregate — must NOT be surfaced.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'unreachable',
      owner: 'Subscription', region: 'Access', state: 'Ended', boundedN: 6, provenance: 'test' });

    const r: any = await runCommand(['explain', '--session', dir, '--name', 'nonNegativeTotal'], fakeDeps);
    expect(r.guardFindings).toEqual([{ region: 'settlement', state: 'open', finding: 'stuck' }]);
  });

  it('explain scopes guard-findings to the LATEST guard-analysis run, agreeing with status (item 3b)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceDModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'nonNegativeTotal', prior: 0.5, source: 'seed', candidate: someStatePredicateOnInvoice }
    ])], fakeDeps);

    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    const h1 = st.candidates.find((c: any) => c.inv.id === 'H1');
    h1.status = 'adopted';
    writeFileSync(stateFile, JSON.stringify(st));
    appendLedger(dir, { kind: 'adopted', at: new Date().toISOString(), invariant: h1.inv, provenance: 'test' });

    // Run 1 (earlier stamp): Invoice.settlement.open flagged stuck.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'stuck',
      owner: 'Invoice', region: 'settlement', state: 'open', boundedN: 6, provenance: 'test', run: '2026-01-01T00:00:00.000Z' });
    appendLedger(dir, { kind: 'guard-sweep', at: new Date().toISOString(), run: '2026-01-01T00:00:00.000Z' });

    // Run 2 (later stamp, e.g. after a model edit + re-classify): the `open` site cleared (no
    // guard-finding for it at all); a different site (`closed`) is flagged instead.
    appendLedger(dir, { kind: 'guard-finding', at: new Date().toISOString(), finding: 'unreachable',
      owner: 'Invoice', region: 'settlement', state: 'closed', boundedN: 6, provenance: 'test', run: '2026-02-01T00:00:00.000Z' });
    appendLedger(dir, { kind: 'guard-sweep', at: new Date().toISOString(), run: '2026-02-01T00:00:00.000Z' });

    const r: any = await runCommand(['explain', '--session', dir, '--name', 'nonNegativeTotal'], fakeDeps);
    // The cleared run-1 finding (settlement.open, stuck) must NOT appear — agreeing with `status`,
    // which counts only the latest run. The still-current run-2 finding must appear.
    expect(r.guardFindings).toEqual([{ region: 'settlement', state: 'closed', finding: 'unreachable' }]);
  });

  it('structure command appends a structure ledger entry and works pre-init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['structure', '--session', dir, '--question', 'What are the aggregates?', '--answer', 'Subscription, Customer'], fakeDeps);
    expect(r.ok).toBe(true);
    expect(r.ledgerCount).toBe(1);
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    expect(ledger[0].kind).toBe('structure');
    expect(ledger[0].question).toBe('What are the aggregates?');
    expect(ledger[0].answer).toBe('Subscription, Customer');
  });

  // Task 10: the init money-sign gate (validateModel's contradictoryMoneySigns +
  // undecidedMoneySigns, wired in at cli.ts's init branch) was never exercised — every prior
  // fixture's Money field was retro-tagged @unsigned/@signed. Post-Task-7 the contradictory case is
  // folded into validateModel itself, but init still reports it the same way: 'ill-formed-model'
  // with a 'money-sign-contradictory' diagnostic, same shape as the undecided case below.
  it('init refuses an undecided Money field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const modelPath = join(dir, 'm.json');
    const model = { ...traceAModel, aggregates: [{ kind: 'aggregate', name: 'Acct', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'bal', type: { kind: 'prim', prim: 'Money' } }] }] };   // no sign tag
    writeFileSync(modelPath, JSON.stringify(model));
    const r: any = await runCommand(['init', '--session', dir, '--model', modelPath], fakeDeps);
    expect(r.error).toBe('ill-formed-model');
    expect(r.diagnostics.some((d: any) => d.code === 'money-sign-undecided')).toBe(true);
  });

  it('init refuses a contradictory Money field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const modelPath = join(dir, 'm.json');
    const model = { ...traceAModel, aggregates: [{ kind: 'aggregate', name: 'Acct', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'bal', type: { kind: 'prim', prim: 'Money' }, tags: ['signed', 'unsigned'] }] }] };
    writeFileSync(modelPath, JSON.stringify(model));
    const r: any = await runCommand(['init', '--session', dir, '--model', modelPath], fakeDeps);
    expect(r.error).toBe('ill-formed-model');
    expect(r.diagnostics.some((d: any) => d.code === 'money-sign-contradictory')).toBe(true);
  });

  it('missing --model on init returns a structured missing-arg error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['init', '--session', dir], fakeDeps);
    expect(r.error).toBe('missing-arg');
    expect(r.arg).toBe('model');
  });

  it('propose before init returns no-model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', '[]'], fakeDeps);
    expect(r.error).toBe('no-model');
  });

  it('malformed inline JSON returns bad-json-or-path instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['init', '--session', dir, '--model', '{not valid json'], fakeDeps);
    expect(r.error).toBe('bad-json-or-path');
    expect(typeof r.detail).toBe('string');
  });

  // Belt test (task 5): the filters in templates.ts make matchTemplates output that always
  // passes validateCandidate, so a valid model can never trip the belt — asserting the belt
  // exists by shape (no template-out-of-grammar on a clean init), not by manufacturing a
  // monkey-model that would be impossible to build once the filters land.
  it('init on a valid model never trips the template-out-of-grammar belt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    const r: any = await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    expect(r.error).not.toBe('template-out-of-grammar');
    expect(r.ok).toBe(true);
  });

  it('unknown command still returns a structured error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['bogus-command', '--session', dir], fakeDeps);
    expect(r.error).toBe('unknown-command');
    expect(r.cmd).toBe('bogus-command');
  });

  it('inferRenameSpec infers entity scope for an aggregate-owned nested entity', () => {
    const spec = inferRenameSpec('InvoiceLine', 'LineItem', invoiceLinesModel, new Set());
    expect(spec).toEqual({ scope: 'entity', path: 'InvoiceLine', from: 'InvoiceLine', to: 'LineItem' });
  });

  it('inferRenameSpec infers field scope for a field owned by a nested entity', () => {
    const spec = inferRenameSpec('InvoiceLine.amount', 'net', invoiceLinesModel, new Set());
    expect(spec).toEqual({ scope: 'field', path: 'InvoiceLine.amount', from: 'amount', to: 'net' });
  });

  // Review finding: derived non-negativity names join owner+path segments with no separator, so
  // `totalAmount : Money` and `total : Amount{amount : Money}` both mint
  // `nonNegativeInvoiceTotalAmount`. init is the only caller of matchTemplates, hence the one gate
  // where derived names enter a session — it must refuse rather than silently shadow one rule.
  const collidingModel = {
    context: 'L', enums: [], events: [], services: [], entities: [],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'totalAmount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['unsigned'] }] }],
  };

  it('init REFUSES a model whose derived names collide, naming both paths and the owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-collide-'));
    const f = join(dir, 'm.json');
    writeFileSync(f, JSON.stringify(collidingModel));

    const init: any = await runCommand(['init', '--session', dir, '--model', f], fakeDeps);
    expect(init.error).toBe('ill-formed-model');
    const d = init.diagnostics.find((x: any) => x.code === 'derived-name-collision');
    expect(d).toBeDefined();
    expect(d.at).toBe('Invoice');
    expect(d.message).toContain('nonNegativeInvoiceTotalAmount');
    expect(d.message).toContain('Invoice.totalAmount');
    expect(d.message).toContain('Invoice.total.amount');
    // Refused BEFORE the adopt loop: nothing shadowed into the session, nothing ledgered.
    expect(init.adopted).toBeUndefined();
    expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
  });

  it('init ACCEPTS the same model once the colliding field is renamed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-collide-ok-'));
    const f = join(dir, 'm.json');
    const fixed = JSON.parse(JSON.stringify(collidingModel));
    fixed.aggregates[0].fields[1].name = 'surcharge';       // was totalAmount
    writeFileSync(f, JSON.stringify(fixed));

    const init: any = await runCommand(['init', '--session', dir, '--model', f], fakeDeps);
    expect(init.error).toBeUndefined();
    const names = init.adopted.map((a: any) => a.name);
    expect(names).toContain('nonNegativeInvoiceSurcharge');
    expect(names).toContain('nonNegativeInvoiceTotalAmount');   // readable name survives untouched
  });

  // Carried finding #1: the gate covered init and apply but not `generate --spec`, which reaches
  // impliedInvariants through plan.ts's canonicalSet. It is the door that most needed it — init and
  // apply produce a session and prose, `generate` writes runtime CHECK CODE, so a silently shadowed
  // rule ships as one check where two were meant.
  // Collides via `terminal${owner}${region}${state}`, not the value-typed `nonNegative...` pair the
  // other tests here use: `access`+`closedOut` and `accessClosed`+`out` both mint
  // terminalSubAccessClosedOut. Deliberate — generate's TS renderer throws on ANY value-typed field
  // (render/types.ts's tsType), so a value-based collision could never reach the emitter and the
  // control below could not prove the spec is otherwise generable. This one generates a full
  // artifact set with the gate removed, which is exactly the hole being closed.
  const COLLIDING_LAT = `context L {
  aggregate Sub {
    subId : Id key
    lifecycle access {
      states { open @initial, closedOut @terminal }
      transition shut { from open to closedOut }
    }
    lifecycle accessClosed {
      states { entered @initial, out @terminal }
      transition leave { from entered to out }
    }
  }
}
`;

  it('generate --spec REFUSES a colliding spec, and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-collide-gen-'));
    const spec = join(dir, 'spec.lat'), out = join(dir, 'out');
    writeFileSync(spec, COLLIDING_LAT);

    const r: any = await runCommand(['generate', '--spec', spec, '--out', out], fakeDeps);
    expect(r.error).toBe('ill-formed-model');   // same code init/apply give — not 'parse-failed'
    const d = r.diagnostics.find((x: any) => x.code === 'derived-name-collision');
    expect(d).toBeDefined();
    expect(d.at).toBe('Sub');
    expect(d.message).toContain('terminalSubAccessClosedOut');
    expect(d.message).toContain('Sub.access.closedOut');
    expect(d.message).toContain('Sub.accessClosed.out');
    // The point of the gate: refused BEFORE any artifact is emitted. Without it this spec writes a
    // complete service (types.ts, schema.sql, invariant checks) carrying one check for two rules.
    expect(r.written).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  });

  it('generate --spec ACCEPTS the same spec once the collision is gone', async () => {
    // Pins the refusal to the COLLISION and nothing else about this spec: rename the second
    // region's terminal state so the two names differ, and the identical call generates.
    const dir = mkdtempSync(join(tmpdir(), 'cli-collide-gen-ok-'));
    const spec = join(dir, 'spec.lat'), out = join(dir, 'out');
    writeFileSync(spec, COLLIDING_LAT.replace(/\bout\b/g, 'departed'));

    const r: any = await runCommand(['generate', '--spec', spec, '--out', out], fakeDeps);
    expect(r.error).toBeUndefined();
    expect(r.written.length).toBeGreaterThan(0);
  });
});
