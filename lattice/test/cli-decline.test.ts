import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { readLedger, loadState, saveState, appendLedger } from '../src/engine/session.js';
import { astToCode } from '../src/emit/code.js';

const fakeDeps: any = { alloy: async () => ({ sat: true, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };

const MODEL = {
  context: 'D', ticksPerDay: 24, enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{ kind: 'aggregate', name: 'Acct', fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'bal', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] }] }]
};

describe('decline', () => {
  let dir: string, modelPath: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decline-'));
    modelPath = join(dir, 'm.json');
    writeFileSync(modelPath, JSON.stringify(MODEL));
    await runCommand(['init', '--session', dir, '--model', modelPath], fakeDeps);
  });

  it('declines an adopted candidate and records the reason', async () => {
    const r: any = await runCommand(['decline', '--session', dir,
      '--id', 'implied-nonNegativeAcctBal', '--reason', 'balances may go negative'], fakeDeps);
    expect(r).toEqual({ ok: true, declined: 'nonNegativeAcctBal' });

    const entry = readLedger(dir).find(e => e.kind === 'declined') as any;
    expect(entry.invariant.name).toBe('nonNegativeAcctBal');
    expect(entry.reason).toBe('balances may go negative');
  });

  it('drops the rule from the adopted set so the solver stops seeing it', async () => {
    await runCommand(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x'], fakeDeps);
    const s = loadState(dir);
    expect(s.candidates.find(c => c.inv.id === 'implied-nonNegativeAcctBal')!.status).toBe('declined');
    expect(s.candidates.filter(c => c.status === 'adopted').map(c => c.inv.id))
      .not.toContain('implied-nonNegativeAcctBal');
  });

  it('rejects an unknown id', async () => {
    const r: any = await runCommand(['decline', '--session', dir, '--id', 'nope', '--reason', 'x'], fakeDeps);
    expect(r.error).toBe('unknown-candidate');
  });

  it('requires --id and --reason', async () => {
    expect((await runCommand(['decline', '--session', dir, '--reason', 'x'], fakeDeps) as any).error).toBe('missing-arg');
    expect((await runCommand(['decline', '--session', dir, '--id', 'x'], fakeDeps) as any).error).toBe('missing-arg');
  });

  it('is refused once a verdict exists', async () => {
    appendLedger(dir, { kind: 'verdict', at: new Date().toISOString(), witnessId: 'w1',
      witness: {} as any, salient: [], judge: 'permit', question: 'q' });
    const r: any = await runCommand(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x'], fakeDeps);
    expect(r.error).toBe('verdicts-exist');
  });

  it('a declined rule stays out of prose and out of reconcile canonical sets across apply', async () => {
    await runCommand(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x'], fakeDeps);
    // apply refuses mid-elicitation sessions (isSessionBusy); this MODEL seeds no distinguishable
    // candidates so init leaves phase 'distinguish' with nothing pending — force 'converged'
    // directly since this test exercises decline+apply, not the elicitation state machine.
    const s0 = loadState(dir);
    s0.phase = 'converged';
    saveState(dir, s0);
    // hand-write the spec the session would print, then apply it back
    const latPath = join(dir, 'spec.lat');
    writeFileSync(latPath, astToCode(MODEL as any, []));
    const r: any = await runCommand(['apply', '--session', dir, '--lat', latPath], fakeDeps);
    expect(r.error).toBeUndefined();
    const prose = readFileSync(join(dir, 'spec.prose.md'), 'utf8');
    expect(prose).not.toContain('nonNegativeAcctBal');
    // and the tracker was not resurrected
    const s = loadState(dir);
    expect(s.candidates.filter(c => c.inv.id === 'implied-nonNegativeAcctBal')).toHaveLength(1);
    expect(s.candidates.find(c => c.inv.id === 'implied-nonNegativeAcctBal')!.status).toBe('declined');
  });

  // Task 12: the convergence-adoption path has the same declined-ledger blindness as adoptGuard —
  // a re-proposed candidate under a FRESH id (so no tracker-level idempotence check can catch it)
  // whose canonical SHAPE matches a rule the ledger last declined must not be silently re-adopted
  // just because it converges as the sole survivor.
  it('a re-proposed shape matching a declined rule parks instead of adopting on convergence', async () => {
    await runCommand(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x'], fakeDeps);
    // Re-propose the same shape under a fresh agent id.
    const same = { id: 'agent-1', name: 'balNonNeg2', prior: 0.6, source: 'agent',
      candidate: { kind: 'statePredicate', aggregate: 'Acct',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['bal'] }, right: { kind: 'int', value: 0 } } } };
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([same])], fakeDeps);

    // Force straight to the brink of convergence (crib from cli.test.ts's next-question-converged
    // tests): single active survivor, both probes already asked, alternatives exhausted, and a
    // verdict present so we land in the hasVerdicts-true branch under test (not the zero-verdict
    // unanchored-survivor park, which is a separate, already-covered guard).
    const st = loadState(dir);
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    saveState(dir, st);
    appendLedger(dir, { kind: 'verdict', at: new Date().toISOString(), witnessId: 'w1',
      witness: { entities: [] } as any, salient: [], judge: 'forbid', question: '' });

    const r: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    expect(r.type).toBe('converged');
    const s = loadState(dir);
    expect(s.candidates.find(c => c.inv.id === 'agent-1')!.status).toBe('parked');
    expect(readLedger(dir).some(e => e.kind === 'open-decision' && (e as any).topic === 'previously-declined')).toBe(true);
  });
});
