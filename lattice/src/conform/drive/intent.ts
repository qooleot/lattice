// Drive intentions (design §3, adversarial-generation): the walk's unit of choice. An intention
// names WHAT to attempt next — create a row, fire a transition, deliberately probe an illegal
// one, or interleave a spec-unknown superset op — without knowing legality at generation time.
// Legality is a pre-state fact only the executor (walk.ts) can observe; intentionArb stays
// pure and cheap so fast-check can shrink freely.
import * as fc from 'fast-check';
import type { GenPlan } from '../../generate/plan.js';

export type Intention =
  | { kind: 'create'; aggregate: string; seed: number }
  | { kind: 'transition'; name: string; aggregate: string; rowPick: number; seed: number }
  | { kind: 'probe'; name: string; aggregate: string; rowPick: number; seed: number }   // deliberately fire when ILLEGAL
  | { kind: 'superset'; name: string; aggregate: string; rowPick: number; seed: number };

/** Weighted mixture over the intention shapes. `probeRate` splits transition-shaped picks
 *  between 'transition' (expect legal) and 'probe' (deliberately try illegal) — the executor is
 *  the actual legality oracle, this only expresses generation-time INTENT. Weights must be
 *  integers (fast-check ^3 constraint), hence the *100 scaling. */
// `createable` (measured, d2-coverage-investigation.md §2 "create's 50% waste"): the target's
// driver map only supports creating SOME aggregates (e.g. Invoice rows are created internally by
// a Subscription create driver's own transaction, never by a direct entry point) — sampling
// `create` intentions uniformly over EVERY spec aggregate throws away roughly half the already-
// small create budget on aggregates with no create driver at all, unconditionally skipped at
// execution time. Restricting the draw to the driver map's own keys (runCampaign passes
// `Object.keys(drivers.drivers.create)`) makes every generated create intention executable.
//
// `supersetTargets` (measured, §2 "F3 — superset aggregate mismatch"): superset ops are impl-
// specific extras with no spec-declared aggregate of their own, so (unlike `txnPairs`, which binds
// transition name to aggregate from the plan) there was nothing to bind `name` to `aggregate`
// against — the two were drawn independently and uniformly, wasting ~50% of superset attempts on
// a mismatched aggregate once they finally get enough rows to attempt at all. A target MAY declare
// which aggregate each superset op actually targets (`supersetAggregates` in its drive module); for
// ops present in that map, the mapped aggregate is used instead of the random draw. Ops absent
// from the map (or when no map is supplied) keep the prior random-aggregate behavior.
export function intentionArb(plan: GenPlan, supersetNames: string[], probeRate: number,
  createable: string[], supersetTargets: Record<string, string> = {}): fc.Arbitrary<Intention> {
  const aggNames = plan.aggregates.map(a => a.name);
  if (aggNames.length === 0) throw new Error('intentionArb: plan has no aggregates to drive');
  if (createable.length === 0) throw new Error('intentionArb: no createable aggregates — drivers.create is empty');
  const txnPairs = plan.aggregates.flatMap(a => a.transitions.map(t => ({ aggregate: a.name, name: t.name })));

  const seedArb = fc.nat(2 ** 31 - 1);
  const rowPickArb = fc.nat(31);
  const rate = Math.max(0, Math.min(1, probeRate));
  const probeWeight = Math.round(rate * 100);
  const legalWeight = 100 - probeWeight;

  const createArb: fc.Arbitrary<Intention> = fc.record({
    kind: fc.constant('create' as const), aggregate: fc.constantFrom(...createable), seed: seedArb,
  });

  const branches: { weight: number; arbitrary: fc.Arbitrary<Intention> }[] = [{ weight: 3, arbitrary: createArb }];

  if (txnPairs.length > 0) {
    const pairArb = fc.constantFrom(...txnPairs);
    const mkTxn = (kind: 'transition' | 'probe'): fc.Arbitrary<Intention> =>
      fc.tuple(pairArb, rowPickArb, seedArb).map(([pair, rowPick, seed]) =>
        ({ kind, name: pair.name, aggregate: pair.aggregate, rowPick, seed }));
    branches.push({ weight: legalWeight, arbitrary: mkTxn('transition') });
    branches.push({ weight: probeWeight, arbitrary: mkTxn('probe') });
  }

  if (supersetNames.length > 0) {
    const supersetArb: fc.Arbitrary<Intention> = fc.tuple(
      fc.constantFrom(...supersetNames), fc.constantFrom(...aggNames), rowPickArb, seedArb,
    ).map(([name, randomAggregate, rowPick, seed]) =>
      ({ kind: 'superset' as const, name, aggregate: supersetTargets[name] ?? randomAggregate, rowPick, seed }));
    branches.push({ weight: 2, arbitrary: supersetArb });
  }

  return fc.oneof(...branches);
}

/** One human-readable narrative line for an executed step (design §3 step 7: "minimal
 *  human-readable command sequence"). `rowId` is null for a create with no known target yet;
 *  `legality`/`outcome` are executor-decided free-text, not enums, so the executor's oracle
 *  branches stay the single source of truth for what counts as legal/accepted. */
export function describeIntention(i: Intention, rowId: string | null, legality: string, outcome: string): string {
  const target = rowId ? `${i.aggregate}#${rowId}` : i.aggregate;
  switch (i.kind) {
    case 'create':
      return `create ${target} (seed=${i.seed}) -> ${outcome}`;
    case 'transition':
      return `transition ${i.name} on ${target} (rowPick=${i.rowPick}, seed=${i.seed}) legality=${legality} -> ${outcome}`;
    case 'probe':
      return `probe ${i.name} on ${target} (rowPick=${i.rowPick}, seed=${i.seed}) legality=${legality} -> ${outcome}`;
    case 'superset':
      return `superset ${i.name} on ${target} (rowPick=${i.rowPick}, seed=${i.seed}) -> ${outcome}`;
  }
}
