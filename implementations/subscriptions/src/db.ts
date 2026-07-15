import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function openDb(file = ':memory:'): Database.Database {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}
