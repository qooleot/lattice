import { describe, it, expect } from 'vitest';
import { diffModels, ledgerReferences } from '../../src/parse/diff.js';
import type { DomainModel, MethodDef } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const mk = (name: string, field: string): DomainModel => ({
  context: 'C', enums: [], values: [], events: [], entities: [], services: [],
  aggregates: [{ kind: 'aggregate', name, fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: field, type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'r', initial: 's1', states: [{ name: 's1' }, { name: 's2', tags: ['terminal'] }] }], transitions: [] } }],
});
const inv = (name: string, field: string): CandidateInvariant => ({
  id: `hand-${name}`, name, prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Job',
    body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [field] }, right: { kind: 'int', value: 0 } } } });

const ledger: LedgerEntry[] = [
  { kind: 'verdict', at: '2026-07-05T00:00:00Z', witnessId: 'w1', judge: 'permit', question: '',
    witness: { entities: [{ type: 'Job', id: 'j1', fields: { units: 3, 'r.state': 's1' } }] }, salient: [] },
  { kind: 'adopted', at: '2026-07-05T00:00:00Z', invariant: inv('unitsSane', 'units'), provenance: 'elicited (w1)' },
];

describe('ledgerReferences', () => {
  const stored = mk('Job', 'units');
  it('finds field references in witnesses', () => {
    expect(ledgerReferences({ scope: 'field', path: 'Job.units', from: 'units', to: 'n' }, ledger, stored)).toEqual(['w1']);
    expect(ledgerReferences({ scope: 'field', path: 'Job.other', from: 'other', to: 'n' }, ledger, stored)).toEqual([]);
  });
  it('finds state and type and invariant references', () => {
    expect(ledgerReferences({ scope: 'state', path: 'Job.r.s1', from: 's1', to: 'x' }, ledger, stored)).toEqual(['w1']);
    expect(ledgerReferences({ scope: 'aggregate', path: 'Job', from: 'Job', to: 'Task' }, ledger, stored)).toEqual(['w1']);
    expect(ledgerReferences({ scope: 'invariant', path: 'unitsSane', from: 'unitsSane', to: 'x' }, ledger, stored))
      .toEqual(['adopted:unitsSane']);
    expect(ledgerReferences({ scope: 'transition', path: 'Job.t', from: 't', to: 'x' }, ledger, stored)).toEqual([]);
  });

  it('finds enum values referenced only inside adopted candidate BODIES (design §5 step 4)', () => {
    const model: DomainModel = {
      context: 'C', enums: [{ name: 'Mode', values: ['fast', 'slow'] }], values: [], events: [], entities: [], services: [],
      aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'speed', type: { kind: 'enum', enum: 'Mode' } }] }],
    };
    const bodyRef: CandidateInvariant = { id: 'hand-fastOnly', name: 'fastOnly', prior: 1, source: 'template',
      candidate: { kind: 'statePredicate', aggregate: 'Job',
        body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['speed'] },
          right: { kind: 'enumval', enum: 'Mode', value: 'fast' } } } };
    const led: LedgerEntry[] = [{ kind: 'adopted', at: 't', invariant: bodyRef, provenance: 'elicited (w1)' }];
    expect(ledgerReferences({ scope: 'enumValue', path: 'Mode.fast', from: 'fast', to: 'quick' }, led, model))
      .toEqual(['adopted:fastOnly']);
    expect(ledgerReferences({ scope: 'enum', path: 'Mode', from: 'Mode', to: 'Speed' }, led, model))
      .toEqual(['adopted:fastOnly']);
    expect(ledgerReferences({ scope: 'enumValue', path: 'Mode.slow', from: 'slow', to: 'slower' }, led, model))
      .toEqual([]);
  });

  it('finds names embedded in adopted provenance text', () => {
    const led: LedgerEntry[] = [
      { kind: 'adopted', at: 't', invariant: inv('unitsSane', 'units'), provenance: 'template tpl-nonneg-Job-units' }];
    expect(ledgerReferences({ scope: 'field', path: 'Job.units', from: 'units', to: 'n' }, led, stored))
      .toEqual(['adopted:unitsSane']);
    expect(ledgerReferences({ scope: 'field', path: 'Job.other', from: 'other', to: 'n' }, led, stored))
      .toEqual([]);
  });

  it('enumValue references require an enum-typed field of that enum', () => {
    const model: DomainModel = {
      context: 'C', enums: [{ name: 'Mode', values: ['fast', 'slow'] }], values: [], events: [], entities: [], services: [],
      aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'speed', type: { kind: 'enum', enum: 'Mode' } },
        { name: 'label', type: { kind: 'prim', prim: 'Text' } }] }],
    };
    const led: LedgerEntry[] = [{ kind: 'verdict', at: 't', witnessId: 'w9', judge: 'permit', question: '',
      witness: { entities: [{ type: 'Job', id: 'j', fields: { speed: 'fast', label: 'slow' } }] }, salient: [] }];
    expect(ledgerReferences({ scope: 'enumValue', path: 'Mode.fast', from: 'fast', to: 'quick' }, led, model)).toEqual(['w9']);
    // 'slow' appears only as a Text field's VALUE — must not count
    expect(ledgerReferences({ scope: 'enumValue', path: 'Mode.slow', from: 'slow', to: 'slower' }, led, model)).toEqual([]);
  });
});

