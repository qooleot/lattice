import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { cancelSubscription, createSubscription, getSubscription } from '../src/subscription-service.js';
import { amountPaid, finalizeInvoice, getInvoice, recordPayment, voidInvoice, writeOffInvoice } from '../src/billing-service.js';

function seeded() {
  const db = makeDb();
  createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 });
  return db;
}
const events = (db: any) => (db.prepare('SELECT event_type, aggregate_id FROM outbox ORDER BY id').all() as any[]);

describe('billing-service', () => {
  it('finalize computes total and emits InvoiceFinalized', () => {
    const db = seeded();
    finalizeInvoice(db, 'sub-1-inv-1');
    const inv = getInvoice(db, 'sub-1-inv-1');
    expect(inv.settlement_state).toBe('open');
    expect(inv.total_due).toBe(5_000);
    expect(events(db)).toEqual([{ event_type: 'InvoiceFinalized', aggregate_id: 'sub-1-inv-1' }]);
  });

  it('partial payments accrue; exact-full payment settles, emits InvoicePaid, bumps paid_invoice_count', () => {
    const db = seeded();
    finalizeInvoice(db, 'sub-1-inv-1');
    recordPayment(db, 'sub-1-inv-1', 2_000, 1_100);
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('open');
    expect(amountPaid(db, 'sub-1-inv-1')).toBe(2_000);
    recordPayment(db, 'sub-1-inv-1', 3_000, 1_200);
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('paid');
    expect(getSubscription(db, 'sub-1').paid_invoice_count).toBe(1);
    expect(events(db).map(e => e.event_type)).toEqual(['InvoiceFinalized', 'InvoicePaid']);
  });

  it('rejects overpayment and payments on non-open invoices', () => {
    const db = seeded();
    expect(() => recordPayment(db, 'sub-1-inv-1', 1, 1_100)).toThrow(/open/);
    finalizeInvoice(db, 'sub-1-inv-1');
    expect(() => recordPayment(db, 'sub-1-inv-1', 5_001, 1_100)).toThrow(/overpayment/);
  });

  it('void covers draft and open; write-off only open; neither emits', () => {
    const db = seeded();
    voidInvoice(db, 'sub-1-inv-1');
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('void');
    expect(() => writeOffInvoice(db, 'sub-1-inv-1')).toThrow();
    expect(events(db)).toEqual([]);
  });

  it('win-back: a canceled customer who settles is reactivated (v2 flow)', () => {
    const db = seeded();
    finalizeInvoice(db, 'sub-1-inv-1');
    cancelSubscription(db, 'sub-1');                    // canceled with an open invoice
    recordPayment(db, 'sub-1-inv-1', 5_000, 1_200);     // pays in full → drifted settle revives
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
  });
});
