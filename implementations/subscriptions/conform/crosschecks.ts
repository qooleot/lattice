// Class-13 instrument: recompute account_summary's spec-covered fields from base tables and
// compare. The derivation is DELIBERATELY duplicated from src/read-model.ts — an independent
// recomputation is the point; sharing code would let one bug hide in both.
import type Database from 'better-sqlite3';

interface Finding { check: string; witnessIds: string[]; detail: string }

function accountSummary(db: Database.Database): Finding[] {
  const out: Finding[] = [];
  const rows = db.prepare('SELECT * FROM account_summary').all() as Record<string, unknown>[];
  for (const row of rows) {
    const id = row.subscription_id as string;
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!sub) { out.push({ check: 'account_summary', witnessIds: [id], detail: `summary row for nonexistent subscription '${id}'` }); continue; }
    const open = (db.prepare(`
      SELECT COALESCE(SUM(i.total_due), 0) -
             COALESCE((SELECT SUM(p.amount) FROM invoice_payments p JOIN invoices i2 ON i2.id = p.invoice_id
                       WHERE i2.subscription_id = ? AND i2.settlement_state = 'open'), 0) AS bal
      FROM invoices i WHERE i.subscription_id = ? AND i.settlement_state = 'open'`).get(id, id) as { bal: number }).bal;
    const lifetime = (db.prepare(`
      SELECT COALESCE(SUM(p.amount), 0) AS s FROM invoice_payments p
      JOIN invoices i ON i.id = p.invoice_id WHERE i.subscription_id = ?`).get(id) as { s: number }).s;
    const mismatches: string[] = [];
    if (row.status !== sub.lifecycle_state) mismatches.push(`status '${row.status}' != lifecycle_state '${sub.lifecycle_state}'`);
    if (row.open_balance !== open) mismatches.push(`open_balance ${row.open_balance} != recomputed ${open}`);
    if (row.lifetime_paid !== lifetime) mismatches.push(`lifetime_paid ${row.lifetime_paid} != recomputed ${lifetime}`);
    if (mismatches.length) out.push({ check: 'account_summary', witnessIds: [id], detail: mismatches.join('; ') });
  }
  return out;
}

export const crosschecks = { account_summary: accountSummary };
