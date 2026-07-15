import { describe, it, expect } from 'vitest';
import { bindSchema, ConformBindError } from './bind.js';
import { tinyDb, tinyModel } from './fixtures.js';

const overrides = {
  Account: {
    balance: (_db: unknown, row: Record<string, unknown>) => 0, // real derivation comes in observe tests
    status: (_db: unknown, row: Record<string, unknown>) => 'openState',
  },
};

describe('bindSchema', () => {
  it('auto-binds by convention, routes overridden fields, and records the key column', () => {
    const db = tinyDb();
    db.prepare(`INSERT INTO accounts (id, owner_name) VALUES ('a1','Ada')`).run();
    const m = bindSchema(db, tinyModel, overrides);
    const acc = m.aggregates.find(a => a.aggregate === 'Account')!;
    expect(acc.table).toBe('accounts');
    expect(acc.keyColumn).toBe('id');
    expect(acc.fields).toContainEqual({ field: 'accountId', kind: 'auto', column: 'id' });
    expect(acc.fields).toContainEqual({ field: 'ownerName', kind: 'auto', column: 'owner_name' });
    expect(acc.fields.find(f => f.field === 'balance')).toMatchObject({ kind: 'override' });
    expect(acc.fields.find(f => f.field === 'status')).toMatchObject({ kind: 'override' });
    expect(acc.unbound).toEqual([]);
  });

  it('throws loudly, listing every unbound field, when overrides are missing', () => {
    const db = tinyDb();
    try {
      bindSchema(db, tinyModel, {});
      expect.unreachable('bindSchema must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConformBindError);
      const acc = (e as ConformBindError).manifest.aggregates.find(a => a.aggregate === 'Account')!;
      expect(acc.unbound).toContain('balance'); // no such column anywhere
      expect(acc.unbound).toContain('status');  // region column is named 'state', not 'status'/'status_state'
    }
  });

  it('rejects a name-matching column whose live values fall outside the region domain', () => {
    const db = tinyDb();
    db.exec(`ALTER TABLE accounts RENAME COLUMN state TO status`); // name now matches…
    db.prepare(`INSERT INTO accounts (id, owner_name, status) VALUES ('a1','Ada','gold')`).run(); // …values don't
    try {
      bindSchema(db, tinyModel, { Account: { balance: () => 0 } });
      expect.unreachable('bindSchema must throw');
    } catch (e) {
      const acc = (e as ConformBindError).manifest.aggregates.find(a => a.aggregate === 'Account')!;
      expect(acc.unbound).toContain('status'); // bound-by-name but refuted-by-data
    }
  });
});
