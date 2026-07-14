import type Database from 'better-sqlite3';

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
