// Conform report + orchestration (spec plan §4): reads a target's conform.config.json, replays
// every captured snapshot through bind → observe → checkInvariants, and aggregates the results
// into a ConformReport. `formatReport` renders it as human-readable text — the CLI's `lattice
// conform` verb is a thin wrapper around this module (never silent: an empty/missing snapshot
// dir is a harness error, not a clean pass — see runConform below).
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadGenInput } from '../generate/load.js';
import { buildPlan } from '../generate/plan.js';
import type { GenInput } from '../generate/types.js';
import type { GenPlan } from '../generate/plan.js';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';
import { checkInvariants, type OptOut } from './tier1.js';
import { checkTraces, type ObservedEvent } from './trace.js';
import { loadCrosschecks, runCrosschecks, type CrosscheckModule } from './crosscheck.js';
import { renderContract } from './contract.js';
import { appendLedger } from '../engine/session.js';
import type { BindingManifest, ConformReport, ConformViolation, OverridesModule } from './types.js';
import { runCampaign, type CampaignOpts, type CampaignResult } from './drive/campaign.js';
import type { DriverModule } from './drive/walk.js';

// `schema` is optional (design §3, Task 6): only `--drive` needs it (drive mode opens `:memory:`
// and executes the target's schema fresh per sequence — no captured snapshots involved), so a
// target that never runs `--drive` never has to declare it.
interface ConformConfig { session: string; snapshots: string; optOuts: OptOut[]; schema?: string }

// Shared post-state check context, built once per `runConform` call and threaded into `checkDb`
// for every snapshot — this is also the seam passive and (future) drive modes share, since both
// need to run the identical bind → observe → tier1 → trace → crosschecks path against a db handle.
export interface CheckContext {
  input: GenInput; plan: GenPlan; overrides: OverridesModule;
  crosschecks: CrosscheckModule | null; optOuts: OptOut[];
}

export interface CheckDbResult {
  violations: ConformViolation[]; traceRowsChecked: number; manifest: BindingManifest;
}

// Runs the full post-state check path against a single open db: bind → observe → tier1 → trace →
// crosschecks, in that order (order matters for violation-list stability, not correctness).
export function checkDb(db: Database.Database, ctx: CheckContext, source: string): CheckDbResult {
  const violations: ConformViolation[] = [];
  const manifest = bindSchema(db, ctx.input.model, ctx.overrides);
  const entitiesArr = observeEntities(db, ctx.input.model, manifest, ctx.overrides);
  violations.push(...checkInvariants(entitiesArr, ctx.plan, ctx.optOuts, source));
  const events = db.prepare(
    'SELECT id as seq, event_type as eventType, aggregate_id as aggregateId FROM outbox ORDER BY id'
  ).all() as ObservedEvent[];
  const trace = checkTraces(entitiesArr, events, ctx.plan.aggregates, source);
  violations.push(...trace.violations);
  if (ctx.crosschecks) violations.push(...runCrosschecks(db, ctx.crosschecks, source));
  return { violations, traceRowsChecked: trace.rowsChecked, manifest };
}

function readConfig(targetDir: string): ConformConfig {
  return JSON.parse(readFileSync(join(targetDir, 'conform', 'conform.config.json'), 'utf8')) as ConformConfig;
}

export async function writeContract(targetDir: string): Promise<string> {
  const cfg = readConfig(targetDir);
  const { model } = loadGenInput(resolve(targetDir, cfg.session));
  const path = join(targetDir, 'conform', 'spec-state.ts');
  writeFileSync(path, renderContract(model));
  return path;
}

function residual(manifest: BindingManifest): ConformReport['residual'] {
  const all = manifest.aggregates.flatMap(a => a.fields);
  return {
    autoBound: all.filter(f => f.kind === 'auto').length,
    overridden: all.filter(f => f.kind === 'override').length,
    total: all.length + manifest.aggregates.reduce((n, a) => n + a.unbound.length, 0),
  };
}

