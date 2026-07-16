// Seeded drive campaigns (design §3, adversarial-generation): fast-check owns generation,
// shrinking, and seeded replay for sequences of Intentions; this module supplies the property
// (executeSequence must report zero violations) and turns fast-check's raw RunDetails into a
// CampaignResult a human or CI can read. `Date.now()` is used ONLY here, for the campaign's own
// start/end duration measurement — never inside the property, which must stay exactly as
// deterministic as executeSequence itself (design constraint: replay from a seed must be exact).
import * as fc from 'fast-check';
import type Database from 'better-sqlite3';
import type { GenPlan } from '../../generate/plan.js';
import type { CheckContext } from '../report.js';
import type { ConformViolation } from '../types.js';
import { executeSequence, type DriverModule, type DriveStats } from './walk.js';
import { intentionArb, type Intention } from './intent.js';

export interface CampaignOpts {
  sequences: number; length: number; seed: number;
  checkEvery: number; probeRate: number; clockStep: number;
}

export interface CampaignResult {
  clean: boolean; sequencesRun: number; stats: DriveStats /* aggregated */;
  failure?: { seed: number; shrunk: Intention[]; narrative: string[]; violations: ConformViolation[] };
  durationMs: number;
}

function emptyStats(): DriveStats {
  return {
    commands: 0, accepted: 0, rejected: 0, probesAttempted: 0, probesRejected: 0,
    supersetOps: 0, guardedTransitionsProbed: [], reattributions: 0,
  };
}

// Folds one executeSequence run's stats into the campaign-wide collector — called for EVERY
// invocation fast-check makes of the property, including runs it discards while shrinking, so
// the aggregate reflects the full seeded exploration, not just the runs that "counted".
function accumulate(agg: DriveStats, guarded: Set<string>, s: DriveStats): void {
  agg.commands += s.commands;
  agg.accepted += s.accepted;
  agg.rejected += s.rejected;
  agg.probesAttempted += s.probesAttempted;
  agg.probesRejected += s.probesRejected;
  agg.supersetOps += s.supersetOps;
  agg.reattributions += s.reattributions;
  for (const t of s.guardedTransitionsProbed) guarded.add(t);
}

export function runCampaign(mkDb: () => Database.Database, drivers: DriverModule,
  ctx: CheckContext, plan: GenPlan, supersetNames: string[], opts: CampaignOpts): CampaignResult {
  const startedAt = Date.now();
  const stats = emptyStats();
  const guarded = new Set<string>();

  const arb = fc.array(intentionArb(plan, supersetNames, opts.probeRate), { maxLength: opts.length });
  const prop = fc.property(arb, seq => {
    const r = executeSequence(mkDb, drivers, ctx, seq, { checkEvery: opts.checkEvery, clockStep: opts.clockStep });
    accumulate(stats, guarded, r.stats);
    return r.violations.length === 0;
  });
  const checkResult = fc.check(prop, { seed: opts.seed, numRuns: opts.sequences });
  stats.guardedTransitionsProbed = [...guarded].sort();

  if (!checkResult.failed) {
    return { clean: true, sequencesRun: checkResult.numRuns, stats, durationMs: Date.now() - startedAt };
  }

  // fast-check's counterexample IS the shrunk sequence (arrays + record fields shrink natively);
  // re-execute it once, uncollected, with checkEvery: 1 so the report's narrative and violations
  // are precise about exactly where the shrunk repro goes wrong — the campaign layer never runs
  // checks itself beyond this single confirmatory replay.
  const shrunk = checkResult.counterexample![0];
  const replay = executeSequence(mkDb, drivers, ctx, shrunk, { checkEvery: 1, clockStep: opts.clockStep });

  return {
    clean: false, sequencesRun: checkResult.numRuns, stats,
    failure: { seed: opts.seed, shrunk, narrative: replay.narrative, violations: replay.violations },
    durationMs: Date.now() - startedAt,
  };
}

export function formatCampaign(r: CampaignResult): string {
  const s = r.stats;
  const guardLine = `guards probed at event time: ${s.probesAttempted} attempts across ` +
    `${s.guardedTransitionsProbed.length} guarded transitions` +
    (s.guardedTransitionsProbed.length ? ` (${s.guardedTransitionsProbed.join(', ')})` : '');
  // Design §2 Oracle, human ruling 2026-07-16: "Honest limitation, reported never hidden" — a
  // probe re-attributed to a legal sibling sharing the same entry point (e.g. voidDraft/voidOpen
  // both wrapping voidInvoice) can mask real drift in that sibling. Always printed, even at 0, so
  // CLEAN never reads as "no masking possible" when it actually means "masking occurred zero
  // times this run" — the absence itself is a fact the report states, not a fact it omits.
  const reattributionLine = s.reattributions > 0
    ? `probe re-attributions (shared entry points; sibling-masking limitation applies): ${s.reattributions}`
    : `probe re-attributions: 0`;
  const statLines = [
    `commands: ${s.commands} (${s.accepted} accepted, ${s.rejected} rejected, ${s.supersetOps} superset ops)`,
    guardLine,
    reattributionLine,
    `duration ${(r.durationMs / 1000).toFixed(1)}s`,
  ];

  if (r.clean) {
    return [`drive: ${r.sequencesRun} sequences — CLEAN`, ...statLines].join('\n');
  }

  const f = r.failure!;
  return [
    `drive: ${r.sequencesRun} sequences — FAILED (seed ${f.seed})`,
    `replay: lattice conform --target <target> --drive --seed ${f.seed}`,
    ...statLines,
    'narrative:',
    ...f.narrative.map(line => `  ${line}`),
    ...f.violations.map(v =>
      `VIOLATION ${v.invariant || v.specElement} (${v.specElement}) — witnesses [${v.witnessIds.join(', ')}] — ` +
      `${v.detail} — anchors [${v.anchors.join('; ')}] — source ${v.source}`),
  ].join('\n');
}
