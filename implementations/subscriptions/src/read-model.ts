import type Database from 'better-sqlite3';
import { getSubscription } from './subscription-service.js';

export function refreshAccountSummary(db: Database.Database, subId: string, now: number): void {
  const sub = getSubscription(db, subId);
  const open = (db.prepare(`
    SELECT COALESCE(SUM(i.total_due), 0) -
           COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                     JOIN invoices i2 ON i2.id = p.invoice_id
                     WHERE i2.subscription_id = ? AND i2.settlement_state = 'open'), 0) AS bal
    FROM invoices i WHERE i.subscription_id = ? AND i.settlement_state = 'open'
  `).get(subId, subId) as { bal: number }).bal;
  const lifetime = (db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS s FROM invoice_payments p
    JOIN invoices i ON i.id = p.invoice_id WHERE i.subscription_id = ?
  `).get(subId) as { s: number }).s;
  db.prepare(`
    INSERT INTO account_summary (subscription_id, plan_code, status, open_balance, lifetime_paid, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      plan_code = excluded.plan_code, status = excluded.status, open_balance = excluded.open_balance,
      lifetime_paid = excluded.lifetime_paid, updated_at = excluded.updated_at
  `).run(subId, sub.plan_code, sub.lifecycle_state, open, lifetime, now);
}
