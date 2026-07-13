import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DomainModel } from './ast/domain.js';
import { validateModel } from './ast/validate.js';
import { validateCandidate } from './ast/grammar.js';
import type { CandidateInvariant, Candidate } from './ast/invariant.js';
import { loadState, saveState, appendLedger, readLedger, readClassifications, readGuardFindings, isoDay, type SessionState, type LedgerEntry } from './engine/session.js';
import { matchTemplates } from './engine/templates.js';
import { registerCandidates, pruneOnVerdict, admit } from './engine/hypothesis.js';
import { nextQuestion, checkDistinct, adoptedConstraints, expressibleAdopted, type SolverDeps } from './engine/planner.js';
import { classifyInvariant, type Classification } from './engine/classify.js';
import { strengthenInvariant } from './engine/strengthen.js';
import { conjunctsOf } from './engine/tier.js';
import { checkMethodGuard } from './engine/method-guard.js';
import { analyzeGuards } from './engine/guard-analysis.js';
import { renderWitnessTable } from './engine/salient.js';
import { astToAlloy } from './emit/alloy.js';
import { astToQuint } from './emit/quint.js';
import { runAlloy } from './solvers/alloy-adapter.js';
import { runQuint, runQuintVerify } from './solvers/quint-adapter.js';
import { astToProse, renderCandidateEnglish } from './emit/prose.js';
import { astToCode } from './emit/code.js';
import { specDiagramFiles } from './emit/mermaid/docs.js';
import { impliedInvariants, canonicalCandidate } from './engine/implied.js';
import { loadLatText } from './parse/fromLangium.js';
import { reconcile } from './engine/reconcile.js';
import type { RenameSpec, RenameScope } from './engine/renames.js';
import { renameEntries, currentInvariantName } from './engine/renames.js';
import { compileWorkspace } from './engine/workspace.js';
import { remapValueKeys } from './engine/witness.js';
import { loadGenInput } from './generate/load.js';
import { generateService } from './generate/generate.js';

// Both solver adapters hand back CaseStates with underscore-flattened value-field keys (design
// §3.5) — remapValueKeys is the single choke point that normalizes them to the dotted-path
// convention the rest of the engine (evaluate.ts, salient.ts, validated Candidate paths) expects.
// Wired here, at the boundary where solver results become CaseStates, rather than deeper in
// hypothesis.ts/planner.ts, so every consumer downstream of `deps.alloy`/`deps.quint` sees
// already-normalized witnesses.
export const realDeps: SolverDeps = {
  alloy: async (m, q, max) => {
    const r = await runAlloy(astToAlloy(m, q), max);
    return { ...r, instances: r.instances.map(cs => remapValueKeys(m, cs)) };
  },
  quint: async (m, q) => {
    const r = await runQuint(astToQuint(m, q), q.maxSteps);
    return { ...r, witness: r.witness ? remapValueKeys(m, r.witness) : r.witness };
  },
  quintVerify: (em, opts) => runQuintVerify(em, opts),
};

const BAD_JSON = Symbol('bad-json-or-path');
const readJson = (v: string): any => {
  try {
    return JSON.parse(v.trim().startsWith('{') || v.trim().startsWith('[') ? v : readFileSync(v, 'utf8'));
  } catch (err) {
    return { [BAD_JSON]: String(err instanceof Error ? err.message : err) };
  }
};
const isBadJson = (v: any): v is { [BAD_JSON]: string } => v != null && typeof v === 'object' && BAD_JSON in v;
const now = () => new Date().toISOString();

/** Mid-flight elicitation (design §5 step 8): apply must not race an open question loop. */
const isSessionBusy = (s: SessionState): boolean =>
  s.phase !== 'converged' || Object.keys(s.pendingWitnesses).length > 0;

const VALID_JUDGES = ['permit', 'forbid', 'undecided'] as const;
const MODEL_COMMANDS = new Set(['propose', 'next-question', 'verdict', 'regenerate', 'witness-show', 'emit', 'explain', 'classify', 'strengthen']);
// terminal/monotonic/leadsTo/refsResolve are template-adopted only (spec §7/§8): they either crash
// candidateToQuint when pair-routed against a Quint-side candidate, or (refsResolve) mis-evaluate
// on Quint witnesses that never populate the fields refsResolve's vacuous-true Alloy semantics
// assume. They must never be elicited via propose/regenerate.
const UNELICITABLE_KINDS = new Set(['terminal', 'monotonic', 'leadsTo', 'refsResolve']);
const notElicitable = (kinds: string[]) =>
  ({ error: 'not-elicitable', kinds, hint: 'these kinds are template-adopted, not elicited' });

