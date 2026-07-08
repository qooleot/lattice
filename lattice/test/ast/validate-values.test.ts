import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel, ValueDef } from '../../src/ast/domain.js';
import type { Cmp, Predicate } from '../../src/ast/invariant.js';

const cmp = (l: string[], op: Cmp, r: string[]): Predicate =>
  ({ kind: 'cmp', op, left: { kind: 'field', owner: 'self', path: l }, right: { kind: 'field', owner: 'self', path: r } });

const period: ValueDef = {
  kind: 'value', name: 'Period',
  fields: [
    { name: 'start', type: { kind: 'prim', prim: 'Date' } },
    { name: 'end', type: { kind: 'prim', prim: 'Date' } }],
  invariants: [{ name: 'wellOrdered', body: cmp(['start'], 'lt', ['end']) }],
};

const model = (values: ValueDef[]): DomainModel => ({
  context: 'C', enums: [], entities: [], events: [], aggregates: [], values, services: [],
});

describe('value objects', () => {
  it('accepts a flat value type with an own-field invariant', () => {
    expect(validateModel(model([period]))).toEqual([]);
  });

  it('rejects a value field marked key (value-no-key)', () => {
    const withKey: ValueDef = { kind: 'value', name: 'Period',
      fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Date' }, key: true },
        { name: 'end', type: { kind: 'prim', prim: 'Date' } }] };
    expect(validateModel(model([withKey])).map(d => d.code)).toContain('value-no-key');
  });

  it('rejects a ref-typed field inside a value (value-flat)', () => {
    const withRef: ValueDef = { kind: 'value', name: 'Period',
      fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Date' } },
        { name: 'owner', type: { kind: 'ref', target: 'Something' } }] };
    expect(validateModel(model([withRef])).map(d => d.code)).toContain('value-flat');
  });

  it('rejects a list-typed field inside a value (value-flat)', () => {
    const withList: ValueDef = { kind: 'value', name: 'Period',
      fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Date' } },
        { name: 'tags', type: { kind: 'list', of: { kind: 'prim', prim: 'Text' } } }] };
    expect(validateModel(model([withList])).map(d => d.code)).toContain('value-flat');
  });

  it('rejects a value invariant referencing an unknown field', () => {
    const bad: ValueDef = { ...period,
      invariants: [{ name: 'wellOrdered', body: cmp(['start'], 'lt', ['nope']) }] };
    expect(validateModel(model([bad])).map(d => d.code)).toContain('unknown-path');
  });

  it('rejects a value invariant path that leaves the value\'s own fields (value-cross-field)', () => {
    const bad: ValueDef = { ...period,
      invariants: [{ name: 'wellOrdered', body: cmp(['start', 'nested'], 'lt', ['end']) }] };
    expect(validateModel(model([bad])).map(d => d.code)).toContain('value-cross-field');
  });

  it('joins the shared duplicate-name pool (a value sharing a name with an enum/entity/aggregate)', () => {
    const m: DomainModel = {
      context: 'C', enums: [], events: [], values: [period],
      entities: [{ kind: 'entity', name: 'Period', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
      aggregates: [], services: [],
    };
    expect(validateModel(m).map(d => d.code)).toContain('duplicate-name');
  });

  it('rejects an unresolved value type reference', () => {
    const m: DomainModel = {
      context: 'C', enums: [], entities: [], events: [], values: [],
      aggregates: [{ kind: 'aggregate', name: 'Lease',
        fields: [
          { name: 'leaseId', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'term', type: { kind: 'value', value: 'Period' } }] }],
      services: [],
    };
    expect(validateModel(m).map(d => d.code)).toContain('unresolved-value');
  });

  it('accepts an aggregate field typed as a declared value', () => {
    const m: DomainModel = {
      context: 'C', enums: [], entities: [], events: [], values: [period],
      aggregates: [{ kind: 'aggregate', name: 'Lease',
        fields: [
          { name: 'leaseId', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'term', type: { kind: 'value', value: 'Period' } }] }],
      services: [],
    };
    expect(validateModel(m)).toEqual([]);
  });
});
