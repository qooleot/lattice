import { describe, it, expect } from 'vitest';
import { classifyInvariant } from '../../src/engine/classify.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel, paidInvFixture, activePaidInFullFixture } from '../fixtures.js';

// Real quint end-to-end (design §5's corrected 2-probe): consecution + reachability-from-real-init,
// through realDeps.quintVerify (a real `quint verify` JVM call per probe — slow, patient timeouts).
describe('classifyInvariant (integration, real quint)', () => {
  it('paid-conjunct classifies entailed on the committed model', async () => {
    const c = await classifyInvariant(subscriptionsModel, paidInvFixture, [], [], realDeps);
    expect(c.verdict).toBe('entailed');
  }, 240_000);

  it('activePaidInFull classifies violated (reachable ¬I) on the committed model', async () => {
    const c = await classifyInvariant(subscriptionsModel, activePaidInFullFixture, [], [], realDeps);
    expect(c.verdict).toBe('violated');
    expect(c.reachable).toBe(true);
  }, 240_000);
});
