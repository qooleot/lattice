import { describe, it, expect } from 'vitest';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js';

describe('astToQuintClassify (integration, real quint)', () => {
  // The worked entailment (spike §4c): the committed Subscriptions `paid ⇒ amountPaid == totalDue`
  // conjunct. Its consecution HOLDS through real Apalache because `settle` — the only transition
  // into `paid` — has guard `requires amountPaid == totalDue`, and no action mutates amountPaid or
  // totalDue. Not asserted structurally: the verdict comes back from a real `runQuintVerify` call.
  it('paid-conjunct consecution holds (settle guard forces it)', async () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [], probe: 'consecution', maxSteps: 1 });
    const r = await runQuintVerify(em, { init: 'indInit', invariant: em.invariantName, maxSteps: 1 });
    expect(r.violated).toBe(false);
  }, 180_000);
});
