import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainModel } from './ast/domain.js';
import { validateModel } from './ast/validate.js';
import { validateCandidate } from './ast/grammar.js';
import type { CandidateInvariant } from './ast/invariant.js';
import { loadState, saveState, appendLedger, readLedger, type SessionState } from './engine/session.js';
import { matchTemplates } from './engine/templates.js';
import { registerCandidates, pruneOnVerdict, admit } from './engine/hypothesis.js';
import { nextQuestion, checkDistinct, adoptedConstraints, type SolverDeps } from './engine/planner.js';
import { renderWitnessTable } from './engine/salient.js';
import { astToAlloy } from './emit/alloy.js';
import { astToQuint } from './emit/quint.js';
import { runAlloy } from './solvers/alloy-adapter.js';
import { runQuint } from './solvers/quint-adapter.js';
import { astToProse } from './emit/prose.js';
import { astToCode } from './emit/code.js';

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
const MODEL_COMMANDS = new Set(['propose', 'next-question', 'verdict', 'regenerate', 'witness-show', 'emit']);
// terminal/monotonic/leadsTo/refsResolve are template-adopted only (spec §7/§8): they either crash
// candidateToQuint when pair-routed against a Quint-side candidate, or (refsResolve) mis-evaluate
// on Quint witnesses that never populate the fields refsResolve's vacuous-true Alloy semantics
// assume. They must never be elicited via propose/regenerate.
const UNELICITABLE_KINDS = new Set(['terminal', 'monotonic', 'leadsTo', 'refsResolve']);
const notElicitable = (kinds: string[]) =>
  ({ error: 'not-elicitable', kinds, hint: 'these kinds are template-adopted, not elicited' });

export async function runCommand(argv: string[], deps: SolverDeps): Promise<object> {
  try {
    const cmd = argv[0]!;
    const { values } = parseArgs({ args: argv.slice(1), options: {
      session: { type: 'string' }, model: { type: 'string' }, candidates: { type: 'string' }, candidate: { type: 'string' },
      witness: { type: 'string' }, judge: { type: 'string' }, out: { type: 'string' }, topic: { type: 'string' }, note: { type: 'string' },
      question: { type: 'string' }, answer: { type: 'string' }
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
      case 'structure':
        if (!values.question) return { error: 'missing-arg', arg: 'question' };
        if (!values.answer) return { error: 'missing-arg', arg: 'answer' };
        break;
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
        mkdirSync(values.out!, { recursive: true });
        const prose = join(values.out!, 'spec.prose.md'), lat = join(values.out!, 'spec.lat');
        writeFileSync(prose, astToProse(model(), adopted, ledger));
        writeFileSync(lat, astToCode(model(), adopted, ledger));
        return { written: [prose, lat] };
      }
      default: return { error: 'unknown-command', cmd };
    }
  } catch (err) {
    return { error: 'internal', message: String(err) };
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) runCommand(process.argv.slice(2), realDeps)
  .then(o => console.log(JSON.stringify(o, null, 2)))
  .catch(err => { console.log(JSON.stringify({ error: 'internal', message: String(err) }, null, 2)); process.exitCode = 1; });
