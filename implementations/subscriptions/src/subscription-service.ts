import type Database from 'better-sqlite3';
import { appendEvent } from './outbox.js';
import { SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_CANCELED } from './events.js';

export interface SubscriptionRow {
  id: string; plan_code: string; seats: number; period_start: number; period_end: number;
  accrued_units: number; paid_invoice_count: number; max_retries: number;
  current_invoice_id: string | null; lifecycle_state: string; superseded_by: string | null;
}

export interface CreateSubscriptionArgs {
  id: string; planCode: string; seats: number;
  periodStart: number; periodEnd: number; licenseFeeAmount: number; maxRetries?: number;
}

export function getSubscription(db: Database.Database, id: string): SubscriptionRow {
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined;
  if (!row) throw new Error(`subscription not found: ${id}`);
  return row;
}

export function createSubscription(db: Database.Database, a: CreateSubscriptionArgs): void {
  db.transaction(() => {
    if (a.seats <= 0) throw new Error('seats must be positive');
    if (a.periodEnd <= a.periodStart) throw new Error('period must be well-ordered');
    db.prepare(`INSERT INTO subscriptions
        (id, plan_code, seats, period_start, period_end, max_retries)
        VALUES (?,?,?,?,?,?)`)
      .run(a.id, a.planCode, a.seats, a.periodStart, a.periodEnd, a.maxRetries ?? 3);
    const invoiceId = `${a.id}-inv-1`;
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES (?,?,?)`)
      .run(invoiceId, a.id, a.licenseFeeAmount);
    db.prepare('UPDATE subscriptions SET current_invoice_id = ? WHERE id = ?').run(invoiceId, a.id);
  })();
}

export function activate(db: Database.Database, subId: string): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (sub.lifecycle_state !== 'trialing') throw new Error(`activate: ${subId} is ${sub.lifecycle_state}`);
    if (sub.paid_invoice_count < 1) throw new Error(`activate: ${subId} has no paid invoice yet`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(subId);
    appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });
  })();
}

export function expireTrials(db: Database.Database, now: number): number {
  return db.transaction(() =>
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'expired'
                WHERE lifecycle_state = 'trialing' AND period_end < ?`).run(now).changes
  )();
}

export function cancelSubscription(db: Database.Database, subId: string): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active', 'past_due'].includes(sub.lifecycle_state))
      throw new Error(`cancel: ${subId} is ${sub.lifecycle_state}`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'canceled' WHERE id = ?`).run(subId);
    appendEvent(db, SUBSCRIPTION_CANCELED, subId, { subId });
  })();
}
