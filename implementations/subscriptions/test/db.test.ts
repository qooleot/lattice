import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';

describe('openDb', () => {
  it('creates every table with foreign keys enforced', () => {
    const db = makeDb();
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all() as { name: string }[]).map(r => r.name);
    expect(names).toEqual([
      'account_summary', 'dunning_attempts', 'invoice_payments', 'invoices', 'outbox', 'subscriptions',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
