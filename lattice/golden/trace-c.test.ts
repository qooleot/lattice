import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { ALLOY_JAR } from '../src/solvers/doctor.js';
import { revrecModel } from '../test/fixtures.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../src/ast/invariant.js';

// Hidden ground truth H*: nothing ever posts into a Closed period (corrections post to an Open one).
const stateEq = (v: string): Predicate => ({ kind: 'cmp', op: 'eq',
  left: { kind: 'field', owner: 'self', path: ['period', 'Lifecycle.state'] },
  right: { kind: 'enumval', enum: 'PeriodState', value: v } });
const posted: Term = { kind: 'field', owner: 'self', path: ['postedAt'] };
const closedAt: Term = { kind: 'field', owner: 'self', path: ['period', 'closedAt'] };

const H1: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
  body: { kind: 'implies', left: stateEq('Closed'), right: { kind: 'cmp', op: 'le', left: posted, right: closedAt } } };
const H2: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
  body: { kind: 'implies',
    left: { kind: 'and', args: [stateEq('Closed'),
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['kind'] }, right: { kind: 'enumval', enum: 'EntryKind', value: 'Recognition' } }] },
    right: { kind: 'cmp', op: 'le', left: posted, right: closedAt } } };
const H3: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
  body: { kind: 'implies', left: stateEq('Closed'),
    right: { kind: 'cmp', op: 'le', left: posted, right: { kind: 'plus', left: closedAt, right: { kind: 'field', owner: 'self', path: ['period', 'lockWindow'] } } } } };
const seeds: CandidateInvariant[] = [
  { id: 'H1', name: 'noPostToClosed', prior: 0.5, source: 'seed', candidate: H1 },
  { id: 'H2', name: 'correctionsMayRestate', prior: 0.3, source: 'seed', candidate: H2 },
  { id: 'H3', name: 'lockWindow', prior: 0.2, source: 'seed', candidate: H3 }
];

describe.skipIf(!existsSync(ALLOY_JAR))('GOLDEN TRACE C — revenue recognition', () => {
  it('templates auto-adopt; residual converges to H1; open decision parks; ≤ 8 judgments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-c-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(revrecModel));
    const init: any = await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], realDeps);
    const adoptedIds = init.adopted.map((a: any) => a.id);
    for (const id of ['tpl-1-Obligation', 'tpl-8-Obligation-recognized', 'tpl-3-AccountingPeriod-Closed', 'tpl-7-AccountingPeriod', 'tpl-9-RevenueEntry'])
      expect(adoptedIds).toContain(id);                              // the "comes free" moment (§2.3)

    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(seeds)], realDeps);

    let judgments = 0, parkedOnce = false;
    for (let turn = 0; turn < 30; turn++) {
      const q: any = await runCommand(['next-question', '--session', dir], realDeps);
      if (q.type === 'converged') break;
      if (q.type === 'merged') continue;
      if (q.type === 'question' || q.type === 'probe-options') {
        const opt = q.type === 'question' ? q : q.options[0];
        // The pre-registered open decision: park the FIRST permit-side probe as usage-after-close.
        if (!parkedOnce && (q.purpose === 'probe-permit' || opt.purpose === 'probe-permit' || q.type === 'probe-options' && q.purpose === 'probe-permit')) {
          parkedOnce = true;
          await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge', 'undecided',
            '--topic', 'usage-after-close', '--note', 'catch-up in open period vs restate — founder undecided'], realDeps);
          continue;
        }
        judgments++;
        await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge',
          evaluateCandidate(H1, opt.witness)], realDeps);            // ground truth judges
        continue;
      }
      if (q.type === 'need-alternatives') {
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify({ id: 'A1', name: 'restate', prior: 0.2, candidate: H2 })], realDeps);
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify({ id: 'A2', name: 'same', prior: 0.2, candidate: H1 })], realDeps);
        continue;
      }
      if (q.type === 'regenerate') {   // acceptable path if probes refute an over-pruned survivor
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify({ id: 'R1', name: 'gt', prior: 0.9, candidate: H1 })], realDeps);
        continue;
      }
      throw new Error(`unexpected ${q.type}`);
    }

    expect(judgments).toBeLessThanOrEqual(8);                        // §2.4 kill criterion for trace C
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    const survivor = st.candidates.find((c: any) => ['H1', 'R1'].includes(c.id) && c.status === 'adopted');
    expect(survivor).toBeDefined();
    expect(st.openDecisions).toBe(1);                                // the parked policy fork
    await runCommand(['emit', '--session', dir, '--out', dir], realDeps);
    const prose = readFileSync(join(dir, 'spec.prose.md'), 'utf8');
    expect(prose).toContain('## ⚠️ Open decisions');
    expect(prose).toContain('usage-after-close');
    expect(prose).toContain('recognized + deferred always equals allocated');
  }, 900_000);
});
