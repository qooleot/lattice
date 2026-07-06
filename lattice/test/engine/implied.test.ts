import { describe, it, expect } from 'vitest';
import { impliedInvariants, isImplied, canonicalCandidate } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';

const m: DomainModel = {
  context: 'C', enums: [], events: [],
  entities: [{ kind: 'entity', name: 'Plan', fields: [
    { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'licenseFee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'adjustment', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
  aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
    { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'plan', type: { kind: 'ref', target: 'Plan' } },
    { name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
    machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
      { name: 'draft' }, { name: 'paid', tags: ['terminal'] }, { name: 'void', tags: ['terminal'] }] }],
      transitions: [] } }],
};

describe('impliedInvariants', () => {
  const derived = impliedInvariants(m);
  const names = derived.map(d => d.name).sort();

  it('derives terminal, refsResolve, nonNegative with deterministic names', () => {
    expect(names).toEqual(['nonNegativeInvoiceTotalDue', 'nonNegativePlanLicenseFee',
      'refsResolveInvoice', 'terminalInvoiceSettlementPaid', 'terminalInvoiceSettlementVoid'].sort());
  });

  it('suppresses nonNegative for @signed Money fields', () => {
    expect(names).not.toContain('nonNegativePlanAdjustment');
  });

  it('candidates carry the exact closed-grammar shapes', () => {
    const t = derived.find(d => d.name === 'terminalInvoiceSettlementPaid')!;
    expect(t.candidate).toEqual({ kind: 'terminal', aggregate: 'Invoice', region: 'settlement', state: 'paid' });
    const n = derived.find(d => d.name === 'nonNegativeInvoiceTotalDue')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'int', value: 0 } } });
    expect(t.id).toBe('implied-terminalInvoiceSettlementPaid');
  });

  it('isImplied matches by candidate shape, ignoring metadata', () => {
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Invoice' }, m)).toBe(true);
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Plan' }, m)).toBe(false);
  });

  it('derives refsResolve for an entity with a ref field (owners are entities ∪ aggregates)', () => {
    const m2: DomainModel = { ...m, entities: [...m.entities,
      { kind: 'entity', name: 'Order', fields: [
        { name: 'orderId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'plan', type: { kind: 'ref', target: 'Plan' } }] }] };
    const d = impliedInvariants(m2).find(x => x.name === 'refsResolveOrder')!;
    expect(d.candidate).toEqual({ kind: 'refsResolve', aggregate: 'Order' });
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Order' }, m2)).toBe(true);
  });

  it('derives a terminal rule per tagged state across multiple regions', () => {
    const m2: DomainModel = JSON.parse(JSON.stringify(m));
    m2.aggregates[0]!.machine!.regions.push({ name: 'dunning', initial: 'idle',
      states: [{ name: 'idle' }, { name: 'closed', tags: ['terminal'] }] });
    const names2 = impliedInvariants(m2).map(d => d.name);
    expect(names2).toEqual(expect.arrayContaining(
      ['terminalInvoiceSettlementPaid', 'terminalInvoiceSettlementVoid', 'terminalInvoiceDunningClosed']));
    const t = impliedInvariants(m2).find(d => d.name === 'terminalInvoiceDunningClosed')!;
    expect(t.candidate).toEqual({ kind: 'terminal', aggregate: 'Invoice', region: 'dunning', state: 'closed' });
  });

  it('isImplied distinguishes different cmp bodies on the same aggregate (deep canonicalization)', () => {
    expect(isImplied({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: 1 } } } }, m)).toBe(false);
    expect(isImplied({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'int', value: 0 } } }, m)).toBe(true);
  });

  it('canonicalCandidate is key-order-insensitive (raw JSON compare was not)', () => {
    const ordered: any = { kind: 'statePredicate', aggregate: 'Box',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } } };
    const jumbled: any = { body: { right: { value: 0, kind: 'int' }, left: { path: ['amount'], owner: 'self', kind: 'field' }, op: 'ge', kind: 'cmp' },
      aggregate: 'Box', kind: 'statePredicate' };
    expect(JSON.stringify(ordered)).not.toBe(JSON.stringify(jumbled));
    expect(canonicalCandidate(ordered)).toBe(canonicalCandidate(jumbled));
  });
});
