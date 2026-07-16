import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { intentionArb, type Intention } from './intent.js';
import type { GenPlan } from '../../generate/plan.js';

// Two spec aggregates, neither with any transitions of their own — enough to exercise
// intentionArb's create/superset branches without dragging in a full transitions fixture (that's
// walk.test.ts's/fixtures.ts's job).
const plan: GenPlan = {
  context: 'Test',
  aggregates: [
    { name: 'Alpha', fields: [], regions: [], transitions: [], invariants: [] },
    { name: 'Beta', fields: [], regions: [], transitions: [], invariants: [] },
  ],
  events: [],
};

describe('intentionArb', () => {
  it('createable restriction: create intentions never target an aggregate outside the createable list', () => {
    // Measured (d2-coverage-investigation.md §2): sampling create's aggregate uniformly across
    // EVERY spec aggregate threw away ~50% of the create budget on aggregates with no create
    // driver at all. 'Beta' has no create driver here (only 'Alpha' is createable) — every
    // generated create intention must target 'Alpha', never 'Beta'.
    const arb = intentionArb(plan, [], 0.2, ['Alpha']);
    const samples = fc.sample(arb, { numRuns: 500, seed: 1 });
    const creates = samples.filter((i): i is Extract<Intention, { kind: 'create' }> => i.kind === 'create');
    expect(creates.length).toBeGreaterThan(0);
    expect(creates.every(c => c.aggregate === 'Alpha')).toBe(true);
  });

  it('throws when createable is empty (a walk that can create nothing is a config error)', () => {
    expect(() => intentionArb(plan, [], 0.2, [])).toThrow(/createable/);
  });

  it('supersetTargets binding: an op present in the map always gets its declared aggregate; an ' +
    'unmapped op keeps the prior random-aggregate behavior', () => {
    // F3 (d2-coverage-investigation.md §2): binding name→aggregate for ops the target declares,
    // while ops it doesn't declare keep drawing independently and uniformly across every spec
    // aggregate — this must hold for BOTH ops at once, from a single intentionArb call.
    const arb = intentionArb(plan, ['mappedOp', 'freeOp'], 0.2, ['Alpha', 'Beta'], { mappedOp: 'Beta' });
    const samples = fc.sample(arb, { numRuns: 2000, seed: 2 });
    const supersets = samples.filter((i): i is Extract<Intention, { kind: 'superset' }> => i.kind === 'superset');
    const mapped = supersets.filter(s => s.name === 'mappedOp');
    const free = supersets.filter(s => s.name === 'freeOp');
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.every(s => s.aggregate === 'Beta')).toBe(true);
    expect(free.length).toBeGreaterThan(0);
    expect(new Set(free.map(s => s.aggregate)).size).toBeGreaterThan(1); // still random, both aggregates appear
  });
});
