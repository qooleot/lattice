import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadGenInput } from '../generate/load.js';
import { buildPlan } from '../generate/plan.js';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';
import { checkInvariants } from './tier1.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const implDir = join(repoRoot, 'implementations/subscriptions');

// Composed positive-control (final-review F1): the observe.test.ts and tier1.test.ts suites
// each pass in isolation while speaking DIFFERENT region-state key conventions — observe.ts
// emitted the bare region name, evaluate.ts's inState/whileStates read '<region>.state' — so
// every state-guarded invariant was silently vacuous end to end and the CLI's negative control
// (0 violations) could not tell "clean" from "blind". This test drives a hand-built DB into a
// state that VIOLATES two state-guarded invariants and runs the real
// bindSchema -> observeEntities -> checkInvariants pipeline over the real session's plan, so a
// regression of the key convention makes it fail (0 violations) instead of silently passing.
describe('composed observe -> tier1 pipeline (positive control)', () => {
  it('convicts state-guarded invariant violations with the right witnesses', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(implDir, 'src/schema.sql'), 'utf8'));

    // Past-due subscription with max_retries=0 whose latest 'open' invoice carries one failed
    // dunning attempt (violates retryCapWhilePastDue: where inState(status pastDue) =>
    // latestInvoice.retryCount <= maxRetries — the state-guarded statePredicate channel; it was
    // activePaidInFull until the w6 finalize-on-active ruling retired that invariant), plus two
    // 'draft' invoices for the same subscription (violates oneDraftInvoicePerSubscription:
    // unique by subscription while settlement in {draft}).
    db.exec(`
      INSERT INTO subscriptions (id, plan_code, seats, period_start, period_end, max_retries, current_invoice_id, lifecycle_state)
      VALUES ('sub-1', 'pro', 2, 1000, 2000, 0, 'sub-1-inv-open', 'past_due');
      INSERT INTO invoices (id, subscription_id, license_fee_amount, usage_amount, total_due, settlement_state)
      VALUES ('sub-1-inv-open', 'sub-1', 5000, 0, 5000, 'open');
      INSERT INTO dunning_attempts (invoice_id, attempted_at, outcome)
      VALUES ('sub-1-inv-open', 1500, 'failed');
      INSERT INTO invoices (id, subscription_id, license_fee_amount, usage_amount, total_due, settlement_state)
      VALUES ('sub-1-inv-draft1', 'sub-1', 1000, 0, 0, 'draft');
      INSERT INTO invoices (id, subscription_id, license_fee_amount, usage_amount, total_due, settlement_state)
      VALUES ('sub-1-inv-draft2', 'sub-1', 1000, 0, 0, 'draft');
    `);

    const input = loadGenInput(join(repoRoot, '.lattice-session-subscriptions'));
    const plan = buildPlan(input);
    const { overrides } = await import(join(implDir, 'conform/overrides.ts'));
    const manifest = bindSchema(db, input.model, overrides);
    const entities = observeEntities(db, input.model, manifest, overrides);
    const violations = checkInvariants(entities, plan, [], 'test:composed');
    db.close();

    const byInvariant = Object.fromEntries(violations.map(v => [v.invariant, v]));
    expect(Object.keys(byInvariant).sort()).toEqual(['oneDraftInvoicePerSubscription', 'retryCapWhilePastDue']);
    expect(byInvariant.retryCapWhilePastDue!.witnessIds).toEqual(['sub-1']);
    // Set-level violations (unique) pin ALL subjects of the aggregate, not just the offending
    // rows (tier1.ts's SET_LEVEL_KINDS handling) — here that's all three invoices.
    expect(byInvariant.oneDraftInvoicePerSubscription!.witnessIds.sort())
      .toEqual(['sub-1-inv-draft1', 'sub-1-inv-draft2', 'sub-1-inv-open']);
  });
});
