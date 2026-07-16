// Drive walk executor (design §3, adversarial-generation): runs a fixed sequence of Intentions
// against a live db through a target-supplied DriverModule, judging each transition/probe step
// against the REAL pre-state (scoped observe + evaluateCandidate) — the honesty gap passive mode
// declares and never closes. Post-state conformance reuses the unchanged slice-2 path (checkDb)
// untouched: this module adds a pre-state oracle in front of it, nothing more.
import type Database from 'better-sqlite3';
import { bindSchema } from '../bind.js';
import { observeScoped, observeEntities } from '../observe.js';
import { checkDb, type CheckContext } from '../report.js';
import { checkInvariants } from '../tier1.js';
import { evaluateCandidate, type CaseEntity } from '../../engine/evaluate.js';
import type { PlanTransition } from '../../generate/plan.js';
import type { BindingManifest, ConformViolation } from '../types.js';
import { describeIntention, type Intention } from './intent.js';

export interface DriveOpts { checkEvery: number; clockStep: number }
export interface DriveStats {
  commands: number; accepted: number; rejected: number;
  probesAttempted: number; probesRejected: number; supersetOps: number;
  guardedTransitionsProbed: string[];
  reattributions: number;
  // Driver-skip signal (human ruling 2026-07-16): a driver throwing 'drive-skip: <reason>' from
  // the LEGAL branch only — see the try/catch below — is neither an accept nor a reject nor a
  // violation. Deliberately NOT counted in `commands`/`accepted`/`rejected`: it is audited
  // separately (formatCampaign always prints it) so it can never silently inflate or deflate
  // those totals.
  driverSkips: number;
  // Coverage counters (human ruling 2026-07-16, c09 follow-up instrument — design §7's forward
  // pointer on reachability telemetry): every region-state value actually observed, keyed
  // '<Aggregate>.<region>=<state>', counted once per occurrence during (a) each transition/probe
  // step's scoped pre-state read and (b) the per-step full-context invariant check below. Answers "did
  // this walk ever observe X in state Y, and how often" without hand-instrumenting source the way
  // the c09 investigation had to (§7's ad hoc `console.error` scratch branch).
  statesObserved: Record<string, number>;
}
export interface DriveResult {
  violations: ConformViolation[]; stats: DriveStats;
  narrative: string[]; // one describeIntention line per executed step
}

/** Deterministic from the intention's seed — no Date.now(), no fast-check, inside the executor
 *  (design constraint: replay from a seed must be exact). `clock()` returns this step's tick of
 *  the walk-level monotonic counter (design §6: "drivers receive a monotonic clock(), real time
 *  never leaks into sequences"); `rand()` is a per-step mulberry32 draw for driver-side value
 *  synthesis. */
export interface DriveGenImpl { seed: number; clock: () => number; rand: () => number }

