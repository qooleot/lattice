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

  it('rejects a value field marked const (value-no-const)', () => {
    const withConst: ValueDef = { kind: 'value', name: 'Period',
      fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Date' }, const: true },
        { name: 'end', type: { kind: 'prim', prim: 'Date' } }] };
    expect(validateModel(model([withConst])).map(d => d.code)).toContain('value-no-const');
  });

  it('tolerates const on an entity key field without any diagnostic (redundant but harmless)', () => {
    const m: DomainModel = {
      context: 'C', enums: [], events: [], values: [],
      entities: [{ kind: 'entity', name: 'Widget',
        fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true, const: true }] }],
      aggregates: [], services: [],
    };
    expect(validateModel(m)).toEqual([]);
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

describe('values nest (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount',
    fields: [{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }] };
  const taxed: ValueDef = { kind: 'value', name: 'TaxedAmount', fields: [
    { name: 'net', type: { kind: 'value', value: 'Amount' } },
    { name: 'tax', type: { kind: 'value', value: 'Amount' } }] };

  it('accepts a value-typed sub-field', () => {
    expect(validateModel(model([amount, taxed]))).toEqual([]);
  });

  it('still rejects a ref sub-field (value-flat)', () => {
    const bad: ValueDef = { kind: 'value', name: 'Bad',
      fields: [{ name: 'r', type: { kind: 'ref', target: 'Amount' } }] };
    expect(validateModel(model([amount, bad])).map(d => d.code)).toContain('value-flat');
  });

  it('still rejects a List sub-field (value-flat)', () => {
    const bad: ValueDef = { kind: 'value', name: 'Bad',
      fields: [{ name: 'l', type: { kind: 'list', of: { kind: 'prim', prim: 'Money' } } }] };
    expect(validateModel(model([amount, bad])).map(d => d.code)).toContain('value-flat');
  });

  it('reports unresolved-value for an undeclared nested value', () => {
    const bad: ValueDef = { kind: 'value', name: 'Bad',
      fields: [{ name: 'n', type: { kind: 'value', value: 'Nope' } }] };
    expect(validateModel(model([bad])).map(d => d.code)).toContain('unresolved-value');
  });
});

describe('value-type cycles (value-cycle)', () => {
  it('rejects a two-value cycle, naming both values in the path', () => {
    const a: ValueDef = { kind: 'value', name: 'A', fields: [{ name: 'b', type: { kind: 'value', value: 'B' } }] };
    const b: ValueDef = { kind: 'value', name: 'B', fields: [{ name: 'a', type: { kind: 'value', value: 'A' } }] };
    const diags = validateModel(model([a, b]));
    const cyc = diags.filter(d => d.code === 'value-cycle');
    expect(cyc.length).toBe(1);
    expect(cyc[0]!.message).toContain('A');
    expect(cyc[0]!.message).toContain('B');
    expect(cyc[0]!.message).toContain('A -> B -> A');
  });

  it('rejects a self-cycle (value A { a : A })', () => {
    const a: ValueDef = { kind: 'value', name: 'A', fields: [{ name: 'a', type: { kind: 'value', value: 'A' } }] };
    const diags = validateModel(model([a]));
    const cyc = diags.filter(d => d.code === 'value-cycle');
    expect(cyc.length).toBe(1);
    expect(cyc[0]!.message).toContain('A -> A');
  });

  it('rejects a three-value chain cycle (A -> B -> C -> A) exactly ONCE', () => {
    const a: ValueDef = { kind: 'value', name: 'A', fields: [{ name: 'b', type: { kind: 'value', value: 'B' } }] };
    const b: ValueDef = { kind: 'value', name: 'B', fields: [{ name: 'c', type: { kind: 'value', value: 'C' } }] };
    const c: ValueDef = { kind: 'value', name: 'C', fields: [{ name: 'a', type: { kind: 'value', value: 'A' } }] };
    const diags = validateModel(model([a, b, c]));
    const cyc = diags.filter(d => d.code === 'value-cycle');
    expect(cyc.length).toBe(1);
    expect(cyc[0]!.message).toContain('A -> B -> C -> A');
  });

  it('does NOT reject a legal nested (DAG) value — Outer { inner : Amount }, Amount { amount : Money }', () => {
    const amount: ValueDef = { kind: 'value', name: 'Amount',
      fields: [{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }] };
    const outer: ValueDef = { kind: 'value', name: 'Outer',
      fields: [{ name: 'inner', type: { kind: 'value', value: 'Amount' } }] };
    expect(validateModel(model([amount, outer])).map(d => d.code)).not.toContain('value-cycle');
  });

  it('does NOT reject a diamond — Outer { l : Amount, r : Amount } — visiting Amount twice on different branches is not a cycle', () => {
    const amount: ValueDef = { kind: 'value', name: 'Amount',
      fields: [{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }] };
    const outer: ValueDef = { kind: 'value', name: 'Outer',
      fields: [
        { name: 'l', type: { kind: 'value', value: 'Amount' } },
        { name: 'r', type: { kind: 'value', value: 'Amount' } }] };
    expect(validateModel(model([amount, outer])).map(d => d.code)).not.toContain('value-cycle');
  });
});
