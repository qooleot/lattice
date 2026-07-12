import { describe, it, expect } from 'vitest';
import { classifyInvariant } from '../../src/engine/classify.js';
import { conjunctsOf } from '../../src/engine/tier.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel, paidImpliesExactConjunct, amountPaidAtMostTotalConjunct } from '../fixtures.js';
import type { Candidate, CandidateInvariant } from '../../src/ast/invariant.js';

// §6.3 abstract-evolution over-approximation caveat — abstract-tier `violated` only.
const CAVEAT = 'abstract-evolution over-approximation: the accrual model permits this; the real (unmodeled) update rule may rule it out — add a guard or confirm intended';

// Reassemble the committed Invoice invariant Never_Overpaid_And_Paid_Exact (spec.lat) as the `and`
// of its two committed conjunct fixtures — the first arg is `amountPaid <= totalDue`, the second is
// `paid ⇒ amountPaid == totalDue` — so conjunctsOf splits it back into the two per-conjunct pieces.
const neverOverpaidAndPaidExact: Candidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  body: { kind: 'and', args: [
    (amountPaidAtMostTotalConjunct as Extract<Candidate, { kind: 'statePredicate' }>).body,
    (paidImpliesExactConjunct as Extract<Candidate, { kind: 'statePredicate' }>).body,
  ] },
};
const inv: CandidateInvariant = {
  id: 'never-overpaid', name: 'neverOverpaidAndPaidExact', prior: 1, source: 'template',
  candidate: neverOverpaidAndPaidExact,
};

// Real quint end-to-end (design §5's corrected 2-probe): consecution + reachability-from-real-init,
// through realDeps.quintVerify (a real `quint verify` JVM call per probe — slow, patient timeouts).
describe('classifyInvariant (integration, real quint)', () => {
  it('per-conjunct split of neverOverpaidAndPaidExact: <= violated/abstract/caveat; paid⇒exact entailed/no-caveat', async () => {
    const conjuncts = conjunctsOf(inv.candidate);
    expect(conjuncts.length).toBe(2);

    const results = [];
    for (const conj of conjuncts) results.push(await classifyInvariant(subscriptionsModel, inv, conj, [], [], realDeps));

    // conjunct 0 = `amountPaid <= totalDue`: NOT guard-forced; abstract accrual drives amountPaid
    // past totalDue → reachable ¬I → violated, tier abstract, with the over-approximation caveat.
    const le = results[0]!;
    expect(le.conjunct).toBe('0');
    expect(le.verdict).toBe('violated');
    expect(le.reachable).toBe(true);
    expect(le.tier).toBe('abstract');
    expect(le.caveat).toBe(CAVEAT);

    // conjunct 1 = `paid ⇒ amountPaid == totalDue`: guard-forced by settle (the only edge into
    // `paid`) → entailed. Holds under arbitrary accrual, so NO caveat (caveat is violated-only).
    const impl = results[1]!;
    expect(impl.conjunct).toBe('1');
    expect(impl.verdict).toBe('entailed');
    expect(impl.caveat).toBeUndefined();
  }, 240_000);
});
