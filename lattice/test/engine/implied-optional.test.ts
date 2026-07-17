import { describe, it, expect } from 'vitest';
import { impliedInvariants } from '../../src/engine/implied.js';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import type { DomainModel } from '../../src/ast/domain.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [{ name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
    { name: 'bill', type: { kind: 'ref', target: 'Method' } },
    { name: 'approved', type: { kind: 'prim', prim: 'Money' }, optional: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
  events: [], services: []
};

// Used by the refsResolve test below. Mirrors quint-optional.test.ts's inline payment model (kept
// in sync by hand, not imported — that file has its own copy of this fixture): an aggregate whose
// only same-context ref is optional, plus a machine so a witness can carry a state.
function paymentWithOptionalMethodModel(): DomainModel {
  return {
    context: 'BillPayments', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'PaymentMethod', fields: [{ name: 'pmId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'paymentMethod', type: { kind: 'ref', target: 'PaymentMethod' }, optional: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'intent', initial: 'requiresPaymentMethod', states: [
        { name: 'requiresPaymentMethod' }, { name: 'succeeded', tags: ['terminal'] }] }],
        transitions: [{ name: 'succeed', region: 'intent', from: ['requiresPaymentMethod'], to: 'succeeded' }] } }],
    events: [], services: []
  };
}

describe('derived invariants over optional fields', () => {
  const d = impliedInvariants(m);

  it('refsResolve names every same-context ref, optional or not', () => {
    const r = d.find(i => i.name === 'refsResolvePayment')!;
    expect(r.candidate).toEqual({ kind: 'refsResolve', aggregate: 'Payment', fields: ['method', 'bill'] });
  });

  it('refsResolve names optional refs — absence is skipped by the judge, dangling convicts', () => {
    const m2 = paymentWithOptionalMethodModel();
    const refs = impliedInvariants(m2).find(i => i.candidate.kind === 'refsResolve');
    expect(refs, 'an all-optional-ref owner still derives refsResolve').toBeDefined();
    expect((refs!.candidate as any).fields).toContain('paymentMethod');

    const absent = { entities: [{ type: 'Payment', id: 'p1', fields: { 'intent.state': 'requiresPaymentMethod' } }] };
    expect(evaluateCandidate(refs!.candidate, absent)).toBe('permit');   // absent ≠ orphan

    const dangling = { entities: [{ type: 'Payment', id: 'p1', fields: { paymentMethod: 'pm-404' } }] };
    expect(evaluateCandidate(refs!.candidate, dangling)).toBe('forbid'); // present must resolve
  });

  it('nonNegative over an optional Money is guarded, not asserted', () => {
    const n = d.find(i => i.name === 'nonNegativePaymentApproved')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'implies',
        left: { kind: 'present', path: ['approved'] },
        right: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['approved'] }, right: { kind: 'int', value: 0 } } } });
  });

  it('nonNegative over a required Money is unchanged', () => {
    const n = d.find(i => i.name === 'nonNegativePaymentAmount')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } } });
  });
});
