import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import type { DomainModel } from '../../src/ast/domain.js';
import { impliedInvariants } from '../../src/engine/implied.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [{ name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
  events: [], services: []
};

describe('quint — optional fields', () => {
  // QuintQuery has no bare `candidate` field (see astToQuint's actual signature: kind/hi/
  // exclusions/maxSteps) — wrap the same statePredicate candidate as `hi` on a probe-permit
  // query, matching the convention every other astToQuint call site in test/emit/quint.test.ts
  // uses. The candidate and predicate under test are unchanged.
  const out = astToQuint(m, { kind: 'probe-permit', hi: { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'present', path: ['method'] } }, exclusions: [], maxSteps: 0 });
  const src = out.source;

  it('emits a Present companion flag beside the field', () => {
    expect(src).toContain('methodPresent: bool');
    expect(src).toContain('method: str');
  });

  it('emits no companion for a required field', () => expect(src).not.toContain('amountPresent'));

  it('emits present(f) as the flag', () => expect(src).toMatch(/\w+\.methodPresent/));
});

// A flag is only worth emitting if the emission names one that exists. pathToQuint walks a ref hop
// through a map-get and a value hop as a plain dotted accessor, so `${pathToQuint(...)}Present`
// lands in a different record in each case — each must be declared where the path actually points.
describe('quint — present() beyond a one-hop own field', () => {
  const mHop: DomainModel = {
    context: 'Hop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'fee', type: { kind: 'prim', prim: 'Money' }, optional: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'method', type: { kind: 'ref', target: 'Method' } }] }],
    events: [], services: []
  };

  it('a ref hop reads the flag off the TARGET record, which declares it', () => {
    const src = astToQuint(mHop, { kind: 'probe-permit', hi: { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'present', path: ['method', 'fee'] } }, exclusions: [], maxSteps: 0 }).source;
    expect(src).toContain('methods.get(x.method).feePresent');
    expect(src).toContain('var methods: str -> { exists: bool, fee: int, feePresent: bool }');
  });

  const mVal: DomainModel = {
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

  it('a value hop reads the flag inside the nested record, which declares it', () => {
    const src = astToQuint(mVal, { kind: 'probe-permit', hi: { kind: 'statePredicate', aggregate: 'Plan',
      body: { kind: 'present', path: ['window', 'end'] } }, exclusions: [], maxSteps: 0 }).source;
    expect(src).toContain('x.window.endPresent');
    expect(src).toContain('window: { start: int, end: int, endPresent: bool }');
  });
});

// A field the solver cannot see gets no flag: fieldQType drops Text/Id entirely, so a flag beside
// one would be a promise the engine cannot keep (the reason `Id?` is documented structural-only).
describe('quint — an unencodable optional field gets no flag', () => {
  const mText: DomainModel = {
    context: 'T', ticksPerDay: 24, enums: [], values: [], entities: [],
    aggregates: [{ kind: 'aggregate', name: 'Note', fields: [
      { name: 'noteId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'memo', type: { kind: 'prim', prim: 'Text' }, optional: true }] }],
    events: [], services: []
  };
  const src = astToQuint(mText, { kind: 'probe-permit', hi: { kind: 'statePredicate', aggregate: 'Note',
    body: { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } },
    exclusions: [], maxSteps: 0 }).source;

  it('drops an optional Text field and its companion alike', () => {
    expect(src).not.toContain('memoPresent');
    expect(src).not.toContain('memo:');
  });
});

describe('the Payment.paymentMethod fix (quint path — Alloy never enforced refsResolve)', () => {
  const payment: DomainModel = {
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

  it('refsResolve no longer names the optional ref, so the initial state is legal', () => {
    const d = impliedInvariants(payment);
    // Anchor FIRST: prove the derivation actually ran over this model. Without this, the
    // absence assertion below passes vacuously if impliedInvariants returns [] for any reason
    // (a renamed derivation, a model the walker skips) — an unfalsifiable guard, which is the
    // exact defect class this codebase keeps producing.
    expect(d.map(i => i.name)).toContain('nonNegativePaymentAmount');
    // every ref on Payment is optional, so no refsResolve rule exists at all
    expect(d.find(i => i.name === 'refsResolvePayment')).toBeUndefined();
  });
});
