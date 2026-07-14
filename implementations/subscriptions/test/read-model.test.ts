import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { activate, createSubscription, rolloverPeriod } from '../src/subscription-service.js';
import { finalizeInvoice, recordPayment } from '../src/billing-service.js';

const summary = (db: any, id: string) => db.prepare('SELECT * FROM account_summary WHERE subscription_id = ?').get(id) as any;

describe('account summary read model', () => {
  it('tracks status and balances through the lifecycle', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 2, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 3_000 });
    expect(summary(db, 'sub-1')).toMatchObject({ status: 'trialing', open_balance: 0, lifetime_paid: 0 });
    finalizeInvoice(db, 'sub-1-inv-1');
    recordPayment(db, 'sub-1-inv-1', 3_000, 1_100);
    activate(db, 'sub-1');
    expect(summary(db, 'sub-1')).toMatchObject({ status: 'active', open_balance: 0, lifetime_paid: 3_000 });
    // First rollover: advance period (charge succeeds on a settled-ahead flow)
    rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-2', licenseFeeAmount: 3_000, nextPeriodEnd: 3_000, now: 2_000, charge: () => true });
    // Second rollover: charge fails, sub goes past_due
    rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-3', licenseFeeAmount: 3_000, nextPeriodEnd: 4_000, now: 3_000, charge: () => false });
    expect(summary(db, 'sub-1')).toMatchObject({ status: 'past_due', open_balance: 3_000, lifetime_paid: 3_000 });
  });
});
