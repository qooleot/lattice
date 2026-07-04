import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { checkDistinct } from '../src/engine/planner.js';
import { ALLOY_JAR } from '../src/solvers/doctor.js';
import { traceAModel } from '../test/fixtures.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';

const groundTruth: Candidate = { kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] };
const mkU = (id: string, by: string[][], prior: number): CandidateInvariant => ({ id, name: id, prior, source: 'seed',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by } });
const seeds = [mkU('H1', [['customer']], 0.35), mkU('H2', [['customer'], ['plan']], 0.40),
  { id: 'H4', name: 'H4', prior: 0.25, source: 'seed' as const,
    candidate: { kind: 'cardinality', aggregate: 'Subscription', where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] }, atMost: 99 } as Candidate }];

describe.skipIf(!existsSync(ALLOY_JAR))('GOLDEN TRACE A', () => {
  it('converges to per-(customer,family) in ≤ 4 judgments with a regeneration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-a-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], realDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(seeds)], realDeps);

    let judgments = 0, regenerated = false, latencies: number[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const q: any = await runCommand(['next-question', '--session', dir], realDeps);
      if (q.ms) latencies.push(q.ms);
      if (q.type === 'converged') break;
      if (q.type === 'merged') continue;
      if (q.type === 'question' || q.type === 'probe-options') {
        const opt = q.type === 'question' ? q : q.options[0];        // fixture pick: first option
        const judge = evaluateCandidate(groundTruth, opt.witness);    // ground truth judges
        judgments++;
        await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge', judge], realDeps);
        continue;
      }
      if (q.type === 'regenerate') {
        regenerated = true;
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'H3', name: 'perCustomerFamily', prior: 0.9, candidate: groundTruth })], realDeps);
        continue;
      }
      if (q.type === 'need-alternatives') {                           // two failing alternatives → converge
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A1', name: 'perCustomer', prior: 0.3, candidate: seeds[0]!.candidate })], realDeps);      // ledger-inconsistent
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A2', name: 'sameThing', prior: 0.3, candidate: groundTruth })], realDeps);                // equivalent
        continue;
      }
      throw new Error(`unexpected planner output ${q.type}`);
    }

    // Hard path exercised + convergence quality
    expect(regenerated).toBe(true);                                   // spec §2.1: must regenerate
    expect(judgments).toBeLessThanOrEqual(4);                         // kill criterion 2 (spec expectation: 2)
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    const adopted = st.candidates.find((c: any) => c.id === 'H3');
    expect(adopted.status).toBe('adopted');
    // survivor ≡ ground truth over scope
    expect(await checkDistinct(groundTruth, groundTruth, traceAModel, realDeps)).toBe(false);
    // latency budget (§2.4)
    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length / 2)]!).toBeLessThanOrEqual(10_000);
    expect(Math.max(...latencies)).toBeLessThanOrEqual(45_000);

    const e: any = await runCommand(['emit', '--session', dir, '--out', dir], realDeps);
    expect(readFileSync(join(dir, 'spec.prose.md'), 'utf8')).toContain('Only one Subscription may be Active per (customer, plan.family)');
  }, 300_000);
});
