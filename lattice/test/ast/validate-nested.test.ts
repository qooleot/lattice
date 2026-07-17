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
  it('accepts a ref to a top-level entity inside a child', () => {
    // The ledger case: Posting is OWNED by its transaction and POINTS AT a chart-of-accounts entry.
    const m = inv([...goodChild, { name: 'account', type: { kind: 'ref', target: 'Account' } }]);
    m.entities.push({ kind: 'entity', name: 'Account',
      fields: [{ name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m)).toEqual([]);
  });

  it('accepts a value-typed field inside a child', () => {
    const m = inv([...goodChild, { name: 'period', type: { kind: 'value', value: 'Period' } }]);
    m.values.push({ kind: 'value', name: 'Period', fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }] });
    expect(validateModel(m)).toEqual([]);
  });

  it('still rejects a List field inside a child (nested-entity-flat)', () => {
    // Out of this slice: quint has no list encoding (fieldQType returns null), so two-level
    // collections need nested bounded maps + an OWNED_BOUND^2 blowup + a bitwidth revisit.
    const m = inv([...goodChild, { name: 'taxes', type: { kind: 'list', of: { kind: 'ref', target: 'Account' } } }]);
    m.entities.push({ kind: 'entity', name: 'Account',
      fields: [{ name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
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

  it('accepts the owned-collection declaration itself (List<ref Child> on the owning aggregate)', () => {
    // Guards the trap: an owned collection IS a ref to a child, and must stay legal.
    expect(validateModel(inv(goodChild)).map(d => d.code)).not.toContain('ref-target-nested-child');
  });

  it('rejects a top-level aggregate ref-ing a nested child (ref-target-nested-child)', () => {
    // Latent bug at 2db1539: this validated clean and emitted Quint drawing from an
    // undeclared INVOICELINE_IDS pool. Children are inlined records with no id pool.
    const m = inv(goodChild);
    m.aggregates.push({ kind: 'aggregate', name: 'Audit', fields: [
      { name: 'auditId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'line', type: { kind: 'ref', target: 'InvoiceLine' } }] });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('rejects a child ref-ing a sibling child (child->child)', () => {
    const m = inv([...goodChild, { name: 'att', type: { kind: 'ref', target: 'Attachment' } }]);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Attachment',
      fields: [{ name: 'attId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('rejects an aggregate ref-ing its OWN child outside a List', () => {
    const m = inv(goodChild);
    m.aggregates[0]!.fields.push({ name: 'first', type: { kind: 'ref', target: 'InvoiceLine' } });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('still accepts a ref to a top-level entity', () => {
    const m = inv(goodChild);
    m.entities.push({ kind: 'entity', name: 'Customer',
      fields: [{ name: 'cid', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'customer', type: { kind: 'ref', target: 'Customer' } });
    expect(validateModel(m).map(d => d.code)).not.toContain('ref-target-nested-child');
  });

  it('rejects List<List<ref Child>> — not an owned collection, must not get the exception', () => {
    // ownedCollectionChild requires of.kind === 'ref', so a doubly-nested list is not an owned
    // collection. It validated completely clean before this guard.
    const m = inv(goodChild);
    m.aggregates[0]!.fields.push({ name: 'nested',
      type: { kind: 'list', of: { kind: 'list', of: { kind: 'ref', target: 'InvoiceLine' } } } });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('rejects a child ref-ing a sibling child via a List, on its own (not via nested-entity-flat)', () => {
    const m = inv([...goodChild, { name: 'atts', type: { kind: 'list', of: { kind: 'ref', target: 'Attachment' } } }]);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Attachment',
      fields: [{ name: 'attId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('rejects a nested entity that no owned collection owns (unowned-nested-entity)', () => {
    // Unreachable in every encoding: quint gives a child no var and no record field (it exists only
    // inside its owner's collection map), and ref-target-nested-child forbids referencing it. It
    // validated clean with ZERO diagnostics before this rule.
    const m = inv(goodChild);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Orphan',
      fields: [{ name: 'oid', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('unowned-nested-entity');
  });

  it('names the orphan and its declaring aggregate', () => {
    const m = inv(goodChild);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Orphan',
      fields: [{ name: 'oid', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    const d = validateModel(m).find(x => x.code === 'unowned-nested-entity')!;
    expect(d.at).toBe('Invoice.Orphan');
    expect(d.message).toContain('Orphan');
    expect(d.message).toContain('Invoice');
  });

  it('does not fire on a properly owned child', () => {
    expect(validateModel(inv(goodChild)).map(d => d.code)).not.toContain('unowned-nested-entity');
  });
});
