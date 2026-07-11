import { describe, it, expect } from 'vitest';
import { checkMethodGuard } from '../../src/engine/method-guard.js';
import type { SolverDeps } from '../../src/engine/planner.js';
import { subscriptionsModel } from '../fixtures.js';

// Fake deps whose quintVerify returns queued results in CALL ORDER:
// call 1 = 'method-implies-guard' probe (violated ⇒ weaker-than-guard),
// call 2 = 'guard-implies-method' probe (violated ⇒ stronger-than-guard).
function fakeDeps(results: { violated: boolean; witness?: any }[]): SolverDeps {
  let i = 0;
  return {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => ({ violated: false, ms: 0 }),
    quintVerify: async () => ({ ...results[i++]!, ms: 0 }),
  };
}

describe('checkMethodGuard verdict logic', () => {
  it('method-implies-guard violated ⇒ weaker-than-guard (advertises rejected calls)', async () => {
    const w = { entities: [{ type: 'Subscription', id: 'subscription1', fields: {} }], trace: [] };
    // [method⇒guard violated] — short-circuits before the second probe
    const r = await checkMethodGuard(subscriptionsModel, 'SubscriptionService', 'activate',
      fakeDeps([{ violated: true, witness: w }]));
    expect(r.verdict).toBe('weaker-than-guard');
    expect(r.witness).toBe(w);
  });

  it('method⇒guard holds, guard⇒method violated ⇒ stronger-than-guard (silently narrows API)', async () => {
    const w = { entities: [{ type: 'Subscription', id: 'subscription1', fields: {} }], trace: [] };
    const r = await checkMethodGuard(subscriptionsModel, 'SubscriptionService', 'activate',
      fakeDeps([{ violated: false }, { violated: true, witness: w }]));
    expect(r.verdict).toBe('stronger-than-guard');
    expect(r.witness).toBe(w);
  });

  it('neither violated ⇒ consistent', async () => {
    const r = await checkMethodGuard(subscriptionsModel, 'SubscriptionService', 'activate',
      fakeDeps([{ violated: false }, { violated: false }]));
    expect(r.verdict).toBe('consistent');
    expect(r.witness).toBeUndefined();
  });
});