function writeProjections(latPath: string, model: DomainModel, adopted: CandidateInvariant[],
    ledger: LedgerEntry[]): string[] {
  const outDir = dirname(latPath);
  const shapes = new Set(adopted.map(a => canonicalCandidate(a.candidate)));
  const derived = impliedInvariants(model).filter(d => !shapes.has(canonicalCandidate(d.candidate)));
  // apply --lat foo.lat rewrites foo.lat itself (spec §4); prose stays a sibling spec.prose.md
  const lat = latPath, prose = join(outDir, 'spec.prose.md');
  writeFileSync(lat, astToCode(model, adopted));
  writeFileSync(prose, astToProse(model, [...adopted, ...derived], ledger));

  const diagramPaths: string[] = [];
  for (const f of specDiagramFiles(model)) {
    const p = join(outDir, f.relPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    diagramPaths.push(p);
  }

  return [lat, prose, ...diagramPaths];
}

/** Apply's workspace hook (spec §6): if `latPath` lives inside a workspace (a `context-map.lat`
 *  sits at `dirname(dirname(latPath))`), recompile the whole workspace's diagram docs after the
 *  member spec itself was written. Diagnostics from a broken SIBLING member are reported but never
 *  block this apply — the edit here already reconciled successfully. */
function workspaceHook(latPath: string): { written: string[] } | { diagnostics: object[] } | undefined {
  const wsDir = dirname(dirname(latPath));
  if (!existsSync(join(wsDir, 'context-map.lat'))) return undefined;
  const w = compileWorkspace(wsDir);
  return w.ok ? { written: w.written } : { diagnostics: w.diagnostics };
}

/** Classify `targets` (a subset of `allAdopted`) against the FULL adopted set as peers (design
 *  §7 classifier contract: peers = everything else currently adopted, regardless of whether this
 *  call is reclassifying all of them or a scoped subset). Shared by the `classify` command (Task 3)
 *  and `classifyOnApply` (Task 4, below) so the "candidates → classified verdicts" logic exists in
 *  exactly one place. */
async function classifyAdopted(
  m: DomainModel, allAdopted: CandidateInvariant[], targets: CandidateInvariant[], deps: SolverDeps, reachSteps?: number,
): Promise<Classification[]> {
  const results: Classification[] = [];
  for (const inv of targets) {
    const peerInvs = allAdopted.filter(a => a.id !== inv.id);
    const peers = expressibleAdopted('quint', peerInvs.map(p => p.candidate));
    const peerNames = peerInvs.filter(p => peers.includes(p.candidate)).map(p => p.name);
    // Per-conjunct gate (Plan 3 Task 3): split a top-level `and` body into one Candidate per
    // conjunct and classify each separately, so the tier + caveat land per conjunct. A single-
    // conjunct invariant yields exactly one result with `conjunct` undefined (shape unchanged).
    for (const conj of conjunctsOf(inv.candidate)) {
      results.push(await classifyInvariant(m, inv, conj, peers, peerNames, deps, reachSteps));
    }
  }
  return results;
}

/** Method⊨transition entailment (design §5, Plan 2b Task 5): for every `performs` method in the
 *  model's services, flag whether its `requires` is consistent with / weaker-than / stronger-than
 *  its transition's guard. Surfaced in the `classify` output (the solver-heavy command), never on
 *  the fast read-only `status` path. Each check is two real `quint verify` probes at --max-steps 0. */
async function checkAllMethodGuards(
  m: DomainModel, deps: SolverDeps,
): Promise<{ service: string; method: string; verdict: string; reachable?: boolean }[]> {
  const out: { service: string; method: string; verdict: string; reachable?: boolean }[] = [];
  for (const svc of m.services) {
    for (const mm of svc.methods) {
      if (!('performs' in mm.kind)) continue;
      const r = await checkMethodGuard(m, svc.name, mm.name, deps);
      out.push({ service: svc.name, method: mm.name, verdict: r.verdict, reachable: r.witness !== undefined });
    }
  }
  return out;
}

/** Reclassify-on-apply (design §7.2, incremental): recompute `classified` labels only for the
 *  invariants in THIS apply's dependency set, appending fresh ledger entries for them; everything
 *  else carries forward its most recent `classified` entry untouched. Keeps full Apalache sweeps
 *  off the interactive apply path (a full sweep is still available via the standalone `classify`
 *  command).
 *
 *  Dependency-set rule implemented (conservative, scoped — design §7.2's "touched invariant/guard/
 *  field + any invariant whose body/scope references it"):
 *    - `changed` is resolved by the CALLER: on a fresh-authored session every adopted invariant is
 *      "new" (nothing to carry forward), so the caller passes the full adopted-name set; on a
 *      reconcile apply the caller passes exactly the names reconcile() itself (re)adopted this edit
 *      (its `ledgerAppends` of kind 'adopted' — the invariants whose body actually changed or that
 *      were newly added).
 *    - Only names in `changed` that are quint-expressible are reclassified here.
 *  Deliberately NOT implemented: broadening to "any adopted invariant over an aggregate whose
 *  guards/fields changed but whose own body didn't" (design §7.2's fuller rule) — reconcile's
 *  ModelDiff only reports structural adds/removes as free-text notes (src/parse/diff.ts), not a
 *  structured per-aggregate change set, and a pure guard-predicate edit on an existing transition
 *  produces no structural note at all today. Parsing those notes to approximate aggregate scope
 *  would be fragile and would pull real-solver reclassification onto structural-only edits (e.g. a
 *  bare "add a transition") that leave every invariant's *own* body untouched. Left as follow-up
 *  scope, flagged rather than silently assumed (see task-4-report.md). */
async function classifyOnApply(
  dir: string, m: DomainModel, adopted: CandidateInvariant[], changed: string[], deps: SolverDeps,
): Promise<Extract<LedgerEntry, { kind: 'classified' }>[]> {
  if (!changed.length) return [];
  const changedSet = new Set(changed);
  const classifiable = expressibleAdopted('quint', adopted.map(a => a.candidate));
  const targets = adopted.filter(a => changedSet.has(a.name) && classifiable.includes(a.candidate));
  if (!targets.length) return [];
  const results = await classifyAdopted(m, adopted, targets, deps);
  const entries = results.map(result => ({ kind: 'classified' as const, at: now(), invariant: result.invariant,
    conjunct: result.conjunct, verdict: result.verdict, tier: result.tier, caveat: result.caveat, witness: result.witness,
    reachable: result.reachable, pinnedBy: result.pinnedBy, provenance: `apply ${isoDay(now())}` }));
  for (const e of entries) appendLedger(dir, e);
  return entries;
}

type GuardCandidate = Extract<Candidate, { kind: 'guard' }>;

/** Mint the deterministic CandidateInvariant for an auto-derived guard (design §8.5-8.7): id/name
 *  from the site + shape (transition + predicate op) so the `strengthen` command and the interactive
 *  strengthening hook produce byte-identical adoptions for the same guard. Guards are never authored
 *  or proposed, so there is no pre-existing id to reuse — this is the single minting point. */
function guardCandidateInvariant(g: GuardCandidate): CandidateInvariant {
  const shape = g.predicate.kind === 'cmp' ? g.predicate.op : g.predicate.kind;
  return { id: `guard-${g.aggregate}-${g.transition}-${shape}`, name: `guard_${g.transition}_${shape}`,
    prior: 1, source: 'regen', candidate: g };
}

/** Adopt a derived guard, idempotently (design carried fix v): if a candidate with the same id is
 *  already adopted, do nothing and return null; otherwise push `{inv, status:'adopted'}` + a
 *  provenance-tagged `adopted` ledger entry and return the minted invariant. `provTag` names the
 *  path that derived it (`strengthen` for the command, `auto-strengthen` for the hook). */
function adoptGuard(s: SessionState, dir: string, g: GuardCandidate, provTag: string): CandidateInvariant | null {
  const gInv = guardCandidateInvariant(g);
  if (s.candidates.some(c => c.inv.id === gInv.id && c.status === 'adopted')) return null;
  s.candidates.push({ inv: gInv, status: 'adopted' });
  appendLedger(dir, { kind: 'adopted', at: now(), invariant: gInv, provenance: `${provTag} ${isoDay(now())}` });
  return gInv;
}

export function inferRenameSpec(path: string, to: string, m: DomainModel, invariantNames: Set<string>): RenameSpec | null {
  const segs = path.split('.');
  const from = segs[segs.length - 1]!;
  const nestedEntities = m.aggregates.flatMap(a => a.entities ?? []);
  const scope = ((): RenameScope | null => {
    if (segs.length === 1) {
      if (m.aggregates.some(a => a.name === from)) return 'aggregate';
      if (m.entities.some(e => e.name === from) || nestedEntities.some(e => e.name === from)) return 'entity';
      if (m.enums.some(e => e.name === from)) return 'enum';
      if (m.events.some(e => e.name === from)) return 'event';
      return invariantNames.has(from) ? 'invariant' : null;
    }
    const owner = m.aggregates.find(a => a.name === segs[0]) ?? m.entities.find(e => e.name === segs[0])
      ?? nestedEntities.find(e => e.name === segs[0]);
    if (segs.length === 2) {
      if (m.enums.some(e => e.name === segs[0] && e.values.includes(from))) return 'enumValue';
      if (!owner) return null;
      if (owner.fields.some(f => f.name === from)) return 'field';
      const mach = owner.kind === 'aggregate' ? owner.machine : undefined;
      if (mach?.regions.some(r => r.name === from)) return 'region';
      if (mach?.transitions.some(t => t.name === from)) return 'transition';
      return null;
    }
    if (segs.length === 3 && owner?.kind === 'aggregate'
        && owner.machine?.regions.some(r => r.name === segs[1] && r.states.some(st => st.name === from))) return 'state';
    return null;
  })();
  return scope ? { scope, path, from, to } : null;
}

export async function runCommand(argv: string[], deps: SolverDeps): Promise<object> {
  try {
    const cmd = argv[0]!;
    const { values } = parseArgs({ args: argv.slice(1), options: {
      session: { type: 'string' }, model: { type: 'string' }, candidates: { type: 'string' }, candidate: { type: 'string' },
      witness: { type: 'string' }, judge: { type: 'string' }, out: { type: 'string' }, topic: { type: 'string' }, note: { type: 'string' },
      question: { type: 'string' }, answer: { type: 'string' },
      lat: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-classify': { type: 'boolean' },
      rename: { type: 'string', multiple: true }, 'force-remove': { type: 'string', multiple: true },
      name: { type: 'string' }, workspace: { type: 'string' }, 'max-steps': { type: 'string' }
    }});

    if (cmd !== 'docs' && !values.session) return { error: 'missing-arg', arg: 'session' };
    const dir = values.session!;

    switch (cmd) {
      case 'init': if (!values.model) return { error: 'missing-arg', arg: 'model' }; break;
      case 'propose': if (!values.candidates) return { error: 'missing-arg', arg: 'candidates' }; break;
      case 'regenerate': if (!values.candidate) return { error: 'missing-arg', arg: 'candidate' }; break;
      case 'verdict':
        if (!values.witness) return { error: 'missing-arg', arg: 'witness' };
        if (!values.judge) return { error: 'missing-arg', arg: 'judge' };
        break;
      case 'witness-show': if (!values.witness) return { error: 'missing-arg', arg: 'witness' }; break;
      case 'emit': if (!values.out) return { error: 'missing-arg', arg: 'out' }; break;
      case 'generate': if (!values.out) return { error: 'missing-arg', arg: 'out' }; break;
      case 'explain': if (!values.name) return { error: 'missing-arg', arg: 'name' }; break;
      case 'strengthen': if (!values.name) return { error: 'missing-arg', arg: 'name' }; break;
      case 'structure':
        if (!values.question) return { error: 'missing-arg', arg: 'question' };
        if (!values.answer) return { error: 'missing-arg', arg: 'answer' };
        break;
      case 'apply': if (!values.lat) return { error: 'missing-arg', arg: 'lat' }; break;
      case 'sync': if (!values.lat) return { error: 'missing-arg', arg: 'lat' }; break;
      case 'docs': if (!values.workspace) return { error: 'missing-arg', arg: 'workspace' }; break;
    }

    if (cmd === 'docs') {
      const w = compileWorkspace(values.workspace!);
      return w.ok ? { written: w.written } : { error: 'workspace-invalid', diagnostics: w.diagnostics };
    }

    if (cmd === 'sync') {
      const mapPath = join(dirname(dirname(values.lat!)), 'context-map.lat');
      const { startSync } = await import('./engine/sync.js');
      startSync({ lat: values.lat!, mapPath, session: dir, deps,
        onOutcome: o => console.log(JSON.stringify(o)) });
      await new Promise(() => {});   // run until SIGINT
    }

    const s = loadState(dir);
    const model = () => s.model as DomainModel;
    const done = (out: object) => { saveState(dir, s); return out; };

    if (MODEL_COMMANDS.has(cmd) && !s.model) return { error: 'no-model', hint: 'run init first' };

    switch (cmd) {
      case 'init': {
        const m = readJson(values.model!);
        if (isBadJson(m)) return { error: 'bad-json-or-path', detail: m[BAD_JSON] };
        const diags = validateModel(m as DomainModel);
        if (diags.length) return { error: 'ill-formed-model', diagnostics: diags };
        s.model = m as DomainModel;
        const { adopt, seeds } = matchTemplates(m as DomainModel);
        for (const inv of adopt) {
          s.candidates.push({ inv, status: 'adopted' });
          appendLedger(dir, { kind: 'adopted', at: now(), invariant: inv, provenance: `template ${inv.id}` });
        }
        s.phase = 'distinguish';
        return done({ ok: true, adopted: adopt.map(a => ({ id: a.id, name: a.name })), seeds });
      }
      case 'propose': {
        const invs = readJson(values.candidates!);
        if (isBadJson(invs)) return { error: 'bad-json-or-path', detail: invs[BAD_JSON] };
        const typedInvs: CandidateInvariant[] = invs;
        const badKinds = typedInvs.map(i => i.candidate.kind).filter(k => UNELICITABLE_KINDS.has(k));
        if (badKinds.length) return notElicitable(badKinds);
        const diags = typedInvs.flatMap(i => validateCandidate(i.candidate, model()).map(d => ({ ...d, candidate: i.id })));
        if (diags.length) return { error: 'out-of-grammar', diagnostics: diags };
        registerCandidates(s, typedInvs);
        return done({ registered: typedInvs.length });
      }
      case 'next-question': {
        const out = await nextQuestion(s, readLedger(dir), model(), deps);
        if (out.type === 'converged') {
          const survivor = s.candidates.find(c => c.status === 'active');
          if (survivor) {
            const priorLedger = readLedger(dir);
            const hasVerdicts = priorLedger.some(e => e.kind === 'verdict');
            if (!hasVerdicts) {
              // Converged with zero judged cases: nothing in the ledger anchors this candidate.
              // Adopting it silently would present an un-vetted hypothesis as settled — instead
              // park it and surface an open decision for a human to confirm.
              survivor.status = 'parked';
              appendLedger(dir, { kind: 'open-decision', at: now(), topic: 'unanchored-survivor',
                note: 'converged with no judged cases; needs human confirmation' });
              return done({ ...out, warning: 'unanchored-survivor-parked' });
            }
            survivor.status = 'adopted';
            const wids = priorLedger.filter(e => e.kind === 'verdict').map(e => (e as any).witnessId).join(', ');
            appendLedger(dir, { kind: 'adopted', at: now(), invariant: survivor.inv, provenance: `elicited (${wids})` });
          }
        }
        return done(out);
      }
      case 'verdict': {
        if (!VALID_JUDGES.includes(values.judge as any)) return { error: 'invalid-judge', allowed: [...VALID_JUDGES] };
        const id = values.witness!;
        const pending = s.pendingWitnesses[id];
        if (!pending) return { error: 'unknown-witness', id };
        if (values.judge === 'undecided') {
          appendLedger(dir, { kind: 'open-decision', at: now(), topic: values.topic ?? 'unnamed', note: values.note ?? '',
            witnessId: id, salient: pending.salient, witness: pending.witness });
          for (const [k, v] of Object.entries(s.pendingWitnesses)) if (v.purpose === pending.purpose) delete s.pendingWitnesses[k];
          return done({ parked: true });
        }
        const judge = values.judge as 'permit' | 'forbid';
        appendLedger(dir, { kind: 'verdict', at: now(), witnessId: id, witness: pending.witness, salient: pending.salient, judge, question: '' });
        const r = pruneOnVerdict(s, pending.witness, judge);
        for (const [k, v] of Object.entries(s.pendingWitnesses)) if (v.purpose === pending.purpose) delete s.pendingWitnesses[k];
        return done(r);
      }
      case 'regenerate': {
        const raw = readJson(values.candidate!);
        if (isBadJson(raw)) return { error: 'bad-json-or-path', detail: raw[BAD_JSON] };
        if (UNELICITABLE_KINDS.has(raw.candidate?.kind)) return notElicitable([raw.candidate.kind]);
        const source = s.phase === 'alternatives' ? 'alternative' : 'regen';
        const inv: CandidateInvariant = { ...raw, source };
        if (source === 'alternative') {
          const survivor = s.candidates.find(c => c.status === 'active');
          if (survivor && !(await checkDistinct(survivor.inv.candidate, inv.candidate, model(), deps, adoptedConstraints(s)))) {
            s.alternativeAttempts++;
            return done({ ok: false, reason: 'equivalent to survivor over scope', attemptsLeft: 2 - s.alternativeAttempts });
          }
        }
        const r = admit(s, inv, model(), readLedger(dir));
        const attemptsLeft = source === 'regen' ? 3 - s.regenAttempts : 2 - s.alternativeAttempts;
        if (r.ok && source === 'alternative') s.phase = 'distinguish';   // a live alternative reopens the loop
        return done({ ...r, attemptsLeft });
      }
      case 'structure': {
        appendLedger(dir, { kind: 'structure', at: now(), question: values.question!, answer: values.answer! });
        return { ok: true, ledgerCount: readLedger(dir).length };
      }
      case 'status': {
        // classified entries are append-only (session.ts:29-32) — later entries supersede earlier
        // ones for the same (invariant, conjunct); keep only the latest per key before counting.
        const latestByKey = new Map<string, ReturnType<typeof readClassifications>[number]>();
        for (const e of readClassifications(dir)) latestByKey.set(`${e.invariant}::${e.conjunct ?? ''}`, e);
        const classifications = { entailed: 0, independent: 0, notInductive: 0, violated: 0 };
        for (const e of latestByKey.values()) {
          if (e.verdict === 'entailed') classifications.entailed++;
          else if (e.verdict === 'independent') classifications.independent++;
          else if (e.verdict === 'not-inductive') classifications.notInductive++;
          else if (e.verdict === 'violated') classifications.violated++;
        }
        // guard-finding entries are append-only (each `classify` run appends fresh ones) — later
        // entries supersede earlier ones for the same (owner, region, state, finding) site; keep
        // only the latest per key before counting, same pattern as `classified` entries above.
        const latestGuardByKey = new Map<string, ReturnType<typeof readGuardFindings>[number]>();
        for (const e of readGuardFindings(dir)) latestGuardByKey.set(`${e.owner}::${e.region}::${e.state}::${e.finding}`, e);
        const gf = [...latestGuardByKey.values()];
        const guardFindings = { stuck: gf.filter(e => e.finding === 'stuck').length,
                                 unreachable: gf.filter(e => e.finding === 'unreachable').length };
        return { phase: s.phase, regenAttempts: s.regenAttempts, alternativeAttempts: s.alternativeAttempts,
          candidates: s.candidates.map(c => ({ id: c.inv.id, name: c.inv.name, prior: c.inv.prior, status: c.status })),
          openDecisions: readLedger(dir).filter(e => e.kind === 'open-decision').length,
          ledgerCount: readLedger(dir).length, classifications, guardFindings };
      }
      case 'witness-show': {
        const p = s.pendingWitnesses[values.witness!];
        return p ? { table: renderWitnessTable(p.witness, model()?.ticksPerDay) } : { error: 'unknown-witness' };
      }
      case 'emit': {
        const adopted = s.candidates.filter(c => c.status === 'adopted').map(c => c.inv);
        const ledger = readLedger(dir);
        mkdirSync(values.out!, { recursive: true });
        const latPath = join(values.out!, 'spec.lat');
        const written = writeProjections(latPath, model(), adopted, ledger);
        return { written };
      }
      case 'generate': {
        const sessionDir = (values.session as string) ?? dir;
        const input = loadGenInput(sessionDir);
        const outDir = values.out!;
        const written = generateService(input, outDir);
        return { written };
      }
      case 'apply': {
        const latPath = values.lat!;
        let text: string;
        try { text = readFileSync(latPath, 'utf8'); }
        catch (err) { return { error: 'unreadable-lat', message: String(err) }; }
        const loaded = loadLatText(text);
        if (!loaded.ok) return { error: 'parse-failed', diagnostics: loaded.diagnostics };

        const sessionExists = existsSync(join(dir, 'state.json'));
        if (sessionExists && isSessionBusy(s) && s.model)
          return { error: 'session-busy', phase: s.phase, pendingWitnesses: Object.keys(s.pendingWitnesses),
            hint: 'finish or abandon the elicitation session before applying hand edits' };

        const storedModel: DomainModel | null = sessionExists
          ? (s.model ?? JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')))
          : null;
        const storedExplicit = sessionExists
          ? s.candidates.filter(c => c.status === 'adopted').map(c => c.inv) : [];

        const invariantNames = storedModel
          ? new Set([
              ...storedExplicit.map(i => i.name),
              ...impliedInvariants(storedModel).map(d => d.name)
            ])
          : new Set<string>();

        const renames: RenameSpec[] = [];
        for (const rv of values.rename ?? []) {
          const m2 = rv.match(/^([A-Za-z_][\w.]*)=([A-Za-z_]\w*)$/);
          if (!m2) return { error: 'bad-rename-flag', flag: rv, hint: 'use --rename Owner.oldName=newName' };
          const spec = inferRenameSpec(m2[1]!, m2[2]!, storedModel ?? loaded.model, invariantNames);
          if (!spec) return { error: 'unknown-rename-path', flag: rv };
          renames.push(spec);
        }

        const at = now();
        const outcomeBase = { warnings: loaded.warnings.map(w => `${w.code}: ${w.message}`) };
        if (!storedModel) {
          // hand-authored new spec (spec §5.8): everything adopts, no verdicts to contradict
          if (values['dry-run']) return { ok: true, dryRun: true, applied: ['fresh session'], ...outcomeBase };
          s.model = loaded.model;
          s.phase = 'converged';
          s.candidates = loaded.invariants.map(inv => ({ inv, status: 'adopted' as const }));
          // mkdir up front: a spec with zero invariants (e.g. an entity-only context) skips the
          // appendLedger loop below, which is otherwise what creates `dir` before this write.
          mkdirSync(dir, { recursive: true });
          for (const inv of loaded.invariants)
            appendLedger(dir, { kind: 'adopted', at, invariant: inv, provenance: `hand-authored ${isoDay(at)}` });
          writeFileSync(join(dir, 'model.json'), JSON.stringify(loaded.model, null, 2));
          const written = writeProjections(latPath, loaded.model, loaded.invariants, readLedger(dir));
          const workspace = workspaceHook(latPath);
          // fresh session: every adopted invariant is new (there is no prior classification to
          // carry forward), so the dependency set is all of them (see classifyOnApply's doc comment).
          const classified = values['no-classify'] ? undefined
            : await classifyOnApply(dir, loaded.model, loaded.invariants, loaded.invariants.map(i => i.name), deps);
          return done({ ok: true, applied: ['fresh session', ...loaded.invariants.map(i => `invariant ${i.name}`)], written,
            ...outcomeBase, ...(workspace ? { workspace } : {}),
            ...(classified ? { classification: { reclassified: classified.length } } : {}) });
        }

        const r = reconcile({ parsed: { model: loaded.model, invariants: loaded.invariants },
          storedModel, storedExplicit, ledger: readLedger(dir),
          confirmedRenames: renames, forceRemove: values['force-remove'] ?? [], at });
        const warnings = [...outcomeBase.warnings, ...r.warnings];
        if (!r.ok) return { error: 'refused', refusals: r.refusals, warnings };
        if (values['dry-run']) return { ok: true, dryRun: true, applied: r.applied, warnings };

        s.model = r.model;
        s.candidates = [
          ...s.candidates.filter(c => c.status !== 'adopted'),
          ...r.adopted.map(inv => ({ inv, status: 'adopted' as const }))];
        // Crash-window ordering: the ledger is written FIRST, deliberately. A crash after the
        // appends leaves state.json/model.json stale — re-running apply re-diffs against the old
        // model and re-appends; the append-only ledger tolerates duplicate adopted/rename entries
        // (latest wins, renames are idempotent). The reverse order is unrecoverable: state.json
        // would already match the edit, so a re-run detects no rename and historical witnesses
        // would never be remapped through the missing rename entries.
        for (const e of r.ledgerAppends) appendLedger(dir, e);
        writeFileSync(join(dir, 'model.json'), JSON.stringify(r.model, null, 2));
        const written = writeProjections(latPath, r.model, r.adopted, readLedger(dir));
        const workspace = workspaceHook(latPath);
        // reconcile: the dependency set is exactly the invariants reconcile() itself just (re)adopted
        // this edit — the 'adopted' entries it appended above (see classifyOnApply's doc comment).
        const changedNames = r.ledgerAppends
          .filter((e): e is Extract<LedgerEntry, { kind: 'adopted' }> => e.kind === 'adopted')
          .map(e => e.invariant.name);
        const classified = values['no-classify'] ? undefined
          : await classifyOnApply(dir, r.model, r.adopted, changedNames, deps);
        return done({ ok: true, applied: r.applied, written, warnings, ...(workspace ? { workspace } : {}),
          ...(classified ? { classification: { reclassified: classified.length } } : {}) });
      }
      case 'classify': {
        // Only quint-expressible kinds (statePredicate/conservation/cardinality/unique/
        // sumOverCollection) can be classified — candidateToQuint throws for the rest
        // (terminal/monotonic/leadsTo/refsResolve, template-adopted only). Filtering here keeps
        // plain `classify` (no --name) safe to run on any real session, most of which carry
        // template-adopted structural invariants of those unclassifiable kinds.
        const adoptedTracked = s.candidates.filter(c => c.status === 'adopted');
        const classifiable = adoptedTracked.filter(c => expressibleAdopted('quint', [c.inv.candidate]).length > 0);

        // A `--name` that matches no classifiable target must never silently no-op (it would
        // otherwise fall through to an empty `targets` list and return `{ classified: [] }` with
        // no signal). Distinguish the two ways that can happen: the name is adopted but its kind
        // isn't quint-expressible (template-adopted terminal/monotonic/leadsTo/refsResolve), vs.
        // no adopted invariant carries that name at all (typo, never proposed, still pending).
        if (values.name && !classifiable.some(c => c.inv.name === values.name)) {
          const adoptedMatch = adoptedTracked.find(c => c.inv.name === values.name);
          return { error: 'not-classifiable', name: values.name,
            hint: adoptedMatch
              ? `'${values.name}' is adopted with kind '${adoptedMatch.inv.candidate.kind}', which quint cannot classify`
              : `no adopted invariant named '${values.name}'` };
        }

        let reachSteps: number | undefined;
        if (values['max-steps'] !== undefined) {
          const n = Number(values['max-steps']);
          if (!Number.isInteger(n) || n <= 0) return { error: 'invalid-arg', arg: 'max-steps' };
          reachSteps = n;
        }

        const targets = values.name ? classifiable.filter(c => c.inv.name === values.name) : classifiable;

        const results = await classifyAdopted(model(), adoptedTracked.map(c => c.inv), targets.map(c => c.inv), deps, reachSteps);
        for (const result of results)
          appendLedger(dir, { kind: 'classified', at: now(), invariant: result.invariant, conjunct: result.conjunct,
            verdict: result.verdict, tier: result.tier, caveat: result.caveat, witness: result.witness,
            reachable: result.reachable, pinnedBy: result.pinnedBy, provenance: `classify ${isoDay(now())}` });
        // Method⊨transition entailment (design §5): flag every performs-method's requires vs its
        // guard. Surfaced here in `classify` (a solver command) as a `methodGuards` section.
        const methodGuards = await checkAllMethodGuards(model(), deps);
        if (values.name) return { classified: results, methodGuards };
        // Guard analysis (design §7.3): structurally-filtered stuck/reachability sites, confirmed
        // against the abstract-evolution machine. Guard findings are model-level (not invariant-
        // scoped), so this runs ONLY on bulk classify (no --name) — `--name` is the fast, scoped
        // path and must not pay for a full-model solver sweep. Surfaced here in `classify` (the
        // solver-heavy command), persisted to the ledger for `status` to count and `explain`-adjacent
        // tooling to read back later.
        const guardFindings = await analyzeGuards(model(), deps, reachSteps);
        for (const f of guardFindings)
          appendLedger(dir, { kind: 'guard-finding', at: now(), finding: f.finding, owner: f.owner,
            region: f.region, state: f.state, witness: f.witness, boundedN: f.boundedN, provenance: `classify ${isoDay(now())}` });

        // Interactive-loop strengthening hook (design §8.5-8.7, Task 6), bulk-only (mirrors the
        // guard-analysis gating above): for each ADOPTED invariant that just classified `violated`,
        // auto-invoke the CTI-guided strengthening engine against the full adopted spec. An
        // `auto-adopt` silently adopts the winning guard (idempotently, ledger-noted with an
        // `auto-strengthen` provenance) and then re-runs the §7.2 reclassify pass over that invariant
        // so a guard that now forces it reclassifies (masking coverage §8.4). Every other Resolution
        // (`inconsistent`/`no-transition`/`distinguish`) is a NON-BLOCKING finding surfaced in the
        // output — `distinguish` carries its survivors (the full interactive question wiring through
        // the planner is DEFERRED; see task-6 report). Each auto-adopt mutates `adoptedConstraints(s)`,
        // so a subsequent violated invariant's probe carries the guard just adopted (engine fix i).
        const autoStrengthened: object[] = [];
        const violatedNames = [...new Set(results.filter(r => r.verdict === 'violated').map(r => r.invariant))];
        for (const name of violatedNames) {
          const target = targets.find(c => c.inv.name === name);
          if (!target) continue;
          const res = await strengthenInvariant(model(), target.inv, adoptedConstraints(s), deps, reachSteps ?? 6);
          if (res.kind !== 'auto-adopt') { autoStrengthened.push({ invariant: name, resolution: res }); continue; }
          const gInv = adoptGuard(s, dir, res.guard, 'auto-strengthen');
          // Masking reclassify (§8.4/§8.7): re-run the on-apply classifier over just this invariant now
          // that the guard is adopted, appending a fresh `classified` entry (status/explain read the
          // latest). Reuses classifyOnApply/classifyAdopted — no hand-rolled classification.
          const reclassified = gInv
            ? await classifyOnApply(dir, model(), s.candidates.filter(c => c.status === 'adopted').map(c => c.inv), [name], deps)
            : [];
          autoStrengthened.push({ invariant: name, resolution: res, guard: gInv?.name,
            reclassified: reclassified.map(e => ({ invariant: e.invariant, verdict: e.verdict, pinnedBy: e.pinnedBy })) });
        }

        // Bulk classify (no --name): name the adopted invariants that were NOT classified, rather
        // than just dropping them — most real sessions carry template-adopted structural invariants
        // of unclassifiable kinds (see comment above), and a silent drop looks identical to "nothing
        // else was adopted".
        const skipped = adoptedTracked.filter(c => !classifiable.includes(c))
          .map(c => ({ name: c.inv.name, kind: c.inv.candidate.kind }));
        return done({ classified: results, skipped, methodGuards, guardFindings, autoStrengthened });
      }
      case 'strengthen': {
        // CTI-guided strengthening (design §8.5-8.7): resolve the named ADOPTED invariant (mirrors
        // classify --name's not-found guard — never a silent no-op) and run the generate→prune→
        // resolve engine against the rest of the adopted spec as peers.
        const adoptedTracked = s.candidates.filter(c => c.status === 'adopted');
        const target = adoptedTracked.find(c => c.inv.name === values.name);
        if (!target) return { error: 'unknown-invariant', name: values.name, hint: `no adopted invariant named '${values.name}'` };

        let reachSteps: number | undefined;
        if (values['max-steps'] !== undefined) {
          const n = Number(values['max-steps']);
          if (!Number.isInteger(n) || n <= 0) return { error: 'invalid-arg', arg: 'max-steps' };
          reachSteps = n;
        }

        // strengthenInvariant now filters its own peers (quint-expressible, self-excluded) and rides
        // adopted guards into the machine (carried fix iii), so pass raw adoptedConstraints(s).
        const res = await strengthenInvariant(model(), target.inv, adoptedConstraints(s), deps, reachSteps ?? 6);
        if (res.kind !== 'auto-adopt') return { strengthened: res };   // finding/survivors — non-blocking (Task 6: distinguish UX)

        // auto-adopt: adopt the winning guard idempotently via the shared minting/ledger helper (same
        // ids/names the interactive hook produces). A no-op (already adopted) still returns the res.
        adoptGuard(s, dir, res.guard, 'strengthen');
        return done({ strengthened: res });
      }
      case 'explain': {
        const ledger = readLedger(dir);
        const renames = renameEntries(ledger).filter(r => r.scope === 'invariant');
        const current = currentInvariantName(values.name!, renames);
        const chain = renames.filter(r => currentInvariantName(r.from, renames) === current);
        const adoptions = ledger.filter(e => e.kind === 'adopted'
          && currentInvariantName((e as any).invariant.name, renames) === current) as any[];
        const derived = impliedInvariants(model()).find(d => d.name === current);
        if (!adoptions.length && !derived) return { error: 'unknown-invariant', name: values.name };
        const latest = adoptions[adoptions.length - 1];
        const inv = latest?.invariant ?? derived!;
        const witnessIds = new Set((latest?.provenance.match(/w\d+/g) ?? []));
        const witnesses = ledger.filter(e => e.kind === 'verdict' && witnessIds.has((e as any).witnessId))
          .map(e => ({ id: (e as any).witnessId, judge: (e as any).judge, at: (e as any).at, salient: (e as any).salient ?? [] }));
        const out: any = { name: current, english: renderCandidateEnglish(inv.candidate),
          provenance: latest?.provenance ?? 'implied by structure', witnesses,
          renames: chain.map(r => ({ from: r.from, to: r.to })) };
        if (derived) {
          // set whenever the rule is CURRENTLY implied — historical adoption entries may coexist
          // (post-migration the 13 template adoptions remain in the ledger under old names)
          const c = derived.candidate;
          out.implied = c.kind === 'terminal' ? `implied by @terminal on ${c.aggregate}.${c.region}.${c.state}`
            : c.kind === 'refsResolve' ? `implied by ref fields on ${c.aggregate}`
            : `implied by Money field on ${c.aggregate}`;
        }
        // Matching `classified` entries (by resolved current name) merge in. The ledger is
        // append-only and chronological, so keep the latest per conjunct (a per-conjunct classify,
        // Plan 3 Task 3, emits one entry per conjunct — later entries supersede earlier ones).
        const classifications = readClassifications(dir).filter(e => e.invariant === current);
        const latestByConjunct = new Map<string, typeof classifications[number]>();
        for (const e of classifications) latestByConjunct.set(e.conjunct ?? '', e);
        const latestClass = [...latestByConjunct.values()];
        const classView = (e: typeof classifications[number]) => ({ verdict: e.verdict, tier: e.tier,
          caveat: e.caveat, witness: e.witness, pinnedBy: e.pinnedBy, reachable: e.reachable });
        if (latestClass.length === 1 && latestClass[0]!.conjunct === undefined) {
          // Single-conjunct invariant: keep the flat `classification` object (shape unchanged).
          out.classification = classView(latestClass[0]!);
        } else if (latestClass.length) {
          // Multi-conjunct: one classification per conjunct, tagged with its index.
          out.classifications = latestClass.map(e => ({ conjunct: e.conjunct, ...classView(e) }));
        }
        return out;
      }
      default: return { error: 'unknown-command', cmd };
    }
  } catch (err) {
    return { error: 'internal', message: String(err) };
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) runCommand(process.argv.slice(2), realDeps)
  .then(o => {
    console.log(JSON.stringify(o, null, 2));
    const err = (o as any)?.error;
    if (err) process.exitCode = err === 'internal' ? 2 : 1;
  })
  .catch(err => { console.log(JSON.stringify({ error: 'internal', message: String(err) }, null, 2)); process.exitCode = 2; });
