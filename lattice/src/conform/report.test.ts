import { describe, it, expect } from 'vitest';
import { formatReport, runConform, runDrive } from './report.js';
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
      traceRowsChecked: 0, guardedTransitions: [], crosschecks: [], durationMs: 0,
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
      traceRowsChecked: 0, guardedTransitions: [], crosschecks: [], durationMs: 0 });
    expect(text).toContain('0 violations across 3 snapshots (6 invariants checked)');
  });

  it('prints tier-2 coverage, unevaluated guards, and the duration budget verdict', () => {
    const text = formatReport({
      target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [], violations: [],
      residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 57, guardedTransitions: ['activate', 'finalize', 'settle'],
      crosschecks: [], durationMs: 4_210,
    });
    expect(text).toContain('tier 2: 57 row-traces checked against the machine');
    expect(text).toContain('guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle');
    expect(text).toContain('duration 4.2s — budget 60s OK');
  });

  it('states declared crosscheck names explicitly on the line after tier 2', () => {
    const text = formatReport({
      target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [], violations: [],
      residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 57, guardedTransitions: [], crosschecks: ['account_summary'], durationMs: 0,
    });
    expect(text).toContain('crosschecks: account_summary');
  });

  it('states absence of declared crosschecks explicitly, never silently', () => {
    const text = formatReport({
      target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [], violations: [],
      residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 57, guardedTransitions: [], crosschecks: [], durationMs: 0,
    });
    expect(text).toContain('crosschecks: none declared');
  });

  it('renders tier-2 violations with empty invariant using specElement as headline', () => {
    const text = formatReport({
      target: 't', snapshots: 1, invariantsChecked: 2, optOuts: [],
      violations: [{ invariant: '', specElement: 'outbox (orphan)',
        anchors: ['transaction rolled back after append'],
        witnessIds: ['sub-1'], source: 'journeys', detail: 'orphaned event in outbox' }],
      residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 10, guardedTransitions: [], crosschecks: [], durationMs: 0,
    });
    expect(text).toContain('VIOLATION outbox (orphan) (outbox (orphan))');
    expect(text).not.toContain('VIOLATION  ('); // no double space
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
      // own session COPY — runConform now appends a ledger entry per run (Task 5 write-back), so
      // pointing straight at the real committed session would pollute .lattice-session-subscriptions.
      mkdirSync(join(tmpDir, 'session'), { recursive: true });
      for (const f of ['state.json', 'model.json', 'ledger.jsonl']) {
        copyFileSync(join(realSessionPath, f), join(tmpDir, 'session', f));
      }
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      mkdirSync(join(tmpDir, '.conform', 'snapshots'), { recursive: true });
      copyFileSync(join(implDir, 'conform', 'overrides.ts'), join(tmpDir, 'conform', 'overrides.ts'));
      copyFileSync(join(implDir, 'conform', 'spec-state.ts'), join(tmpDir, 'conform', 'spec-state.ts'));
      copyFileSync(join(snapDir, snapSqlite), join(tmpDir, '.conform', 'snapshots', snapSqlite));
      copyFileSync(join(snapDir, snapJson), join(tmpDir, '.conform', 'snapshots', snapJson));
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: join(tmpDir, 'session'),
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

  it('appends one conformance ledger entry per run (write-back, design §4.6)', async () => {
    const implDir = resolve(__dirname, '../../..', 'implementations/subscriptions');
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    const snapDir = join(implDir, '.conform/snapshots');
    if (!existsSync(snapDir)) return; // no snapshots in this checkout — nothing to assert
    const snapSqlite = readdirSync(snapDir).find(f => f.endsWith('.sqlite'));
    if (!snapSqlite) return;
    const snapJson = snapSqlite.replace(/\.sqlite$/, '.json');

    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-ledger-test-'));
    try {
      // own session COPY so the append never mutates the real committed ledger
      mkdirSync(join(tmpDir, 'session'), { recursive: true });
      for (const f of ['state.json', 'model.json', 'ledger.jsonl']) {
        copyFileSync(join(realSessionPath, f), join(tmpDir, 'session', f));
      }
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      mkdirSync(join(tmpDir, '.conform', 'snapshots'), { recursive: true });
      copyFileSync(join(implDir, 'conform', 'overrides.ts'), join(tmpDir, 'conform', 'overrides.ts'));
      copyFileSync(join(implDir, 'conform', 'spec-state.ts'), join(tmpDir, 'conform', 'spec-state.ts'));
      copyFileSync(join(snapDir, snapSqlite), join(tmpDir, '.conform', 'snapshots', snapSqlite));
      copyFileSync(join(snapDir, snapJson), join(tmpDir, '.conform', 'snapshots', snapJson));
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: join(tmpDir, 'session'), snapshots: '.conform/snapshots', optOuts: [],
      }));

      // The copied ledger.jsonl carries whatever real conformance history the checked-in session
      // already has (this task's own step 4 real run commits one such entry) — scope by `target`
      // (this test's unique tmpDir) rather than asserting the ledger is pristine, so the test keeps
      // verifying "one entry per run, append-only" without being order/history-dependent forever.
      const { readConformance } = await import('../engine/session.js');
      const forThisRun = () => readConformance(join(tmpDir, 'session')).filter(e => e.target === resolve(tmpDir));
      await runConform(tmpDir, 'report');
      const entries = forThisRun();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'conformance', mode: 'report', target: resolve(tmpDir) });
      expect(entries[0]!.snapshots).toBeGreaterThan(0);
      expect(typeof entries[0]!.durationMs).toBe('number');
      // tmp-target test copies overrides but NOT crosschecks.ts, so expect empty crosschecks array
      expect(entries[0]!.crosschecks).toEqual([]);

      await runConform(tmpDir, 'report');
      expect(forThisRun()).toHaveLength(2); // append-only, one per run
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('runDrive', () => {
  const DRIVE_OPTS = { sequences: 5, length: 5, seed: 1, checkEvery: 5, probeRate: 0.2 };

  it("rejects a target with no drive.ts (must export 'drivers')", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-drive-test-'));
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    try {
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: realSessionPath, snapshots: '.conform/snapshots', optOuts: [],   // no "schema" key either
      }));
      writeFileSync(join(tmpDir, 'conform', 'overrides.ts'), 'export const overrides = {};');

      try {
        await runDrive(tmpDir, DRIVE_OPTS);
        expect.unreachable('runDrive must throw when conform/drive.ts is missing');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/must export 'drivers'/);
      }
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('validates drive.ts shape BEFORE checking for the config schema key (order pinned)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-drive-test-'));
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    try {
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: realSessionPath, snapshots: '.conform/snapshots', optOuts: [],   // still no "schema" key
      }));
      writeFileSync(join(tmpDir, 'conform', 'overrides.ts'), 'export const overrides = {};');
      // Empty maps: the non-empty-transitions/create validation must fire before the schema check
      // ever runs, even though this config also lacks "schema".
      writeFileSync(join(tmpDir, 'conform', 'drive.ts'), 'export const drivers = { transitions: {}, create: {} };');

      try {
        await runDrive(tmpDir, DRIVE_OPTS);
        expect.unreachable('runDrive must throw on an empty drivers module');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/non-empty 'transitions' and 'create'/);
        expect((err as Error).message).not.toMatch(/schema/);
      }
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('rejects --drive when conform.config.json has no "schema" key (drive.ts is otherwise valid)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-drive-test-'));
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    try {
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: realSessionPath, snapshots: '.conform/snapshots', optOuts: [],   // no "schema" key
      }));
      writeFileSync(join(tmpDir, 'conform', 'overrides.ts'), 'export const overrides = {};');
      writeFileSync(join(tmpDir, 'conform', 'drive.ts'),
        "export const drivers = { transitions: { t: () => {} }, create: { Agg: () => {} } };");

      try {
        await runDrive(tmpDir, DRIVE_OPTS);
        expect.unreachable('runDrive must throw when the config has no schema key');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/schema/);
      }
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("appends one drive-mode conformance ledger entry per run, carrying `reattributions` " +
    '(F1, D1 final review — "reported never hidden" must reach the ledger, not just the console)', async () => {
    const implDir = resolve(__dirname, '../../..', 'implementations/subscriptions');
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    if (!existsSync(join(implDir, 'conform', 'drive.ts'))) return; // no drive.ts in this checkout — nothing to assert

    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-drive-ledger-test-'));
    try {
      // own session COPY, same reasoning as runConform's ledger test above: runDrive appends to
      // the ledger too, and pointing at the real committed session would pollute it.
      mkdirSync(join(tmpDir, 'session'), { recursive: true });
      for (const f of ['state.json', 'model.json', 'ledger.jsonl']) {
        copyFileSync(join(realSessionPath, f), join(tmpDir, 'session', f));
      }
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      copyFileSync(join(implDir, 'conform', 'overrides.ts'), join(tmpDir, 'conform', 'overrides.ts'));
      copyFileSync(join(implDir, 'conform', 'spec-state.ts'), join(tmpDir, 'conform', 'spec-state.ts'));
      copyFileSync(join(implDir, 'conform', 'drive.ts'), join(tmpDir, 'conform', 'drive.ts'));
      // drive.ts imports service modules by relative path ('../src/...') — the copy above needs
      // that same relative layout, not the whole impl tree, so symlink just src/ alongside it.
      const { symlinkSync } = await import('node:fs');
      symlinkSync(join(implDir, 'src'), join(tmpDir, 'src'), 'dir');
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: join(tmpDir, 'session'), snapshots: '.conform/snapshots', optOuts: [],
        schema: join(implDir, 'src', 'schema.sql'), // absolute — path.resolve() ignores targetDir for absolute paths
      }));

      const { readConformance } = await import('../engine/session.js');
      const forThisRun = () => readConformance(join(tmpDir, 'session')).filter(e => e.target === resolve(tmpDir));

      // seed 1 is the clean-impl validation's own pinned seed (D1.T7) — deterministically CLEAN,
      // so this run's `reattributions` value is a fixed, reproducible fact, not seed-dependent
      // flakiness. voidDraft/voidOpen share voidInvoice (design §2 human ruling 2026-07-16), so a
      // real drive run against the real target is expected to re-attribute at least once.
      const { exitCode } = await runDrive(tmpDir, { sequences: 50, length: 20, seed: 1, checkEvery: 5, probeRate: 0.3 });
      expect(exitCode).toBe(0);

      const entries = forThisRun();
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({ kind: 'conformance', mode: 'drive', target: resolve(tmpDir) });
      expect(entry.drive).toBeDefined();
      expect(typeof entry.drive!.reattributions).toBe('number');
      expect(entry.drive!.reattributions).toBeGreaterThan(0);

      await runDrive(tmpDir, { sequences: 50, length: 20, seed: 1, checkEvery: 5, probeRate: 0.3 });
      expect(forThisRun()).toHaveLength(2); // append-only, one per run
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
