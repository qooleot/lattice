import { describe, it, expect } from 'vitest';
import { astToAlloy } from '../../src/emit/alloy.js';
import type { Candidate } from '../../src/ast/invariant.js';
import { traceAModel } from '../fixtures.js';

const h1: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] };
const h2: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

describe('astToAlloy', () => {
  it('emits sigs, state sigs, candidate preds, and a distinguish run', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4 });
    expect(als).toContain('sig Subscription');
    expect(als).toContain('one sig Subscription_Access_Active');
    expect(als).toContain('Access_state: one Subscription_Access');
    expect(als).toContain('pred Hi');
    expect(als).toContain('pred Hj');
    expect(als).toContain('run q { (Hi and not Hj) or (not Hi and Hj) } for 4 but 5 Int');
  });
  it('emits exclusion shape predicates conjoined into the run', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: h1, exclusions: [[
      { dim: 'customer equal', value: true }, { dim: 'plan equal', value: false },
      { dim: 'plan.family equal', value: true }, { dim: 'inState count', value: 2 }
    ]], scope: 4 });
    expect(als).toContain('pred shape0');
    expect(als).toContain('a.customer = b.customer');
    expect(als).toContain('a.plan != b.plan');
    expect(als).toContain('a.plan.family = b.plan.family');
    expect(als).toContain('run q { (not Hi) and (not shape0) } for 4 but 5 Int');
  });
  it('probe-permit runs Hi with a non-vacuity witness pattern', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-permit', hi: h1, exclusions: [], scope: 4 });
    expect(als).toContain('pred nonVacuous');
    expect(als).toContain('run q { Hi and nonVacuous } for 4 but 5 Int');
  });

  // Regression coverage for golden trace A: a probe on H1 (unique per customer only) needs a
  // witness that also varies plan.family — a field H1 itself never references — so the human can
  // catch that H1 is coarser than the true per-(customer, plan.family) key. Left to a plain SAT
  // search, Kodkod's symmetry breaking always collapses `family` to a single reused atom since
  // nothing in `not Hi` forces otherwise (see task-17 report for the empirical trace). The
  // `varyUnreferenced` flag adds an explicit "some domain field H1 ignores must differ" conjunct.
  it('probe-forbid with varyUnreferenced forces a field the candidate ignores to differ', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: h1, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('some disj a, b: Subscription | (not Hi) and (a.plan.family != b.plan.family)');
  });
  it('probe-permit with varyUnreferenced forces a field the candidate ignores to differ', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-permit', hi: h1, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('some disj a, b: Subscription | Hi and nonVacuous and (a.plan.family != b.plan.family)');
  });
  it('falls back to varying the bare ref when its own deeper field is already referenced', () => {
    // This candidate already references plan.family, so the deeper path is excluded — the vary
    // clause falls back to the bare `plan` ref (still informative: a different plan in the same
    // family is a case this candidate's own key can't see either way).
    const perCustomerFamily: Candidate = { kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] };
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: perCustomerFamily, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('some disj a, b: Subscription | (not Hi) and (a.plan != b.plan)');
  });
  it('varyUnreferenced does not affect distinguish queries', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('run q { (Hi and not Hj) or (not Hi and Hj) } for 4 but 5 Int');
  });
});
