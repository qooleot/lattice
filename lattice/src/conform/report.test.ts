import { describe, it, expect } from 'vitest';
import { formatReport, runConform } from './report.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
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
      traceRowsChecked: 0, guardedTransitions: [], durationMs: 0,
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
      violations: [], residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 0, guardedTransitions: [], durationMs: 0 });
    expect(text).toContain('0 violations across 3 snapshots (6 invariants checked)');
  });

  it('prints tier-2 coverage, unevaluated guards, and the duration budget verdict', () => {
    const text = formatReport({
      target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [], violations: [],
      residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 57, guardedTransitions: ['activate', 'finalize', 'settle'],
      durationMs: 4_210,
    });
    expect(text).toContain('tier 2: 57 row-traces checked against the machine');
    expect(text).toContain('guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle');
    expect(text).toContain('duration 4.2s — budget 60s OK');
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

  it('excludes opted-out invariants from invariantsChecked (final-review F3)', async () => {
    const implDir = resolve(__dirname, '../../..', 'implementations/subscriptions');
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    const snapDir = join(implDir, '.conform/snapshots');
    if (!existsSync(snapDir)) return; // no captured snapshots to reuse in this checkout — nothing to assert
    const snapSqlite = readdirSync(snapDir).find(f => f.endsWith('.sqlite'));
    if (!snapSqlite) return;
    const snapJson = snapSqlite.replace(/\.sqlite$/, '.json');

    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-optout-test-'));
    try {
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      mkdirSync(join(tmpDir, '.conform', 'snapshots'), { recursive: true });
      copyFileSync(join(implDir, 'conform', 'overrides.ts'), join(tmpDir, 'conform', 'overrides.ts'));
      copyFileSync(join(implDir, 'conform', 'spec-state.ts'), join(tmpDir, 'conform', 'spec-state.ts'));
      copyFileSync(join(snapDir, snapSqlite), join(tmpDir, '.conform', 'snapshots', snapSqlite));
      copyFileSync(join(snapDir, snapJson), join(tmpDir, '.conform', 'snapshots', snapJson));
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: realSessionPath,
        snapshots: '.conform/snapshots',
        optOuts: [{ invariant: 'retryCapWhilePastDue', reason: 'test: excluded from checked count' }],
      }));

      // The real session's adopted-invariant count grows over time — assert RELATIVE to it:
      // one valid opt-out must reduce the checked count by exactly one, never be included.
      const { loadGenInput } = await import('../generate/load.js');
      const { buildPlan } = await import('../generate/plan.js');
      const plan = buildPlan(loadGenInput(realSessionPath));
      const nonGuard = plan.aggregates.flatMap(a => a.invariants).filter(i => i.candidate.kind !== 'guard').length;
      const { report } = await runConform(tmpDir, 'report');
      expect(report.invariantsChecked).toBe(nonGuard - 1);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
