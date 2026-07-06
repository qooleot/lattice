import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DomainModel } from './ast/domain.js';
import { validateModel } from './ast/validate.js';
import { validateCandidate } from './ast/grammar.js';
import type { CandidateInvariant } from './ast/invariant.js';
import { loadState, saveState, appendLedger, readLedger, type SessionState, type LedgerEntry } from './engine/session.js';
import { matchTemplates } from './engine/templates.js';
import { registerCandidates, pruneOnVerdict, admit } from './engine/hypothesis.js';
import { nextQuestion, checkDistinct, adoptedConstraints, type SolverDeps } from './engine/planner.js';
import { renderWitnessTable } from './engine/salient.js';
import { astToAlloy } from './emit/alloy.js';
import { astToQuint } from './emit/quint.js';
import { runAlloy } from './solvers/alloy-adapter.js';
import { runQuint } from './solvers/quint-adapter.js';
import { astToProse, renderCandidateEnglish } from './emit/prose.js';
import { astToCode } from './emit/code.js';
import { impliedInvariants, canonicalCandidate } from './engine/implied.js';
import { loadLatText } from './parse/fromLangium.js';
import { reconcile } from './engine/reconcile.js';
import type { RenameSpec, RenameScope } from './engine/renames.js';
import { renameEntries, currentInvariantName } from './engine/renames.js';

export const realDeps: SolverDeps = {
  alloy: async (m, q, max) => runAlloy(astToAlloy(m, q), max),
  quint: async (m, q) => runQuint(astToQuint(m, q), q.maxSteps)
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

const VALID_JUDGES = ['permit', 'forbid', 'undecided'] as const;
const MODEL_COMMANDS = new Set(['propose', 'next-question', 'verdict', 'regenerate', 'witness-show', 'emit', 'explain']);
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
  const lat = join(outDir, 'spec.lat'), prose = join(outDir, 'spec.prose.md');
  writeFileSync(lat, astToCode(model, adopted));
  writeFileSync(prose, astToProse(model, [...adopted, ...derived], ledger));
  return [lat, prose];
}

function inferRenameSpec(path: string, to: string, m: DomainModel, invariantNames: Set<string>): RenameSpec | null {
  const segs = path.split('.');
  const from = segs[segs.length - 1]!;
  const scope = ((): RenameScope | null => {
    if (segs.length === 1) {
      if (m.aggregates.some(a => a.name === from)) return 'aggregate';
      if (m.entities.some(e => e.name === from)) return 'entity';
      if (m.enums.some(e => e.name === from)) return 'enum';
      if (m.events.some(e => e.name === from)) return 'event';
      return invariantNames.has(from) ? 'invariant' : null;
    }
    const owner = m.aggregates.find(a => a.name === segs[0]) ?? m.entities.find(e => e.name === segs[0]);
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
      lat: { type: 'string' }, 'dry-run': { type: 'boolean' },
      rename: { type: 'string', multiple: true }, 'force-remove': { type: 'string', multiple: true },
      name: { type: 'string' }
    }});

    if (!values.session) return { error: 'missing-arg', arg: 'session' };
    const dir = values.session;

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
      case 'explain': if (!values.name) return { error: 'missing-arg', arg: 'name' }; break;
      case 'structure':
        if (!values.question) return { error: 'missing-arg', arg: 'question' };
        if (!values.answer) return { error: 'missing-arg', arg: 'answer' };
        break;
      case 'apply': if (!values.lat) return { error: 'missing-arg', arg: 'lat' }; break;
      case 'sync': if (!values.lat) return { error: 'missing-arg', arg: 'lat' }; break;
    }

    if (cmd === 'sync') {
      const { startSync } = await import('./engine/sync.js');
      startSync({ lat: values.lat!, session: dir, deps,
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
      case 'status':
        return { phase: s.phase, regenAttempts: s.regenAttempts, alternativeAttempts: s.alternativeAttempts,
          candidates: s.candidates.map(c => ({ id: c.inv.id, name: c.inv.name, prior: c.inv.prior, status: c.status })),
          openDecisions: readLedger(dir).filter(e => e.kind === 'open-decision').length,
          ledgerCount: readLedger(dir).length };
      case 'witness-show': {
        const p = s.pendingWitnesses[values.witness!];
        return p ? { table: renderWitnessTable(p.witness, model()?.ticksPerDay) } : { error: 'unknown-witness' };
      }
      case 'emit': {
        const adopted = s.candidates.filter(c => c.status === 'adopted').map(c => c.inv);
        const ledger = readLedger(dir);
        const shapes = new Set(adopted.map(a => canonicalCandidate(a.candidate)));
        const derived = impliedInvariants(model()).filter(d => !shapes.has(canonicalCandidate(d.candidate)));
        mkdirSync(values.out!, { recursive: true });
        const prose = join(values.out!, 'spec.prose.md'), lat = join(values.out!, 'spec.lat');
        writeFileSync(prose, astToProse(model(), [...adopted, ...derived], ledger));
        writeFileSync(lat, astToCode(model(), adopted));
        return { written: [prose, lat] };
      }
      case 'apply': {
        const latPath = values.lat!;
        let text: string;
        try { text = readFileSync(latPath, 'utf8'); }
        catch (err) { return { error: 'unreadable-lat', message: String(err) }; }
        const loaded = loadLatText(text);
        if (!loaded.ok) return { error: 'parse-failed', diagnostics: loaded.diagnostics };

        const sessionExists = existsSync(join(dir, 'state.json'));
        if (sessionExists && (s.phase !== 'converged' || Object.keys(s.pendingWitnesses).length > 0) && s.model)
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
          for (const inv of loaded.invariants)
            appendLedger(dir, { kind: 'adopted', at, invariant: inv, provenance: `hand-authored ${at.slice(0, 10)}` });
          writeFileSync(join(dir, 'model.json'), JSON.stringify(loaded.model, null, 2));
          const written = writeProjections(latPath, loaded.model, loaded.invariants, readLedger(dir));
          return done({ ok: true, applied: ['fresh session', ...loaded.invariants.map(i => `invariant ${i.name}`)], written, ...outcomeBase });
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
        for (const e of r.ledgerAppends) appendLedger(dir, e);
        writeFileSync(join(dir, 'model.json'), JSON.stringify(r.model, null, 2));
        const written = writeProjections(latPath, r.model, r.adopted, readLedger(dir));
        return done({ ok: true, applied: r.applied, written, warnings });
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
          .map(e => ({ id: (e as any).witnessId, judge: (e as any).judge, at: (e as any).at, salient: (e as any).salient }));
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
