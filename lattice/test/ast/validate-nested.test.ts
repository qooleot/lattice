import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import { ownedCollectionChild } from '../../src/ast/domain.js';
import type { DomainModel, AggregateDef } from '../../src/ast/domain.js';

const inv = (childFields: any[], listOf = 'InvoiceLine'): DomainModel => ({
  context: 'C', enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{ kind: 'aggregate', name: 'Invoice',
    fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: listOf } } }],
    entities: [{ kind: 'entity', name: 'InvoiceLine', fields: childFields }] }],
});
const goodChild = [
  { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
  { name: 'amount', type: { kind: 'prim', prim: 'Money' } }];

describe('nested entities', () => {
  it('accepts a keyed, flat child and classifies the owned collection', () => {
    const m = inv(goodChild);
    expect(validateModel(m)).toEqual([]);
    const a = m.aggregates[0] as AggregateDef;
    expect(ownedCollectionChild(a, a.fields[1]!)?.name).toBe('InvoiceLine');
  });
  it('rejects unkeyed children', () => {
    expect(validateModel(inv([{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }]))
      .map(d => d.code)).toContain('missing-key');
  });
  it('rejects ref/list fields inside children (nested-entity-flat)', () => {
    expect(validateModel(inv([...goodChild, { name: 'bad', type: { kind: 'ref', target: 'Invoice' } }]))
      .map(d => d.code)).toContain('nested-entity-flat');
  });
  it('rejects a value-typed field inside a nested child (nested-entity-flat, design §5.2)', () => {
    const m = inv([...goodChild, { name: 'period', type: { kind: 'value', value: 'Period' } }]);
    m.values.push({ kind: 'value', name: 'Period', fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }] });
    expect(validateModel(m).map(d => d.code)).toContain('nested-entity-flat');
  });
  it('List of a non-nested target is not an owned collection', () => {
    const m = inv(goodChild, 'Invoice');
    const a = m.aggregates[0] as AggregateDef;
    expect(ownedCollectionChild(a, a.fields[1]!)).toBeNull();
  });
  it('rejects two owned-collection fields targeting the same child entity', () => {
    const m = inv(goodChild);
    const a = m.aggregates[0] as AggregateDef;
    a.fields.push({ name: 'archived', type: { kind: 'list', of: { kind: 'ref', target: 'InvoiceLine' } } });
    expect(validateModel(m).map(d => d.code)).toContain('duplicate-owned-collection-target');
  });
  it('accepts two owned-collection fields targeting different child entities', () => {
    const m = inv(goodChild);
    const a = m.aggregates[0] as AggregateDef;
    a.entities!.push({ kind: 'entity', name: 'Attachment', fields: [
      { name: 'attId', type: { kind: 'prim', prim: 'Id' }, key: true } ] });
    a.fields.push({ name: 'attachments', type: { kind: 'list', of: { kind: 'ref', target: 'Attachment' } } });
    expect(validateModel(m).map(d => d.code)).not.toContain('duplicate-owned-collection-target');
  });
});
