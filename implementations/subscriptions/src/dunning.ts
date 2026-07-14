import type Database from 'better-sqlite3';
import { getSubscription, cancelSubscription } from './subscription-service.js';
import { amountPaid, getInvoice, recordPayment, writeOffInvoice } from './billing-service.js';
import { refreshAccountSummary } from './read-model.js';

function failedAttempts(db: Database.Database, invoiceId: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM dunning_attempts WHERE invoice_id = ? AND outcome = 'failed'`)
    .get(invoiceId) as { c: number }).c;
}

export function recordPaymentFailure(db: Database.Database, invoiceId: string, now: number): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'open') throw new Error(`payment failure on non-open invoice ${invoiceId}`);
    db.prepare(`INSERT INTO dunning_attempts (invoice_id, attempted_at, outcome) VALUES (?,?,'failed')`)
      .run(invoiceId, now);
    const sub = getSubscription(db, inv.subscription_id);
    if (sub.lifecycle_state === 'active') {
      db.prepare(`UPDATE subscriptions SET lifecycle_state = 'past_due' WHERE id = ?`).run(sub.id);
    }
    refreshAccountSummary(db, inv.subscription_id, now);
  })();
}

export function runDunning(
  db: Database.Database, now: number,
  charge: (invoiceId: string, amountDue: number) => boolean,
): { attempted: number; exhausted: number } {
  const targets = db.prepare(`
    SELECT i.id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
    WHERE i.settlement_state = 'open' AND s.lifecycle_state = 'past_due' ORDER BY i.id
  `).all() as { id: string }[];
  let attempted = 0, exhausted = 0;
  for (const { id } of targets) {
    db.transaction(() => {
      const inv = getInvoice(db, id);
      const sub = getSubscription(db, inv.subscription_id);
      if (failedAttempts(db, id) >= sub.max_retries) {
        writeOffInvoice(db, id);
        cancelSubscription(db, sub.id);
        exhausted++;
        return;
      }
      const due = inv.total_due - amountPaid(db, id);
      attempted++;
      if (charge(id, due)) recordPayment(db, id, due, now);
      else db.prepare(`INSERT INTO dunning_attempts (invoice_id, attempted_at, outcome) VALUES (?,?,'failed')`).run(id, now);
    })();
  }
  return { attempted, exhausted };
}
