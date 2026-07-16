import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { bindSchema } from './bind.js';
import { observeEntities, observeScoped } from './observe.js';
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
      { type: 'Account', id: 'a1', fields: { accountId: 'a1', ownerName: 'Ada', balance: 500, 'status.state': 'openState' } },
    ]);
  });

  it('fails hard when an override returns undefined (a lying projection must not coerce)', () => {
    const db = seeded();
    const lying = { Account: { ...overrides.Account, status: () => undefined as unknown as string } };
    const manifest = bindSchema(db, tinyModel, lying);
    expect(() => observeEntities(db, tinyModel, manifest, lying)).toThrow(/Account\.status.*a1/);
  });

  it('omits nullable-ref field from fields when SQL NULL (auto-bound ref with no value)', () => {
    const db = tinyDb();
    // One account with NULL parent_id (no parent set)
    db.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES ('a1','Ada','openState')`).run();
    // Another account with parent_id pointing to a1 (has a parent)
    db.prepare(`INSERT INTO accounts (id, owner_name, state, parent_id) VALUES ('a2','Bob','openState','a1')`).run();

    const manifest = bindSchema(db, tinyModel, overrides);
    const entities = observeEntities(db, tinyModel, manifest, overrides);

    // a1 has NULL parent_id, so the 'parent' key should be omitted from fields
    const a1 = entities.find(e => e.id === 'a1')!;
    expect('parent' in a1.fields).toBe(false);
    expect(a1.fields).toEqual({ accountId: 'a1', ownerName: 'Ada', balance: 0, 'status.state': 'openState' });

    // a2 has parent_id='a1', so the 'parent' key should be present with that value
    const a2 = entities.find(e => e.id === 'a2')!;
    expect('parent' in a2.fields).toBe(true);
    expect(a2.fields.parent).toBe('a1');
  });

  it('omits nullable-ref field from fields when an OVERRIDE returns null (semantic rename of a nullable ref)', () => {
    const db = tinyDb();
    db.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES ('a1','Ada','openState')`).run();
    db.prepare(`INSERT INTO accounts (id, owner_name, state, parent_id) VALUES ('a2','Bob','openState','a1')`).run();

    // Force 'parent' to bind via an override (instead of auto) that reads the same column —
    // exercises the OVERRIDE branch of the null/undefined check, not the auto branch.
    const overridden = { Account: { ...overrides.Account, parent: (_db: unknown, row: Record<string, unknown>) => row.parent_id as string } };
    const manifest = bindSchema(db, tinyModel, overridden);
    const entities = observeEntities(db, tinyModel, manifest, overridden);

    // a1's override returns null (row.parent_id is null) — the key must be omitted, not throw.
    const a1 = entities.find(e => e.id === 'a1')!;
    expect('parent' in a1.fields).toBe(false);

    // a2's override returns 'a1' — the key must be present.
    const a2 = entities.find(e => e.id === 'a2')!;
    expect('parent' in a2.fields).toBe(true);
    expect(a2.fields.parent).toBe('a1');

    // 'status' is a region member (bound via override here) — must project under the
    // evaluator's witness-key convention '<region>.state', not the bare region name.
    expect(a2.fields['status.state']).toBe('openState');
  });
});

describe('observeScoped', () => {
  it('projects one row plus its ref closure (one hop)', () => {
    const db = seeded(); // existing helper: account a1 with entries + parent_id column
    db.prepare(`INSERT INTO accounts (id, owner_name, state, parent_id) VALUES ('a2','Bob','openState','a1')`).run();
    const manifest = bindSchema(db, tinyModel, overrides);
    const scoped = observeScoped(db, tinyModel, manifest, overrides, 'Account', 'a2');
    expect(scoped.map(e => e.id)).toEqual(['a2', 'a1']);       // target first, then ref target
    expect(scoped[0]!.fields.parent).toBe('a1');
    expect(() => observeScoped(db, tinyModel, manifest, overrides, 'Account', 'ghost')).toThrow(/ghost/);
  });
});
