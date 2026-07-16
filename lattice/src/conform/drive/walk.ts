// Drive walk executor (design §3, adversarial-generation): runs a fixed sequence of Intentions
// against a live db through a target-supplied DriverModule, judging each transition/probe step
// against the REAL pre-state (scoped observe + evaluateCandidate) — the honesty gap passive mode
// declares and never closes. Post-state conformance reuses the unchanged slice-2 path (checkDb)
// untouched: this module adds a pre-state oracle in front of it, nothing more.
import type Database from 'better-sqlite3';
import { bindSchema } from '../bind.js';
import { observeScoped } from '../observe.js';
import { checkDb, type CheckContext } from '../report.js';
import { evaluateCandidate } from '../../engine/evaluate.js';
import type { PlanTransition } from '../../generate/plan.js';
import type { BindingManifest, ConformViolation } from '../types.js';
import { describeIntention, type Intention } from './intent.js';

export interface DriveOpts { checkEvery: number; clockStep: number }
export interface DriveStats {
  commands: number; accepted: number; rejected: number;
  probesAttempted: number; probesRejected: number; supersetOps: number;
  guardedTransitionsProbed: string[];
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
    supersetOps: 0, guardedTransitionsProbed: [],
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
          } catch {
            stats.commands++; stats.rejected++;
            violations.push(transitionViolation(t, id, source,
              `impl rejected a spec-legal command: '${t.name}' was legal from the observed pre-state ` +
              `(from-state + guard both held) but the driver threw`));
            narrative.push(describeIntention(intention, id, 'legal', 'rejected (VIOLATION)'));
          }
        } else {
          stats.commands++; stats.probesAttempted++;
          try {
            driverFn(db, id, gen);
            violations.push(transitionViolation(t, id, source,
              `impl accepted a spec-illegal command: '${t.name}' was illegal from the observed pre-state ` +
              `but the driver accepted it without throwing`));
            narrative.push(describeIntention(intention, id, 'illegal', 'accepted (VIOLATION)'));
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
