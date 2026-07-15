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
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';
import { checkInvariants, type OptOut } from './tier1.js';
import { renderContract } from './contract.js';
import type { BindingManifest, ConformReport, ConformViolation, OverridesModule } from './types.js';

interface ConformConfig { session: string; snapshots: string; optOuts: OptOut[] }

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
  Promise<{ report: ConformReport; exitCode: number }> {
  const cfg = readConfig(targetDir);
  const input = loadGenInput(resolve(targetDir, cfg.session));
  const plan = buildPlan(input);
  const overridesPath = resolve(targetDir, 'conform', 'overrides.ts');
  const ovModule = await import(overridesPath) as { overrides: OverridesModule };
  if (!ovModule || typeof ovModule.overrides !== 'object' || ovModule.overrides === null) {
    throw new Error(`conform: ${overridesPath} must export 'overrides' (an aggregate→field→fn map)`);
  }
  const snapDir = resolve(targetDir, cfg.snapshots);
  if (!existsSync(snapDir)) throw new Error(`conform: no snapshots at ${snapDir} — run the target's test suite first`);
  const snaps = readdirSync(snapDir).filter(f => f.endsWith('.sqlite')).sort();
  if (snaps.length === 0) throw new Error(`conform: snapshot directory ${snapDir} is empty — run the target's test suite first`);
  const violations: ConformViolation[] = [];
  let manifest: BindingManifest | undefined;
  for (const snap of snaps) {
    const db = new Database(join(snapDir, snap), { readonly: true });
    try {
      const meta = JSON.parse(readFileSync(join(snapDir, snap.replace(/\.sqlite$/, '.json')), 'utf8')) as { source: string };
      const m = bindSchema(db, input.model, ovModule.overrides);
      manifest ??= m; // first snapshot's binding fixes the manifest reported (schema is shared across snapshots)
      const entities = observeEntities(db, input.model, m, ovModule.overrides);
      violations.push(...checkInvariants(entities, plan, cfg.optOuts, meta.source));
    } finally { db.close(); }
  }
  // GenPlan has no top-level `invariants` — every invariant lives under an aggregate
  // (plan.aggregates[].invariants); guard-kind candidates are transition-enablement conditions
  // that checkInvariants skips entirely (Tier 2's concern), so they don't count as "checked" here.
  const allInvariants = plan.aggregates.flatMap(a => a.invariants);
  const report: ConformReport = {
    target: targetDir, snapshots: snaps.length,
    invariantsChecked: allInvariants.filter(i => i.candidate.kind !== 'guard').length,
    optOuts: cfg.optOuts, violations, residual: residual(manifest!),
  };
  const exitCode = mode === 'enforce' && violations.length > 0 ? 1 : 0;
  return { report, exitCode };
}

export function formatReport(r: ConformReport): string {
  const lines = [
    `conform ${r.target}`,
    `${r.violations.length} violations across ${r.snapshots} snapshots (${r.invariantsChecked} invariants checked)`,
    `residual surface: auto-bound ${r.residual.autoBound}/${r.residual.total} fields ` +
      `(${Math.round((100 * r.residual.autoBound) / r.residual.total)}%), ${r.residual.overridden} overridden`,
    ...r.optOuts.map(o => `OPT-OUT ${o.invariant} — ${o.reason}`),
    ...r.violations.map(v =>
      `VIOLATION ${v.invariant} (${v.specElement}) — witnesses [${v.witnessIds.join(', ')}] — ` +
      `${v.detail} — anchors [${v.anchors.join('; ')}] — source ${v.source}`),
  ];
  return lines.join('\n');
}
