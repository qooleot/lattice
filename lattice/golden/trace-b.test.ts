import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { traceBModel, graceCandidate } from '../test/fixtures.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';

const groundTruth = graceCandidate(true);           // active-while-unpaid only within grace
const seeds: CandidateInvariant[] = [
  { id: 'H2', name: 'graceWindow', prior: 0.40, source: 'seed', candidate: graceCandidate(true) },
  { id: 'H3', name: 'unconstrained', prior: 0.35, source: 'seed',
    candidate: { kind: 'cardinality', aggregate: 'Subscription', where: null, atMost: 99 } as Candidate },
  { id: 'H1', name: 'noGrace', prior: 0.25, source: 'seed', candidate: graceCandidate(false) }
];

describe('GOLDEN TRACE B', () => {
  it('converges on the grace rule in exactly 2 judgments, routed to quint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-b-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceBModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], realDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(seeds)], realDeps);

    let judgments = 0; const latencies: number[] = []; const tables: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const q: any = await runCommand(['next-question', '--session', dir], realDeps);
      if (q.ms) latencies.push(q.ms);
      if (q.type === 'converged') break;
      if (q.type === 'merged') continue;
      if (q.type === 'question' || q.type === 'probe-options') {
        const opt = q.type === 'question' ? q : q.options[0];
        tables.push(opt.table);
        judgments++;
        await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge',
          evaluateCandidate(groundTruth, opt.witness)], realDeps);
        continue;
      }
      if (q.type === 'need-alternatives') {
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A1', name: 'noGraceAgain', prior: 0.2, candidate: graceCandidate(false) })], realDeps);  // contradicts ledger
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A2', name: 'sameGrace', prior: 0.2, candidate: graceCandidate(true) })], realDeps);      // equivalent
        continue;
      }
      throw new Error(`unexpected ${q.type}`);
    }

    expect(judgments).toBe(2);                                        // spec §2.2 / §16: exactly two
    expect(tables.some(t => t.includes('ticks'))).toBe(true);         // units rendering present
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    expect(st.candidates.find((c: any) => c.id === 'H2').status).toBe('adopted');
    latencies.sort((a, b) => a - b);
    expect(latencies.length).toBeGreaterThan(0);
    expect(latencies[Math.floor(latencies.length / 2)]!).toBeLessThanOrEqual(10_000);   // §2.4 p50 (steady-state; run once to warm Apalache)
    expect(Math.max(...latencies)).toBeLessThanOrEqual(45_000);

    await runCommand(['emit', '--session', dir, '--out', dir], realDeps);
    expect(readFileSync(join(dir, 'spec.prose.md'), 'utf8')).toContain('now ≤ invoice.dueDate + grace');
  }, 600_000);
});
