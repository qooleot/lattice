import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import {
  activate, cancelSubscription, changePlan, changeSeats, createSubscription, expireTrials,
  getSubscription, recordUsage, rolloverPeriod,
} from '../src/subscription-service.js';
import { finalizeInvoice, getInvoice, recordPayment, voidInvoice } from '../src/billing-service.js';
import { runDunning } from '../src/dunning.js';

const eventLog = (db: any) =>
  (db.prepare('SELECT event_type, aggregate_id FROM outbox ORDER BY id').all() as any[])
    .map(e => `${e.event_type}:${e.aggregate_id}`);

describe('full customer journey', () => {
  it('trial → activate → usage/rollover → failed charge → dunning exhaustion', () => {
    const db = makeDb();
    createSubscription(db, { id: 'acme', planCode: 'basic', seats: 3, periodStart: 0, periodEnd: 100, licenseFeeAmount: 3_000, maxRetries: 1 });
    finalizeInvoice(db, 'acme-inv-1');
    recordPayment(db, 'acme-inv-1', 1_000, 10);
    recordPayment(db, 'acme-inv-1', 2_000, 20);
    activate(db, 'acme');
    expect(() => recordUsage(db, 'acme', 5, 100)).toThrow(/draft/); // current invoice already paid
    rolloverPeriod(db, 'acme', { nextInvoiceId: 'acme-inv-2', licenseFeeAmount: 3_000, nextPeriodEnd: 200, now: 100, charge: () => true });
    recordUsage(db, 'acme', 5, 100);
    changeSeats(db, 'acme', 4, 500);
    rolloverPeriod(db, 'acme', { nextInvoiceId: 'acme-inv-3', licenseFeeAmount: 3_000, nextPeriodEnd: 300, now: 200, charge: () => false });
    expect(getSubscription(db, 'acme').lifecycle_state).toBe('past_due');
    expect(getInvoice(db, 'acme-inv-2').total_due).toBe(4_000); // 3000 fee + 500 usage + 500 proration
    expect(runDunning(db, 210, () => false)).toEqual({ attempted: 1, exhausted: 0 });
    expect(runDunning(db, 220, () => false)).toEqual({ attempted: 0, exhausted: 1 });
    const done = getSubscription(db, 'acme');
    expect(done.lifecycle_state).toBe('canceled');
    expect(getInvoice(db, 'acme-inv-2').settlement_state).toBe('uncollectible');
    expect(getInvoice(db, 'acme-inv-3').settlement_state).toBe('draft');
    // hand-verified against the spec machine: finalize(inv-1 draft→open), settle(inv-1 open→paid),
    // activate(trialing→active), finalize(inv-2 draft→open) at rollover 2; rollover 1 skipped
    // billing (inv-1 settled ahead); dunning failures, write-off, and past_due were silent;
    // exhaustion cancels via the legal cancel(past_due→canceled).
    expect(eventLog(db)).toEqual([
      'InvoiceFinalized:acme-inv-1', 'InvoicePaid:acme-inv-1', 'SubscriptionActivated:acme',
      'InvoiceFinalized:acme-inv-2', 'SubscriptionCanceled:acme',
    ]);
  });

  it('trial expiry and mid-trial cancel and plan supersession', () => {
    const db = makeDb();
    createSubscription(db, { id: 'a', planCode: 'basic', seats: 1, periodStart: 0, periodEnd: 50, licenseFeeAmount: 100 });
    createSubscription(db, { id: 'b', planCode: 'basic', seats: 1, periodStart: 0, periodEnd: 500, licenseFeeAmount: 100 });
    createSubscription(db, { id: 'c', planCode: 'basic', seats: 2, periodStart: 0, periodEnd: 500, licenseFeeAmount: 100 });
    expect(expireTrials(db, 60)).toBe(1);
    cancelSubscription(db, 'b');
    voidInvoice(db, 'c-inv-1');
    changePlan(db, 'c', { newId: 'c2', planCode: 'pro', licenseFeeAmount: 900, now: 60, periodEnd: 600 });
    expect(getSubscription(db, 'a').lifecycle_state).toBe('expired');
    expect(getSubscription(db, 'b').lifecycle_state).toBe('canceled');
    expect(getSubscription(db, 'c').superseded_by).toBe('c2');
    expect(getSubscription(db, 'c2').plan_code).toBe('pro');
  });
});
