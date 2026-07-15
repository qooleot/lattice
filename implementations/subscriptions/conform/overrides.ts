// The residual hand-written adapter (design §4.3). Its size is the slice's measured number.
import type Database from 'better-sqlite3';
import { defineOverrides } from './spec-state.js';

const STATE_MAP: Record<string, 'trialing' | 'active' | 'pastDue' | 'canceled' | 'expired'> = {
  trialing: 'trialing', active: 'active', past_due: 'pastDue', canceled: 'canceled', expired: 'expired',
};

export const overrides = defineOverrides({
  Subscription: {
    status: (_db, row) => STATE_MAP[row.lifecycle_state as string]!,
    latestInvoice: (_db, row) => row.current_invoice_id as string | null,
  },
  Invoice: {
    amountPaid: (db, row) =>
      ((db as Database.Database).prepare('SELECT COALESCE(SUM(amount),0) s FROM invoice_payments WHERE invoice_id = ?')
        .get(row.id) as { s: number }).s,
    retryCount: (db, row) =>
      ((db as Database.Database).prepare(`SELECT COUNT(*) c FROM dunning_attempts WHERE invoice_id = ? AND outcome = 'failed'`)
        .get(row.id) as { c: number }).c,
  },
});