export async function runConform(targetDir: string, mode: 'report' | 'enforce'):
  Promise<{ report: ConformReport; exitCode: number; ledgerError?: string }> {
  const startedAt = Date.now();
  const cfg = readConfig(targetDir);
  const sessionDir = resolve(targetDir, cfg.session);
  const input = loadGenInput(sessionDir);
  const plan = buildPlan(input);
  const overridesPath = resolve(targetDir, 'conform', 'overrides.ts');
  const ovModule = await import(overridesPath) as { overrides: OverridesModule };
  if (!ovModule || typeof ovModule.overrides !== 'object' || ovModule.overrides === null) {
    throw new Error(`conform: ${overridesPath} must export 'overrides' (an aggregate→field→fn map)`);
  }
  const cc = await loadCrosschecks(targetDir);
  const snapDir = resolve(targetDir, cfg.snapshots);
  if (!existsSync(snapDir)) throw new Error(`conform: no snapshots at ${snapDir} — run the target's test suite first`);
  const snaps = readdirSync(snapDir).filter(f => f.endsWith('.sqlite')).sort();
  if (snaps.length === 0) throw new Error(`conform: snapshot directory ${snapDir} is empty — run the target's test suite first`);
  const violations: ConformViolation[] = [];
  let manifest: BindingManifest | undefined;
  let traceRows = 0;
  // Derive guardedTransitions from the machine, not observed rows: compute from plan.aggregates
  // unconditionally so no-row aggregates still appear in the "guards NOT evaluated" line.
  const guardedTransitions = plan.aggregates
    .flatMap(a => a.transitions)
    .filter(t => t.requires)
    .map(t => t.name)
    .sort();
  const guardedSet = new Set(guardedTransitions);
  const ctx: CheckContext = { input, plan, overrides: ovModule.overrides, crosschecks: cc, optOuts: cfg.optOuts };
  for (const snap of snaps) {
    const db = new Database(join(snapDir, snap), { readonly: true });
    try {
      const meta = JSON.parse(readFileSync(join(snapDir, snap.replace(/\.sqlite$/, '.json')), 'utf8')) as { source: string };
      const result = checkDb(db, ctx, meta.source);
      manifest ??= result.manifest; // first snapshot's binding fixes the manifest reported (schema is shared across snapshots)
      violations.push(...result.violations);
      traceRows += result.traceRowsChecked;
    } finally { db.close(); }
  }
  // GenPlan has no top-level `invariants` — every invariant lives under an aggregate
  // (plan.aggregates[].invariants); guard-kind candidates are transition-enablement conditions
  // that checkInvariants skips entirely (Tier 2's concern), so they don't count as "checked"
  // here. Opted-out invariants are likewise skipped by checkInvariants (never evaluated), so an
  // "N invariants checked" header must exclude them too — by the time we get here every opt-out
  // has already been validated (checkInvariants throws on a reasonless or phantom one), so the
  // subtraction is safe.
  const allInvariants = plan.aggregates.flatMap(a => a.invariants);
  const skippedOptOuts = new Set(cfg.optOuts.map(o => o.invariant));
  const report: ConformReport = {
    target: targetDir, snapshots: snaps.length,
    invariantsChecked: allInvariants.filter(i => i.candidate.kind !== 'guard' && !skippedOptOuts.has(i.name)).length,
    optOuts: cfg.optOuts, violations, residual: residual(manifest!),
    traceRowsChecked: traceRows, guardedTransitions,
    crosschecks: cc ? Object.keys(cc.crosschecks) : [],
    durationMs: Date.now() - startedAt,
  };
  const exitCode = mode === 'enforce' && violations.length > 0 ? 1 : 0;
  let ledgerError: string | undefined;
  try {
    appendLedger(sessionDir, {
      kind: 'conformance', at: new Date().toISOString(), target: resolve(targetDir), mode,
      snapshots: report.snapshots, invariantsChecked: report.invariantsChecked,
      traceRowsChecked: report.traceRowsChecked, violationCount: report.violations.length,
      violations: report.violations.map(v => ({ specElement: v.specElement, anchors: v.anchors,
        witnessIds: v.witnessIds, source: v.source, detail: v.detail })),
      residual: report.residual, optOuts: report.optOuts, crosschecks: report.crosschecks, durationMs: report.durationMs,
    });
  } catch (e) { ledgerError = e instanceof Error ? e.message : String(e); }
  return { report, exitCode, ledgerError };
}

