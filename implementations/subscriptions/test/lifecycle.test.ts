import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { activate, cancelSubscription, createSubscription, expireTrials, getSubscription } from '../src/subscription-service.js';
import { finalizeInvoice, getInvoice, recordPayment } from '../src/billing-service.js';
import { recordPaymentFailure, runDunning } from '../src/dunning.js';

function paidTrial() {
  const db = makeDb();
  createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000, maxRetries: 2 });
  finalizeInvoice(db, 'sub-1-inv-1');
  recordPayment(db, 'sub-1-inv-1', 5_000, 1_100);
  return db;
}
const eventTypes = (db: any) => (db.prepare('SELECT event_type FROM outbox ORDER BY id').all() as any[]).map(r => r.event_type);

describe('lifecycle', () => {
  it('activate requires a paid invoice and emits SubscriptionActivated', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 });
    expect(() => activate(db, 'sub-1')).toThrow(/paid/);
    finalizeInvoice(db, 'sub-1-inv-1');
    recordPayment(db, 'sub-1-inv-1', 5_000, 1_100);
    activate(db, 'sub-1');
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
    expect(eventTypes(db)).toEqual(['InvoiceFinalized', 'InvoicePaid', 'SubscriptionActivated']);
  });

  it('expireTrials expires only overdue trials, silently', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 1, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 100 });
    createSubscription(db, { id: 'sub-2', planCode: 'pro', seats: 1, periodStart: 1_000, periodEnd: 9_000, licenseFeeAmount: 100 });
    expect(expireTrials(db, 5_000)).toBe(1);
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('expired');
    expect(getSubscription(db, 'sub-2').lifecycle_state).toBe('trialing');
    expect(eventTypes(db)).toEqual([]);
  });

  it('cancel is legal from trialing/active/past_due only', () => {
    const db = paidTrial();
    activate(db, 'sub-1');
    cancelSubscription(db, 'sub-1');
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('canceled');
    expect(() => cancelSubscription(db, 'sub-1')).toThrow();
    expect(eventTypes(db)).toContain('SubscriptionCanceled');
  });

  it('payment failure marks past_due; successful retry recovers silently', () => {
    const db = paidTrial();
    activate(db, 'sub-1');
    // second billing cycle: a fresh open invoice that fails
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES ('sub-1-inv-2','sub-1',5000)`).run();
    finalizeInvoice(db, 'sub-1-inv-2');
    recordPaymentFailure(db, 'sub-1-inv-2', 2_100);
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('past_due');
    expect((db.prepare('SELECT COUNT(*) c FROM dunning_attempts').get() as any).c).toBe(0); // initial decline != attempt
    const r = runDunning(db, 2_200, () => true);
    expect(r).toEqual({ attempted: 1, exhausted: 0 });
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
    expect(getInvoice(db, 'sub-1-inv-2').settlement_state).toBe('paid');
  });

  it('exhaustion after max_retries cancels the subscription and writes off the invoice', () => {
    const db = paidTrial(); // maxRetries: 2
    activate(db, 'sub-1');
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES ('sub-1-inv-2','sub-1',5000)`).run();
    finalizeInvoice(db, 'sub-1-inv-2');
    recordPaymentFailure(db, 'sub-1-inv-2', 2_100);       // initial decline: 0 attempts, not a retry
    expect(runDunning(db, 2_200, () => false)).toEqual({ attempted: 1, exhausted: 0 }); // attempt 1
    expect(runDunning(db, 2_300, () => false)).toEqual({ attempted: 1, exhausted: 0 }); // attempt 2
    expect(runDunning(db, 2_400, () => false)).toEqual({ attempted: 0, exhausted: 1 }); // cap reached (2 >= maxRetries 2)
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('canceled');
    expect(getInvoice(db, 'sub-1-inv-2').settlement_state).toBe('uncollectible');
    expect(eventTypes(db)).toContain('SubscriptionCanceled');
    const summary = db.prepare('SELECT * FROM account_summary WHERE subscription_id = ?').get('sub-1') as any;
    expect(summary.status).toBe('canceled');
    expect(summary.open_balance).toBe(0); // write-off happened BEFORE the cancel refresh
  });
});
