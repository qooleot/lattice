import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { createSubscription, getSubscription } from '../src/subscription-service.js';

const baseArgs = { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 };

describe('createSubscription', () => {
  it('creates a trialing subscription with a draft first invoice as current', () => {
    const db = makeDb();
    createSubscription(db, baseArgs);
    const sub = getSubscription(db, 'sub-1');
    expect(sub.lifecycle_state).toBe('trialing');
    expect(sub.paid_invoice_count).toBe(0);
    expect(sub.current_invoice_id).toBe('sub-1-inv-1');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get('sub-1-inv-1') as any;
    expect(inv.settlement_state).toBe('draft');
    expect(inv.license_fee_amount).toBe(5_000);
    expect(inv.total_due).toBe(0); // totals are computed at finalize, not at creation
    // creation is not a spec event — nothing on the outbox
    expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c).toBe(0);
  });

  it('rejects a duplicate id', () => {
    const db = makeDb();
    createSubscription(db, baseArgs);
    expect(() => createSubscription(db, baseArgs)).toThrow();
  });
});