export interface DriveCliOpts { sequences: number; length: number; seed: number; checkEvery: number; probeRate: number }

// A pinned monotonic clock step, not CLI-configurable (design §3, Task 6): real time never leaks
// into a drive sequence (walk.ts's own clock is a pure counter), so there's nothing a user could
// meaningfully tune here beyond what --sequences/--length/--seed/--check-every/--probe-rate cover.
const DRIVE_CLOCK_STEP = 60;

export async function runDrive(targetDir: string, opts: DriveCliOpts):
  Promise<{ result: CampaignResult; exitCode: number; ledgerError?: string }> {
  const cfg = readConfig(targetDir);
  const sessionDir = resolve(targetDir, cfg.session);
  const input = loadGenInput(sessionDir);
  const plan = buildPlan(input);
  const overridesPath = resolve(targetDir, 'conform', 'overrides.ts');
  const ovModule = await import(overridesPath) as { overrides: OverridesModule };
  if (!ovModule || typeof ovModule.overrides !== 'object' || ovModule.overrides === null) {
    throw new Error(`conform: ${overridesPath} must export 'overrides' (an aggregate→field→fn map)`);
  }
  const cc = await loadCrosschecks(targetDir);

  // Shape-validated like overrides — a module without a usable `drivers` export is a harness
  // error, not a clean pass. Checked BEFORE the schema-key requirement below (report.test.ts pins
  // this order): an empty stub module is a config error on its own terms, independent of whether
  // --drive could even open a db yet.
  const drivePath = resolve(targetDir, 'conform', 'drive.ts');
  if (!existsSync(drivePath)) {
    throw new Error(`conform --drive: ${drivePath} must export 'drivers' (a transitions/superset/create map) — file not found`);
  }
  const driveModule = await import(drivePath) as
    { drivers?: DriverModule['drivers']; supersetAggregates?: Record<string, string> };
  const d = driveModule?.drivers;
  if (!d || typeof d !== 'object' || typeof d.transitions !== 'object' || d.transitions === null ||
      Object.keys(d.transitions).length === 0 || typeof d.create !== 'object' || d.create === null ||
      Object.keys(d.create).length === 0) {
    throw new Error(`conform --drive: ${drivePath} must export 'drivers' with non-empty 'transitions' and 'create'`);
  }
  if (!cfg.schema) {
    throw new Error(
      `conform --drive: ${join(targetDir, 'conform', 'conform.config.json')} has no "schema" key ` +
      `(e.g. "src/schema.sql") — drive mode opens a fresh in-memory db per sequence and needs to know how`);
  }
  const schemaSql = readFileSync(resolve(targetDir, cfg.schema), 'utf8');
  const mkDb = (): Database.Database => { const db = new Database(':memory:'); db.exec(schemaSql); return db; };

  const ctx: CheckContext = { input, plan, overrides: ovModule.overrides, crosschecks: cc, optOuts: cfg.optOuts };
  const supersetNames = Object.keys(d.superset ?? {});
  // Superset binding (measured, d2-coverage-investigation.md §2 F3): a target MAY export
  // `supersetAggregates` (op name → the aggregate it actually targets) alongside `drivers` —
  // missing entirely is a valid "no binding declared" answer, not an error, so every superset op
  // keeps the prior random-aggregate behavior until a target opts in.
  const supersetTargets = driveModule.supersetAggregates ?? {};
  const campaignOpts: CampaignOpts = {
    sequences: opts.sequences, length: opts.length, seed: opts.seed,
    checkEvery: opts.checkEvery, probeRate: opts.probeRate, clockStep: DRIVE_CLOCK_STEP,
  };
  const result = runCampaign(mkDb, { drivers: d }, ctx, plan, supersetNames, campaignOpts, supersetTargets);

  // residual/invariantsChecked/crosschecks mirror runConform's ledger fields exactly (same bind →
  // plan → crosscheck-declaration facts, mode-independent) so `readConformance` readers never need
  // a mode-conditional shape; a throwaway db supplies the one-off binding manifest drive mode
  // otherwise has no reason to keep around after the campaign closes every db it opens itself.
  const probeDb = mkDb();
  const manifest = bindSchema(probeDb, input.model, ovModule.overrides);
  probeDb.close();
  const allInvariants = plan.aggregates.flatMap(a => a.invariants);
  const skippedOptOuts = new Set(cfg.optOuts.map(o => o.invariant));
  const violations = result.clean ? [] : result.failure!.violations;

  const exitCode = result.clean ? 0 : 1;
  let ledgerError: string | undefined;
  try {
    appendLedger(sessionDir, {
      kind: 'conformance', at: new Date().toISOString(), target: resolve(targetDir), mode: 'drive',
      snapshots: 0, // no captured snapshots in drive mode — sequence count lives under `drive`
      invariantsChecked: allInvariants.filter(i => i.candidate.kind !== 'guard' && !skippedOptOuts.has(i.name)).length,
      traceRowsChecked: 0, // not tracked at campaign granularity (walk.ts checks it per-step internally)
      violationCount: violations.length,
      violations: violations.map(v => ({ specElement: v.specElement, anchors: v.anchors,
        witnessIds: v.witnessIds, source: v.source, detail: v.detail })),
      residual: residual(manifest), optOuts: cfg.optOuts, crosschecks: cc ? Object.keys(cc.crosschecks) : [],
      durationMs: result.durationMs,
      drive: {
        sequences: result.sequencesRun, seed: opts.seed,
        probesAttempted: result.stats.probesAttempted, probesRejected: result.stats.probesRejected,
        guardedTransitionsProbed: result.stats.guardedTransitionsProbed,
        reattributions: result.stats.reattributions,
        driverSkips: result.stats.driverSkips,
        ...(result.clean ? {} : { shrunk: result.failure!.narrative }),
      },
    });
  } catch (e) { ledgerError = e instanceof Error ? e.message : String(e); }
  return { result, exitCode, ledgerError };
}

