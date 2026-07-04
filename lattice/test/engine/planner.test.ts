import { describe, it, expect } from 'vitest';
import { nextQuestion, checkDistinct } from '../../src/engine/planner.js';
import { registerCandidates, pruneOnVerdict, admit } from '../../src/engine/hypothesis.js';
import { newSession, type LedgerEntry, type SessionState } from '../../src/engine/session.js';
import { extractSalient } from '../../src/engine/salient.js';
import { traceAModel } from '../fixtures.js';
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
