import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { findJava } from './doctor.js';
import type { QuintEmission } from '../emit/quint.js';
import type { CaseEntity, CaseState } from '../engine/evaluate.js';

const exec = promisify(execFile);
export interface QuintResult { violated: boolean; witness?: CaseState; ms: number }

export async function runQuint(em: QuintEmission, maxSteps: number): Promise<QuintResult> {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'quint-'));
  const qnt = join(dir, 'q.qnt');
  const itf = join(dir, 'out.itf.json');
  writeFileSync(qnt, em.source);
  const env = { ...process.env, JAVA_HOME: dirname(dirname(findJava())) };
  try {
    await exec('npx', ['quint', 'verify', '--max-steps', String(maxSteps), '--invariant', em.invariantName, '--out-itf', itf, qnt],
      { env, timeout: 90_000 });
    return { violated: false, ms: Date.now() - t0 };            // exit 0 ⇒ invariant holds to bound
  } catch (e: any) {
    if (existsSync(itf)) {
      const witness = parseITF(JSON.parse(readFileSync(itf, 'utf8')), em.varTypes);
      return { violated: true, witness, ms: Date.now() - t0 };  // exit != 0 + trace ⇒ violation found
    }
    throw new Error(`quint verify failed without a counterexample: ${e.stderr ?? e.message}`);
  }
}

const deBig = (v: any): any => (v && typeof v === 'object' && '#bigint' in v) ? Number(v['#bigint']) : v;

function stateToEntities(st: Record<string, any>, varTypes: Record<string, string>): { now?: number; entities: CaseEntity[] } {
  const entities: CaseEntity[] = [];
  let now: number | undefined;
  for (const [k, raw] of Object.entries(st)) {
    if (k.startsWith('#')) continue;
    if (k === 'now') { now = deBig(raw); continue; }
    const type = varTypes[k];
    if (!type) continue;
    const pairs: [any, any][] = raw && raw['#map'] ? raw['#map'] : [];
    for (const [id, rec] of pairs) {
      if (rec.exists === false) continue;
      const fields: Record<string, string | number | boolean> = {};
      for (const [fk, fv] of Object.entries(rec)) {
        if (fk === 'exists') continue;
        fields[fk.replace(/_state$/, '.state')] = deBig(fv);
      }
      entities.push({ type, id: String(id), fields });
    }
  }
  return { now, entities };
}

export function parseITF(itf: any, varTypes: Record<string, string>): CaseState {
  const states: Record<string, any>[] = itf.states ?? [];
  const last = states[states.length - 1] ?? {};
  const { now, entities } = stateToEntities(last, varTypes);
  const trace = states.slice(0, -1).map(s => stateToEntities(s, varTypes).entities);
  return { now, entities, trace };
}
