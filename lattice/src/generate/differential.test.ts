import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadGenInput } from './load.js';
import { buildPlan } from './plan.js';
import { compileInvariantCheck } from './invariantCheck.js';
import { evaluateCandidate } from '../engine/evaluate.js';
import type { CaseEntity } from '../engine/evaluate.js';
import type { LedgerEntry } from '../engine/session.js';
import type { PlanInvariant } from './plan.js';

// Differential test (signature test of the Lattice generation slice): for every adopted invariant
// and every judged (verdict) witness whose entities include that invariant's aggregate, the
// GENERATED readable check must agree with the engine's evaluateCandidate oracle. This is testing
// the exact source (compileInvariantCheck) that render/invariants.ts wraps into invariants.ts, so
// green here means the generated invariant checks are faithful to the judged ledger, not merely
// "looks plausible".

const SESSION_DIR = join(import.meta.dirname, '../../../.lattice-session-subscriptions');

// A compiled check's body references `row.<region>` for inState/region checks and `row.<field>` for
// own-fields. Witnesses store region state under a `"<region>.state"` key (e.g. `settlement.state`),
// so flatten generically: start from the entity's own fields, then for every key ending in `.state`,
// also expose it under the bare region name.
function flattenEntity(e: CaseEntity): Record<string, string | number | boolean> {
  const row: Record<string, string | number | boolean> = { ...e.fields };
  for (const k of Object.keys(e.fields)) {
    if (k.endsWith('.state')) row[k.slice(0, -'.state'.length)] = e.fields[k]!;
  }
  return row;
}

function runGenerated(inv: PlanInvariant, subjects: CaseEntity[]): 'permit' | 'forbid' {
  const compiled = compileInvariantCheck(inv);
  if (compiled.kind === 'row') {
    const fn = new Function('row', `return (${compiled.bodyTs});`);
    const ok = subjects.every(e => fn(flattenEntity(e)));
    return ok ? 'permit' : 'forbid';
  } else {
    const fn = new Function('rows', `return (${compiled.bodyTs});`);
    const ok = fn(subjects.map(flattenEntity));
    return ok ? 'permit' : 'forbid';
  }
}

describe('differential: generated invariant checks vs evaluateCandidate oracle', () => {
  const input = loadGenInput(SESSION_DIR);
  const plan = buildPlan(input);
  const verdicts = input.ledger.filter((e): e is Extract<LedgerEntry, { kind: 'verdict' }> => e.kind === 'verdict');
  const invariants = plan.aggregates.flatMap(a => a.invariants);

  expect(invariants.length).toBeGreaterThan(0);
  expect(verdicts.length).toBeGreaterThan(0);

  let forbidCount = 0;
  let pairCount = 0;

  for (const inv of invariants) {
    for (const v of verdicts) {
      const subjects = v.witness.entities.filter(e => e.type === inv.aggregate);
      if (subjects.length === 0) continue;   // witness doesn't touch this invariant's aggregate — out of scope
      pairCount++;
      const oracle = evaluateCandidate(inv.candidate, v.witness);
      if (oracle === 'forbid') forbidCount++;

      it(`${inv.name} agrees with oracle on ${v.witnessId} (oracle=${oracle})`, () => {
        const generated = runGenerated(inv, subjects);
        expect(generated).toBe(oracle);
      });
    }
  }

  it('sanity: tested a non-trivial number of (invariant × witness) pairs', () => {
    expect(pairCount).toBe(21 + 9);
  });

  // Teeth: the suite must not be vacuously all-permit — real forbids must be exercised.
  it('teeth: the oracle produces at least one forbid across all pairs', () => {
    expect(forbidCount).toBeGreaterThan(0);
  });
});