export function formatReport(r: ConformReport): string {
  const lines = [
    `conform ${r.target}`,
    `${r.violations.length} violations across ${r.snapshots} snapshots (${r.invariantsChecked} invariants checked)`,
    `residual surface: auto-bound ${r.residual.autoBound}/${r.residual.total} fields ` +
      `(${Math.round((100 * r.residual.autoBound) / r.residual.total)}%), ${r.residual.overridden} overridden`,
    `tier 2: ${r.traceRowsChecked} row-traces checked against the machine`,
    `crosschecks: ${r.crosschecks.length ? r.crosschecks.join(', ') : 'none declared'}`,
    ...(r.guardedTransitions.length
      ? [`guards NOT evaluated at event time (pre-state unobserved in passive mode): ${r.guardedTransitions.join(', ')}`]
      : []),
    ...r.optOuts.map(o => `OPT-OUT ${o.invariant} — ${o.reason}`),
    ...r.violations.map(v =>
      `VIOLATION ${v.invariant || v.specElement} (${v.specElement}) — witnesses [${v.witnessIds.join(', ')}] — ` +
      `${v.detail} — anchors [${v.anchors.join('; ')}] — source ${v.source}`),
    `duration ${(r.durationMs / 1000).toFixed(1)}s — budget 60s ${r.durationMs <= 60_000 ? 'OK' : 'EXCEEDED'}`,
  ];
  return lines.join('\n');
}
