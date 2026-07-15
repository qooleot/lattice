import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';
import { tinyDb, tinyModel } from './fixtures.js';

const overrides = {
  Account: {
    balance: (db: unknown, row: Record<string, unknown>) =>
      ((db as Database.Database).prepare('SELECT COALESCE(SUM(amount),0) s FROM account_entries WHERE account_id = ?')
        .get(row.id) as { s: number }).s,
    status: (_db: unknown, row: Record<string, unknown>) => row.state as string,
  },
};

function seeded() {
  const db = tinyDb();
  db.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES ('a1','Ada','openState')`).run();
  db.prepare(`INSERT INTO account_entries (account_id, amount) VALUES ('a1', 700), ('a1', -200)`).run();
  return db;
}

describe('observeEntities', () => {
  it('projects rows into spec-shaped CaseEntities via bindings and overrides', () => {
    const db = seeded();
    const manifest = bindSchema(db, tinyModel, overrides);
    const entities = observeEntities(db, tinyModel, manifest, overrides);
    expect(entities).toEqual([
      { type: 'Account', id: 'a1', fields: { accountId: 'a1', ownerName: 'Ada', balance: 500, status: 'openState' } },
    ]);
  });

  it('fails hard when an override returns undefined (a lying projection must not coerce)', () => {
    const db = seeded();
    const lying = { Account: { ...overrides.Account, status: () => undefined as unknown as string } };
    const manifest = bindSchema(db, tinyModel, lying);
    expect(() => observeEntities(db, tinyModel, manifest, lying)).toThrow(/Account\.status.*a1/);
  });
});