export type Fn = (db: unknown, id: string, gen: DriveGenImpl) => void;
export type DriverModule = {
  drivers: { transitions: Record<string, Fn>; superset?: Record<string, Fn>; create: Record<string, Fn> };
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function findTransition(ctx: CheckContext, aggregate: string, name: string): PlanTransition {
  const t = ctx.plan.aggregates.find(a => a.name === aggregate)?.transitions.find(tr => tr.name === name);
  if (!t) throw new Error(`drive: no transition '${name}' declared on aggregate '${aggregate}' in the plan`);
  return t;
}

/** Coverage counters (see DriveStats.statesObserved doc). Scans every entity's projected fields
 *  for the observer's region-state key convention ('<region>.state', observe.ts) and tallies
 *  '<Aggregate>.<region>=<state>' occurrences. */
function recordStateCoverage(counts: Record<string, number>, entities: CaseEntity[]): void {
  const suffix = '.state';
  for (const e of entities) {
    for (const [key, val] of Object.entries(e.fields)) {
      if (!key.endsWith(suffix)) continue;
      const region = key.slice(0, -suffix.length);
      const label = `${e.type}.${region}=${String(val)}`;
      counts[label] = (counts[label] ?? 0) + 1;
    }
  }
}

/** Per-step FULL-CONTEXT invariant check (design amendment 2026-07-16, human ruling on the c09
 *  root-cause finding — docs/superpowers/specs/2026-07-15-lattice-drive-rediscovery-results.md
 *  §7; SCOPE WIDENED same day, second ruling — design doc fork-4 amendment): the end-of-sequence/
 *  checkEvery sweep is batched to sequence boundaries by deliberate design (O(1)-query-per-step
 *  cost model) and is structurally blind to a violation that a LATER, itself-legal command in the
 *  same sequence resolves before the sweep ever runs (measured, seed 22: a `changePlanOp` left a
 *  successor Subscription active-and-unpaid; the very next intention was a plain legal `cancel`
 *  on that same row, and the sweep never observed the violating state at all).
 *
 *  The FIRST version of this fix re-checked ONLY the intention's nominally touched aggregate. That
 *  was itself wrong: several drivers mutate an aggregate their intention does NOT name —
 *  `rollover`/`changeSeats`/`recordUsage`/`changePlanOp` are Subscription-bound intentions whose
 *  drivers also write Invoice rows; `settle` is Invoice-bound but bumps
 *  `Subscription.paid_invoice_count` and can recover `lifecycle_state`. A touched-aggregate filter
 *  doesn't close the cadence gap in that case, it RELOCATES it onto the aggregate the intention
 *  didn't name — a transient violation on the side-mutated aggregate can still be legally erased
 *  before any sweep sees it, exactly like c09, just on a different table.
 *
 *  Fixed by dropping the touched-aggregate filter entirely: every accepted/re-attributed/superset
 *  step re-evaluates the Tier-1 invariants of EVERY bound aggregate in the manifest, over the same
 *  entity set the full end-of-sequence sweep uses (`observeEntities` — every bound aggregate's
 *  full row set; a ref-hop invariant resolves because the ref target's own full row set is already
 *  present in that same combined set, not because of a separate one-hop fetch). This is exactly a
 *  Tier-1-only sweep — no trace check, no crosschecks, per step; those stay the full sweep's job.
 *  Cost is bounded-context-sized (O(every bound aggregate) per step, not O(1 aggregate) per step)
 *  — acceptable at this context's scale (a handful of tiny in-memory tables per sequence, see
 *  measured durations in the fix report). A target where full-context per-step reads would be too
 *  costly (large or remote) is the recorded seam: a future DECLARED per-op mutation footprint
 *  (driver map states which aggregates an op can touch) would let this check scope to exactly that
 *  declared set instead of the whole context — not implemented here, since this context is small
 *  enough that the full-context read is already cheap. Runs IN ADDITION to checkEvery/
 *  end-of-sequence checks. Violations found here are pushed into the SAME violations array as
 *  every other finding — a per-step catch is a real violation, not a separate class of finding. */
function stepCheck(db: Database.Database, ctx: CheckContext, manifest: BindingManifest,
  source: string, stats: DriveStats): ConformViolation[] {
  const entities = observeEntities(db, ctx.input.model, manifest, ctx.overrides);
  recordStateCoverage(stats.statesObserved, entities);
  return checkInvariants(entities, ctx.plan, ctx.optOuts, source);
}

function transitionViolation(t: PlanTransition, id: string, source: string, detail: string): ConformViolation {
  return {
    invariant: '', specElement: t.anchors.specElement,
    anchors: t.anchors.provenance.length ? t.anchors.provenance : [t.anchors.specElement],
    witnessIds: [id], source, detail,
  };
}

/** Real reads, not a mirror: rows created INSIDE drivers (e.g. a createSubscription driver that
 *  also inserts the first Invoice) never show up in any executor-side bookkeeping — the only
 *  honest way to know what rows exist is to ask the db. Ordered by key column so rowPick's
 *  modulo indexing is deterministic across calls within a step. Returns [] (skip the step, as
 *  before) for an aggregate with no binding or no rows yet. */
function liveIds(db: Database.Database, manifest: BindingManifest, aggregate: string): string[] {
  const agg = manifest.aggregates.find(a => a.aggregate === aggregate);
  if (!agg || !agg.table || !agg.keyColumn) return [];
  return (db.prepare(`SELECT ${agg.keyColumn} FROM ${agg.table} ORDER BY ${agg.keyColumn}`).all() as
    Record<string, unknown>[]).map(row => String(row[agg.keyColumn]));
}

export function executeSequence(mkDb: () => Database.Database, drivers: DriverModule,
  ctx: CheckContext, seq: Intention[], opts: DriveOpts): DriveResult {
  if (Object.keys(drivers.drivers.create).length === 0) {
    throw new Error('drive: drivers.create is empty — a walk that can create nothing is a config error');
  }

  const db = mkDb();
  const manifest = bindSchema(db, ctx.input.model, ctx.overrides);
  const createCounters: Record<string, number> = {};
  const stats: DriveStats = {
    commands: 0, accepted: 0, rejected: 0, probesAttempted: 0, probesRejected: 0,
    supersetOps: 0, guardedTransitionsProbed: [], reattributions: 0, driverSkips: 0,
    statesObserved: {},
  };
  const guardedProbed = new Set<string>();
  const violations: ConformViolation[] = [];
  const narrative: string[] = [];
  let clock = 1_000_000;

  // Dedup guard for the boundary case: when the last executed step's accepted-count already
  // triggered an in-loop checkDb, the unconditional end-of-sequence sweep below would re-run
  // checkDb against identical, unchanged db state and duplicate every live violation it finds.
  // `null` means "no check has run yet" — the sweep must still run once in that case.
  let lastCheckedAtAccepted: number | null = null;
  const runCheck = (source: string) => {
    violations.push(...checkDb(db, ctx, source).violations);
    lastCheckedAtAccepted = stats.accepted;
  };

  for (let i = 0; i < seq.length; i++) {
    const intention = seq[i]!;
    const source = `drive:${i + 1}`;
    const tick = clock;
    const gen: DriveGenImpl = { seed: intention.seed, clock: () => tick, rand: mulberry32(intention.seed) };
    let executed = true;

    if (intention.kind === 'create') {
      const fn = drivers.drivers.create[intention.aggregate];
      if (!fn) { executed = false; }
      else {
        const n = (createCounters[intention.aggregate] = (createCounters[intention.aggregate] ?? 0) + 1);
        const id = `d-${intention.aggregate.toLowerCase()}-${n}`;
        fn(db, id, gen);
        stats.commands++; stats.accepted++;
        narrative.push(describeIntention(intention, id, 'n/a', 'accepted'));
      }
    } else if (intention.kind === 'superset') {
      const fn = drivers.drivers.superset?.[intention.name];
      const ids = liveIds(db, manifest, intention.aggregate);
      if (!fn || ids.length === 0) { executed = false; }
      else {
        const id = ids[intention.rowPick % ids.length]!;
        let outcome = 'accepted';
        try { fn(db, id, gen); } catch { outcome = 'rejected'; }
        stats.commands++; stats.supersetOps++;
        narrative.push(describeIntention(intention, id, 'n/a', outcome));
        if (outcome === 'accepted') {
          violations.push(...stepCheck(db, ctx, manifest, `${source}:step-check`, stats));
        }
      }
    } else {
      // 'transition' or 'probe': legality decides the branch, not the intention's own kind — a
      // 'transition' that lands illegal downgrades into exactly the probe branch below (design
      // §3: "keeps generated sequences useful without a legality oracle at generation time"),
      // and a 'probe' that lands legal runs exactly the legal branch ("just a command").
      const ids = liveIds(db, manifest, intention.aggregate);
      if (ids.length === 0) { executed = false; }
      else {
        const id = ids[intention.rowPick % ids.length]!;
        const t = findTransition(ctx, intention.aggregate, intention.name);
        const scoped = observeScoped(db, ctx.input.model, manifest, ctx.overrides, intention.aggregate, id);
        recordStateCoverage(stats.statesObserved, scoped);
        const regionKey = `${t.region}.state`;
        const stateVal = scoped[0]!.fields[regionKey];
        if (stateVal === undefined) {
          throw new Error(
            `drive: missing region-state key '${regionKey}' for ${intention.aggregate}#${id} — observed row ` +
            `has no field '${regionKey}'; check that transition '${t.name}''s region ('${t.region}') matches ` +
            `a region bound on ${intention.aggregate}`);
        }
        const fromOk = t.from.includes(String(stateVal));
        const guardOk = !t.requires || evaluateCandidate(
          { kind: 'statePredicate', aggregate: intention.aggregate, body: t.requires }, { entities: scoped }) === 'permit';
        const legal = fromOk && guardOk;
        const driverFn = drivers.drivers.transitions[intention.name];
        if (!driverFn) throw new Error(`drive: no transition driver for '${intention.name}' on '${intention.aggregate}'`);

        if (legal) {
          try {
            driverFn(db, id, gen);
            stats.commands++; stats.accepted++;
            narrative.push(describeIntention(intention, id, 'legal', 'accepted'));
            violations.push(...stepCheck(db, ctx, manifest, `${source}:step-check`, stats));
          } catch (err) {
            // Driver-skip signal (human ruling 2026-07-16, the paymentFailed opt-out): a driver
            // may throw 'drive-skip: <reason>' to declare a real impl precondition the spec's
            // single-aggregate state machine can't express (d2-coverage-investigation.md §4a) —
            // the walk treats it as SKIPPED, neither an accept, a reject, nor a violation.
            // CRITICAL: this prefix is honored ONLY here, in the LEGAL branch. The illegal/probe
            // branch below has its own separate catch that does NOT check for this prefix — a
            // drive-skip thrown from a spec-illegal probe still counts as an ordinary rejected
            // probe (see the pinned test), so a weakened guard can never hide behind this escape
            // hatch: the signal only ever suppresses a violation that would otherwise have fired
            // against a command the spec itself says WAS legal.
            const msg = err instanceof Error ? err.message : String(err);
            const skipPrefix = 'drive-skip:';
            if (msg.startsWith(skipPrefix)) {
              stats.driverSkips++;
              const reason = msg.slice(skipPrefix.length).trim();
              narrative.push(
                `${intention.kind} ${t.name} on ${intention.aggregate}#${id} → skipped (impl precondition: ${reason})`);
            } else {
              stats.commands++; stats.rejected++;
              violations.push(transitionViolation(t, id, source,
                `impl rejected a spec-legal command: '${t.name}' was legal from the observed pre-state ` +
                `(from-state + guard both held) but the driver threw`));
              narrative.push(describeIntention(intention, id, 'legal', 'rejected (VIOLATION)'));
            }
          }
        } else {
          stats.commands++; stats.probesAttempted++;
          const preRegionState = String(stateVal);
          try {
            driverFn(db, id, gen);
            // Post-accept re-attribution (design §2 Oracle, human ruling 2026-07-16): one impl
            // entry point can serve multiple spec transitions sharing a from-state (voidInvoice
            // ← voidDraft + voidOpen). The acceptance is a violation ONLY if no sibling
            // transition of the same aggregate+region explains the observed pre→post step —
            // from-state membership and guard both evaluated on the PRE-state we already
            // scoped-read, `to` matched against a fresh post-state read.
            let postRegionState: string | undefined;
            let vanished = false;
            try {
              const postScoped = observeScoped(db, ctx.input.model, manifest, ctx.overrides, intention.aggregate, id);
              postRegionState = String(postScoped[0]!.fields[regionKey]);
            } catch {
              vanished = true; // impl freedom: the operation may delete the row (e.g. a hard-void)
            }
            const siblings = vanished ? [] : ctx.plan.aggregates
              .find(a => a.name === intention.aggregate)?.transitions
              .filter(tr => tr.region === t.region) ?? [];
            const sibling = siblings.find(tr =>
              tr.from.includes(preRegionState) &&
              (!tr.requires || evaluateCandidate(
                { kind: 'statePredicate', aggregate: intention.aggregate, body: tr.requires },
                { entities: scoped }) === 'permit') &&
              tr.to === postRegionState);

            if (sibling) {
              stats.reattributions++;
              narrative.push(
                `probe ${t.name} on ${intention.aggregate}#${id} → accepted, re-attributed to ${sibling.name}`);
              violations.push(...stepCheck(db, ctx, manifest, `${source}:step-check`, stats));
            } else {
              const detail = vanished
                ? `impl accepted a spec-illegal command: '${t.name}' was illegal from the observed pre-state ` +
                  `but the driver accepted it without throwing, and the row was deleted post-accept — no legal ` +
                  `sibling transition could be checked, treated as unexplained`
                : `impl accepted a spec-illegal command: '${t.name}' was illegal from the observed pre-state ` +
                  `but the driver accepted it without throwing`;
              violations.push(transitionViolation(t, id, source, detail));
              narrative.push(describeIntention(intention, id, 'illegal', 'accepted (VIOLATION)'));
            }
          } catch {
            stats.probesRejected++;
            if (fromOk && !guardOk) guardedProbed.add(t.name); // illegality came from the guard, not from-state
            narrative.push(describeIntention(intention, id, 'illegal', 'rejected'));
          }
        }
      }
    }

    if (executed) {
      clock += opts.clockStep;
      if (stats.accepted > 0 && stats.accepted % opts.checkEvery === 0) runCheck(source);
    }
  }

  // Sequence-end sweep — but only if the db state has moved since the last check, or no check
  // has run at all. Without this guard, a final accepted step landing exactly on a checkEvery
  // boundary triggers an in-loop checkDb, then this unconditional sweep re-runs checkDb against
  // identical state and duplicates every live violation.
  if (lastCheckedAtAccepted === null || stats.accepted !== lastCheckedAtAccepted) {
    runCheck(`drive:${seq.length}`);
  }
  db.close();

  stats.guardedTransitionsProbed = [...guardedProbed].sort();
  return { violations, stats, narrative };
}
