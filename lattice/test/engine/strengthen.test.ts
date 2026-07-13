import { describe, it, expect } from 'vitest';
import { ctiTransition, guardVariants } from '../../src/engine/strengthen.js';
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
