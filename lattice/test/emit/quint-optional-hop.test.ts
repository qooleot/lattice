import { describe, it, expect } from 'vitest';
import { astToQuint, candidateToQuint, predToQuint, refHopGates } from '../../src/emit/quint.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate, Predicate } from '../../src/ast/invariant.js';

// Finding: an absent optional ref still holds a drawn id (initValue draws from METHOD_IDS
// regardless of the Present flag), so gating a hop on the TARGET's `.exists` alone lets Apalache
// read through a hop the state says is absent. Every gate must conjoin the hop's own flag.
const m: DomainModel = {
  context: 'HopGate', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [
    { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'fee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'tag', type: { kind: 'prim', prim: 'Int' }, optional: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true }],
    machine: { regions: [{ name: 'intent', initial: 'pending', states: [
      { name: 'pending', tags: ['active'] }] }], transitions: [] } }],
  events: [], services: []
};

describe('refHopGates — optional hop contributes its Present flag', () => {
  it('returns flag + exists for an optional hop, exists only for a required one', () => {
    expect(refHopGates(m, ['method', 'fee'], 'x', 'Payment'))
      .toEqual(['x.methodPresent', 'methods.get(x.method).exists']);
  });

  it('cmp through an optional hop is gated on the flag (implies polarity)', () => {
    const p: Predicate = { kind: 'cmp', op: 'gt',
      left: { kind: 'field', owner: 'self', path: ['method', 'fee'] },
      right: { kind: 'int', value: 0 } };
    expect(predToQuint(m, p, 'x', 'Payment'))
      .toBe('((x.methodPresent and methods.get(x.method).exists) implies (methods.get(x.method).fee > 0))');
  });

  it('present() through an optional hop conjoins the flag (fact polarity)', () => {
    const p: Predicate = { kind: 'present', path: ['method', 'tag'] };
    expect(predToQuint(m, p, 'x', 'Payment'))
      .toBe('((x.methodPresent and methods.get(x.method).exists) and methods.get(x.method).tagPresent)');
  });

  it('unique collision through an optional hop conjoins both rows\' flags', () => {
    const c: Candidate = { kind: 'unique', aggregate: 'Payment',
      whileStates: { region: 'intent', states: ['pending'] }, by: [['method', 'fee']] };
    const em = astToQuint(m, { kind: 'probe-forbid', hi: c, exclusions: [], maxSteps: 0 });
    expect(em.source).toContain('payments.get(k1).methodPresent');
    expect(em.source).toContain('payments.get(k2).methodPresent');
  });
});

// Step 4b (carried finding #5 from Slice B2): conservation and sumOverCollection's total read call
// pathToQuint bare — no hop gate at all — so a part/total path crossing a ref lets Apalache read a
// never-created (or absent-optional) record's placeholder and convict where the judge permits.
describe('conservation and sumOverCollection gate a ref-hop total the same way cmp does', () => {
  // A conservation model: Payment.amount is an own field; Payment.method is an optional ref to
  // Method.fee. total crosses the optional hop, parts is an own field.
  const mCons: DomainModel = {
    context: 'ConsHop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'fee', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'total', type: { kind: 'prim', prim: 'Money' } },
      { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true }] }],
    events: [], services: []
  };

  it('a total path through an optional hop emits the flag gate, implies-wrapped', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Payment', parts: [['amount']], total: ['method', 'fee'] };
    const src = candidateToQuint(mCons, c, 'Cons');
    expect(src).toContain('x.methodPresent');
    expect(src).toContain('implies');
  });

  it('an own-field total path emits unchanged (no gate, no implies)', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Payment', parts: [['amount']], total: ['total'] };
    const src = candidateToQuint(mCons, c, 'Cons');
    expect(src).not.toContain('Present');
    expect(src).not.toContain('implies');
    expect(src).toContain('x.amount == x.total');
  });

  // sumOverCollection: the summed CHILD field never crosses a ref hop (a child's own field), but the
  // aggregate-level `total` it's compared against can.
  const mSum: DomainModel = {
    context: 'SumHop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'cap', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
      { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'Line' } } }],
      entities: [{ kind: 'entity', name: 'Line', fields: [
        { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
    events: [], services: []
  };

  it('sumOverCollection gates its total when the total path crosses an optional hop', () => {
    const c: Candidate = { kind: 'sumOverCollection', aggregate: 'Invoice', collection: 'lines',
      child: 'Line', field: 'amount', op: 'eq', total: ['method', 'cap'] };
    const src = candidateToQuint(mSum, c, 'Sum');
    expect(src).toContain('x.methodPresent');
    expect(src).toContain('implies');
  });
});

// The CHILD-SUBJECT conservation branch (overChildren) is a separate code path from the top-level
// arm and must gate the same way. A child cannot carry an optional field (validate.ts's
// optional-owned-child rejects the model), so only the EXISTENCE half is reachable here: post-B2 a
// child may hold a required ref to a top-level owner, and a parts/total path hopping that ref reads
// a possibly-never-created record's placeholder — refHopGates emits only `.exists` atoms, which is
// exactly right.
describe('child-subject conservation gates its ref-hop reads (existence only)', () => {
  const mChild: DomainModel = {
    context: 'ChildCons', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'fee', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Leg' } } }],
      entities: [{ kind: 'entity', name: 'Leg', fields: [
        { name: 'legId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
        { name: 'net', type: { kind: 'prim', prim: 'Money' } },
        { name: 'method', type: { kind: 'ref', target: 'Method' } }] }] }],
    events: [], services: []
  };

  it('a total path through the child\'s ref emits the .exists gate, implies polarity, inside the slot body', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Leg', parts: [['amount']], total: ['method', 'fee'] };
    const src = candidateToQuint(mChild, c, 'ChildCons');
    expect(src).toContain('(methods.get(o.legs.get(i).method).exists) implies (o.legs.get(i).amount == methods.get(o.legs.get(i).method).fee)');
  });

  it('a child-subject conservation over plain child fields emits unchanged (no gate, no implies)', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Leg', parts: [['amount']], total: ['net'] };
    const src = candidateToQuint(mChild, c, 'ChildCons');
    expect(src).not.toContain('implies');
    expect(src).toContain('(o.legs.get(i).amount == o.legs.get(i).net)');
  });
});
