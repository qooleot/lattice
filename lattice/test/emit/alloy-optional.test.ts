import { describe, it, expect } from 'vitest';
import { astToAlloy } from '../../src/emit/alloy.js';
import type { AlloyQuery } from '../../src/emit/alloy.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [{ name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'approved', type: { kind: 'prim', prim: 'Money' }, optional: true }] }],
  events: [], services: []
};

const hi: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
  body: { kind: 'present', path: ['approved'] } };

describe('alloy — optional fields', () => {
  const q: AlloyQuery = { kind: 'probe-permit', hi, exclusions: [], scope: 4 };
  const src = astToAlloy(m, q);

  it('emits lone for an optional ref and an optional prim', () => {
    expect(src).toContain('method: lone Method');
    expect(src).toContain('approved: lone Int');
  });

  it('leaves required fields as one', () => expect(src).toContain('amount: one Int'));

  it('emits present(f) as `some`', () => expect(src).toMatch(/some\s+\w+\.approved/));
});
