import { describe, it, expect } from 'vitest';
import { impliedInvariants, isImplied, canonicalCandidate, valueLawInstances } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';
import { periodModel } from '../fixtures.js';
import { astToCode } from '../../src/emit/code.js';

const m: DomainModel = {
  context: 'C', enums: [], values: [], events: [],
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

// Local fixture (tests don't import across test files): an Order aggregate whose only ref
// field is a qualified cross-context ref to `target` (e.g. 'Catalog.Plan', spec §4.2).
const base = (target: string): DomainModel => ({
  context: 'Billing', ticksPerDay: 24,
  enums: [], values: [],
  entities: [],
  aggregates: [{
    kind: 'aggregate', name: 'Order',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'plan', type: { kind: 'ref', target } }
    ]
  }],
  events: []
});

// Task 11: type-carried laws (design §3.5/§6) — a value type's own invariant is instantiated as a
// statePredicate candidate on every OWNER field of that value type, with every path prefixed
// [fieldName, ...]. periodModel: Subscription.period: Period, Period.wellOrdered { start < end }.
describe('impliedInvariants — type-carried value laws', () => {
  it('instantiates a value invariant as a prefixed statePredicate candidate per use site', () => {
    const laws = impliedInvariants(periodModel).filter(i => i.id.includes('val'));
    expect(laws.length).toBe(1);
    expect(laws[0]!.candidate).toMatchObject({ kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt', left: { kind: 'field', path: ['period', 'start'] }, right: { kind: 'field', path: ['period', 'end'] } } });
  });

  it('valueLawInstances is the shared source of truth (implied + templates derive from it)', () => {
    const instances = valueLawInstances(periodModel);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.owner.name).toBe('Subscription');
    expect(instances[0]!.field).toBe('period');
    expect(instances[0]!.value.name).toBe('Period');
    expect(instances[0]!.inv.name).toBe('wellOrdered');
  });

  it('isImplied matches the per-site instantiated law by shape', () => {
    const c = impliedInvariants(periodModel).find(i => i.id.includes('val'))!.candidate;
    expect(isImplied(c, periodModel)).toBe(true);
  });

  it('a value law never prints per-site (as a Subscription invariant), even when explicitly adopted — only the value block\'s own declaration prints', () => {
    const law = impliedInvariants(periodModel).find(i => i.id.includes('val'))!;
    const code = astToCode(periodModel, [law]);
    // The value block's own `invariant wellOrdered { start < end }` declaration is expected —
    // what must NOT appear is a second, per-site printed copy on the Subscription aggregate
    // (which would read `period.start < period.end`, the prefixed candidate body).
    expect(code).not.toContain('period.start < period.end');
    const subscriptionBlock = code.slice(code.indexOf('aggregate Subscription'));
    expect(subscriptionBlock).not.toContain('invariant');
  });
});

describe('impliedInvariants — qualified-ref exclusion (spec §4.2)', () => {
  it('impliedInvariants skips refs-resolve when the only ref is qualified', () => {
    const m = base('Catalog.Plan');
    expect(impliedInvariants(m).some(i => i.candidate.kind === 'refsResolve')).toBe(false);
  });

  it('impliedInvariants still derives refs-resolve for a local ref', () => {
    const m = base('Catalog.Plan');
    m.entities.push({ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'who', type: { kind: 'ref', target: 'Customer' } });
    expect(impliedInvariants(m).some(i => i.candidate.kind === 'refsResolve')).toBe(true);
  });
});
