import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { arbSpec } from './arbitraries.js';
import { astToCode } from '../../src/emit/code.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { isImplied } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';
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
  // Order is NOT part of the round-trip identity: the printer groups invariants by owning aggregate
  // (spec: invariants live textually inside their aggregate block), so an input list whose invariants
  // interleave across aggregates (as real adoption order can) is legitimately re-grouped on print;
  // parsing it back yields aggregate-grouped order, not original list order. Compare as a set keyed by name.
  const shape = (i: CandidateInvariant) => ({ name: i.name, doc: i.doc, candidate: i.candidate });
  const byName = (xs: CandidateInvariant[]) =>
    new Map(xs.map(i => [i.name, shape(i)]));
  expect(byName(r.invariants)).toEqual(byName(explicit));
  // normalization idempotence: one more print∘parse is a fixed point
  expect(astToCode(r.model, r.invariants)).toBe(text);
}

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
