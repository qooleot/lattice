# Lattice — Slice #2 Drift-Experiment Results (pre-registered)

- **Date:** 2026-07-15
- **Work-branch commit (fork point for all drift branches):** `68064004018133a3dee78db8622032bc0265b22d`
  (`fix(conform): conformance ledger entries record crosschecks; loadCrosschecks validation covered`)
- **Harness version note:** Tiers 1+2 (`checkInvariants` / `checkTraces`) + crosschecks
  (`lattice/src/conform/crosscheck.ts`, wired into `report.ts`; class-13 instrument from Task 1 of
  this plan). All 13 drift classes below are exercised against this harness, unchanged, for every
  class.
- **Criteria under test (design §7, `docs/superpowers/specs/2026-07-14-lattice-slice-2-conformance-design.md`):**
  1. Catch 13/13 drift classes, each with a diagnostic naming the violated spec element + ledger
     anchors, locatable by a developer from the message alone. Any structurally uncatchable class
     is a design finding for the human — never quietly re-scoped.
  2. 0 false positives on the clean impl across 3 full harness runs.
  3. Runtime ≤ 60s for a full `lattice conform` run over the impl suite.
  4. Residual surface measured and reported (fields auto-bound/overridden/uncovered, overrides line
     count) — kill criterion if auto-binding covers <50% of spec fields.

This document commits the pre-registered expectations table (section 2) and the ×3 negative
control (section 3) BEFORE any drift experiment is run — that is what makes them pre-registered.
Sections 2 and 3 are copied/measured verbatim from the plan
(`docs/superpowers/plans/2026-07-15-lattice-slice-2-plan-4-drift-experiments.md`, Tasks 2–7) and
from real harness runs; nothing below is retrofitted after the fact.

## 1. Pre-registered table

