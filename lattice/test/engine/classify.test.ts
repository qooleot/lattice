import { describe, it, expect } from 'vitest';
import { classifyInvariant } from '../../src/engine/classify.js';
import type { SolverDeps } from '../../src/engine/planner.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

const inv: CandidateInvariant = { id: 'i1', name: 'testInv', prior: 1, source: 'template', candidate: paidImpliesExactConjunct };

// §6.1 honest-ceiling caveat (must-fix, whole-branch review): pre-Plan-3 (no abstract-evolution
// modeling yet), an unguarded data-field invariant's 'sound' tier for entailed/independent rests
// only on bounded INT_POOL sampling in emission, not on accrual semantics. 'violated' is the safe
// false-alarm direction and carries no caveat.
const CAVEAT = 'provisional: pre-abstract-evolution (design §6/Plan 3), soundness for unguarded data-field facts rests on bounded INT_POOL sampling, not accrual semantics';

// Fake deps whose quintVerify returns queued results in CALL ORDER: probe 1 = consecution, probe 2 = reachability.
function fakeDeps(results: { violated: boolean; witness?: any }[]): SolverDeps {
  let i = 0;
  return {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => ({ violated: false, ms: 0 }),
    quintVerify: async () => ({ ...results[i++]!, ms: 0 }),
  };
}

describe('classifyInvariant branch logic (consecution + reachability)', () => {
  it('reachability finds ¬I -> violated with the reachable witness (regardless of consecution)', async () => {
    const w = { entities: [{ type: 'Invoice', id: 'invoice1', fields: {} }], trace: [] };
    // [consecution=holds, reachability=violated]
    const c = await classifyInvariant(subscriptionsModel, inv, [], [], fakeDeps([{ violated: false }, { violated: true, witness: w }]));
    expect(c.verdict).toBe('violated');
    expect(c.reachable).toBe(true);
    expect(c.witness).toBe(w);
    expect(c.caveat).toBeUndefined();
  });
  it('¬I unreachable + inductive (consecution holds) -> entailed (pinnedBy peers), carries the honest-ceiling caveat', async () => {
    // [consecution=holds, reachability=clean]
    const c = await classifyInvariant(subscriptionsModel, inv, [], ['peerA'], fakeDeps([{ violated: false }, { violated: false }]));
    expect(c.verdict).toBe('entailed');
    expect(c.pinnedBy).toEqual(['peerA']);
    expect(c.caveat).toBe(CAVEAT);
  });
  it('¬I unreachable + not inductive (consecution fails) -> independent (carries the consecution CTI and the honest-ceiling caveat)', async () => {
    const cti = { entities: [{ type: 'Subscription', id: 'subscription1', fields: {} }], trace: [] };
    // [consecution=violated (CTI), reachability=clean]
    const c = await classifyInvariant(subscriptionsModel, inv, [], [], fakeDeps([{ violated: true, witness: cti }, { violated: false }]));
    expect(c.verdict).toBe('independent');
    expect(c.witness).toBe(cti);
    expect(c.caveat).toBe(CAVEAT);
  });
});
