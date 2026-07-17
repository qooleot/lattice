import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { findJava } from './doctor.js';
import type { QuintEmission } from '../emit/quint.js';
import type { CaseEntity, CaseState } from '../engine/evaluate.js';
import { childVarKey } from '../engine/owned.js';

const exec = promisify(execFile);
type ExecLike = (file: string, args: string[], opts: object) => Promise<{ stdout: string }>;
export interface QuintResult { violated: boolean; witness?: CaseState; ms: number }

// Every `quint verify` spawns its own Apalache JVM and SIGTERMs it when the quint process exits;
// quint's DEFAULT server endpoint is the fixed port 8822. On that shared port, a back-to-back
// verify races the previous call's dying JVM (and any other checkout's concurrently-running
// lattice tests): the fresh JVM fails to bind ("Address already in use"), quint connects to the
// dying server instead, and the call dies mid-request. Observed live (golden trace C):
// "14 UNAVAILABLE: Connection dropped" and "13 INTERNAL: Received RST_STREAM with code 0".
// Since no server ever outlives its quint process, the shared port buys nothing — so each
// invocation gets its own ephemeral port, which removes the race at the root.
const randomPort = () => 20000 + Math.floor(Math.random() * 40000);

// Residual transients that a unique port can't rule out: the random port is occupied by a foreign
// service (quint then fails to bind its own server), or a slow cold JVM start blows quint's 5s
// reflection deadline ("Error querying reflection endpoint"). Retried ONCE, on a fresh port.
// Deterministic failures (parse, typecheck, name resolution) never match and fail immediately.
const TRANSIENT_QUINT =
  /UNAVAILABLE|RST_STREAM|DEADLINE_EXCEEDED|Failed to bind to address|Error querying reflection endpoint|Failed to launch Apalache server/;

async function verifyWithArgs(em: QuintEmission, extraArgs: string[], execImpl: ExecLike): Promise<QuintResult> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), 'quint-'));
    const qnt = join(dir, 'q.qnt');
    const itf = join(dir, 'out.itf.json');
    writeFileSync(qnt, em.source);
    const env = { ...process.env, JAVA_HOME: dirname(dirname(findJava())) };
    try {
      await execImpl('npx', ['quint', 'verify',
        '--server-endpoint', `localhost:${randomPort()}`, '--out-itf', itf, ...extraArgs, qnt],
        { env, timeout: 90_000 });
      return { violated: false, ms: Date.now() - t0 };            // exit 0 ⇒ invariant holds to bound
    } catch (e: any) {
      if (existsSync(itf)) {
        const witness = parseITF(JSON.parse(readFileSync(itf, 'utf8')), em.varTypes);
        return { violated: true, witness, ms: Date.now() - t0 };  // exit != 0 + trace ⇒ violation found
      }
      if (attempt === 0 && TRANSIENT_QUINT.test(`${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`)) {
        await sleep(1000);                                        // let the dying JVM release the port
        continue;
      }
      throw new Error(`quint verify failed without a counterexample: ${e.stderr ?? e.message}`);
    }
  }
}

export async function runQuint(em: QuintEmission, maxSteps: number, execImpl: ExecLike = exec): Promise<QuintResult> {
  return verifyWithArgs(em, ['--max-steps', String(maxSteps), '--invariant', em.invariantName], execImpl);
}

export interface VerifyOpts {
  maxSteps: number;
  init?: string;        // custom --init action name (default: the module's 'init')
  invariant?: string;   // --invariant def name (default: em.invariantName)
}

export async function runQuintVerify(em: QuintEmission, opts: VerifyOpts, execImpl: ExecLike = exec): Promise<QuintResult> {
  const args: string[] = [];
  if (opts.init) args.push('--init', opts.init);
  args.push('--max-steps', String(opts.maxSteps), '--invariant', opts.invariant ?? em.invariantName);
  return verifyWithArgs(em, args, execImpl);
}

const deBig = (v: any): any => (v && typeof v === 'object' && '#bigint' in v) ? Number(v['#bigint']) : v;

