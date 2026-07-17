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

// The same hole on unique's by-clause, at the THIRD polarity. `by (pm.fee)` with `pm` optional is
// accepted by the language (absence-undecided gates a path's end, not its middle), and in Alloy
// `none = none` is TRUE — two pm-less rows compare equal on `a.pm.fee = b.pm.fee` and read as a
// collision Alloy reports as a uniqueness violation. evaluate.ts:79 skips such rows ("unknown facts
// don't convict") and quint conjoins `<hop>.exists` into its collision predicate; Alloy must too.
describe('alloy — ref-hop existence gate on unique by-keys', () => {
  const mUniq: DomainModel = {
    context: 'UniqHop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'PM', fields: [
      { name: 'pmId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'fee', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'pm', type: { kind: 'ref', target: 'PM' }, optional: true },
      { name: 'required', type: { kind: 'ref', target: 'PM' } },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'Access', initial: 'Open', states: [
        { name: 'Open', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }], transitions: [] } }],
    events: [], services: []
  };
  const uniqueBy = (by: string[][]): Candidate => ({ kind: 'unique', aggregate: 'Payment',
    whileStates: { region: 'Access', states: ['Open'] }, by });
  const emit = (c: Candidate) => astToAlloy(mUniq, { kind: 'probe-permit', hi: c, exclusions: [], scope: 4 });

  // Fact polarity, and the reason it differs from cmp's: the gate joins the COLLISION, which must
  // be FALSE when a hop is absent (so the rows don't collide). cmp gates with `implies` because an
  // ungrounded read must be vacuously TRUE. Do not unify these two arms.
  it('gates the collision on both sides existing, conjunctively', () =>
    expect(emit(uniqueBy([['pm', 'fee']])))
      .toContain('implies not ((some a.pm and some b.pm) and a.pm.fee = b.pm.fee)'));

  it('leaves a by-key through a required hop ungated — `one` can never be empty', () =>
    expect(emit(uniqueBy([['required', 'fee']]))).toContain('implies not (a.required.fee = b.required.fee)'));

  it('does not gate a by-key that crosses no hop', () =>
    expect(emit(uniqueBy([['amount']]))).toContain('implies not (a.amount = b.amount)'));

  it('gates every optional hop across a multi-key by-clause', () => {
    const src = emit(uniqueBy([['pm', 'fee'], ['amount']]));
    expect(src).toContain('(some a.pm and some b.pm) and a.pm.fee = b.pm.fee and a.amount = b.amount');
  });

  // The same none = none hazard in the shape-exclusion renderer. An `equal` dim only exists when
  // both sides resolved (salient.ts:86), so excluding "two rows with equal fees" must not also
  // exclude "two rows with no pm at all" — ungated it did, and the pm-less witness the judge
  // permits became unreachable (real Alloy: UNSAT before, SAT after).
  const excl = (facts: { dim: string; value: unknown }[]) =>
    astToAlloy(mUniq, { kind: 'probe-permit', hi: uniqueBy([['pm', 'fee']]), exclusions: [facts as never], scope: 4 });

  it('gates an `equal` exclusion dim whose path hops through an optional ref', () =>
    expect(excl([{ dim: 'pm.fee equal', value: true }]))
      .toContain('(some a.pm and some b.pm) and a.pm.fee = b.pm.fee'));

  it('gates the `!=` polarity of that dim identically', () =>
    expect(excl([{ dim: 'pm.fee equal', value: false }]))
      .toContain('(some a.pm and some b.pm) and a.pm.fee != b.pm.fee'));

  // A literal-valued dim is already FALSE on an absent hop — the right answer, so no gate.
  it('leaves a literal-valued exclusion dim ungated', () =>
    expect(excl([{ dim: 'amount value', value: 3 }])).toContain('a.amount = 3'));
});

// candidateToPred's sumOverCollection arm rendered `total`'s path bare — no alloyRefHops gate —
// while every sibling arm (cmp, unique, and quint's own sum arm) is gated. expressibleAdopted
// includes sumOverCollection as an ADOPTED constraint alloy can express directly (candidateToPred's
// intent comment at :270), so an adopted sum rule whose `total` crosses a `lone` hop made Alloy's
// empty join FALSE where the TS judge and quint both permit it — the same "none = none"-shaped
// divergence class the unique and cmp arms above already close. Fixture mirrors
// quint-optional-hop.test.ts's mSum exactly, so the same shape is pinned on both engines.
describe('alloy — ref-hop existence gate on sumOverCollection total', () => {
  const mSum: DomainModel = {
    context: 'SumHop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'cap', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'prim', prim: 'Money' } },
      { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
      { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'Line' } } }],
      entities: [{ kind: 'entity', name: 'Line', fields: [
        { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
    events: [], services: []
  };
  const emit = (c: Candidate) => astToAlloy(mSum, { kind: 'probe-permit', hi: c, exclusions: [], scope: 4 });

  it('gates the comparison at permit polarity when total crosses an optional hop', () => {
    const c: Candidate = { kind: 'sumOverCollection', aggregate: 'Invoice', collection: 'lines',
      child: 'Line', field: 'amount', op: 'eq', total: ['method', 'cap'] };
    expect(emit(c)).toContain(
      '(some x.method) implies (x.method.cap = (sum l: { l: Line | l.owner = x } | l.amount))');
  });

  it('leaves an own-field total emitted unchanged — no gate, no implies', () => {
    const c: Candidate = { kind: 'sumOverCollection', aggregate: 'Invoice', collection: 'lines',
      child: 'Line', field: 'amount', op: 'eq', total: ['total'] };
    const src = emit(c);
    expect(src).toContain('pred Hi { all x: Invoice | x.total = (sum l: { l: Line | l.owner = x } | l.amount) }');
    expect(src).not.toContain('implies');
  });
});
