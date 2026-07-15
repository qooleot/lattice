import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCrosschecks, loadCrosschecks, type CrosscheckModule } from './crosscheck.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mod: CrosscheckModule = {
  crosschecks: {
    positiveBalance: (db) => {
      const bad = ((db as Database.Database).prepare('SELECT id FROM t WHERE v < 0').all() as { id: string }[]);
      return bad.map(b => ({ check: 'positiveBalance', witnessIds: [b.id], detail: `v negative for ${b.id}` }));
    },
  },
};

describe('runCrosschecks', () => {
  const mk = () => { const db = new Database(':memory:'); db.exec('CREATE TABLE t (id TEXT, v INTEGER)'); return db; };

  it('maps findings to conform violations with the crosscheck specElement', () => {
    const db = mk();
    db.prepare(`INSERT INTO t VALUES ('a', -1), ('b', 2)`).run();
    const v = runCrosschecks(db, mod, 'src1');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ specElement: 'crosscheck positiveBalance', witnessIds: ['a'], source: 'src1' });
  });

  it('clean state yields no violations', () => {
    const db = mk();
    db.prepare(`INSERT INTO t VALUES ('b', 2)`).run();
    expect(runCrosschecks(db, mod, 'src1')).toEqual([]);
  });
});

describe('loadCrosschecks', () => {
  it('returns null for a target dir with no conform/crosschecks.ts', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-load-test-'));
    try {
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      const result = await loadCrosschecks(tmpDir);
      expect(result).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('throws for a target with conform/crosschecks.ts that exports the wrong shape', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-bad-test-'));
    try {
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      writeFileSync(join(tmpDir, 'conform', 'crosschecks.ts'),
        'export const wrongName = {};');
      try {
        await loadCrosschecks(tmpDir);
        expect.unreachable('loadCrosschecks must throw on bad crosschecks module');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/must export 'crosschecks'/);
      }
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
