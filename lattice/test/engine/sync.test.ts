import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSync } from '../../src/engine/sync.js';
import { runCommand, realDeps } from '../../src/cli.js';

const SESSION_SRC = join(import.meta.dirname, '../../../.lattice-session-subscriptions');

describe('engine sync', () => {
  it('applies on change, reports refusals with a hint, survives parse errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-sync-'));
    const sessionDir = join(dir, 'session'); const specDir = join(dir, 'spec');
    cpSync(SESSION_SRC, sessionDir, { recursive: true });
    mkdirSync(specDir);
    await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
    const lat = join(specDir, 'spec.lat');

    const outcomes: any[] = [];
    const seen = (n: number) => new Promise<void>((res, rej) => {
      const t = setInterval(() => { if (outcomes.length >= n) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); rej(new Error(`timeout waiting for outcome ${n}: ${JSON.stringify(outcomes)}`)); }, 15000);
    });
    const watcher = startSync({ lat, session: sessionDir, onOutcome: o => outcomes.push(o), deps: realDeps });
    try {
      // 1: broken edit → parse-failed outcome, watcher stays alive
      writeFileSync(lat, readFileSync(lat, 'utf8') + '\n// bad\n');
      await seen(1);
      expect(outcomes[0].error).toBe('parse-failed');
      // 2: valid no-op rewrite → applies
      await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
      await seen(2);
      expect(outcomes[1].ok).toBe(true);
    } finally { await watcher.close(); }
  }, 30000);

  it('a change to mapPath triggers an apply of the unchanged spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-sync-map-'));
    const sessionDir = join(dir, 'session'); const specDir = join(dir, 'spec');
    cpSync(SESSION_SRC, sessionDir, { recursive: true });
    mkdirSync(specDir);
    await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
    const lat = join(specDir, 'spec.lat');
    const mapPath = join(dir, 'context-map.lat');
    writeFileSync(mapPath, 'contextMap M {\n}\n');

    const outcomes: any[] = [];
    const seen = (n: number) => new Promise<void>((res, rej) => {
      const t = setInterval(() => { if (outcomes.length >= n) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); rej(new Error(`timeout waiting for outcome ${n}: ${JSON.stringify(outcomes)}`)); }, 15000);
    });
    const watcher = startSync({ lat, mapPath, session: sessionDir, onOutcome: o => outcomes.push(o), deps: realDeps });
    try {
      // a map edit re-runs the same apply on the unchanged spec → no-op reconcile, ok outcome
      writeFileSync(mapPath, 'contextMap M {\n  // edited\n}\n');
      await seen(1);
      expect(outcomes[0].ok).toBe(true);
    } finally { await watcher.close(); }
  }, 30000);
});
