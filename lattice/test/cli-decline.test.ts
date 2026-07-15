import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { readLedger, loadState, appendLedger } from '../src/engine/session.js';

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
});
