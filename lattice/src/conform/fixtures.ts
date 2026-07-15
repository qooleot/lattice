import Database from 'better-sqlite3';
import type { DomainModel } from '../ast/domain.js';

/** One aggregate, engineer-shaped storage: key 'id', snake_case, a region behind a
 *  divergently-named column, and one field materialized nowhere (needs an override). */
export const tinyModel: DomainModel = {
  context: 'Tiny',
  enums: [],
  values: [],
  entities: [],
  services: [],
  events: [
    { name: 'AccountClosed', fields: [{ name: 'accountId', type: { kind: 'prim', prim: 'Id' } }] },
  ],
  aggregates: [{
    kind: 'aggregate',
    name: 'Account',
    fields: [
      { name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'balance', type: { kind: 'prim', prim: 'Money' } },
      { name: 'ownerName', type: { kind: 'prim', prim: 'Text' } },
      { name: 'parent', type: { kind: 'ref', target: 'Account' } },
    ],
    machine: {
      regions: [{
        name: 'status', initial: 'openState',
        states: [{ name: 'openState' }, { name: 'closedState', tags: ['terminal'] }],
      }],
      transitions: [
        { name: 'close', region: 'status', from: ['openState'], to: 'closedState', emits: 'AccountClosed' },
      ],
    },
  }],
};

export function tinyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'openState',   -- region column with a non-convention name
      parent_id TEXT                             -- nullable ref to another Account
    );
    CREATE TABLE account_entries (               -- balance = SUM(amount): materialized nowhere
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount INTEGER NOT NULL
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  return db;
}
