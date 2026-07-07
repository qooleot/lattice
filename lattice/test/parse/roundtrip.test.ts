import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { arbSpec, arbContextMap, fieldArb } from './arbitraries.js';
import { astToCode, contextMapToCode } from '../../src/emit/code.js';
import { loadLatText, loadContextMapText } from '../../src/parse/fromLangium.js';
import { isImplied } from '../../src/engine/implied.js';
import type { DomainModel, TypeRef } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/domains');
const SESSION = join(import.meta.dirname, '../../../.lattice-session-subscriptions');

function roundTrip(model: DomainModel, invariants: CandidateInvariant[]) {
  const text = astToCode(model, invariants);
  const r = loadLatText(text);
  expect(r.ok, `parse failed:\n${text}\n${JSON.stringify(!r.ok && r.diagnostics, null, 2)}`).toBe(true);
  if (!r.ok) return;
  expect(r.model).toEqual(model);
  const explicit = invariants.filter(i => !isImplied(i.candidate, model));
  // parse assigns hand-<name> ids and prior 1/source template; compare name+doc+candidate (spec §7.1).
  // Order is NOT fully part of the round-trip identity: the printer groups invariants by owning
  // aggregate (spec: invariants live textually inside their aggregate block, context-level owners
  // last — see src/emit/code.ts), so an input list whose invariants interleave across aggregates (as
  // real adoption order can) is legitimately re-grouped on print; parsing it back yields
  // aggregate-grouped order, not original list order. But WITHIN one aggregate's group the printer's
  // filter is stable, so intra-aggregate order is preserved and IS part of the identity. Group both
  // sides by owning aggregate (model.aggregates order, context-level owners last) and compare each
  // group as an ordered array — strictly stronger than a fully-unordered compare, while still
  // tolerating cross-aggregate regrouping.
  const shape = (i: CandidateInvariant) => ({ name: i.name, doc: i.doc, candidate: i.candidate });
  const groupByAggregate = (xs: CandidateInvariant[]) => {
    const owners = [...model.aggregates.map(a => a.name), ''];
    const groups = new Map<string, ReturnType<typeof shape>[]>(owners.map(o => [o, []]));
    for (const i of xs) {
      const key = groups.has(i.candidate.aggregate) ? i.candidate.aggregate : '';
      groups.get(key)!.push(shape(i));
    }
    return groups;
  };
  // generator's `used` Set guarantees invariant names are unique, so name-based grouping below is unambiguous.
  expect(groupByAggregate(r.invariants)).toEqual(groupByAggregate(explicit));
  // normalization idempotence: one more print∘parse is a fixed point
  expect(astToCode(r.model, r.invariants)).toBe(text);
}

describe('generator assumptions', () => {
  it('fieldArb (aggregate fields) never emits ref types — the refsResolve arm depends on it', () => {
    // if an aggregate ever grew a ref field, its explicit refsResolve invariant would become
    // structure-implied and be silently dropped by the printer, breaking round-trip identity
    const hasRef = (t: TypeRef): boolean => t.kind === 'ref' || (t.kind === 'list' && hasRef(t.of));
    fc.assert(fc.property(fieldArb('f', ['SomeEnum']), f => !hasRef(f.type)), { numRuns: 500 });
  });
});

describe('round-trip: parse ∘ print = id (spec §7.1)', () => {
  it('holds on generated specs (property)', () => {
    fc.assert(fc.property(arbSpec, ({ model, invariants }) => { roundTrip(model, invariants); }),
      { numRuns: 200 });
  });

  it('holds on all fixture domains', () => {
    for (const f of readdirSync(FIXTURES).filter(f => f.endsWith('.json'))) {
      const model = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as DomainModel;
      roundTrip(model, []);
    }
  });

  it('holds on the real subscriptions session (model + adopted)', () => {
    const state = JSON.parse(readFileSync(join(SESSION, 'state.json'), 'utf8'));
    const model: DomainModel = state.model;
    const adopted: CandidateInvariant[] = state.candidates
      .filter((c: any) => c.status === 'adopted').map((c: any) => c.inv);
    roundTrip(model, adopted);
  });
});

describe('contextMap round-trip: parse ∘ print = id', () => {
  it('holds on generated maps (property)', () => {
    fc.assert(fc.property(arbContextMap, map => {
      const text = contextMapToCode(map);
      const r = loadContextMapText(text);
      expect(r.ok, `parse failed:\n${text}\n${JSON.stringify(!r.ok && r.diagnostics)}`).toBe(true);
      if (!r.ok) return;
      expect(r.map).toEqual(map);
      expect(contextMapToCode(r.map)).toBe(text);        // idempotent normalization
    }), { numRuns: 200 });
  });
});
