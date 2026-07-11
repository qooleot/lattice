import { describe, it, expect } from 'vitest';
import { classifyInvariant } from '../../src/engine/classify.js';
import type { SolverDeps } from '../../src/engine/planner.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js';
import type { Candidate, CandidateInvariant } from '../../src/ast/invariant.js';

// paidImpliesExactConjunct references data fields (amountPaid/totalDue) → conjunctTier 'abstract'.
const inv: CandidateInvariant = { id: 'i1', name: 'testInv', prior: 1, source: 'template', candidate: paidImpliesExactConjunct };

// A pure region/state fact — no data-field reference → conjunctTier 'sound'.
const soundCandidate: Candidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  body: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
};
const soundInv: CandidateInvariant = { id: 'i2', name: 'soundInv', prior: 1, source: 'template', candidate: soundCandidate };

// §6.3 abstract-evolution over-approximation caveat — attached ONLY to abstract-tier `violated`
// findings (the over-approximation can only produce spurious violations, never spurious holds).
const CAVEAT = 'abstract-evolution over-approximation: the accrual model permits this; the real (unmodeled) update rule may rule it out — add a guard or confirm intended';

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
  it('abstract-tier reachability finds ¬I -> violated + over-approximation caveat + tier abstract + conjunct threaded', async () => {
    const w = { entities: [{ type: 'Invoice', id: 'invoice1', fields: {} }], trace: [] };
    // [consecution=holds, reachability=violated]
    const c = await classifyInvariant(subscriptionsModel, inv, { candidate: inv.candidate, conjunct: '0' }, [], [],
      fakeDeps([{ violated: false }, { violated: true, witness: w }]));
    expect(c.verdict).toBe('violated');
    expect(c.tier).toBe('abstract');
    expect(c.conjunct).toBe('0');
    expect(c.reachable).toBe(true);
    expect(c.witness).toBe(w);
    expect(c.caveat).toBe(CAVEAT);
  });
  it('sound-tier violated (no data field) -> NO caveat (safe direction)', async () => {
    const w = { entities: [{ type: 'Invoice', id: 'invoice1', fields: {} }], trace: [] };
    const c = await classifyInvariant(subscriptionsModel, soundInv, { candidate: soundInv.candidate }, [], [],
      fakeDeps([{ violated: false }, { violated: true, witness: w }]));
    expect(c.verdict).toBe('violated');
    expect(c.tier).toBe('sound');
    expect(c.conjunct).toBeUndefined();
    expect(c.caveat).toBeUndefined();
  });
  it('¬I unreachable + inductive -> entailed (pinnedBy peers), NO caveat even at abstract tier', async () => {
    // [consecution=holds, reachability=clean]
    const c = await classifyInvariant(subscriptionsModel, inv, { candidate: inv.candidate, conjunct: '1' }, [], ['peerA'],
      fakeDeps([{ violated: false }, { violated: false }]));
    expect(c.verdict).toBe('entailed');
    expect(c.tier).toBe('abstract');
    expect(c.conjunct).toBe('1');
    expect(c.pinnedBy).toEqual(['peerA']);
    expect(c.caveat).toBeUndefined();
  });
  it('¬I unreachable + not inductive -> independent (carries CTI), NO caveat even at abstract tier', async () => {
    const cti = { entities: [{ type: 'Subscription', id: 'subscription1', fields: {} }], trace: [] };
    // [consecution=violated (CTI), reachability=clean]
    const c = await classifyInvariant(subscriptionsModel, inv, { candidate: inv.candidate }, [], [],
      fakeDeps([{ violated: true, witness: cti }, { violated: false }]));
    expect(c.verdict).toBe('independent');
    expect(c.tier).toBe('abstract');
    expect(c.witness).toBe(cti);
    expect(c.caveat).toBeUndefined();
  });
});
