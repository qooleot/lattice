import { describe, it, expect } from 'vitest';
import { runCampaign, formatCampaign } from './campaign.js';
import {
  tinyCtx, tinyDrivers, buggyDrivers, skipDrivers, mkTinyDb, tinyPlanForWalk, tinyPlanWithSibling,
} from './fixtures.js';

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
    // Driver-skip signal (human ruling 2026-07-16): always printed, even at 0 — "audited" means
    // visible in every run, not just the runs where a driver actually skipped.
    expect(a.stats.driverSkips).toBe(0);
    expect(formatCampaign(a)).toContain('driver skips (impl preconditions, audited): 0');
  });

  it('driver-skip signal: skips accumulate across the whole campaign and are always reported', () => {
    const a = runCampaign(mkTinyDb, skipDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(true);          // skips are neither rejections nor violations
    expect(a.stats.driverSkips).toBeGreaterThan(0);
    expect(formatCampaign(a)).toContain(
      `driver skips (impl preconditions, audited): ${a.stats.driverSkips}`);
  });

  it('buggy target: campaign fails, shrinks to a minimal repro, and replays identically', () => {
    const a = runCampaign(mkTinyDb, buggyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(false);
    // Length-floor amendment (d2-coverage-investigation.md §1): OPTS.length is 12, so
    // fc.array's minLength floor is Math.floor(12 * 2/3) = 8 — shrinking can no longer collapse
    // the counterexample below that floor, so 8 (not the old ~3) is the true minimal repro size.
    expect(a.failure!.shrunk.length).toBe(8);
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
    // Length-floor amendment (d2-coverage-investigation.md §1): at the old length: 6 this seed's
    // now-deeper sequences (minLength floor Math.floor(6*2/3)=4) genuinely hit a second 'close' on
    // an already-closed row — a real, unrelated violation (buggyDrivers never checks from-state;
    // see fixtures.ts's tinyDrivers comment) that no sibling explains, so length was re-swept down
    // to 3 (minLength floor 2) to keep this test's premise (clean, masked-probe reporting) honest.
    const REATTR_OPTS = { sequences: 30, length: 3, seed: 42, checkEvery: 5, probeRate: 0.3, clockStep: 60 };
    const ctx = { ...tinyCtx(), plan: tinyPlanWithSibling };
    const a = runCampaign(mkTinyDb, buggyDrivers, ctx, tinyPlanForWalk, [], REATTR_OPTS);
    expect(a.clean).toBe(true);
    expect(a.stats.reattributions).toBeGreaterThan(0);
    expect(formatCampaign(a)).toContain(
      `probe re-attributions (shared entry points; sibling-masking limitation applies): ${a.stats.reattributions}`);
  });
});
