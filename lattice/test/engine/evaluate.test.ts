import { describe, it, expect } from 'vitest';
import { evaluateCandidate, type CaseState } from '../../src/engine/evaluate.js';
import type { Candidate } from '../../src/ast/invariant.js';

const uniqueByCustomerFamily: Candidate = {
  kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']]
};

// DPSF: two active subs, same customer, different plan, SAME family (spec §2.1)
const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p2', fields: { family: 'storage' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
// DPDF: same customer, DIFFERENT family
const dpdf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} }, { type: 'Family', id: 'compute', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p3', fields: { family: 'compute' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

const graceRule: Candidate = {
  kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['invoice', 'status'] }, right: { kind: 'enumval', enum: 'Status', value: 'Unpaid' } }
    ]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' }, right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } }
  }
};
const mkGraceCase = (now: number): CaseState => ({ now, entities: [
  { type: 'Invoice', id: 'i1', fields: { status: 'Unpaid', dueDate: 100 } },
  { type: 'Subscription', id: 's1', fields: { grace: 72, invoice: 'i1', 'Access.state': 'Active' } }
]});

describe('evaluateCandidate', () => {
  it('unique: forbids two active in same (customer, family)', () =>
    expect(evaluateCandidate(uniqueByCustomerFamily, dpsf)).toBe('forbid'));
  it('unique: permits two active in different families', () =>
    expect(evaluateCandidate(uniqueByCustomerFamily, dpdf)).toBe('permit'));
  it('unique: a by-tuple with an unresolvable component never convicts (unknown facts)', () => {
    // Witnesses never carry key fields (emitters drop them — atom identity suffices), so a
    // by-path like ['id'] resolves undefined on every subject. That must not read as a collision.
    const byKey: Candidate = { kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] }, by: [['id']] };
    expect(evaluateCandidate(byKey, dpsf)).toBe('permit');
    const composite: Candidate = { kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['id']] };
    expect(evaluateCandidate(composite, dpsf)).toBe('permit');
  });
  it('statePredicate: forbids unpaid beyond grace (5 days = 120 ticks past due, grace 72)', () =>
    expect(evaluateCandidate(graceRule, mkGraceCase(220))).toBe('forbid'));
  it('statePredicate: permits unpaid within grace (5 hours past due)', () =>
    expect(evaluateCandidate(graceRule, mkGraceCase(105))).toBe('permit'));
  it('cardinality: at most one Open period', () => {
    const c: Candidate = { kind: 'cardinality', aggregate: 'AccountingPeriod',
      where: { kind: 'inState', owner: 'self', region: 'Lifecycle', states: ['Open'] }, atMost: 1 };
    const two: CaseState = { entities: [
      { type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Open' } },
      { type: 'AccountingPeriod', id: 'p2', fields: { 'Lifecycle.state': 'Open' } }
    ]};
    expect(evaluateCandidate(c, two)).toBe('forbid');
    two.entities[1]!.fields['Lifecycle.state'] = 'Closed';
    expect(evaluateCandidate(c, two)).toBe('permit');
  });
  it('conservation: recognized + deferred == allocated', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] };
    const ok: CaseState = { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 60, allocated: 100 } }] };
    const leak: CaseState = { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 50, allocated: 100 } }] };
    expect(evaluateCandidate(c, ok)).toBe('permit');
    expect(evaluateCandidate(c, leak)).toBe('forbid');
  });
  it('refsResolve: forbids a dangling ref', () => {
    const c: Candidate = { kind: 'refsResolve', aggregate: 'RevenueEntry' };
    const s: CaseState = { entities: [{ type: 'RevenueEntry', id: 'e1', fields: { obligation: 'ghost' } }] };
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
  it('monotonic: forbids a decrease across the trace', () => {
    const c: Candidate = { kind: 'monotonic', aggregate: 'Obligation', field: ['recognized'] };
    const s: CaseState = {
      entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 30 } }],
      trace: [[{ type: 'Obligation', id: 'o1', fields: { recognized: 40 } }]]
    };
    expect(evaluateCandidate(c, s)).toBe('forbid');
    expect(evaluateCandidate(c, { ...s, trace: [[{ type: 'Obligation', id: 'o1', fields: { recognized: 10 } }]] })).toBe('permit');
  });
  it('terminal: forbids leaving a terminal state across the trace', () => {
    const c: Candidate = { kind: 'terminal', aggregate: 'AccountingPeriod', region: 'Lifecycle', state: 'Closed' };
    const s: CaseState = {
      entities: [{ type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Open' } }],
      trace: [[{ type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Closed' } }]]
    };
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
});
