import { describe, it, expect } from 'vitest';
import { astToAlloy } from '../../src/emit/alloy.js';
import { validateModel } from '../../src/ast/validate.js';
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

// An optional sub-field of a value type is rejected at the model level (optional-value): the whole
// value flattens into `one`-multiplicity `<field>_<sub>` relations, so the marker has nothing to
// attach to and `present(window.end)` would be a tautology here while quint made it real. There is
// no emission to assert — the model never loads.
describe('alloy — a value sub-field cannot be optional', () => {
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

  it('is rejected by validateModel, not encoded', () =>
    expect(validateModel(mValue).map(d => d.code)).toContain('optional-value'));
});

// The gate that makes evaluate.ts:45's "unknown facts don't convict" true in Alloy too. `lone`
// made ref hops partial, and Alloy DECIDES on an empty join (`none > 0` is false) where the judge
// and quint both permit — real Alloy called `all x: Payment | x.method.fee > 0` UNSAT alongside a
// method-less Payment, forbidding the shape invariant.md promises is satisfied "silently, forever".
describe('alloy — ref-hop existence gate on cmp', () => {
  const mHop: DomainModel = {
    context: 'Hop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'fee', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
      { name: 'required', type: { kind: 'ref', target: 'Method' } },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    events: [], services: []
  };
  const cmpOver = (path: string[]): Candidate => ({ kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'Payment', path }, right: { kind: 'int', value: 0 } } });
  const emit = (c: Candidate) => astToAlloy(mHop, { kind: 'probe-permit', hi: c, exclusions: [], scope: 4 });

  it('gates a read through an optional hop at permit polarity', () =>
    expect(emit(cmpOver(['method', 'fee']))).toContain('((some x.method) implies (x.method.fee > 0))'));

  it('leaves a read through a required hop ungated — `one` can never be empty', () =>
    expect(emit(cmpOver(['required', 'fee']))).toContain('(x.required.fee > 0)'));

  it('does not gate a read that crosses no hop', () =>
    expect(emit(cmpOver(['amount']))).toContain('(x.amount > 0)'));
});
