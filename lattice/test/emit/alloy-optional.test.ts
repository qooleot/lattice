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

// present() over a value-typed field's sub-field must flatten the same way termToAlloy's field
// arm does (alloyFieldPath) — emitOwnerSig never declares a `period.start` relation, only
// `period_start`, so a naive path join here would be an Alloy parse error, not just a wrong result.
const mValue: DomainModel = {
  context: 'OptVal', ticksPerDay: 24, enums: [],
  values: [{ kind: 'value', name: 'Window', fields: [
    { name: 'start', type: { kind: 'prim', prim: 'Int' } },
    { name: 'end', type: { kind: 'prim', prim: 'Int' }, optional: true }] }],
  entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Plan', fields: [
    { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'window', type: { kind: 'value', value: 'Window' } }] }],
  events: [], services: []
};

const hiValue: Candidate = { kind: 'statePredicate', aggregate: 'Plan',
  body: { kind: 'present', path: ['window', 'end'] } };

describe('alloy — present() over a value sub-field', () => {
  const q: AlloyQuery = { kind: 'probe-permit', hi: hiValue, exclusions: [], scope: 4 };
  const src = astToAlloy(mValue, q);

  it('flattens to the underscore-joined relation, not a dotted path', () => {
    expect(src).toMatch(/some\s+x\.window_end\b/);
    expect(src).not.toContain('x.window.end');
  });
});
