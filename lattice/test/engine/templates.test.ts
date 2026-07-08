import { describe, it, expect } from 'vitest';
import { matchTemplates } from '../../src/engine/templates.js';
import type { DomainModel } from '../../src/ast/domain.js';

const revrecMini: DomainModel = {
  context: 'RevRec', ticksPerDay: 24,
  enums: [{ name: 'EntryKind', values: ['Recognition', 'Correction'] }], values: [],
  entities: [
    { kind: 'entity', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'monotonic'] },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] },
    { kind: 'entity', name: 'RevenueEntry', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'obligation', type: { kind: 'ref', target: 'Obligation' } },
      { name: 'kind', type: { kind: 'enum', enum: 'EntryKind' } }] }
  ],
  aggregates: [{ kind: 'aggregate', name: 'AccountingPeriod', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'Lifecycle', initial: 'Open', states: [{ name: 'Open', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }], transitions: [] } }],
  events: []
};

describe('matchTemplates', () => {
  const { adopt, seeds } = matchTemplates(revrecMini);
  const kinds = adopt.map(a => a.candidate.kind);

  it('#1 conservation from @balance/@total tags', () =>
    expect(adopt.some(a => a.candidate.kind === 'conservation' && a.candidate.aggregate === 'Obligation')).toBe(true));
  it('#2 non-negative for every Money field', () =>
    expect(adopt.filter(a => a.name.startsWith('NonNegative')).length).toBe(3));
  it('#3 terminal for @terminal states', () =>
    expect(adopt.some(a => a.candidate.kind === 'terminal' && (a.candidate as any).state === 'Closed')).toBe(true));
  it('#7 cardinality single-active when the tagged aggregate has no refs', () =>
    expect(adopt.some(a => a.candidate.kind === 'cardinality' && a.candidate.aggregate === 'AccountingPeriod' && (a.candidate as any).atMost === 1)).toBe(true));
  it('#8 monotonic from @monotonic tag', () =>
    expect(adopt.some(a => a.candidate.kind === 'monotonic')).toBe(true));
  it('#9 refsResolve for owners with refs', () =>
    expect(adopt.some(a => a.candidate.kind === 'refsResolve' && a.candidate.aggregate === 'RevenueEntry')).toBe(true));
  it('all adopted have template source + deterministic ids', () => {
    expect(adopt.every(a => a.source === 'template')).toBe(true);
    expect(new Set(adopt.map(a => a.id)).size).toBe(adopt.length);
  });
  it('#7-unique seeds fire for @active aggregates WITH refs (trace A model)', async () => {
    const { traceAModel } = await import('../fixtures.js');
    const r = matchTemplates(traceAModel);
    expect(r.seeds.some(s => s.candidate.kind === 'unique')).toBe(true);
  });
});

describe('matchTemplates — qualified-ref exclusion (spec §4.2)', () => {
  // Local fixture (tests don't import across test files): an Order aggregate whose only ref
  // field is a qualified cross-context ref.
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

  it('adopts no tpl-9 (refsResolve) invariant when the only ref field is qualified', () => {
    const m = base('Catalog.Plan');
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'refsResolve')).toBe(false);
  });
});
