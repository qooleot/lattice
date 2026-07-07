import { describe, it, expect } from 'vitest';
import { validateWorkspace } from '../../src/ast/workspace.js';
import type { ContextMapModel } from '../../src/ast/contextmap.js';
import type { DomainModel } from '../../src/ast/domain.js';

const catalog: DomainModel = { context: 'Catalog', enums: [], events: [], aggregates: [],
  entities: [{ kind: 'entity', name: 'Plan',
    fields: [{ name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true }] }] };
const subs: DomainModel = { context: 'Subscriptions', enums: [], events: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Subscription', fields: [
    { name: 'subId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'plan', type: { kind: 'ref', target: 'Catalog.Plan' } }] }] };
const map: ContextMapModel = { name: 'Acme',
  contexts: [{ name: 'Subscriptions', path: 'subscriptions' }, { name: 'Catalog', path: 'catalog' }],
  relationships: [{ kind: 'upstreamDownstream', left: 'Catalog', right: 'Subscriptions', exposes: ['Plan'] }] };
const members = [{ name: 'Catalog', model: catalog }, { name: 'Subscriptions', model: subs }];
const clone = <T,>(x: T): T => structuredClone(x);

describe('validateWorkspace', () => {
  it('accepts a covered workspace', () => expect(validateWorkspace(map, members)).toEqual([]));
  it('flags an exposes entry the upstream does not declare', () => {
    const m = clone(map); m.relationships[0]!.exposes = ['Plan', 'Ghost'];
    expect(validateWorkspace(m, members).some(d => d.code === 'unknown-exposed-type')).toBe(true);
  });
  it('flags an uncovered qualified ref (no relationship)', () => {
    const m = clone(map); m.relationships = [];
    expect(validateWorkspace(m, members).some(d => d.code === 'uncovered-cross-context-ref')).toBe(true);
  });
  it('flags an uncovered qualified ref (relationship does not expose the type)', () => {
    const m = clone(map); m.relationships[0]!.exposes = [];
    expect(validateWorkspace(m, members).some(d => d.code === 'uncovered-cross-context-ref')).toBe(true);
  });
  it('flags an uncovered qualified ref (wrong direction: member is the upstream)', () => {
    const m = clone(map);
    m.relationships[0] = { kind: 'upstreamDownstream', left: 'Subscriptions', right: 'Catalog', exposes: ['Plan'] };
    expect(validateWorkspace(m, members).some(d => d.code === 'uncovered-cross-context-ref')).toBe(true);
  });
  it('flags a qualified ref whose target context is absent from the map', () => {
    const ms = clone(members);
    (ms[1]!.model.aggregates[0]!.fields[1]!.type as any).target = 'Ghost.Plan';
    expect(validateWorkspace(map, ms).some(d => d.code === 'uncovered-cross-context-ref')).toBe(true);
  });
  it('accepts coverage via a sharedKernel in either direction', () => {
    const m = clone(map);
    m.relationships[0] = { kind: 'sharedKernel', left: 'Subscriptions', right: 'Catalog', exposes: ['Plan'] };
    expect(validateWorkspace(m, members)).toEqual([]);
  });
  it('flags a member whose model.context mismatches its declared name', () => {
    const ms = clone(members); ms[0]!.model.context = 'Katalog';
    expect(validateWorkspace(map, ms).some(d => d.code === 'context-name-mismatch')).toBe(true);
  });
  it('flags an uncovered qualified ref carried only on an event field', () => {
    const ms = clone(members);
    // Move the qualified ref off the aggregate field and onto an event field instead,
    // so the aggregate no longer carries any qualified ref itself.
    ms[1]!.model.aggregates[0]!.fields[1] = { name: 'planId', type: { kind: 'prim', prim: 'Id' } };
    ms[1]!.model.events = [{ name: 'PlanChanged', fields: [
      { name: 'plan', type: { kind: 'ref', target: 'Catalog.Plan' } }] }];
    const m = clone(map); m.relationships = [];
    expect(validateWorkspace(m, ms).some(d => d.code === 'uncovered-cross-context-ref')).toBe(true);
  });
  it('accepts a covered qualified ref carried only on an event field', () => {
    const ms = clone(members);
    ms[1]!.model.aggregates[0]!.fields[1] = { name: 'planId', type: { kind: 'prim', prim: 'Id' } };
    ms[1]!.model.events = [{ name: 'PlanChanged', fields: [
      { name: 'plan', type: { kind: 'ref', target: 'Catalog.Plan' } }] }];
    expect(validateWorkspace(map, ms)).toEqual([]);
  });
});
