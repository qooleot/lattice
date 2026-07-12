import { describe, it, expect } from 'vitest';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';
import { subscriptionsModel, paidImpliesExactConjunct, amountPaidAtMostTotalConjunct } from '../fixtures.js';

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

  // Plan 3 Task 1 (design §6.3's worked flip): astToQuintClassify's machine now over-approximates
  // accrual (Task 1's abstractEvolution flag, set unconditionally on the `base` call). Unlike
  // paidImpliesExactConjunct (guard-forced by settle, still holds under accrual — see above),
  // `amountPaid <= totalDue` has NO guard protecting it: an `open` invoice can accrue amountPaid
  // past totalDue via evolve_Invoice_amountPaid (both non-terminal-gated, non-const numeric
  // fields), so real Apalache finds a genuine CTI. This is exactly what makes abstract-evolution
  // meaningful — under the old frozen-data machine (no evolve_ actions touching amountPaid or
  // totalDue at all) this same consecution check trivially holds, an overclaim the flag exists to
  // correct (design §6.1).
  it('amountPaid<=totalDue consecution is VIOLABLE under abstract accrual (design §6.3 flip — no guard prevents overpayment while open)', async () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: amountPaidAtMostTotalConjunct, peers: [], probe: 'consecution', maxSteps: 1 });
    expect(em.source).toContain('action evolve_Invoice_amountPaid');   // sanity: the abstract step really is in this machine
    const r = await runQuintVerify(em, { init: 'indInit', invariant: em.invariantName, maxSteps: 1 });
    expect(r.violated).toBe(true);
  }, 180_000);
});
