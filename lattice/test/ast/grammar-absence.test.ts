import { describe, it, expect } from 'vitest';
import { validateCandidate } from '../../src/ast/grammar.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate, Predicate } from '../../src/ast/invariant.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Refund', fields: [
    { name: 'refundId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    { name: 'approvedAmount', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] }] }],
  events: [], services: []
};
const approved = (): Predicate => ({ kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['approvedAmount'] }, right: { kind: 'int', value: 0 } });
const sp = (body: Predicate, where?: Predicate): Candidate => ({ kind: 'statePredicate', aggregate: 'Refund', ...(where ? { where } : {}), body });
const codes = (c: Candidate) => validateCandidate(c, m).map(d => d.code);

describe('absence-undecided', () => {
  it('rejects a bare read of an optional field', () =>
    expect(codes(sp(approved()))).toContain('absence-undecided'));

  it('accepts it under a where-guard present()', () =>
    expect(codes(sp(approved(), { kind: 'present', path: ['approvedAmount'] }))).toEqual([]));

  it('accepts present(f) && f > 0', () =>
    expect(codes(sp({ kind: 'and', args: [{ kind: 'present', path: ['approvedAmount'] }, approved()] }))).toEqual([]));

  it('accepts f > 0 && present(f) — && is symmetric', () =>
    expect(codes(sp({ kind: 'and', args: [approved(), { kind: 'present', path: ['approvedAmount'] }] }))).toEqual([]));

  it('accepts present(f) => f > 0', () =>
    expect(codes(sp({ kind: 'implies', left: { kind: 'present', path: ['approvedAmount'] }, right: approved() }))).toEqual([]));

  it('rejects present(f) || f > 0 — either side may be read when the other is false', () =>
    expect(codes(sp({ kind: 'or', args: [{ kind: 'present', path: ['approvedAmount'] }, approved()] }))).toContain('absence-undecided'));

  it('does not fire for a required field', () => {
    const req: Candidate = sp({ kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } });
    expect(codes(req)).toEqual([]);
  });

  it('fires for an optional path in a unique by-clause', () => {
    const u: Candidate = { kind: 'unique', aggregate: 'Refund',
      whileStates: { region: 'r', states: ['s'] }, by: [['approvedAmount']] };
    expect(validateCandidate(u, m).map(d => d.code)).toContain('absence-undecided');
  });

  it('fires for an optional field in a monotonic candidate', () => {
    const mono: Candidate = { kind: 'monotonic', aggregate: 'Refund', field: ['approvedAmount'] };
    expect(validateCandidate(mono, m).map(d => d.code)).toContain('absence-undecided');
  });

  it('does not fire for a required field in a monotonic candidate', () => {
    const mono: Candidate = { kind: 'monotonic', aggregate: 'Refund', field: ['amount'] };
    expect(validateCandidate(mono, m).map(d => d.code)).not.toContain('absence-undecided');
  });
});

// present() only means something over a field that can actually be absent. Over a required field
// it is the constant `true` in Alloy (`some x.amount`) but a read of a flag Quint never declares
// (`x.amountPresent` — real quint: "Trying to unify { exists: bool, amount: int } and
// { amountPresent: _t | tail__t }", typechecking failed). Routing hides it: a present-only body
// routes to Alloy, then poisons every Quint query once adopted (expressibleAdopted).
describe('present-not-optional', () => {
  it('rejects present() over a required field', () =>
    expect(codes(sp({ kind: 'present', path: ['amount'] }))).toContain('present-not-optional'));

  it('does not fire for present() over an optional field', () =>
    expect(codes(sp({ kind: 'present', path: ['approvedAmount'] }))).toEqual([]));

  it('fires from anywhere in the body, not just the top', () =>
    expect(codes(sp({ kind: 'implies', left: { kind: 'present', path: ['amount'] }, right: approved() })))
      .toContain('present-not-optional'));

  it('fires from a where-guard too', () =>
    expect(codes(sp(approved(), { kind: 'and', args: [{ kind: 'present', path: ['approvedAmount'] }, { kind: 'present', path: ['amount'] }] })))
      .toContain('present-not-optional'));
});

// The `absence-undecided — sumOverCollection child field` cases that stood here are gone with the
// gate they covered: validateModel's optional-owned-child now rejects an optional field on an
// aggregate-owned child, so the models those tests built are no longer legal specs.

// Task 10: the conservation/sumOverCollection absence-undecided sites (grammar.ts's parts/total
// checks) had no direct coverage — pin all three gates (conservation part, conservation total,
// sumOverCollection total) the way the field-level cases above already pin `statePredicate`.
const modelWithOptionalMoneyFields: DomainModel = {
  context: 'Opt2', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'A', fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'optA', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] },
    { name: 'optTotal', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] },
    { name: 'reqB', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    { name: 'reqC', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    { name: 'reqTotal', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'Line' } } }],
    entities: [{ kind: 'entity', name: 'Line', fields: [
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] }] }] }],
  events: [], services: []
};

describe('conservation/sumOverCollection absence-undecided', () => {
  it.each([
    ['conservation part', { kind: 'conservation', aggregate: 'A', parts: [['optA'], ['reqB']], total: ['reqTotal'] }],
    ['conservation total', { kind: 'conservation', aggregate: 'A', parts: [['reqB'], ['reqC']], total: ['optTotal'] }],
    ['sumOverCollection total', { kind: 'sumOverCollection', aggregate: 'A', collection: 'lines', child: 'Line', field: 'amount', op: 'eq', total: ['optTotal'] }],
  ])('%s over an optional path is absence-undecided', (_label, candidate) => {
    const diags = validateCandidate(candidate as any, modelWithOptionalMoneyFields);
    expect(diags.some(d => d.code === 'absence-undecided')).toBe(true);
  });
});
