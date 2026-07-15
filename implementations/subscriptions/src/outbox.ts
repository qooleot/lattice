import type Database from 'better-sqlite3';

export function appendEvent(db: Database.Database, eventType: string, aggregateId: string, payload: unknown): void {
  db.prepare(`INSERT INTO outbox (event_type, aggregate_id, payload, created_at) VALUES (?,?,?,unixepoch())`)
    .run(eventType, aggregateId, JSON.stringify(payload));
}
