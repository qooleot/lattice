import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DomainModel } from './ast/domain.js';
import { validateModel } from './ast/validate.js';
import { validateCandidate } from './ast/grammar.js';
import type { CandidateInvariant, Candidate } from './ast/invariant.js';
import { loadState, saveState, appendLedger, readLedger, readClassifications, readGuardFindings, readGuardSweeps, readMethodGuards, isoDay, type SessionState, type LedgerEntry } from './engine/session.js';
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
  // Adopted GUARD candidates (I-1 fix): guards are machine assumptions, not always-property peers —
  // expressibleAdopted filters them out of `peers` (candidateToQuint throws on the guard kind), so
  // they must be collected SEPARATELY and threaded into classifyInvariant's `guards` channel (which
  // rides them into the classify machine's `trans_` actions). Mirrors strengthenInvariant keeping
  // `machineAdopted` guards apart from its filtered `peers`. Without this the classify machine is
  // guard-blind and the §8.4 masking reclassify is inert on real quint.
  const guards = allAdopted.filter(a => a.candidate.kind === 'guard').map(a => a.candidate);
  for (const inv of targets) {
    const peerInvs = allAdopted.filter(a => a.id !== inv.id);
    const peers = expressibleAdopted('quint', peerInvs.map(p => p.candidate));
    const peerNames = peerInvs.filter(p => peers.includes(p.candidate)).map(p => p.name);
    // Per-conjunct gate (Plan 3 Task 3): split a top-level `and` body into one Candidate per
    // conjunct and classify each separately, so the tier + caveat land per conjunct. A single-
    // conjunct invariant yields exactly one result with `conjunct` undefined (shape unchanged).
    for (const conj of conjunctsOf(inv.candidate)) {
      results.push(await classifyInvariant(m, inv, conj, peers, peerNames, deps, reachSteps, guards));
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

/** The single-conjunct CandidateInvariant for a violated per-conjunct classify result, so
 *  strengthenInvariant sees a cmp/implies body (not an `and`) — E2E finding #2. `conjunct` is the
 *  index string from the Classification; undefined ⇒ the invariant is single-conjunct (pass as-is). */
function conjunctTarget(inv: CandidateInvariant, conjunct?: string): CandidateInvariant {
  if (conjunct === undefined) return inv;
  const parts = conjunctsOf(inv.candidate);
  const part = parts.find(p => p.conjunct === conjunct) ?? parts[Number(conjunct)];
  return part ? { ...inv, candidate: part.candidate } : inv;
}

/** Peers to hand strengthenInvariant when targeting one conjunct of `inv`: `adoptedConstraints(s)`
 *  minus `inv`'s own (parent, possibly `and`-bodied) candidate. Required in addition to
 *  conjunctTarget: `inv` stays ADOPTED (and thus present in `adoptedConstraints(s)`) while we probe a
 *  single conjunct of it, and strengthenInvariant's own self-exclusion (`c !== violated.candidate`)
 *  only catches the parent in the single-conjunct case, where the candidate passed as `violated` IS
 *  the adopted one by reference. For a conjunct, `violated.candidate` is a FRESH sub-object
 *  (conjunctTarget's `{ ...c, body: a }`), so the parent's full `and` body would otherwise survive the
 *  filter as an unfiltered peer — and since the parent tautologically implies its own conjunct, that
 *  peer makes strengthenInvariant's CTI probe (`adopted implies Hi`) vacuously unviolated, silently
 *  masking a real violation as `no-transition` (confirmed on real quint: leaving the parent in
 *  `adopted` for the settle-guard-stripped `neverOverpaidAndPaidExact` conjunct 1 reports
 *  `no-transition`, filtering it out reports `auto-adopt`). */
function peersExcludingParent(s: SessionState, inv: CandidateInvariant): Candidate[] {
  return adoptedConstraints(s).filter(c => c !== inv.candidate);
}

/** Every adopted (non-guard) invariant name scoped to `aggregate` — the reclassify dependency set
 *  after adopting a guard on that aggregate (design §7.2 aggregate-scope, guard case). */
function aggregateScopedNames(s: SessionState, aggregate: string): string[] {
  return s.candidates.filter(c => c.status === 'adopted'
    && (c.inv.candidate as any).aggregate === aggregate
    && c.inv.candidate.kind !== 'guard')
    .map(c => c.inv.name);
}

/** Guard-change staleness detector (item 3, sub-fix a): a transition's `requires` guard can change
 *  on a hand-edit apply WITHOUT any invariant BODY changing — reconcile's `ledgerAppends` only
 *  record invariant adoptions (a pure guard-predicate edit on an existing transition produces no
 *  structural note at all today, per classifyOnApply's doc comment above), so a bare guard edit
 *  leaves classifications silently stale: the classify machine's masking channel (I-1) changed, but
 *  nothing in the reconcile/reclassify path re-triggers a classify run. Flags every `(aggregate,
 *  transition)` whose `requires` differs between `storedModel` and `newModel`, EXCLUDING aggregates
 *  that already had an invariant (re)adopted this apply — `classifyOnApply` already reclassifies
 *  those, so a redundant warning there would just be noise. Transition add/remove counts as a guard
 *  change too (the missing side's `requires` is treated as absent, via `?? null`). Compares by
 *  `(aggregate.name, transition.name)`, not object identity — transitions can reorder across an edit
 *  without that being a "change". */
function guardChangeWarnings(storedModel: DomainModel, newModel: DomainModel, adoptedAggregates: Set<string>): string[] {
  const warnings: string[] = [];
  for (const a of newModel.aggregates) {
    if (adoptedAggregates.has(a.name)) continue;
    const oldAgg = storedModel.aggregates.find(o => o.name === a.name);
    const oldTs = new Map((oldAgg?.machine?.transitions ?? []).map(t => [t.name, t]));
    const newTs = new Map((a.machine?.transitions ?? []).map(t => [t.name, t]));
    for (const tName of new Set([...oldTs.keys(), ...newTs.keys()])) {
      const oldReq = JSON.stringify(oldTs.get(tName)?.requires ?? null);
      const newReq = JSON.stringify(newTs.get(tName)?.requires ?? null);
      if (oldReq !== newReq)
        warnings.push(`classifications may be stale: guard changed on ${a.name}.${tName} — run classify`);
    }
  }
  return warnings;
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
      name: { type: 'string' }, workspace: { type: 'string' }, 'max-steps': { type: 'string' }, conjunct: { type: 'string' },
      choose: { type: 'string' }
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
        // guard-finding entries are append-only (each `classify` run appends fresh ones) and NEVER
        // individually retracted: a site that stops being flagged after a model edit + re-classify
        // simply has no entry in the newest run, but its old entry is still sitting in the ledger.
        // Latest-per-key dedup alone (below) would keep counting that stale entry forever, because
        // "latest for its key" and "latest run overall" are different things once a site clears.
        // Fix (item 3b, run-stamp approach): every `guard-finding` a bulk `classify` run appends
        // shares one `run` stamp (see the `classify` case), and each such run also appends exactly
        // one `guard-sweep` marker — including runs that find nothing — so the true latest run is
        // always resolvable even when it cleared every site. Resolve the latest run from the sweep
        // stream (ledger is append-only/chronological, so the last sweep IS the latest run), filter
        // findings to that run, THEN dedup latest-per-key as a secondary guard (defensive: a single
        // run should never repeat a key, but this keeps the invariant honest either way). Ledgers
        // with no `guard-sweep` entries at all (pre-item-3, never re-classified since) fall back to
        // the old un-filtered behavior — there is no run concept to anchor to.
        const sweeps = readGuardSweeps(dir);
        const latestRun = sweeps.length ? sweeps[sweeps.length - 1]!.run : undefined;
        const allFindings = readGuardFindings(dir);
        const currentFindings = latestRun !== undefined ? allFindings.filter(e => e.run === latestRun) : allFindings;
        const latestGuardByKey = new Map<string, ReturnType<typeof readGuardFindings>[number]>();
        for (const e of currentFindings) latestGuardByKey.set(`${e.owner}::${e.region}::${e.state}::${e.finding}`, e);
        const gf = [...latestGuardByKey.values()];
        const guardFindings = { stuck: gf.filter(e => e.finding === 'stuck').length,
                                 unreachable: gf.filter(e => e.finding === 'unreachable').length };
        // method-guard entries are append-only (each `classify` run appends fresh ones per
        // service::method) — dedup latest-per-key before counting by verdict, same treatment as
        // `classified`/`guard-finding` above.
        const latestMG = new Map<string, ReturnType<typeof readMethodGuards>[number]>();
        for (const e of readMethodGuards(dir)) latestMG.set(`${e.service}::${e.method}`, e);
        const methodGuards: Record<string, number> = {};
        for (const e of latestMG.values()) methodGuards[e.verdict] = (methodGuards[e.verdict] ?? 0) + 1;
        return { phase: s.phase, regenAttempts: s.regenAttempts, alternativeAttempts: s.alternativeAttempts,
          candidates: s.candidates.map(c => ({ id: c.inv.id, name: c.inv.name, prior: c.inv.prior, status: c.status })),
          openDecisions: readLedger(dir).filter(e => e.kind === 'open-decision').length,
          ledgerCount: readLedger(dir).length, classifications, guardFindings, methodGuards };
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
        // Guard-change staleness (item 3a): computed against the SAME `r.ledgerAppends` used below
        // for `changedNames` — an aggregate that just had an invariant (re)adopted is already going
        // to be reclassified by classifyOnApply, so it's excluded here regardless of --dry-run/
        // --no-classify (the warning is about staleness that would OTHERWISE go undetected).
        const adoptedAggregates = new Set(
          r.ledgerAppends
            .filter((e): e is Extract<LedgerEntry, { kind: 'adopted' }> => e.kind === 'adopted')
            .map(e => (e.invariant.candidate as any).aggregate));
        warnings.push(...guardChangeWarnings(storedModel, r.model, adoptedAggregates));
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
        // Persist (item 4): method-guard results previously only lived in this command's own
        // output — nothing survived to the ledger for `status` to count or `explain`-adjacent
        // tooling to read back. Runs unconditionally (both --name and bulk paths), mirroring where
        // checkAllMethodGuards itself runs above (before the --name early return).
        for (const mg of methodGuards)
          appendLedger(dir, { kind: 'method-guard', at: now(), service: mg.service, method: mg.method,
            verdict: mg.verdict, reachable: mg.reachable, provenance: `classify ${isoDay(now())}` });
        if (values.name) return { classified: results, methodGuards };
        // Guard analysis (design §7.3): structurally-filtered stuck/reachability sites, confirmed
        // against the abstract-evolution machine. Guard findings are model-level (not invariant-
        // scoped), so this runs ONLY on bulk classify (no --name) — `--name` is the fast, scoped
        // path and must not pay for a full-model solver sweep. Surfaced here in `classify` (the
        // solver-heavy command), persisted to the ledger for `status` to count and `explain`-adjacent
        // tooling to read back later.
        const guardFindings = await analyzeGuards(model(), deps, reachSteps);
        // Run-stamp (item 3b): every guard-finding appended by THIS bulk-classify run shares one
        // `run` timestamp, captured once so `status` can isolate "the latest run's findings" even
        // though `guard-finding` entries are otherwise append-only and never cleared. A site that
        // stops being flagged after a model edit + re-classify simply has no entry carrying the new
        // max `run` stamp, so it silently drops out of the count — no explicit "cleared" marker
        // needed. ISO timestamps sort lexicographically, so `run` is trivially comparable as a string.
        const guardRun = now();
        for (const f of guardFindings)
          appendLedger(dir, { kind: 'guard-finding', at: now(), finding: f.finding, owner: f.owner,
            region: f.region, state: f.state, witness: f.witness, boundedN: f.boundedN,
            provenance: `classify ${isoDay(now())}`, run: guardRun });
        // Sweep marker (item 3b): appended UNCONDITIONALLY, even when guardFindings is empty — a run
        // that clears every previously-flagged site must still register as "the latest run" so
        // `status` stops counting the stale ones (see readGuardSweeps's doc comment in session.ts).
        appendLedger(dir, { kind: 'guard-sweep', at: now(), run: guardRun });

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
        // Per-CONJUNCT, not per-invariant (E2E finding #2): classify's `results` are already split by
        // conjunctsOf (classifyAdopted above), so a violated multi-conjunct invariant surfaces one
        // `Classification` per violated conjunct here. Handing strengthenInvariant the WHOLE invariant
        // (an `and` body) makes invariantCmp (strengthen.ts) return null — it never fires on realistic
        // multi-conjunct invariants. conjunctTarget rebuilds the single-conjunct CandidateInvariant
        // (cmp/implies body) that strengthenInvariant can actually shape a guard from. Dedupe on
        // (invariant, conjunct) — `results` cannot repeat a key within one classify run, but this keeps
        // the loop robust to future callers that might pass duplicate targets.
        const seenKeys = new Set<string>();
        for (const r of results.filter(x => x.verdict === 'violated')) {
          const key = `${r.invariant}::${r.conjunct ?? ''}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const target = targets.find(c => c.inv.name === r.invariant);
          if (!target) continue;
          const vInv = conjunctTarget(target.inv, r.conjunct);
          const res = await strengthenInvariant(model(), vInv, peersExcludingParent(s, target.inv), deps, reachSteps ?? 6);
          if (res.kind !== 'auto-adopt') {
            autoStrengthened.push({ invariant: r.invariant, conjunct: r.conjunct, resolution: res });
            continue;
          }
          const gInv = adoptGuard(s, dir, res.guard, 'auto-strengthen');
          // Masking reclassify (§8.4/§8.7, broadened per §7.2 aggregate-scope, item 1): re-run the
          // on-apply classifier over every adopted invariant scoped to the guard's aggregate — not
          // just this invariant — now that the guard is adopted, appending fresh `classified` entries
          // (status/explain read the latest). A guard can mask a SIBLING invariant on the same
          // aggregate just as well as the one that triggered strengthening, so the reclassify scope
          // must cover the whole aggregate. Reuses classifyOnApply/classifyAdopted — no hand-rolled
          // classification.
          const scope = [...new Set([r.invariant, ...aggregateScopedNames(s, res.guard.aggregate)])];
          const reclassified = gInv
            ? await classifyOnApply(dir, model(), s.candidates.filter(c => c.status === 'adopted').map(c => c.inv), scope, deps)
            : [];
          autoStrengthened.push({ invariant: r.invariant, conjunct: r.conjunct, resolution: res, guard: gInv?.name,
            reclassified: reclassified.map(e => ({ invariant: e.invariant, verdict: e.verdict, pinnedBy: e.pinnedBy })) });
        }

        // Bulk classify (no --name): name the adopted invariants that were NOT classified, rather
        // than just dropping them — most real sessions carry template-adopted structural invariants
        // of unclassifiable kinds (see comment above), and a silent drop looks identical to "nothing
        // else was adopted".
        // M-3: adopted GUARDS are machine assumptions, not invariants — they live in `adoptedTracked`
        // (so their effect rides into every classify machine) but are never `classifiable` themselves.
        // Exclude them from `skipped`, which names UNCLASSIFIED *invariants* (template-adopted
        // terminal/monotonic/leadsTo/refsResolve); a guard listed alongside them is a category error.
        const skipped = adoptedTracked.filter(c => !classifiable.includes(c) && c.inv.candidate.kind !== 'guard')
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

        // Per-CONJUNCT, not per-invariant (E2E finding #2): a multi-conjunct `and`-bodied invariant
        // makes invariantCmp (strengthen.ts) return null, so strengthenInvariant can never auto-adopt
        // on the whole invariant. `--name` alone (no `--conjunct`) has no per-conjunct classify result
        // to key off, so it defaults to conjunct '0' when the invariant is multi-conjunct (documented
        // in the returned `conjunct` field) — an explicit `--conjunct <idx>` targets a specific one.
        const multiConjunct = conjunctsOf(target.inv.candidate).length > 1;
        const conjunct = multiConjunct ? (values.conjunct ?? '0') : values.conjunct;
        const vInv = conjunctTarget(target.inv, conjunct);

        // strengthenInvariant now filters its own peers (quint-expressible, self-excluded) and rides
        // adopted guards into the machine (carried fix iii); peersExcludingParent additionally strips
        // `target.inv`'s own (possibly `and`-bodied) candidate, which strengthenInvariant's self-
        // exclusion can't catch once `vInv.candidate` is a split-out conjunct sub-object (see
        // peersExcludingParent's doc comment) — for a single-conjunct invariant this is a no-op
        // (vInv.candidate === target.inv.candidate, already excluded either way).
        const res = await strengthenInvariant(model(), vInv, peersExcludingParent(s, target.inv), deps, reachSteps ?? 6);

        // Interactive ≥2-survivor guard CHOICE (item 2). `--choose <op>` adopts the surviving variant
        // whose predicate op the author picked — re-running the engine on the SAME target/peers as the
        // no-`--choose` render, so the survivor set is identical to what was shown. Guards are NOT
        // routed through the planner's nextQuestion/routeCandidate (those throw on the guard kind by
        // design); the author selects via `--choose` against the engine's own separating probe.
        if (values.choose !== undefined) {
          if (res.kind !== 'distinguish') return { strengthened: res };   // situation changed since the render
          const chosen = res.survivors.find(g => g.predicate.kind === 'cmp' && g.predicate.op === values.choose);
          if (!chosen) return { error: 'invalid-arg', arg: 'choose', hint: `no surviving guard with op '${values.choose}'` };
          adoptGuard(s, dir, chosen, 'strengthen-chose');
          // Masking reclassify (§7.2 aggregate-scope), same pass the auto-adopt hook runs: the chosen
          // guard can mask siblings over its aggregate, so reclassify the whole aggregate scope.
          await classifyOnApply(dir, model(), s.candidates.filter(c => c.status === 'adopted').map(c => c.inv),
            [...new Set([target.inv.name, ...aggregateScopedNames(s, chosen.aggregate)])], deps);
          return done({ strengthened: { kind: 'auto-adopt', guard: chosen }, chose: values.choose });
        }

        // ≥2 survivors with no `--choose`: render the choice — each survivor named as the guard the
        // hook/command would mint (guard_<transition>_<op>), plus the separating witness tables so the
        // author can tell them apart. Adopts nothing; the author replies with `--choose <op>`.
        if (res.kind === 'distinguish') {
          return { strengthened: { kind: 'distinguish',
            survivors: res.survivors.map(g => ({ name: `guard_${g.transition}_${(g.predicate as { op: string }).op}`,
              op: (g.predicate as { op: string }).op, transition: g.transition })),
            witnesses: res.witnesses.map(w => ({ table: renderWitnessTable(w, model().ticksPerDay) })) } };
        }

        if (res.kind !== 'auto-adopt') return { strengthened: res, conjunct };   // inconsistent/no-transition — non-blocking finding

        // auto-adopt: adopt the winning guard idempotently via the shared minting/ledger helper (same
        // ids/names the interactive hook produces). A no-op (already adopted) still returns the res.
        adoptGuard(s, dir, res.guard, 'strengthen');
        return done({ strengthened: res, conjunct });
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
        // Guard-finding visibility (item 4): `guard-finding` entries are state-keyed (owner/region/
        // state), not invariant-keyed, so they can't merge in by name like `classified` above.
        // Instead, surface every finding on the SAME aggregate this invariant is about — the
        // finding may not name this invariant, but a stuck/unreachable state on its aggregate is
        // directly relevant context for reading the invariant. Latest-per-key dedup/run-filtering
        // (as `status` does for its counts) is not reapplied here — this is a raw, append-only
        // read-back for a single invariant's explain output, not an aggregate count.
        out.guardFindings = readGuardFindings(dir)
          .filter(f => f.owner === (inv.candidate as any).aggregate)
          .map(f => ({ region: f.region, state: f.state, finding: f.finding }));
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
