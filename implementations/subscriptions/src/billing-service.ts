import type Database from 'better-sqlite3';
import { appendEvent } from './outbox.js';
import { INVOICE_FINALIZED, INVOICE_PAID } from './events.js';
import { getSubscription } from './subscription-service.js';
import { refreshAccountSummary } from './read-model.js';

export interface InvoiceRow {
  id: string; subscription_id: string; license_fee_amount: number;
  usage_amount: number; total_due: number; settlement_state: string;
}

export function getInvoice(db: Database.Database, id: string): InvoiceRow {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
  if (!row) throw new Error(`invoice not found: ${id}`);
  return row;
}

export function amountPaid(db: Database.Database, invoiceId: string): number {
  return (db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM invoice_payments WHERE invoice_id = ?')
    .get(invoiceId) as { s: number }).s;
}

export function finalizeInvoice(db: Database.Database, invoiceId: string): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'draft') throw new Error(`finalize: ${invoiceId} is ${inv.settlement_state}`);
    const total = inv.license_fee_amount + inv.usage_amount;
    db.prepare(`UPDATE invoices SET total_due = ?, settlement_state = 'open' WHERE id = ?`).run(total, invoiceId);
    appendEvent(db, INVOICE_FINALIZED, invoiceId, { invoiceId });
    refreshAccountSummary(db, inv.subscription_id, 0);
  })();
}

export function recordPayment(db: Database.Database, invoiceId: string, amount: number, now: number): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'open') throw new Error(`payments only accepted on open invoices (${invoiceId} is ${inv.settlement_state})`);
    if (amount <= 0) throw new Error('payment amount must be positive');
    const paid = amountPaid(db, invoiceId);
    if (paid + amount > inv.total_due) throw new Error(`overpayment rejected: ${paid} + ${amount} > ${inv.total_due}`);
    db.prepare('INSERT INTO invoice_payments (invoice_id, amount, paid_at) VALUES (?,?,?)').run(invoiceId, amount, now);
    if (paid + amount === inv.total_due) settle(db, inv);
  })();
}

function settle(db: Database.Database, inv: InvoiceRow): void {
  db.prepare(`UPDATE invoices SET settlement_state = 'paid' WHERE id = ?`).run(inv.id);
  appendEvent(db, INVOICE_PAID, inv.id, { invoiceId: inv.id });
  const sub = getSubscription(db, inv.subscription_id);
  db.prepare('UPDATE subscriptions SET paid_invoice_count = paid_invoice_count + 1 WHERE id = ?').run(sub.id);
  if (sub.lifecycle_state === 'past_due') {
    // payment restored the account — silent recovery, no event
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(sub.id);
  }
  refreshAccountSummary(db, inv.subscription_id, 0);
}

export function voidInvoice(db: Database.Database, invoiceId: string): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'draft' && inv.settlement_state !== 'open')
      throw new Error(`void: ${invoiceId} is ${inv.settlement_state}`);
    db.prepare(`UPDATE invoices SET settlement_state = 'void' WHERE id = ?`).run(invoiceId);
    refreshAccountSummary(db, inv.subscription_id, 0);
  })();
}

export function writeOffInvoice(db: Database.Database, invoiceId: string): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'open') throw new Error(`write-off: ${invoiceId} is ${inv.settlement_state}`);
    db.prepare(`UPDATE invoices SET settlement_state = 'uncollectible' WHERE id = ?`).run(invoiceId);
    refreshAccountSummary(db, inv.subscription_id, 0);
  })();
}