| # | slug | edit (one line) | exercising fixture | expected impl-suite failures | pre-registered catch signal (tier + element + substring) |
|---|------|------------------|---------------------|-------------------------------|------------------------------------------------------------|
| c01 | skipped-emit | `subscription-service.ts` `activate`: delete the `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` line (refactor casualty). | existing corpus (lifecycle activate test, journey). | lifecycle `activate requires a paid invoice and emits SubscriptionActivated` (eventTypes assertion), journey eventLog assertion. | caught-violation, Tier 2 — output contains `machine Subscription.status` and a detail matching `do not include observed final 'active'`. |
| c02 | wrong-event | `cancelSubscription`: emits `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` (copy-paste error — was `SUBSCRIPTION_CANCELED`). | existing corpus — lifecycle cancel-after-activate test, events `[SubscriptionActivated, SubscriptionActivated]`, final `canceled`. | lifecycle cancel test (`eventTypes` contains-Canceled assertion), journey eventLog. | caught-violation, Tier 2 — detail matching `stuck at event #2 (SubscriptionActivated` with witness the canceled subscription. |
| c03 | emit-outside-tx | `activate`: move the `appendEvent(...)` call to BEFORE `db.transaction(() => { ... })()`. | existing corpus — lifecycle rejection case (`expect(() => activate(db,'sub-1')).toThrow(/paid/)`) leaves a `SubscriptionActivated` event with the row still `trialing`. | outbox-count assertions in lifecycle/journey (extra early event also lands on success paths — event order shifts). | caught-violation, Tier 2 — detail matching `reachable state(s) {active} do not include observed final 'trialing'` OR `all 1 event(s) consumed` with final `trialing`; witness `sub-1`. |
| c04 | weakened-guard | `activate`: delete the `if (sub.paid_invoice_count < 1) throw ...` guard; engineer replaces the rejection test with a v2-flow test that activates on a finalized-unpaid invoice. | replaced test (pre-registered exercising fixture): quiesces active `sub-1` with a finalized-unpaid latest invoice. | journey (`recordUsage` reject expectation may shift) — record whatever actually fails; the replaced test passes by design. | caught-violation, Tier 1 — output contains `activePaidInFull` with witness `sub-1` (active sub, `amountPaid 0 != totalDue 5000`). |
| c05 | win-back | `billing-service.ts` `settle()`: recovery condition widened to `if (sub.lifecycle_state === 'past_due' || sub.lifecycle_state === 'canceled')`; engineer adds a win-back happy test. | win-back test: `sub-1` canceled with an open invoice, then paid in full → drifted settle revives it. | none pre-registered (drift only ADDS a path) — record any that appear. | caught-violation, Tier 2 — events end `... SubscriptionCanceled, InvoicePaid` with observed final `active`; detail matching `do not include observed final 'active'` after all Subscription-region events consumed (state canceled, terminal); witness `sub-1`. |
| c06 | state-rename | Rename the past-due state in CODE only: `'past_due'` → `'delinquent'` in `schema.sql` comment and all `src/*.ts`; `conform/overrides.ts` STATE_MAP NOT touched. | existing corpus (any past-due test — rollover failure path). | none (internally consistent rename) — record any that appear. | caught-loud — conform exit 2 with stderr matching `Subscription.status is null/undefined for row`. |
| c07 | partial-write | `billing-service.ts` `recordPayment`: the `INSERT INTO invoice_payments ...` moved so it only runs on the NON-settling branch (botched refactor loses the final payment record). | existing corpus (partial→settle billing test: final payment never recorded; invoice `paid` with SUM = 2000 of 5000). | billing settle test (`amountPaid` assertions), possibly journey. | caught-violation, Tier 1 — output contains `neverOverpaidAndPaidExact`, witness the settled invoice id. |
| c08 | two-drafts | `subscription-service.ts` `rolloverPeriod`: delete the `if (needsBilling) finalizeInvoice(db, closingId);` line and the whole `if (needsBilling) { ...charge... }` block. | existing corpus (growth rollover tests roll active subs whose current invoice is a draft → two drafts per subscription). | growth rollover tests (finalize/charge expectations), journey. | caught-violation, Tier 1 — output contains `oneDraftInvoicePerSubscription` with `set-level violation` detail (unique-kind), witnesses include the affected invoice ids. |
| c09 | upgrade-activates | `subscription-service.ts` `changePlan`: after `createSubscription(...)`, carries active status over and bills the new fee immediately (finalizes invoice, sets `lifecycle_state = 'active'`, emits `SUBSCRIPTION_ACTIVATED`) when the predecessor was active/past_due. | existing corpus — growth `changePlan` test runs on an `activeSub()`; successor `sub-2` quiesces active with finalized-unpaid `sub-2-inv-1`. | growth changePlan test (`lifecycle_state 'trialing'` expectation on the successor). | caught-violation, Tier 1 — `activePaidInFull` with witness `sub-2` (guards unevaluated in passive mode — pre-registered NOT to rely on the guard; the cross-aggregate invariant is the catcher). |
| c10 | column-rename | Migration-style rename, code kept consistent: `schema.sql` `seats INTEGER NOT NULL` → `seat_qty INTEGER NOT NULL`; `subscription-service.ts` INSERT/UPDATE/`SubscriptionRow.seats` all renamed to `seat_qty`; `conform/overrides.ts` NOT touched. | existing corpus. | none (internally consistent rename; if `tsc`/tests surface stragglers, fix them ON THE DRIFT BRANCH until the impl suite is green). | caught-loud — conform exit 2, stderr matching `unbound spec fields` and `Subscription` … `seats`. |
| c11 | stale-override | Rename `invoice_payments.amount` → `amount_cents` in `schema.sql`, `billing-service.ts` (amountPaid SUM, INSERT), `read-model.ts` (both SUM sites); leave `conform/overrides.ts` AND `conform/crosschecks.ts` untouched (the engineer forgot them — that is the rot). | existing corpus. | none (consistent within src/). | caught-loud — conform exit 2, stderr containing `no such column: amount`. |
| c12 | proration-total | `subscription-service.ts` `changeSeats`: support mid-cycle seat changes on OPEN invoices by adjusting `total_due` directly (replaces the draft-only guard); engineer adds a happy test that hits the OPEN path. | happy test (pre-registered exercising fixture): finalizes `sub-1-inv-2` to open, then `changeSeats(db, 'sub-1', 6, 1_000)` on the open path — `total_due += 1000`. | none new beyond the drift's own test passing. | caught-violation, Tier 1 — `totalDueAtMostParts` (open invoice with `total_due > license_fee_amount + usage_amount`), witness `sub-1-inv-2`. Pre-registered collateral (also expected, not a surprise): the same fixture quiesces an ACTIVE sub with an open unpaid latest invoice, so `activePaidInFull` fires too — record both; the class-12 verdict keys on `totalDueAtMostParts`. |
| c13 | stale-read-model | `billing-service.ts` `settle()`: delete its `refreshAccountSummary(db, inv.subscription_id, 0);` line (the "batch summary refreshes nightly" accident). | existing corpus (any settle path — the summary's `open_balance`/`lifetime_paid` go stale the moment an invoice settles). | read-model tests (lifetime_paid assertions). | caught-violation, crosscheck — output contains `crosscheck account_summary` with detail matching `lifetime_paid` and/or `open_balance` mismatches (the class-13 instrument built in Task 1). |

## 2. Negative control (×3, work branch, BEFORE any drift experiment)

Protocol per run, from the work branch at the commit above:

```
cd implementations/subscriptions && rm -rf .conform && npx vitest run
cd ../lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --report
```

### Run 1

- impl suite: 8 test files, 24 tests passed, 0 failed.
- `conform --report`:
  ```
  conform ../implementations/subscriptions
  0 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  duration 0.1s — budget 60s OK
  ```
- violations: **0**
- snapshots: 23
- tier-2 row-traces: 66
- crosschecks line: `crosschecks: account_summary`
- ledger duration (`durationMs`, internal harness timer): 73ms

### Run 2

- impl suite: 8 test files, 24 tests passed, 0 failed.
- `conform --report`:
  ```
  conform ../implementations/subscriptions
  0 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  duration 0.1s — budget 60s OK
  ```
- violations: **0**
- snapshots: 23
- tier-2 row-traces: 66
- crosschecks line: `crosschecks: account_summary`
- ledger duration (`durationMs`, internal harness timer): 59ms

### Run 3

- impl suite: 8 test files, 24 tests passed, 0 failed.
- `conform --report`:
  ```
  conform ../implementations/subscriptions
  0 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  duration 0.1s — budget 60s OK
  ```
- violations: **0**
- snapshots: 23
- tier-2 row-traces: 66
- crosschecks line: `crosschecks: account_summary`
- ledger duration (`durationMs`, internal harness timer): 56ms

Each run appended one entry to `.lattice-session-subscriptions/ledger.jsonl` (kind `conformance`,
`violationCount: 0`, `crosschecks: ["account_summary"]`) — the ledger diff is committed alongside
this doc as evidence.

**false positives: 0/3 runs ✅**

All three runs were well under the 60s runtime budget (harness-measured duration 56–73ms; wall-clock
including process startup ~1.2–1.5s).

## Outcomes

### c01 — skipped emit

PENDING

### c02 — wrong event type

PENDING

### c03 — emit outside the transaction

PENDING

### c04 — weakened guard

PENDING

### c05 — terminal resurrection

PENDING

### c06 — state-name drift

PENDING

### c07 — partial write on settle

PENDING

### c08 — widened uniqueness

PENDING

### c09 — cross-aggregate activation

PENDING

### c10 — schema rename breaks auto-binding

PENDING

### c11 — stale override

PENDING

### c12 — out-of-spec feature corrupts covered state

PENDING

### c13 — stale read model

PENDING
