import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import {
  activate, changePlan, changeSeats, createSubscription, getSubscription, recordUsage, rolloverPeriod,
} from '../src/subscription-service.js';
import { finalizeInvoice, getInvoice, recordPayment } from '../src/billing-service.js';

function activeSub() {
  const db = makeDb();
  createSubscription(db, { id: 'sub-1', planCode: 'basic', seats: 4, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 4_000 });
  finalizeInvoice(db, 'sub-1-inv-1');
  recordPayment(db, 'sub-1-inv-1', 4_000, 1_100);
  activate(db, 'sub-1');
  // open the second billing period so there is a current draft to accrue into
  rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-2', licenseFeeAmount: 4_000, nextPeriodEnd: 3_000, now: 2_000, charge: () => true });
  return db;
}

describe('growth features (superset)', () => {
  it('recordUsage accrues units onto the current draft invoice', () => {
    const db = activeSub();
    recordUsage(db, 'sub-1', 10, 25);
    expect(getSubscription(db, 'sub-1').accrued_units).toBe(10);
    expect(getInvoice(db, 'sub-1-inv-2').usage_amount).toBe(250);
  });

  it('rollover advances the period and opens the next draft; settled-ahead invoices skip billing', () => {
    const db = activeSub();
    const sub = getSubscription(db, 'sub-1');
    expect(sub.current_invoice_id).toBe('sub-1-inv-2');
    expect(sub.period_start).toBe(2_000);
    expect(sub.period_end).toBe(3_000);
    expect(sub.accrued_units).toBe(0);
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('paid'); // paid before rollover — no re-billing
    expect(getInvoice(db, 'sub-1-inv-2').settlement_state).toBe('draft');
    // settled-ahead path emits nothing beyond the pre-rollover history
    const types = (db.prepare('SELECT event_type FROM outbox ORDER BY id').all() as any[]).map(r => r.event_type);
    expect(types).toEqual(['InvoiceFinalized', 'InvoicePaid', 'SubscriptionActivated']);
  });

  it('failed rollover charge leaves the sub past_due with the old invoice open', () => {
    const db = activeSub();
    recordUsage(db, 'sub-1', 4, 100);
    rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-3', licenseFeeAmount: 4_000, nextPeriodEnd: 4_000, now: 3_000, charge: () => false });
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('past_due');
    const inv2 = getInvoice(db, 'sub-1-inv-2');
    expect(inv2.settlement_state).toBe('open');
    expect(inv2.total_due).toBe(4_400); // fee + accrued usage
  });

  it('changeSeats prorates onto the draft and clamps below zero', () => {
    const db = activeSub();
    changeSeats(db, 'sub-1', 6, 1_500);
    expect(getSubscription(db, 'sub-1').seat_qty).toBe(6);
    expect(getInvoice(db, 'sub-1-inv-2').usage_amount).toBe(1_500);
    expect(() => changeSeats(db, 'sub-1', 2, -9_999)).toThrow(/negative/);
  });

  it('changePlan supersedes: cancels old (event), creates new on the new plan, never mutates plan_code', () => {
    const db = activeSub();
    changePlan(db, 'sub-1', { newId: 'sub-2', planCode: 'pro', licenseFeeAmount: 9_000, now: 2_500, periodEnd: 3_500 });
    const oldSub = getSubscription(db, 'sub-1');
    expect(oldSub.lifecycle_state).toBe('canceled');
    expect(oldSub.plan_code).toBe('basic');
    expect(oldSub.superseded_by).toBe('sub-2');
    const newSub = getSubscription(db, 'sub-2');
    expect(newSub.plan_code).toBe('pro');
    expect(newSub.seat_qty).toBe(4); // carried over from the superseded row
    expect(newSub.lifecycle_state).toBe('trialing');
  });
});