// A value instance in ITF (design §3.5): quint encodes a value-typed field as an inline nested
// record (astToQuint's fieldQType value case — `period: { start: int, end: int }`), which ITF
// renders as a PLAIN object. Every other ITF composite announces itself with a `#`-prefixed tag
// (`#map` for owned collections/refs, `#bigint` for integers, `#set`/`#tup` elsewhere), so "no
// `#` key" is exactly "this is a value record". Checked over all keys rather than the two tags
// that happen to appear here, so a future tagged form is never mistaken for a value.
const isValueRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  !Object.keys(v as object).some(k => k.startsWith('#'));

/**
 * Flatten a value record to underscore-joined LEAF keys, so BOTH adapters produce the same
 * underscore-flattened shape (Alloy does this natively via its sig relation names) — remapValueKeys
 * (witness.ts) is the single downstream point that converts those to the dotted-path convention the
 * rest of the engine expects.
 *
 * Values NEST (slice B2), so this recurses to arbitrary DEPTH, driven by the record's own structure
 * (which IS the declaration, flattened by the emitter). It used to flatten exactly one level, which
 * for `total : Outer` / `value Outer { inner : Amount }` bound `total_inner` to the raw, un-deBig'd
 * ITF sub-record: no `total_inner_amount` key for the judge to read (so it PERMITTED what Apalache
 * FORBADE), and renderWitnessTable printed `total.inner: [object Object]` to the human. Recursing
 * to the leaves is also what guarantees every bound value is deBig'd — an object only ever reaches
 * `out[key]` once it has no further record structure to descend.
 */
function flattenValueRecord(prefix: string, rec: Record<string, unknown>,
    out: Record<string, string | number | boolean>): void {
  for (const [sk, sv] of Object.entries(rec)) {
    const key = `${prefix}_${sk}`;
    if (isValueRecord(sv)) flattenValueRecord(key, sv, out);
    else out[key] = deBig(sv);
  }
}

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
      const children: CaseEntity[] = [];
      for (const [fk, fv] of Object.entries(rec)) {
        if (fk === 'exists') continue;
        // Owned collection (design §6.1): ITF encodes the bounded map as `{'#map': [[k, v], …]}`.
        // Only entries below the companion `<f>Count` are live; the rest are unreachable filler.
        if (fv !== null && typeof fv === 'object' && '#map' in (fv as any)) {
          const childType = varTypes[childVarKey(k, fk)];
          if (!childType) continue;                       // not an owned collection — ignore
          const count = Number(deBig((rec as any)[`${fk}Count`] ?? 0));
          for (const [ck, cv] of (fv as any)['#map']) {
            if (Number(deBig(ck)) >= count) continue;     // beyond <f>Count: not live
            const cf: Record<string, string | number | boolean> = { owner: String(id) };
            // Same value-record flatten as the owner branch below: a CHILD may declare a
            // value-typed field too, and implied.ts's valueLawInstances derives that value's laws
            // at the child's use site, so the child's witness keys must reach the judge in the same
            // underscore-flattened shape remapValueKeys knows how to dot.
            for (const [k2, v2] of Object.entries(cv as Record<string, unknown>)) {
              if (isValueRecord(v2)) flattenValueRecord(k2, v2, cf);
              else cf[k2] = deBig(v2);
            }
            children.push({ type: childType, id: `${String(id)}#${fk}${Number(deBig(ck))}`, fields: cf });
          }
          continue;
        }
        if (fk.endsWith('Count') && varTypes[childVarKey(k, fk.slice(0, -'Count'.length))]) {
          fields[`${fk.slice(0, -'Count'.length)}.count`] = deBig(fv); continue;
        }
        // Value fields (design §3.5) — see flattenValueRecord for the shape and the recursion.
        if (isValueRecord(fv)) { flattenValueRecord(fk, fv, fields); continue; }
        fields[fk.replace(/_state$/, '.state')] = deBig(fv);
      }
      entities.push({ type, id: String(id), fields }, ...children);
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
