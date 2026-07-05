import { describe, it, expect } from 'vitest';
import { nextQuestion, checkDistinct } from '../../src/engine/planner.js';
import { registerCandidates, pruneOnVerdict, admit } from '../../src/engine/hypothesis.js';
import { newSession, type LedgerEntry, type SessionState } from '../../src/engine/session.js';
import { extractSalient } from '../../src/engine/salient.js';
import { traceAModel, traceBModel, graceCandidate } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const mkU = (id: string, by: string[][], prior: number): CandidateInvariant => ({
  id, name: id, prior, source: 'seed',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by }
});
const H1 = mkU('H1', [['customer']], 0.35);
const H2 = mkU('H2', [['customer'], ['plan']], 0.40);
const H4: CandidateInvariant = { id: 'H4', name: 'H4', prior: 0.25, source: 'seed',
  candidate: { kind: 'cardinality', aggregate: 'Subscription', where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] }, atMost: 99 } };

const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p2', fields: { family: 'f1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const dpdf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} }, { type: 'Family', id: 'f2', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p3', fields: { family: 'f2' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

// Fake solver: scripted by call order for the distinguish/probe queries trace A makes.
function fakeDeps(script: CaseState[][]): any {
  let call = 0;
  return {
    alloy: async () => {
      const instances = script[call++] ?? [];
      return { sat: instances.length > 0, instances, ms: 5 };
    },
    quint: async () => { throw new Error('trace A never routes to quint'); }
  };
}

async function judge(s: SessionState, ledger: LedgerEntry[], out: any, judgeAs: 'permit' | 'forbid', witness: CaseState, cands: CandidateInvariant[]) {
  const salient = extractSalient(cands.map(c => c.candidate), witness);
  ledger.push({ kind: 'verdict', at: 't', witnessId: out.witnessId ?? out.options[0].witnessId, witness, salient, judge: judgeAs, question: 'q' });
  return pruneOnVerdict(s, witness, judgeAs);
}

describe('planner — trace A logic with fake solvers', () => {
  it('runs Q1 distinguish → prune → forbid-probe → refute → regenerate → alternatives → converged', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    registerCandidates(s, [H1, H2, H4]);
    const deps = fakeDeps([[dpsf], [dpdf]]);   // Q1 witness, then probe options

    // Q1: top pair by combined prior = (H2, H1) → DPSF
    const q1 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q1.type).toBe('question');
    const r1 = await judge(s, ledger, q1, 'forbid', dpsf, [H1, H2, H4]);
    expect(r1.pruned.sort()).toEqual(['H2', 'H4']);          // both permitted DPSF

    // Sole survivor H1 (seed) → mandatory forbid-side probe → DPDF among options
    const q2 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q2.type).toBe('probe-options');
    const r2 = await judge(s, ledger, { witnessId: (q2 as any).options[0].witnessId }, 'permit', dpdf, [H1]);
    expect(r2.empty).toBe(true);                              // H1 refuted

    // Empty → regenerate
    const q3 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q3).toEqual({ type: 'regenerate', attemptsLeft: 3 });

    // Claude regenerates H3 = per (customer, family) — fits ledger
    const H3: CandidateInvariant = { id: 'H3', name: 'H3', prior: 0.9, source: 'regen',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] } };
    expect(admit(s, H3, traceAModel, ledger).ok).toBe(true);

    // Sole survivor with source=regen → NO probes → alternatives phase
    const q4 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q4).toEqual({ type: 'need-alternatives', attemptsLeft: 2 });

    // Two failed alternative attempts (one ledger-inconsistent, one equivalent) → converged
    expect(admit(s, { ...H1, id: 'A1', source: 'alternative' }, traceAModel, ledger).ok).toBe(false); // contradicts w2
    s.alternativeAttempts = 2;   // second attempt: checkDistinct returned false (equivalent) — counted by CLI
    const q5 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q5).toEqual({ type: 'converged' });
  });

  it('checkDistinct: UNSAT distinguish ⇒ equivalent ⇒ false', async () => {
    const deps = fakeDeps([[]]);
    expect(await checkDistinct(H1.candidate, H1.candidate, traceAModel, deps)).toBe(false);
  });

  // Regression coverage for the golden-trace-A bug: exclusions must be recomputed against the
  // CURRENT query's candidates, not reused verbatim from the ledger's stored `salient` field.
  // A verdict recorded while only H1/H2 (customer, plan — no family) were active produces a
  // shape with no `plan.family` dim. If that coarse shape is later reused verbatim to exclude a
  // distinguish query between H1 and a *different*, family-aware candidate, it silently excludes
  // the only witness that could ever distinguish them — see task-17 report for the full trace.
  it('exclusions are rescoped per query — a stale coarse shape does not block a finer distinguish', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    const H1only = H1;
    const H3: CandidateInvariant = { id: 'H3', name: 'H3', prior: 0.9, source: 'regen',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] } };
    registerCandidates(s, [H1only]);
    // Record a verdict from an earlier round where only H1 (customer-only) was under
    // consideration — its extracted salient facts have no `plan.family` dim at all.
    const staleWitness: CaseState = { entities: [
      { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} }, { type: 'Family', id: 'f2', fields: {} },
      { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p2', fields: { family: 'f2' } },
      { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
      { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
    ]};
    const staleSalient = extractSalient([H1only.candidate], staleWitness);   // only `customer equal` + count — no plan dims at all
    ledger.push({ kind: 'verdict', at: 't0', witnessId: 'w0', witness: staleWitness, salient: staleSalient, judge: 'permit', question: 'q' });

    // Now a fresh alternative (H3, family-aware) is admitted and the loop must distinguish it
    // from H1. The fake solver returns dpsf (same customer, same family) for this query — if the
    // planner wrongly reused the stale shape (customer equal=true) as an exclusion, this witness
    // would look identical on the recorded dims and get excluded, leaving nothing to return.
    registerCandidates(s, [H3]);
    const deps = fakeDeps([[dpsf]]);
    const q = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q.type).toBe('question');
    expect((q as any).witness).toEqual(dpsf);
  });

  // Regression coverage for golden-trace-B: a probe-forbid on a sole-survivor `statePredicate`
  // candidate MUST reuse exclusions scoped to that candidate (recomputed fresh from raw witnesses,
  // same helper the distinguish loop uses) — going tautologically UNSAT once every way the
  // candidate can be violated has already been shown and forbidden is correct, not a masking bug,
  // because extractSalient's collectCmps walk is exhaustive over a statePredicate's own comparison
  // tree (unlike `unique`, whose extraction is partial — see the *next* test for that contrast).
  it('probe-forbid on a statePredicate reuses exclusions from a prior forbid verdict against it — goes UNSAT once fully covered', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    const H2: CandidateInvariant = { id: 'H2', name: 'graceWindow', prior: 0.9, source: 'seed', candidate: graceCandidate(true) };
    registerCandidates(s, [H2]);
    // A prior distinguish verdict already forbade a beyond-grace witness (the only violation shape
    // a statePredicate implication has: guard true, body false).
    const beyondGrace: CaseState = {
      now: 220,
      entities: [
        { type: 'Invoice', id: 'i1', fields: { status: 'Unpaid', dueDate: 0 } },
        { type: 'Subscription', id: 's1', fields: { 'Access.state': 'Active', grace: 72, invoice: 'i1' } }
      ]
    };
    const salient = extractSalient([H2.candidate], beyondGrace);
    ledger.push({ kind: 'verdict', at: 't0', witnessId: 'w0', witness: beyondGrace, salient, judge: 'forbid', question: 'q' });

    const deps: any = {
      alloy: async () => { throw new Error('statePredicate with arith routes to quint, not alloy'); },
      quint: async (_m: unknown, q: any) => {
        // Sanity: the exclusion shape must actually be wired into this query (no exclusions would
        // be a silent false-pass of this regression test).
        expect(q.exclusions.length).toBeGreaterThan(0);
        return { violated: false, ms: 5 };   // UNSAT: nothing left uncovered by the exclusion
      }
    };
    const q = await nextQuestion(s, ledger, traceBModel, deps);
    // Sole a-priori survivor with no remaining probe-forbid witness ⇒ falls through to probe-permit,
    // then (no permit evidence, no witness either in this stub) to the alternatives phase — it must
    // NOT surface a probe-forbid question, since the only violation shape was already judged.
    expect(q.type).not.toBe('probe-options');
  });

  // Contrast case: the SAME exclusion-reuse must NOT apply to `unique` candidates (Task 17's
  // masking bug). extractSalient only records pairwise by-key equality booleans for `unique` —
  // never unconstrained domain fields like plan.family — so reprojecting a forbid verdict onto a
  // unique survivor alone reproduces a shape matching `not Hi` on the dims it happens to check,
  // while silently missing the dimension a real, still-outstanding refutation needs to vary.
  it('probe-forbid on a `unique` candidate still ignores exclusions — Task 17 masking guard holds', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    registerCandidates(s, [H1]);
    const salient = extractSalient([H1.candidate], dpsf);
    ledger.push({ kind: 'verdict', at: 't0', witnessId: 'w0', witness: dpsf, salient, judge: 'forbid', question: 'q' });
    const deps = fakeDeps([[dpdf]]);   // a real, still-outstanding refutation (different family)
    const q = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q.type).toBe('probe-options');   // must still be found — not masked by the stale reuse
  });

  // Regression coverage for the live-discovered inState-masking bug: two statePredicate candidates
  // differing ONLY by an inState guard (e.g. `totalDue <= parts` vs `inState(...) implies totalDue
  // = parts`) must NOT be falsely merged as equivalent. Before the fix, collectCmps in salient.ts
  // skipped `inState` predicates entirely, so extractSalient never captured machine-state as a
  // salient dim — a prior verdict's rebuilt exclusion shape then covered the WHOLE Hi≠Hj region
  // (same masking class as the Task-17 `unique` bug documented above `exclusionsFrom`), and the
  // distinguish query went UNSAT purely because the exclusion was too coarse, not because the
  // candidates actually agree. This test asserts directly on the exclusion contents handed to the
  // fake solver — the machine-state dim must now be present, so the shape no longer blankets the
  // whole region.
  it('extractSalient captures inState guard dims — exclusions for a state-guarded statePredicate pair include the machine-state dim', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    const noGuard: CandidateInvariant = { id: 'HnoGuard', name: 'HnoGuard', prior: 0.6, source: 'seed', candidate: {
      kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['grace'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } }
    }};
    const guarded: CandidateInvariant = { id: 'HGuarded', name: 'HGuarded', prior: 0.55, source: 'seed', candidate: {
      kind: 'statePredicate', aggregate: 'Subscription',
      where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['grace'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } }
    }};
    registerCandidates(s, [noGuard, guarded]);

    // A prior verdict whose witness matches the arith dims (`grace le grace` trivially true) but
    // carries a machine-state field the old extraction dropped entirely.
    const priorWitness: CaseState = { entities: [
      { type: 'Subscription', id: 's1', fields: { grace: 72, 'Access.state': 'Active' } }
    ]};
    const priorSalient = extractSalient([noGuard.candidate, guarded.candidate], priorWitness);
    ledger.push({ kind: 'verdict', at: 't0', witnessId: 'w0', witness: priorWitness, salient: priorSalient, judge: 'permit', question: 'q' });

    let capturedExclusions: any;
    const deps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 1 }),
      quint: async (_m: unknown, q: any) => { capturedExclusions = q.exclusions; return { violated: false, ms: 1 }; }
    };
    await nextQuestion(s, ledger, traceBModel, deps);

    expect(capturedExclusions).toBeDefined();
    expect(capturedExclusions.length).toBeGreaterThan(0);
    const dims = capturedExclusions.flatMap((facts: any[]) => facts.map(f => f.dim));
    expect(dims).toContain('Access.state = Active');
  });

  // Regression coverage: Alloy's own enumeration order is first-SAT-found, not "most minimal" —
  // an early instance can carry gratuitous extra atoms that make the witness harder to read than
  // necessary. The planner should prefer the smallest enumerated instance.
  it('prefers the smallest enumerated witness among several returned instances', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    registerCandidates(s, [H1, H2]);
    const bigger: CaseState = { entities: [...dpsf.entities, { type: 'Customer', id: 'c9', fields: {} }] };
    const deps = fakeDeps([[bigger, dpsf]]);   // bigger returned first, smaller second
    const q = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q.type).toBe('question');
    expect((q as any).witness).toEqual(dpsf);
  });
});
