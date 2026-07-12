import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession, loadState, saveState, appendLedger, readLedger, readClassifications } from '../../src/engine/session.js';

describe('session store', () => {
  it('round-trips state.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-'));
    const s = newSession();
    s.phase = 'distinguish';
    saveState(dir, s);
    expect(loadState(dir).phase).toBe('distinguish');
  });
  it('appends and reads ledger.jsonl in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-'));
    appendLedger(dir, { kind: 'structure', at: 't1', question: 'q', answer: 'a' });
    appendLedger(dir, { kind: 'open-decision', at: 't2', topic: 'usage-after-close', note: 'parked' });
    const l = readLedger(dir);
    expect(l.length).toBe(2);
    expect(l[1]!.kind).toBe('open-decision');
  });
  it('loadState on a fresh dir returns a new session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-'));
    expect(loadState(dir).candidates).toEqual([]);
  });
});

describe('classified ledger entry', () => {
  it('round-trips a classified entry and readClassifications filters to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    appendLedger(dir, { kind: 'structure', at: '2026-07-09T00:00:00Z', question: 'q', answer: 'a' });
    appendLedger(dir, {
      kind: 'classified', at: '2026-07-09T00:00:01Z',
      invariant: 'neverOverpaidAndPaidExact', conjunct: 'paid-implies-exact',
      verdict: 'entailed', tier: 'sound',
      pinnedBy: ['settle.requires'], provenance: 'induction 2026-07-09',
    });
    appendLedger(dir, {
      kind: 'classified', at: '2026-07-09T00:00:02Z',
      invariant: 'activePaidInFull', verdict: 'violated', tier: 'sound',
      reachable: true,
      witness: { entities: [], trace: [] },
      provenance: 'escalated 2026-07-09',
    });
    expect(readLedger(dir).length).toBe(3);
    const cls = readClassifications(dir);
    expect(cls.length).toBe(2);
    expect(cls[0]!.verdict).toBe('entailed');
    expect(cls[0]!.pinnedBy).toEqual(['settle.requires']);
    expect(cls[1]!.verdict).toBe('violated');
    expect(cls[1]!.reachable).toBe(true);
  });
});
