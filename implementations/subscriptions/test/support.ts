import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';

/** Open handles for the current test file. Plan 2's conformance capture hook drains this
 *  array in afterEach — keep the export stable. */
export const openDbs: Database.Database[] = [];

export function makeDb(): Database.Database {
  const db = openDb();
  openDbs.push(db);
  return db;
}
