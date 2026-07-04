import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession, loadState, saveState, appendLedger, readLedger } from '../../src/engine/session.js';

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
