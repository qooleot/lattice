import { describe, it, expect } from 'vitest';
import { runCampaign, formatCampaign } from './campaign.js';
import { tinyCtx, tinyDrivers, buggyDrivers, mkTinyDb, tinyPlanForWalk } from './fixtures.js';

const OPTS = { sequences: 50, length: 12, seed: 42, checkEvery: 5, probeRate: 0.3, clockStep: 60 };

describe('runCampaign', () => {
  it('clean target: campaign is clean, deterministic, and reports probe coverage', () => {
    const a = runCampaign(mkTinyDb, tinyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    const b = runCampaign(mkTinyDb, tinyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(true);
    expect(a.stats.probesAttempted).toBeGreaterThan(0);
    expect(b.stats).toEqual(a.stats);                      // seeded determinism
    expect(formatCampaign(a)).toContain('guards probed at event time:');
  });

  it('buggy target: campaign fails, shrinks to a minimal repro, and replays identically', () => {
    const a = runCampaign(mkTinyDb, buggyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(false);
    expect(a.failure!.shrunk.length).toBeLessThanOrEqual(3); // create + probe (+ slack)
    expect(a.failure!.violations[0]!.detail).toMatch(/accepted a spec-illegal command/);
    const b = runCampaign(mkTinyDb, buggyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(b.failure!.shrunk).toEqual(a.failure!.shrunk);   // same seed ⇒ same shrunk repro
    expect(formatCampaign(a)).toContain(`--seed ${OPTS.seed}`);
  });
});
