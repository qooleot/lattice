import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { renderDdl, OUTBOX_DDL } from './sql.js';
import { buildPlan } from '../plan.js';
import { tinyInput } from '../fixtures.js';

describe('renderDdl', () => {
  const ddl = renderDdl(buildPlan(tinyInput));
  it('creates the aggregate table with a primary key and state column', () => {
    expect(ddl).toMatch(/CREATE TABLE "Account"/);
    expect(ddl).toMatch(/"accountId" TEXT PRIMARY KEY/);
    expect(ddl).toMatch(/"balance" INTEGER/);
    expect(ddl).toMatch(/"status" TEXT NOT NULL/);
  });
  it('produces DDL that a real sqlite engine accepts', () => {
    const db = new Database(':memory:');
    expect(() => db.exec(ddl)).not.toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toContain('Account');
    expect(tables).toContain('outbox');
    db.close();
  });
  it('exposes a stable outbox schema (slice-2 seam)', () => {
    expect(OUTBOX_DDL).toMatch(/CREATE TABLE outbox/);
    expect(OUTBOX_DDL).toMatch(/event_type TEXT NOT NULL/);
  });
});
