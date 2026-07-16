import { describe, it, expect } from 'vitest';
import { runCampaign, formatCampaign } from './campaign.js';
import { tinyCtx, tinyDrivers, buggyDrivers, mkTinyDb, tinyPlanForWalk, tinyPlanWithSibling } from './fixtures.js';

const OPTS = { sequences: 50, length: 12, seed: 42, checkEvery: 5, probeRate: 0.3, clockStep: 60 };

describe('runCampaign', () => {
  it('clean target: campaign is clean, deterministic, and reports probe coverage', () => {
    const a = runCampaign(mkTinyDb, tinyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    const b = runCampaign(mkTinyDb, tinyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(true);
    expect(a.stats.probesAttempted).toBeGreaterThan(0);
    expect(b.stats).toEqual(a.stats);                      // seeded determinism
    expect(formatCampaign(a)).toContain('guards probed at event time:');
    // F1 (D1 final review): "reported never hidden" — printed even at 0, worded plainly (no
    // masking-limitation caveat) since 0 means no masking occurred, not that it can't happen.
    expect(a.stats.reattributions).toBe(0);
    expect(formatCampaign(a)).toContain('probe re-attributions: 0');
    expect(formatCampaign(a)).not.toContain('sibling-masking limitation applies');
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

  it('re-attributing target: masked probes are reported, never hidden (F1, D1 final review)', () => {
    // buggyDrivers' weakened close accepts every probe; tinyPlanWithSibling adds 'discard' — a
    // same-region/from/to sibling with no requires — so every accepted illegal 'close' probe on
    // an open-state row gets re-attributed instead of flagged. The arb still only ever generates
    // 'close'/'probe close' intentions (plan param stays tinyPlanForWalk, which doesn't declare
    // 'discard' — buggyDrivers has no 'discard' entry to invoke); only ctx.plan carries the
    // sibling, for the executor's post-accept sibling lookup (walk.ts:188-196). This seed/opts
    // combination is empirically clean with reattributions > 0 (picked by sweep, pinned here).
    const REATTR_OPTS = { sequences: 30, length: 6, seed: 42, checkEvery: 5, probeRate: 0.3, clockStep: 60 };
    const ctx = { ...tinyCtx(), plan: tinyPlanWithSibling };
    const a = runCampaign(mkTinyDb, buggyDrivers, ctx, tinyPlanForWalk, [], REATTR_OPTS);
    expect(a.clean).toBe(true);
    expect(a.stats.reattributions).toBeGreaterThan(0);
    expect(formatCampaign(a)).toContain(
      `probe re-attributions (shared entry points; sibling-masking limitation applies): ${a.stats.reattributions}`);
  });
});