describe('diffModels', () => {
  const before = { model: mk('Job', 'units'), canonical: [inv('unitsSane', 'units')] };

  it('detects ledger-referenced field rename as a proposal, not delete+add', () => {
    const d = diffModels(before, { model: mk('Job', 'usedUnits'), canonical: [inv('unitsSane', 'usedUnits')] }, ledger, before.model);
    expect(d.renameProposals).toEqual([{ scope: 'field', path: 'Job.units', from: 'units', to: 'usedUnits' }]);
    // the invariant body changed only via the renamed path — after rename confirmation reconcile
    // re-diffs; at this layer it still reports the body change:
    expect(d.changedInvariants.map(c => c.name)).toEqual(['unitsSane']);
  });

  it('unreferenced delete+add stays structural', () => {
    const quiet: LedgerEntry[] = [];
    const d = diffModels(before, { model: mk('Job', 'usedUnits'), canonical: [inv('unitsSane', 'usedUnits')] }, quiet, before.model);
    expect(d.renameProposals).toEqual([]);
    expect(d.structuralNotes.join(' ')).toContain('usedUnits');
  });

  it('pairs region renames with an Owner.region path', () => {
    const after: DomainModel = JSON.parse(JSON.stringify(mk('Job', 'units')));
    after.aggregates[0]!.machine!.regions[0]!.name = 'phase';
    const d = diffModels({ model: mk('Job', 'units'), canonical: [] }, { model: after, canonical: [] }, ledger, mk('Job', 'units'));
    expect(d.renameProposals).toEqual([{ scope: 'region', path: 'Job.r', from: 'r', to: 'phase' }]);
  });

  it('pairs state renames with an Owner.region.state path (last segment = from)', () => {
    const after: DomainModel = JSON.parse(JSON.stringify(mk('Job', 'units')));
    after.aggregates[0]!.machine!.regions[0]!.states[0]!.name = 'begun';
    after.aggregates[0]!.machine!.regions[0]!.initial = 'begun';
    const d = diffModels({ model: mk('Job', 'units'), canonical: [] }, { model: after, canonical: [] }, ledger, mk('Job', 'units'));
    expect(d.renameProposals).toEqual([{ scope: 'state', path: 'Job.r.s1', from: 's1', to: 'begun' }]);
  });

  it('pairs enum renames (single-segment path) backed by an adopted-body reference', () => {
    const withEnum = (enumName: string): DomainModel => ({
      context: 'C', enums: [{ name: enumName, values: ['fast', 'slow'] }], values: [], events: [], entities: [], services: [],
      aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'speed', type: { kind: 'enum', enum: enumName } }] }],
    });
    const bodyRef: CandidateInvariant = { id: 'hand-fastOnly', name: 'fastOnly', prior: 1, source: 'template',
      candidate: { kind: 'statePredicate', aggregate: 'Job',
        body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['speed'] },
          right: { kind: 'enumval', enum: 'Mode', value: 'fast' } } } };
    const led: LedgerEntry[] = [{ kind: 'adopted', at: 't', invariant: bodyRef, provenance: 'elicited (w1)' }];
    const d = diffModels({ model: withEnum('Mode'), canonical: [] }, { model: withEnum('Speed'), canonical: [] },
      led, withEnum('Mode'));
    expect(d.renameProposals).toEqual([{ scope: 'enum', path: 'Mode', from: 'Mode', to: 'Speed' }]);
  });

  it('detects invariant rename by identical candidate', () => {
    const d = diffModels(before, { model: before.model, canonical: [inv('unitsStaySane', 'units')] }, ledger, before.model);
    expect(d.renameProposals).toEqual([{ scope: 'invariant', path: 'unitsSane', from: 'unitsSane', to: 'unitsStaySane' }]);
    expect(d.addedInvariants).toEqual([]);
    expect(d.removedInvariants).toEqual([]);
  });

  it('reports added/changed/removed invariants by name', () => {
    const extra = inv('another', 'units');
    const changed = { ...inv('unitsSane', 'units'), candidate: { kind: 'refsResolve' as const, aggregate: 'Job' } };
    const d = diffModels(before, { model: before.model, canonical: [changed, extra] }, [], before.model);
    expect(d.addedInvariants.map(i => i.name)).toEqual(['another']);
    expect(d.changedInvariants.map(c => c.name)).toEqual(['unitsSane']);
  });

  it('doc-only change is not a changedInvariant', () => {
    const docd = { ...inv('unitsSane', 'units'), doc: 'now documented' };
    const d = diffModels(before, { model: before.model, canonical: [docd] }, [], before.model);
    expect(d.changedInvariants).toEqual([]);
    expect(d.addedInvariants).toEqual([]);
  });

  it('invariant equality is key-order-insensitive (rename pairing + change detection)', () => {
    const jumbled = JSON.parse(JSON.stringify(inv('unitsSane', 'units')));
    jumbled.candidate = { body: { right: { value: 0, kind: 'int' }, left: { path: ['units'], owner: 'self', kind: 'field' }, op: 'ge', kind: 'cmp' }, aggregate: 'Job', kind: 'statePredicate' };
    const d = diffModels({ model: mk('Job', 'units'), canonical: [jumbled] },
      { model: mk('Job', 'units'), canonical: [inv('unitsSane', 'units')] }, [], mk('Job', 'units'));
    expect(d.changedInvariants).toEqual([]);   // same semantics, different key order — not a change
    expect(d.addedInvariants).toEqual([]);
    expect(d.removedInvariants).toEqual([]);
  });

  // Task 12: services (design §3.6) — structural notes only, no rename proposals (services don't
  // join namedThings; no ledger references exist for methods/params in v1).
  describe('services — structural notes, no rename proposals', () => {
    const svcMethod: MethodDef = { name: 'settle', params: [], kind: { performs: { aggregate: 'Job', transition: 'go' } } };
    const withSvc = (methods: MethodDef[]): DomainModel => ({ ...before.model,
      aggregates: [{ ...before.model.aggregates[0]!, machine: { regions: [{ name: 'r', initial: 's1', states: [{ name: 's1' }, { name: 's2', tags: ['terminal' as const] }] }], transitions: [{ name: 'go', region: 'r', from: ['s1'], to: 's2' }] } }],
      services: [{ name: 'JobOps', methods: [...methods] }] });

    it('reports an added service', () => {
      const d = diffModels({ model: before.model, canonical: [] }, { model: withSvc([svcMethod]), canonical: [] }, [], before.model);
      expect(d.structuralNotes).toContain('added service JobOps');
      expect(d.renameProposals).toEqual([]);
    });

    it('reports a removed service', () => {
      const d = diffModels({ model: withSvc([svcMethod]), canonical: [] }, { model: before.model, canonical: [] }, [], before.model);
      expect(d.structuralNotes).toContain('removed service JobOps');
    });

    it('reports added/removed/changed methods on a surviving service', () => {
      const another: MethodDef = { name: 'peek', params: [], kind: { readOnly: true } };
      const changed: MethodDef = { ...svcMethod, kind: { performs: { aggregate: 'Job', transition: 'go' } }, doc: 'now documented' };
      const d = diffModels({ model: withSvc([svcMethod, another]), canonical: [] },
        { model: withSvc([changed]), canonical: [] }, [], before.model);
      expect(d.structuralNotes).toContain('removed method JobOps.peek');
      expect(d.structuralNotes).toContain('changed method JobOps.settle');
      expect(d.renameProposals).toEqual([]);
    });
  });
});
