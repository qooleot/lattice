import { describe, it, expect } from 'vitest';
import { impliedInvariants } from '../../src/engine/implied.js';
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

describe('derived invariants over optional fields', () => {
  const d = impliedInvariants(m);

  it('refsResolve excludes an optional ref — absent is not an orphan', () => {
    const r = d.find(i => i.name === 'refsResolvePayment')!;
    expect(r.candidate).toEqual({ kind: 'refsResolve', aggregate: 'Payment', fields: ['bill'] });
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
