import type Database from 'better-sqlite3';
import { appendEvent } from './outbox.js';
import { SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_CANCELED } from './events.js';
import { finalizeInvoice, getInvoice, recordPayment } from './billing-service.js';
import { refreshAccountSummary } from './read-model.js';
import { recordPaymentFailure } from './dunning.js';

export interface SubscriptionRow {
  id: string; plan_code: string; seat_qty: number; period_start: number; period_end: number;
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
        (id, plan_code, seat_qty, period_start, period_end, max_retries)
        VALUES (?,?,?,?,?,?)`)
      .run(a.id, a.planCode, a.seats, a.periodStart, a.periodEnd, a.maxRetries ?? 3);
    const invoiceId = `${a.id}-inv-1`;
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES (?,?,?)`)
      .run(invoiceId, a.id, a.licenseFeeAmount);
    db.prepare('UPDATE subscriptions SET current_invoice_id = ? WHERE id = ?').run(invoiceId, a.id);
    refreshAccountSummary(db, a.id, 0);
  })();
}

export function activate(db: Database.Database, subId: string): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (sub.lifecycle_state !== 'trialing') throw new Error(`activate: ${subId} is ${sub.lifecycle_state}`);
    if (sub.paid_invoice_count < 1) throw new Error(`activate: ${subId} has no paid invoice yet`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(subId);
    appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });
    refreshAccountSummary(db, subId, 0);
  })();
}

export function expireTrials(db: Database.Database, now: number): number {
  return db.transaction(() => {
    const ids = (db.prepare(`SELECT id FROM subscriptions
                WHERE lifecycle_state = 'trialing' AND period_end < ?`).all(now) as { id: string }[])
      .map(r => r.id);
    if (ids.length === 0) return 0;
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'expired'
                WHERE lifecycle_state = 'trialing' AND period_end < ?`).run(now);
    for (const id of ids) refreshAccountSummary(db, id, now);
    return ids.length;
  })();
}

export function cancelSubscription(db: Database.Database, subId: string): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active', 'past_due'].includes(sub.lifecycle_state))
      throw new Error(`cancel: ${subId} is ${sub.lifecycle_state}`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'canceled' WHERE id = ?`).run(subId);
    appendEvent(db, SUBSCRIPTION_CANCELED, subId, { subId });
    refreshAccountSummary(db, subId, 0);
  })();
}

export function recordUsage(db: Database.Database, subId: string, units: number, centsPerUnit: number): void {
  db.transaction(() => {
    if (units <= 0 || centsPerUnit < 0) throw new Error('usage must be positive');
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active'].includes(sub.lifecycle_state)) throw new Error(`recordUsage: ${subId} is ${sub.lifecycle_state}`);
    if (!sub.current_invoice_id) throw new Error(`recordUsage: ${subId} has no current invoice`);
    const inv = getInvoice(db, sub.current_invoice_id);
    if (inv.settlement_state !== 'draft') throw new Error('usage accrues only onto a draft invoice');
    db.prepare('UPDATE subscriptions SET accrued_units = accrued_units + ? WHERE id = ?').run(units, subId);
    db.prepare('UPDATE invoices SET usage_amount = usage_amount + ? WHERE id = ?').run(units * centsPerUnit, inv.id);
  })();
}

export interface RolloverArgs {
  nextInvoiceId: string; licenseFeeAmount: number; nextPeriodEnd: number; now: number;
  charge: (invoiceId: string, amountDue: number) => boolean;
}

export function rolloverPeriod(db: Database.Database, subId: string, a: RolloverArgs): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (sub.lifecycle_state !== 'active') throw new Error(`rollover: ${subId} is ${sub.lifecycle_state}`);
    if (!sub.current_invoice_id) throw new Error(`rollover: ${subId} has no current invoice`);
    const closingId = sub.current_invoice_id;
    const closingBefore = getInvoice(db, closingId);
    const needsBilling = closingBefore.settlement_state === 'draft'; // settled-ahead invoices skip billing
    if (needsBilling) finalizeInvoice(db, closingId);
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES (?,?,?)`)
      .run(a.nextInvoiceId, subId, a.licenseFeeAmount);
    db.prepare(`UPDATE subscriptions SET period_start = period_end, period_end = ?, accrued_units = 0,
                current_invoice_id = ? WHERE id = ?`).run(a.nextPeriodEnd, a.nextInvoiceId, subId);
    if (needsBilling) {
      const closing = getInvoice(db, closingId);
      if (a.charge(closingId, closing.total_due)) recordPayment(db, closingId, closing.total_due, a.now);
      else recordPaymentFailure(db, closingId, a.now);
    }
    refreshAccountSummary(db, subId, a.now);
  })();
}

export function changeSeats(db: Database.Database, subId: string, newSeats: number, prorationAmount: number): void {
  db.transaction(() => {
    if (newSeats <= 0) throw new Error('seats must be positive');
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active'].includes(sub.lifecycle_state)) throw new Error(`changeSeats: ${subId} is ${sub.lifecycle_state}`);
    if (!sub.current_invoice_id) throw new Error(`changeSeats: ${subId} has no current invoice`);
    const inv = getInvoice(db, sub.current_invoice_id);
    if (inv.settlement_state !== 'draft') throw new Error('seat changes only while the current invoice is draft');
    if (inv.usage_amount + prorationAmount < 0) throw new Error('proration would drive usage negative');
    db.prepare('UPDATE invoices SET usage_amount = usage_amount + ? WHERE id = ?').run(prorationAmount, inv.id);
    db.prepare('UPDATE subscriptions SET seat_qty = ? WHERE id = ?').run(newSeats, subId);
  })();
}

export interface ChangePlanArgs { newId: string; planCode: string; licenseFeeAmount: number; now: number; periodEnd: number }

export function changePlan(db: Database.Database, subId: string, a: ChangePlanArgs): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    cancelSubscription(db, subId);
    createSubscription(db, {
      id: a.newId, planCode: a.planCode, seats: sub.seat_qty,
      periodStart: a.now, periodEnd: a.periodEnd,
      licenseFeeAmount: a.licenseFeeAmount, maxRetries: sub.max_retries,
    });
    db.prepare('UPDATE subscriptions SET superseded_by = ? WHERE id = ?').run(a.newId, subId);
  })();
}
