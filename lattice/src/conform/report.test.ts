import { describe, it, expect } from 'vitest';
import { formatReport, runConform } from './report.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('formatReport', () => {
  it('prints residual surface, opt-outs, and anchored violations', () => {
    const text = formatReport({
      target: 'implementations/subscriptions', snapshots: 12, invariantsChecked: 6,
      optOuts: [{ invariant: 'retryCapWhilePastDue', reason: 'fixture X predates dunning' }],
      violations: [{ invariant: 'activePaidInFull', specElement: 'invariant activePaidInFull',
        anchors: ['hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5'],
        witnessIds: ['sub-1'], source: 'journey: trial → activate', detail: 'violated by 1/3 Subscription row(s)' }],
      residual: { autoBound: 14, overridden: 4, total: 18 },
    });
    expect(text).toContain('auto-bound 14/18');
    expect(text).toContain('4 overridden');
    expect(text).toContain('OPT-OUT retryCapWhilePastDue — fixture X predates dunning');
    expect(text).toContain('VIOLATION activePaidInFull');
    expect(text).toContain('witnesses [sub-1]');
    expect(text).toContain('hand-edited 2026-07-08');
    expect(text).toContain('source journey: trial → activate');
  });

  it('reports a clean run explicitly, never silently', () => {
    const text = formatReport({ target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [],
      violations: [], residual: { autoBound: 14, overridden: 4, total: 18 } });
    expect(text).toContain('0 violations across 3 snapshots (6 invariants checked)');
  });
});

describe('runConform', () => {
  it('validates overrides module shape and rejects modules without overrides export', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-test-'));
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    try {
      // Create conform directory and config
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: realSessionPath,
        snapshots: '.conform/snapshots',
        optOuts: [],
      }));

      // Create overrides.ts with wrong export name
      writeFileSync(join(tmpDir, 'conform', 'overrides.ts'),
        'export const wrongName = {};');

      // Create snapshots directory with a dummy snapshot
      mkdirSync(join(tmpDir, '.conform', 'snapshots'), { recursive: true });
      const db = new Database(join(tmpDir, '.conform', 'snapshots', 'test.sqlite'));
      db.close();
      writeFileSync(join(tmpDir, '.conform', 'snapshots', 'test.json'),
        JSON.stringify({ source: 'test' }));

      // Call runConform and expect error
      try {
        await runConform(tmpDir, 'report');
        expect.unreachable('runConform must throw on bad overrides module');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/must export 'overrides'/);
      }
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
