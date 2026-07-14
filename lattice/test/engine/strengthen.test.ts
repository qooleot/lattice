import { describe, it, expect } from 'vitest';
import { ctiTransition, guardVariants, strengthenInvariant } from '../../src/engine/strengthen.js';
import { subscriptionsModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

// Invoice invariant conditioning on `paid`: paid ⇒ amountPaid == totalDue (body is the cmp for lattice extraction).
const paidExact: CandidateInvariant = { id: 'x', name: 'paidExact', prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Invoice',
    where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
    body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } } };

// CaseEntity = { type, id, fields: {...} }; region state is keyed '<region>.state' (evaluate.ts:52).
const inv = (settlement: string, paid: number, due: number) => ({ type: 'Invoice', id: 'i1', fields: { 'settlement.state': settlement, amountPaid: paid, totalDue: due } });
describe('ctiTransition', () => {
  it('maps a region-state change in the last step to the entering transition', () => {
    const w = { entities: [inv('paid', 3, 5)], trace: [[inv('open', 3, 5)]] };
    // open → paid in region settlement ⇒ the `settle` transition.
    expect(ctiTransition(subscriptionsModel, paidExact, w)).toEqual({ owner: 'Invoice', region: 'settlement', transition: 'settle' });
  });
  it('returns null when only fields changed (accrual step, no region moved)', () => {
    // Both before and final are 'paid' (no region move); final is forbidden (paid, 9≠5) so a
    // violating instance IS found — this must fall through the region-diff loop, not short-circuit
    // on the `!bad` guard.
    const w = { entities: [inv('paid', 9, 5)], trace: [[inv('paid', 3, 5)]] };
    expect(ctiTransition(subscriptionsModel, paidExact, w)).toBeNull();
  });
  it('returns null when no violating instance is found (candidate never forbidden)', () => {
    const w = { entities: [inv('open', 9, 5)], trace: [[inv('open', 3, 5)]] };
    expect(ctiTransition(subscriptionsModel, paidExact, w)).toBeNull();
  });
  it('returns null when the trace is empty (violation at init)', () => {
    expect(ctiTransition(subscriptionsModel, paidExact, { entities: [inv('open', 9, 5)] })).toBeNull();
  });
});

describe('guardVariants', () => {
  it('generates the {eq,le,ge} lattice over the invariant cmp operand pair', () => {
    const site = { owner: 'Invoice', region: 'settlement', transition: 'settle' };
    const vs = guardVariants(site, paidExact);
    expect(vs.map(v => v.predicate.kind === 'cmp' ? v.predicate.op : undefined).sort()).toEqual(['eq', 'ge', 'le']);
    expect(vs.every(v => v.kind === 'guard' && v.transition === 'settle' && v.aggregate === 'Invoice')).toBe(true);
    // operands preserved (amountPaid vs totalDue)
    expect(vs[0]!.predicate).toMatchObject({ left: { path: ['amountPaid'] }, right: { path: ['totalDue'] } });
  });
});

// Item 2 (Task 6): when the equivalence-prune leaves ≥2 surviving guard variants, strengthenInvariant
// resolves to `distinguish` AND returns the separating witness between adjacent survivors so an author
// can tell them apart. Scripted deps (a ≥2-survivor pruning is hard to hit on the committed model; the
// real-quint behavior of each prune stage was proven in earlier tasks). Call sequence over
// guardVariants' fixed {eq, le, ge} order:
//   quintVerify: [reachability(CTI+witness), closes-eq(closes), closes-le(closes), closes-ge(open)]
//     ⇒ eq + le close the CTI, ge does not ⇒ two closers.
//   quint (probe-permit): 3 consistency (all consistent) + separation probes; every probe-permit
//     returns a witness ⇒ eq and le SEPARATE (not equivalent) ⇒ both survive.
describe('strengthenInvariant — ≥2 survivors resolve to distinguish with separating witnesses', () => {
  const ctiWitness = { entities: [inv('paid', 3, 5)], trace: [[inv('open', 3, 5)]] };
  const sepWitness = { entities: [inv('paid', 4, 5)] };
  function scriptedDeps() {
    let qvi = 0;
    const quintVerifyResults = [
      { violated: true, witness: ctiWitness },   // 1: reachability — CTI confirmed
      { violated: false },                       // 2: closes-eq — closes (violated:false)
      { violated: false },                       // 3: closes-le — closes
      { violated: true },                        // 4: closes-ge — does NOT close
    ];
    const deps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 0 }),
      // consistency (3a) + separation (3c + witness collection) probes: all reachable ⇒ violated:true,
      // and always carry a witness so separatingWitness returns a CaseState (variants DO separate).
      quint: async () => ({ violated: true, witness: sepWitness, ms: 0 }),
      quintVerify: async () => ({ ...(quintVerifyResults[qvi++] ?? { violated: false }), ms: 0 }),
    };
    return deps;
  }

  it('returns exactly the two closers as survivors plus ≥1 separating witness', async () => {
    const res = await strengthenInvariant(subscriptionsModel, paidExact, [paidExact.candidate], scriptedDeps());
    expect(res.kind).toBe('distinguish');
    if (res.kind !== 'distinguish') throw new Error('expected distinguish');
    expect(res.survivors).toHaveLength(2);
    expect(res.survivors.map(g => (g.predicate as any).op).sort()).toEqual(['eq', 'le']);
    expect(res.survivors.every(g => g.kind === 'guard' && g.transition === 'settle')).toBe(true);
    expect(res.witnesses.length).toBeGreaterThanOrEqual(1);
    expect(res.witnesses[0]).toEqual(sepWitness);
  });
});
