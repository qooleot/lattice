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
});

const invoiceModel = (lineFields: any[]): DomainModel => ({
  context: 'Opt', ticksPerDay: 24, enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
    { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'total', type: { kind: 'prim', prim: 'Money' } },
    { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'InvoiceLine' } } }],
    entities: [{ kind: 'entity', name: 'InvoiceLine', fields: lineFields }] }],
});
const sumCandidate = (m: DomainModel): Candidate => ({
  kind: 'sumOverCollection', aggregate: 'Invoice', collection: 'lines', child: 'InvoiceLine',
  field: 'amount', op: 'eq', total: ['total']
});

describe('absence-undecided — sumOverCollection child field', () => {
  it('rejects an optional child field summed across the collection', () => {
    const m2 = invoiceModel([
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' }, optional: true }]);
    expect(validateCandidate(sumCandidate(m2), m2).map(d => d.code)).toContain('absence-undecided');
  });

  it('does not fire for a required child field', () => {
    const m2 = invoiceModel([
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }]);
    expect(validateCandidate(sumCandidate(m2), m2).map(d => d.code)).not.toContain('absence-undecided');
  });
});
