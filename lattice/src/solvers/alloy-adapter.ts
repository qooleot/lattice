import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { ALLOY_JAR, VENDOR, findJava } from './doctor.js';
import type { CaseEntity, CaseState } from '../engine/evaluate.js';

const exec = promisify(execFile);
export interface AlloyResult { sat: boolean; instances: CaseState[]; ms: number }

async function ensureShim(java: string): Promise<void> {
  if (existsSync(join(VENDOR, 'AlloyRunner.class'))) return;
  const javac = java.replace(/java$/, 'javac');
  await exec(javac, ['-cp', ALLOY_JAR, '-d', VENDOR, join(VENDOR, 'AlloyRunner.java')]);
}

export async function runAlloy(als: string, maxInstances: number): Promise<AlloyResult> {
  const t0 = Date.now();
  const java = findJava();
  await ensureShim(java);
  const dir = mkdtempSync(join(tmpdir(), 'alloy-'));
  const file = join(dir, 'q.als');
  writeFileSync(file, als);
  const sep = process.platform === 'win32' ? ';' : ':';
  const { stdout } = await exec(java, ['-cp', `${ALLOY_JAR}${sep}${VENDOR}`, 'AlloyRunner', file, String(maxInstances), dir]);
  if (stdout.includes('UNSAT')) return { sat: false, instances: [], ms: Date.now() - t0 };
  const instances = readdirSync(dir).filter(f => f.endsWith('.xml')).sort()
    .map(f => parseInstanceXML(readFileSync(join(dir, f), 'utf8')));
  return { sat: true, instances, ms: Date.now() - t0 };
}

const asArray = <T>(x: T | T[] | undefined): T[] => x === undefined ? [] : Array.isArray(x) ? x : [x];

export function parseInstanceXML(xml: string): CaseState {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
  const inst = doc.alloy.instance;
  const entities = new Map<string, CaseEntity>();
  const sigOf = new Map<string, string>();       // sig ID -> type name
  const skip = /^(seq\/Int|Int|String|univ|none)$/;

  for (const sig of asArray<any>(inst.sig)) {
    const label: string = (sig.label as string).replace(/^this\//, '');
    sigOf.set(sig.ID, label);
    if (skip.test(label) || sig.builtin === 'yes') continue;
    for (const atom of asArray<any>(sig.atom)) {
      const id: string = atom.label;
      // "one sig" state/enum atoms (Foo$0 of a one-sig) become plain values, not entities:
      if (sig.one === 'yes') continue;
      entities.set(id, { type: label, id, fields: {} });
    }
  }
  const oneSigValue = (atomLabel: string): string => atomLabel.replace(/\$\d+$/, '');

  for (const field of asArray<any>(inst.field)) {
    const rawName: string = field.label;
    const name = rawName.replace(/_state$/, '.state');
    for (const tuple of asArray<any>(field.tuple)) {
      const atoms = asArray<any>(tuple.atom).map(a => a.label as string);
      if (atoms.length !== 2) continue;
      const owner = entities.get(atoms[0]!);
      if (!owner) continue;
      const v = atoms[1]!;
      if (/^-?\d+$/.test(v)) owner.fields[name] = Number(v);
      else if (entities.has(v)) owner.fields[name] = v;
      else owner.fields[name] = deStatePrefix(oneSigValue(v));
    }
  }
  return { entities: [...entities.values()] };
}

// Subscription_Access_Active -> Active ; USD stays USD
function deStatePrefix(v: string): string {
  const parts = v.split('_');
  return parts.length >= 3 ? parts[parts.length - 1]! : v;
}
