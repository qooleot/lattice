import { describe, it, expect } from 'vitest';
import { resolveWitness, currentInvariantName, renameEntries, applyRenamesToModel,
  applyRenamesToInvariant, type RenameSpec } from '../../src/engine/renames.js';
import type { CaseState } from '../../src/engine/evaluate.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const model: DomainModel = {
  context: 'C', enums: [{ name: 'Mode', values: ['fast', 'slow'] }], values: [], events: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
    { name: 'jobId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'speed', type: { kind: 'enum', enum: 'Mode' } },
    { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'run', initial: 'queued',
      states: [{ name: 'queued' }, { name: 'done', tags: ['terminal'] }] }], transitions: [] } }],
};

const witness: CaseState = { entities: [
  { type: 'Task', id: 't1', fields: { 'exec.state': 'waiting', count: 3, kind: 'quick' } }] };

it('resolves chained field renames in order', () => {
  const renames: RenameSpec[] = [
    { scope: 'field', path: 'Job.count', from: 'count', to: 'n' },
    { scope: 'field', path: 'Job.n', from: 'n', to: 'units' },
    { scope: 'aggregate', path: 'Task', from: 'Task', to: 'Job' }];
  // aggregate rename applies to type; field renames key off the CURRENT aggregate name at each step —
  // apply aggregate rename first in this list order? No: sequential means Task→Job must precede if
  // field paths say Job. Order in the list is ledger order; this test pins sequential semantics.
  const r = resolveWitness(witness, [
    { scope: 'aggregate', path: 'Task', from: 'Task', to: 'Job' },
    { scope: 'field', path: 'Job.count', from: 'count', to: 'n' },
    { scope: 'field', path: 'Job.n', from: 'n', to: 'units' }], model);
  expect(r.entities[0]!.type).toBe('Job');
  expect(r.entities[0]!.fields['units']).toBe(3);
  expect(r.entities[0]!.fields['count']).toBeUndefined();
});

it('resolves region, state and enum-value renames', () => {
  const r = resolveWitness(witness, [
    { scope: 'aggregate', path: 'Task', from: 'Task', to: 'Job' },
    { scope: 'region', path: 'Job.exec', from: 'exec', to: 'run' },
    { scope: 'state', path: 'Job.run.waiting', from: 'waiting', to: 'queued' },
    { scope: 'field', path: 'Job.kind', from: 'kind', to: 'speed' },
    { scope: 'enumValue', path: 'Mode.quick', from: 'quick', to: 'fast' }], model);
  expect(r.entities[0]!.fields['run.state']).toBe('queued');
  expect(r.entities[0]!.fields['speed']).toBe('fast');   // enum rename uses model: speed is Mode-typed
});

it('does not mutate the input witness and renames trace snapshots too', () => {
  const w: CaseState = { entities: [{ type: 'Job', id: 'j', fields: { count: 1 } }],
    trace: [[{ type: 'Job', id: 'j', fields: { count: 0 } }]] };
  const r = resolveWitness(w, [{ scope: 'field', path: 'Job.count', from: 'count', to: 'units' }], model);
  expect(w.entities[0]!.fields['count']).toBe(1);
  expect(r.trace![0]![0]!.fields['units']).toBe(0);
});

it('currentInvariantName follows the chain', () => {
  expect(currentInvariantName('A', [
    { scope: 'invariant', path: 'A', from: 'A', to: 'B' },
    { scope: 'invariant', path: 'B', from: 'B', to: 'C' }])).toBe('C');
  expect(currentInvariantName('x', [])).toBe('x');
});

it('renameEntries extracts rename ledger entries in order', () => {
  const ledger: LedgerEntry[] = [
    { kind: 'structure', at: 't', question: 'q', answer: 'a' },
    { kind: 'rename', at: 't', scope: 'field', path: 'Job.count', from: 'count', to: 'units' }];
  expect(renameEntries(ledger)).toEqual([{ scope: 'field', path: 'Job.count', from: 'count', to: 'units' }]);
});

it('applyRenamesToModel rewrites defs and internal references', () => {
  const m2 = applyRenamesToModel(model, [
    { scope: 'state', path: 'Job.run.queued', from: 'queued', to: 'waiting' },
    { scope: 'field', path: 'Job.units', from: 'units', to: 'n' },
    { scope: 'enumValue', path: 'Mode.fast', from: 'fast', to: 'quick' }]);
  const job = m2.aggregates[0]!;
  expect(job.machine!.regions[0]!.initial).toBe('waiting');
  expect(job.machine!.regions[0]!.states[0]!.name).toBe('waiting');
  expect(job.fields.map(f => f.name)).toContain('n');
  expect(m2.enums[0]!.values).toContain('quick');
  expect(model.aggregates[0]!.fields.map(f => f.name)).toContain('units');   // input untouched
});

it('applyRenamesToInvariant rewrites paths, states and its own name', () => {
  const inv = applyRenamesToInvariant({ id: 'x', name: 'old', prior: 1, source: 'template',
    candidate: { kind: 'statePredicate', aggregate: 'Job', body: { kind: 'and', args: [
      { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } },
      { kind: 'inState', owner: 'self', region: 'run', states: ['queued'] }] } } }, [
    { scope: 'invariant', path: 'old', from: 'old', to: 'renamed' },
    { scope: 'field', path: 'Job.units', from: 'units', to: 'n' },
    { scope: 'state', path: 'Job.run.queued', from: 'queued', to: 'waiting' }]);
  expect(inv.name).toBe('renamed');
  const body = inv.candidate as any;
  expect(body.body.args[0].left.path).toEqual(['n']);
  expect(body.body.args[1].states).toEqual(['waiting']);
});
