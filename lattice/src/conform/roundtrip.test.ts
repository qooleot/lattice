import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { loadGenInput } from '../generate/load.js';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const implDir = join(repoRoot, 'implementations/subscriptions');
const snapDir = join(implDir, '.conform/snapshots');

// Round-trip guardrail (design §4.3): the projection must agree with the impl's own outbox facts.
// For every snapshot: a SubscriptionActivated event implies the aggregate observes status ∈
// {active, pastDue, canceled} (activated then possibly failed/canceled later) and NEVER
// trialing/expired; an InvoicePaid event implies that invoice observes amountPaid == totalDue.
describe('observe() round-trip against the event stream', () => {
  it.skipIf(!existsSync(snapDir))('projection never contradicts recorded events', async () => {
    const { model } = loadGenInput(join(repoRoot, '.lattice-session-subscriptions'));
    const { overrides } = await import(join(implDir, 'conform/overrides.ts'));
    for (const snap of readdirSync(snapDir).filter(f => f.endsWith('.sqlite'))) {
      const db = new Database(join(snapDir, snap), { readonly: true });
      try {
        const entities = observeEntities(db, model, bindSchema(db, model, overrides), overrides);
        const events = db.prepare('SELECT event_type, aggregate_id FROM outbox ORDER BY id').all() as
          { event_type: string; aggregate_id: string }[];
        for (const e of events) {
          if (e.event_type === 'SubscriptionActivated') {
            const s = entities.find(x => x.type === 'Subscription' && x.id === e.aggregate_id)!;
            expect(['active', 'pastDue', 'canceled'], `${snap}: ${e.aggregate_id}`).toContain(s.fields.status);
          }
          if (e.event_type === 'InvoicePaid') {
            const i = entities.find(x => x.type === 'Invoice' && x.id === e.aggregate_id)!;
            expect(i.fields.amountPaid, `${snap}: ${e.aggregate_id}`).toBe(i.fields.totalDue);
          }
        }
      } finally { db.close(); }
    }
  });
});
