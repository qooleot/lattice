// Read-model cross-checks (design §6 class 13): typed target-side instruments that recompute a
// read model's spec-covered fields independently from base tables and compare. Unlike Tier 1/2
// (which check invariants/traces the plan derives from the spec), this class is deliberately
// out-of-spec — it exists to catch derivation bugs a target's own read model might hide from
// itself. Optional: a target with no conform/crosschecks.ts runs zero of these, stated (never
// silently) in the report.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConformViolation } from './types.js';

export interface CrosscheckFinding { check: string; witnessIds: string[]; detail: string }
export type Crosscheck = (db: unknown /* better-sqlite3 Database */) => CrosscheckFinding[];
export interface CrosscheckModule { crosschecks: Record<string, Crosscheck> }

export async function loadCrosschecks(targetDir: string): Promise<CrosscheckModule | null> {
  const path = resolve(targetDir, 'conform', 'crosschecks.ts');
  if (!existsSync(path)) return null;
  const mod = await import(path) as Partial<CrosscheckModule>;
  if (!mod || typeof mod.crosschecks !== 'object' || mod.crosschecks === null) {
    throw new Error(`conform: ${path} must export 'crosschecks' (a name→function map)`);
  }
  return mod as CrosscheckModule;
}

export function runCrosschecks(db: unknown, mod: CrosscheckModule, source: string): ConformViolation[] {
  const out: ConformViolation[] = [];
  for (const [name, fn] of Object.entries(mod.crosschecks)) {
    for (const f of fn(db)) {
      out.push({
        invariant: '', specElement: `crosscheck ${name}`,
        anchors: ['target crosscheck (out-of-spec read model, design §6 class 13)'],
        witnessIds: f.witnessIds, source, detail: f.detail,
      });
    }
  }
  return out;
}
