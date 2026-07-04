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
import { nextQuestion, checkDistinct, type SolverDeps } from './engine/planner.js';
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

const readJson = (v: string): any => JSON.parse(v.trim().startsWith('{') || v.trim().startsWith('[') ? v : readFileSync(v, 'utf8'));
const now = () => new Date().toISOString();

export async function runCommand(argv: string[], deps: SolverDeps): Promise<object> {
  const cmd = argv[0]!;
  const { values } = parseArgs({ args: argv.slice(1), options: {
    session: { type: 'string' }, model: { type: 'string' }, candidates: { type: 'string' }, candidate: { type: 'string' },
    witness: { type: 'string' }, judge: { type: 'string' }, out: { type: 'string' }, topic: { type: 'string' }, note: { type: 'string' }
  }});
  const dir = values.session!;
  const s = loadState(dir);
  const model = () => s.model as DomainModel;
  const done = (out: object) => { saveState(dir, s); return out; };

  switch (cmd) {
    case 'init': {
      const m: DomainModel = readJson(values.model!);
      const diags = validateModel(m);
      if (diags.length) return { error: 'ill-formed-model', diagnostics: diags };
      s.model = m;
      const { adopt, seeds } = matchTemplates(m);
      for (const inv of adopt) {
        s.candidates.push({ inv, status: 'adopted' });
        appendLedger(dir, { kind: 'adopted', at: now(), invariant: inv, provenance: `template ${inv.id}` });
      }
      s.phase = 'distinguish';
      return done({ ok: true, adopted: adopt.map(a => ({ id: a.id, name: a.name })), seeds });
    }
    case 'propose': {
      const invs: CandidateInvariant[] = readJson(values.candidates!);
      const diags = invs.flatMap(i => validateCandidate(i.candidate, model()).map(d => ({ ...d, candidate: i.id })));
      if (diags.length) return { error: 'out-of-grammar', diagnostics: diags };
      registerCandidates(s, invs);
      return done({ registered: invs.length });
    }
    case 'next-question': {
      const out = await nextQuestion(s, readLedger(dir), model(), deps);
      if (out.type === 'converged') {
        const survivor = s.candidates.find(c => c.status === 'active');
        if (survivor) {
          survivor.status = 'adopted';
          const wids = readLedger(dir).filter(e => e.kind === 'verdict').map(e => (e as any).witnessId).join(', ');
          appendLedger(dir, { kind: 'adopted', at: now(), invariant: survivor.inv, provenance: `elicited (${wids})` });
        }
      }
      return done(out);
    }
    case 'verdict': {
      const id = values.witness!;
      const pending = s.pendingWitnesses[id];
      if (!pending) return { error: 'unknown-witness', id };
      if (values.judge === 'undecided') {
        appendLedger(dir, { kind: 'open-decision', at: now(), topic: values.topic ?? 'unnamed', note: values.note ?? '', witnessId: id });
        delete s.pendingWitnesses[id];
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
      const source = s.phase === 'alternatives' ? 'alternative' : 'regen';
      const inv: CandidateInvariant = { ...raw, source };
      if (source === 'alternative') {
        const survivor = s.candidates.find(c => c.status === 'active');
        if (survivor && !(await checkDistinct(survivor.inv.candidate, inv.candidate, model(), deps))) {
          s.alternativeAttempts++;
          return done({ ok: false, reason: 'equivalent to survivor over scope', attemptsLeft: 2 - s.alternativeAttempts });
        }
      }
      const r = admit(s, inv, model(), readLedger(dir));
      const attemptsLeft = source === 'regen' ? 3 - s.regenAttempts : 2 - s.alternativeAttempts;
      if (r.ok && source === 'alternative') s.phase = 'distinguish';   // a live alternative reopens the loop
      return done({ ...r, attemptsLeft });
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
      writeFileSync(lat, astToCode(model(), adopted));
      return { written: [prose, lat] };
    }
    default: return { error: 'unknown-command', cmd };
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) runCommand(process.argv.slice(2), realDeps).then(o => console.log(JSON.stringify(o, null, 2)));
