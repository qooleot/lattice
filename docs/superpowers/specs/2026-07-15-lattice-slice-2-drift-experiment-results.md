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

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c01-skipped-emit` (forked from `0cad28c`).
- Edit: deleted `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` from `activate` in
  `implementations/subscriptions/src/subscription-service.ts`.
- impl-exit=1 (`/tmp/drift-c01-impl.log`). Failing tests:
  - `test/lifecycle.test.ts > lifecycle > activate requires a paid invoice and emits SubscriptionActivated`
    (`eventTypes` assertion — expected `SubscriptionActivated` appended, got only `['InvoiceFinalized', 'InvoicePaid']`).
  - `test/journey.test.ts > full customer journey > trial → activate → usage/rollover → failed charge → dunning exhaustion`
    (`eventLog` assertion — missing `SubscriptionActivated:acme`).
  - Collateral: 1 additional test file failed (3 failed / 21 passed of 24 total) — a settle-path
    test whose event-count expectation also shifted.
- conform-exit=0 (`--report` never sets a nonzero exit; violations>0 in output is the criterion
  per protocol). `/tmp/drift-c01-conform.log`:
  ```
  conform ../implementations/subscriptions
  7 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [sub-1] — no legal path: Subscription 'sub-1' region 'status' — all 0 event(s) consumed, reachable state(s) {trialing, expired} do not include observed final 'active'; events=[] — anchors [spec:machine Subscription.status] — source activate requires a paid invoice and emits SubscriptionActivated
  ```
  (6 more VIOLATION lines follow, all `machine Subscription.status`, same shape, from other
  fixtures whose traces now dead-end for `sub-1`.)
- Pre-registered signals confirmed: output contains `machine Subscription.status` (7 occurrences)
  and details matching `do not include observed final 'active'` (5 of 7; the other 2 read
  `do not include observed final 'pastDue'` — same drift, later fixture states — collateral, not
  the pinned signal, recorded for completeness).
- Ledger evidence (`.lattice-session-subscriptions/ledger.jsonl`, `violationCount: 7`) committed on
  the drift branch (`drift(c01): ledger evidence from conform --report run`), per the "drift-branch
  runs append to their own ledger copy" rule.

### c02 — wrong event type

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c02-wrong-event` (forked from work-branch tip after the c01 doc commit,
  `f5f762f`).
- Edit: in `cancelSubscription`, `implementations/subscriptions/src/subscription-service.ts`,
  changed `appendEvent(db, SUBSCRIPTION_CANCELED, subId, { subId });` to
  `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` (copy-paste error).
- impl-exit=1 (`/tmp/drift-c02-impl.log`). Failing tests:
  - `test/lifecycle.test.ts > lifecycle > cancel is legal from trialing/active/past_due only`
    (`eventTypes` no longer contains `SubscriptionCanceled`).
  - `test/lifecycle.test.ts > lifecycle > exhaustion after max_retries cancels the subscription and writes off the invoice`
    (same contains-Canceled assertion).
  - `test/journey.test.ts > full customer journey > ...` (`eventLog` — trailing
    `SubscriptionCanceled:acme` replaced by `SubscriptionActivated:acme`).
  - 3 failed / 21 passed of 24 total.
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c02-conform.log`:
  ```
  conform ../implementations/subscriptions
  4 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [sub-1] — no legal path: Subscription 'sub-1' region 'status' — stuck at event #2 (SubscriptionActivated, outbox seq 4) from state(s) {active, pastDue, canceled}; events=[SubscriptionActivated, SubscriptionActivated] — anchors [transition activate] — source cancel is legal from trialing/active/past_due only
  ```
  (3 more VIOLATION lines follow: `sub-1` again via the exhaustion fixture, `acme` via the journey
  fixture, and `sub-1` via `changePlan` — all `stuck at event #2 (SubscriptionActivated`.)
- Pre-registered signal confirmed: detail matches `stuck at event #2 (SubscriptionActivated` with
  witness `sub-1` (first VIOLATION line, witness `[sub-1]`, from the pinned cancel-after-activate
  lifecycle test — exact fixture pre-registered in the brief).
- Ledger evidence (`violationCount: 4`) committed on the drift branch
  (`drift(c02): ledger evidence from conform --report run`).

### c03 — emit outside the transaction

**Verdict: CAUGHT-VIOLATION (with pre-registration phrasing error — human ruling 2026-07-15)** (the pre-registered detail signal did not fire — a real but different Tier-2
violation fired instead; recorded honestly per protocol, not re-scoped).

- Branch: `drift/c03-emit-outside-tx` (forked from work-branch tip after the c02 doc commit,
  `1afc833`).
- Edit: in `activate`, `implementations/subscriptions/src/subscription-service.ts`, moved
  `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` to before `db.transaction(() => { ... })()`.
- impl-exit=1 (`/tmp/drift-c03-impl.log`). Only 1 test failed (not the "outbox-count
  assertions in lifecycle/journey" plural predicted by the brief):
  - `test/lifecycle.test.ts > lifecycle > activate requires a paid invoice and emits SubscriptionActivated`
    — `eventTypes` order assertion: expected `['InvoiceFinalized', 'InvoicePaid', 'SubscriptionActivated']`,
    got `['SubscriptionActivated', 'InvoiceFinalized', 'InvoicePaid', 'SubscriptionActivated']`
    (the early emit from the REJECTED first `activate(db,'sub-1')` call in the same test survives,
    then a second, legitimate `SubscriptionActivated` is appended by the later successful call in
    the same test body — both events land in one outbox since the DB is shared across both calls
    within the test).
  - 1 failed / 23 passed of 24 total. The journey test passed (its own `activate` call never hits
    the rejection path), so the "journey" half of the predicted failure set did not fail.
- conform-exit=0 (`--report`). `/tmp/drift-c03-conform.log`:
  ```
  conform ../implementations/subscriptions
  1 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [sub-1] — no legal path: Subscription 'sub-1' region 'status' — stuck at event #2 (SubscriptionActivated, outbox seq 4) from state(s) {active, pastDue, canceled}; events=[SubscriptionActivated, SubscriptionActivated] — anchors [transition activate] — source activate requires a paid invoice and emits SubscriptionActivated
  duration 0.0s — budget 60s OK
  ```
- Pre-registered signal check (grepped verbatim, no tuning): neither substring fired.
  - `grep "do not include observed final 'trialing'" /tmp/drift-c03-conform.log` → no match.
  - `grep "all 1 event(s) consumed" /tmp/drift-c03-conform.log` → no match.
  - The witness (`sub-1`) and spec element (`machine Subscription.status`, Tier 2) DO match, and a
    real violation with a legitimate detail (`stuck at event #2 (SubscriptionActivated, outbox seq 4)
    from state(s) {active, pastDue, canceled); events=[SubscriptionActivated, SubscriptionActivated]`)
    was produced — but that exact string was not the pre-registered one, so per the "zero tuning /
    verbatim MISSED" rule this class is recorded as MISSED, not silently credited as a match.
- Root-cause finding for the human: the pre-registration assumed conform would observe an
  *intermediate* state — final `trialing` with 1 stray event, straight after the rejected
  `activate(db,'sub-1')` call. That state is never captured: `conform-capture.ts` snapshots only in
  `afterEach`, i.e. once per whole test, after the test's *final* DB state. Because the pinned
  exercising test (`activate requires a paid invoice and emits SubscriptionActivated`) chains a
  rejected call followed by a real successful `activate` call on the SAME db/subId, the only
  snapshot ever taken shows the union of both calls: final state `active`, 2 accumulated
  `SubscriptionActivated` events — not the isolated rejection outcome the class spec predicted. The
  harness still caught *a* violation from the drift (Tier 2, same spec element, same witness), just
  described differently than pre-registered — a finding about single-snapshot-per-test capture
  granularity limiting what the corpus can exercise, not a harness catching-power gap.
- Ledger evidence (`violationCount: 1`) committed on the drift branch
  (`drift(c03): ledger evidence from conform --report run`).

**Controller adjudication (human review requested at the Task-8 verdict):** the registered
DETAIL SUBSTRING missed; the CLASS-level catch question is separable. The harness DID flag the
drifted row (`sub-1`) at the pre-registered tier (Tier 2) and element (`machine
Subscription.status`), from the pre-registered drift edit, with a correct and developer-locatable
diagnostic — the registration's error was predicting the fixture's quiescent state (the pinned
test chains the rejected activate into a successful one, so quiescence is `active` with 2 events,
not `trialing` with 1). Proposed scoring for §7.1: **caught-violation with a pre-registration
phrasing error**, recorded distinctly from a clean catch; the alternative (strict MISSED) stands
in this section's verdict line until the human rules at Task 8. Follow-up options (post-slice,
never mid-experiment): per-command capture granularity, or a dedicated rejected-then-quiesce
fixture in the corpus. Human ruling (2026-07-15): class-catch — scored caught-with-phrasing-error; the registration error stays on record.

### c04 — weakened guard

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c04-weakened-guard` (forked from work-branch tip `ec4bff3`).
- Edit: deleted `if (sub.paid_invoice_count < 1) throw new Error(...)` from `activate` in
  `implementations/subscriptions/src/subscription-service.ts`. Replaced the rejection test in
  `test/lifecycle.test.ts` with the engineer's v2-flow happy test (pre-registered exact text):
  `activate works immediately after invoicing (v2 flow)` — creates `sub-1`, finalizes
  `sub-1-inv-1` (open, unpaid), calls `activate(db, 'sub-1')` (guard gone — succeeds), asserts
  `lifecycle_state` is `active`.
- impl-exit=0 (`/tmp/drift-c04-impl.log`) — all 8 test files, 24 tests passed. The replaced test
  passes by design; no other test broke (the pre-registered "journey `recordUsage` reject
  expectation may shift" did not materialize — `recordUsage`'s own guard is untouched and no
  other fixture routes through the deleted `paid_invoice_count` check).
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c04-conform.log`:
  ```
  conform ../implementations/subscriptions
  1 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION activePaidInFull (invariant activePaidInFull) — witnesses [sub-1] — violated by 1/1 Subscription row(s) — anchors [hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5; w1; w2; w3; w4; w5] — source activate works immediately after invoicing (v2 flow)
  duration 0.0s — budget 60s OK
  ```
- Pre-registered signal confirmed: output contains `activePaidInFull` (1 occurrence) with witness
  `sub-1` — exact match, Tier 1, from the pinned exercising fixture (`source` line names the
  replaced test verbatim).
- Ledger evidence (`violationCount: 1`) committed on the drift branch
  (`drift(c04): ledger evidence from conform --report run`).



### c05 — terminal resurrection

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c05-win-back` (forked from work-branch tip `3319251`).
- Edit: in `settle()`, `implementations/subscriptions/src/billing-service.ts`, widened the silent
  recovery condition from `sub.lifecycle_state === 'past_due'` to
  `sub.lifecycle_state === 'past_due' || sub.lifecycle_state === 'canceled'`. Added the engineer's
  win-back happy test to `test/billing-service.test.ts` (pre-registered exact text): `win-back: a
  canceled customer who settles is reactivated (v2 flow)` — finalizes `sub-1-inv-1`, cancels
  `sub-1` (canceled with an open invoice), pays it in full (`recordPayment` → drifted `settle`
  revives), asserts `lifecycle_state` is `active`.
- impl-exit=0 (`/tmp/drift-c05-impl.log`) — all 8 test files, 25 tests passed (24 pre-existing +
  the 1 new win-back test). Matches the pre-registration: "none pre-registered (drift only ADDS a
  path)" — no collateral failures.
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c05-conform.log`:
  ```
  conform ../implementations/subscriptions
  1 violations across 24 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 68 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [sub-1] — no legal path: Subscription 'sub-1' region 'status' — all 1 event(s) consumed, reachable state(s) {canceled} do not include observed final 'active'; events=[SubscriptionCanceled] — anchors [transition cancel] — source win-back: a canceled customer who settles is reactivated (v2 flow)
  duration 0.0s — budget 60s OK
  ```
- Pre-registered signal confirmed: detail matches `do not include observed final 'active'`
  verbatim, after all Subscription-region events consumed (`all 1 event(s) consumed, reachable
  state(s) {canceled}` — canceled is terminal, `SubscriptionCanceled` is the only Subscription-
  region event on this row), witness `sub-1`, Tier 2, `machine Subscription.status`. (The
  pre-registration's "events end ... SubscriptionCanceled, InvoicePaid" describes the full outbox
  log; the machine trace itself only consumes Subscription-region events, so its `events=[...]`
  list correctly shows just `[SubscriptionCanceled]` — no discrepancy, the detail substring that
  was pinned as the actual grep target matches exactly.)
- Ledger evidence (`violationCount: 1`) committed on the drift branch
  (`drift(c05): ledger evidence from conform --report run`).



### c06 — state-name drift

**Verdict: CAUGHT-LOUD**

- Branch: `drift/c06-state-rename` (forked from work-branch tip `26a5be7`).
- Edit: renamed the past-due lifecycle value `'past_due'` → `'delinquent'` in CODE only —
  `implementations/subscriptions/src/schema.sql` (comment on `lifecycle_state`), and all
  `src/*.ts` occurrences: `src/billing-service.ts` (`settle`'s recovery condition),
  `src/subscription-service.ts` (`cancelSubscription`'s legal-states check),
  `src/dunning.ts` (comment, `recordPaymentFailure`'s UPDATE, `runDunning`'s target-selection
  WHERE clause). `conform/overrides.ts` STATE_MAP left untouched (still maps `past_due: 'pastDue'`,
  no `delinquent` key) — that is the drift, per the brief.
- impl-exit=1 (`/tmp/drift-c06-impl.log`) — 4 failed / 20 passed of 24 total. Test files were NOT
  edited per the brief (drift is code-only), so tests that literal-compare
  `lifecycle_state`/`status` against `'past_due'` now fail against the actual stored value
  `'delinquent'`:
  - `test/lifecycle.test.ts > lifecycle > payment failure marks past_due; successful retry recovers silently`
  - `test/growth.test.ts > growth features (superset) > failed rollover charge leaves the sub past_due with the old invoice open`
  - `test/journey.test.ts > full customer journey > trial → activate → usage/rollover → failed charge → dunning exhaustion`
  - `test/read-model.test.ts > account summary read model > tracks status and balances through the lifecycle`
    (`toMatchObject({ status: 'past_due', ... })` vs actual `status: 'delinquent'`).
  This differs from the pre-registration's "none (internally consistent rename)" — the rename IS
  internally consistent within `src/`, but the untouched test literals are not part of `src/`, so
  they surface as impl failures. Recorded verbatim, not re-scoped (brief's own fallback: "record
  any that appear").
- conform-exit=2 (loud failure — no `--report` summary line is ever printed).
  `/tmp/drift-c06-conform.log`:
  ```
  conform observe: Subscription.status is null/undefined for row sub-1 — projection must be total or the field overridden
  ```
- Pre-registered signal confirmed: stderr matches `Subscription.status is null/undefined for row`
  verbatim — `STATE_MAP[row.lifecycle_state]` has no `delinquent` key, so `overrides.ts`'s
  `status` projection returns `undefined` for the first row it observes with that state, and the
  harness fails hard rather than mapping garbage (design §4.3's loud-never-wrong guarantee).
  Exit code 2 as pre-registered.
- No ledger delta on the drift branch: the harness aborts before ever writing a `--report` ledger
  entry (loud failure happens inside `conform observe`, upstream of report/ledger assembly), so
  there is nothing to commit beyond the drift edit itself — consistent with the CAUGHT-LOUD design
  (loud, never wrong, and never silently recorded as a passing run).



### c07 — partial write on settle

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c07-partial-write` (forked from work-branch tip `5ca0d78`).
- Edit: in `recordPayment`, `implementations/subscriptions/src/billing-service.ts`, moved the
  `db.prepare('INSERT INTO invoice_payments ...').run(...)` line so it only runs on the
  NON-settling branch (a botched refactor that "moved recording into settle" and lost the final
  payment insert):
  ```ts
  if (paid + amount === inv.total_due) settle(db, inv);
  else {
    db.prepare('INSERT INTO invoice_payments (invoice_id, amount, paid_at) VALUES (?,?,?)').run(invoiceId, amount, now);
    refreshAccountSummary(db, inv.subscription_id, now);
  }
  ```
- impl-exit=1 (`/tmp/drift-c07-impl.log`). 1 failed / 23 passed of 24 total:
  - `test/read-model.test.ts > account summary read model > tracks status and balances through the
    lifecycle` — `lifetime_paid` expected `3000`, got `0` (the settling payment's INSERT never ran,
    so the read model's SUM sees no rows for that payment).
  - The pre-registered "billing settle test (`amountPaid` assertions), possibly journey" did not
    surface directly — `billing-service.test.ts`'s own settle test's `amountPaid` assertion happens
    to still pass in this corpus's exact sequencing (record verbatim, not re-scoped); the read-model
    test is what actually broke.
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c07-conform.log`:
  ```
  conform ../implementations/subscriptions
  15 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 64 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION neverOverpaidAndPaidExact (invariant neverOverpaidAndPaidExact) — witnesses [sub-1-inv-1] — violated by 1/1 Invoice row(s) — anchors [elicited (w1, w2, w3); w1; w2; w3; w4; w5] — source activate requires a paid invoice and emits SubscriptionActivated
  duration 0.0s — budget 60s OK
  ```
  (13 more VIOLATION lines follow: `neverOverpaidAndPaidExact` fires on the settled invoice of
  nearly every fixture that pays an invoice in full — `sub-1-inv-1`, `sub-1-inv-2`, `acme-inv-1` —
  plus collateral `activePaidInFull` hits on `sub-1` in fixtures where the drift also leaves the
  subscription's `paid_invoice_count`/lifecycle bookkeeping inconsistent with a fully-paid invoice.)
- Pre-registered signal confirmed: output contains `neverOverpaidAndPaidExact` (11 occurrences)
  with witness the settled invoice id — first hit `sub-1-inv-1`, from the pinned exercising
  fixture family (settle path). Collateral (recorded, not the pinned signal): `activePaidInFull`
  also fires 4 times (`sub-1`), since the drift's missing payment row makes settled subscriptions
  look unpaid to the Invoice-side invariant AND to the Subscription-side cross-aggregate invariant.
- Ledger evidence (`violationCount: 15`) committed on the drift branch
  (`drift(c07): ledger evidence from conform --report run`).

### c08 — widened uniqueness

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c08-two-drafts` (forked from work-branch tip `1cbc7b2`).
- Edit: in `rolloverPeriod`, `implementations/subscriptions/src/subscription-service.ts`, deleted
  `if (needsBilling) finalizeInvoice(db, closingId);` and the whole
  `if (needsBilling) { ...charge... }` block at the end (the "simplify rollover — billing runs
  nightly anyway" accident: the old draft is left open as draft while the next draft still opens).
- impl-exit=1 (`/tmp/drift-c08-impl.log`). 3 failed / 21 passed of 24 total:
  - `test/growth.test.ts > growth features (superset) > failed rollover charge leaves the sub
    past_due with the old invoice open` — `lifecycle_state` expected `past_due`, got `active`.
  - `test/journey.test.ts > full customer journey > trial → activate → usage/rollover → failed
    charge → dunning exhaustion` — same shape, `lifecycle_state` expected `past_due`, got `active`.
  - `test/read-model.test.ts > account summary read model > tracks status and balances through the
    lifecycle` — `status` expected `past_due`/`open_balance: 3000`, got `active`/`open_balance: 0`.
  - Matches the pre-registration ("growth rollover tests (finalize/charge expectations), journey").
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c08-conform.log`:
  ```
  conform ../implementations/subscriptions
  3 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION oneDraftInvoicePerSubscription (invariant oneDraftInvoicePerSubscription) — witnesses [acme-inv-1, acme-inv-2, acme-inv-3] — set-level violation — anchors [elicited (w1, w2, w3, w4, w5); w1; w2; w3; w4; w5] — source trial → activate → usage/rollover → failed charge → dunning exhaustion
  VIOLATION oneDraftInvoicePerSubscription (invariant oneDraftInvoicePerSubscription) — witnesses [sub-1-inv-1, sub-1-inv-2, sub-1-inv-3] — set-level violation — anchors [elicited (w1, w2, w3, w4, w5); w1; w2; w3; w4; w5] — source failed rollover charge leaves the sub past_due with the old invoice open
  VIOLATION oneDraftInvoicePerSubscription (invariant oneDraftInvoicePerSubscription) — witnesses [sub-1-inv-1, sub-1-inv-2, sub-1-inv-3] — set-level violation — anchors [elicited (w1, w2, w3, w4, w5); w1; w2; w3; w4; w5] — source tracks status and balances through the lifecycle
  duration 0.0s — budget 60s OK
  ```
- Pre-registered signal confirmed: output contains `oneDraftInvoicePerSubscription` (3 occurrences)
  with `set-level violation` detail, witnesses include the affected invoice ids
  (`acme-inv-1, acme-inv-2, acme-inv-3` and `sub-1-inv-1, sub-1-inv-2, sub-1-inv-3` — the closing
  draft invoice is left open alongside the newly-opened draft after each rollover without a
  finalize, exactly the two-drafts drift the class predicts).
- Ledger evidence (`violationCount: 3`) committed on the drift branch
  (`drift(c08): ledger evidence from conform --report run`).

### c09 — cross-aggregate activation

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c09-upgrade-activates` (forked from work-branch tip `a34633b`).
- Edit: in `changePlan`, `implementations/subscriptions/src/subscription-service.ts`, after
  `createSubscription(...)`, added the "carry the customer's active status over, and bill the new
  fee immediately" accident:
  ```ts
  if (sub.lifecycle_state === 'active' || sub.lifecycle_state === 'past_due') {
    finalizeInvoice(db, `${a.newId}-inv-1`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(a.newId);
    appendEvent(db, SUBSCRIPTION_ACTIVATED, a.newId, { subId: a.newId });
  }
  ```
  (`sub` is read before `cancelSubscription`, so `sub.lifecycle_state` is the predecessor's
  pre-cancel state; `finalizeInvoice` and `SUBSCRIPTION_ACTIVATED` were already imported.) The
  drift emits a well-formed `SubscriptionActivated` event — the trace itself is not malformed, only
  the unpaid activation it represents.
- impl-exit=1 (`/tmp/drift-c09-impl.log`). 1 failed / 23 passed of 24 total:
  - `test/growth.test.ts > growth features (superset) > changePlan supersedes: cancels old (event),
    creates new on the new plan, never mutates plan_code` — `newSub.lifecycle_state` expected
    `trialing`, got `active`. Matches the pre-registration exactly.
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c09-conform.log`:
  ```
  conform ../implementations/subscriptions
  2 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION activePaidInFull (invariant activePaidInFull) — witnesses [sub-2] — violated by 1/2 Subscription row(s) — anchors [hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5; w1; w2; w3; w4; w5] — source changePlan supersedes: cancels old (event), creates new on the new plan, never mutates plan_code
  VIOLATION crosscheck account_summary (crosscheck account_summary) — witnesses [sub-2] — status 'trialing' != lifecycle_state 'active' — anchors [target crosscheck (out-of-spec read model, design §6 class 13)] — source changePlan supersedes: cancels old (event), creates new on the new plan, never mutates plan_code
  duration 0.0s — budget 60s OK
  ```
- Pre-registered signal confirmed: output contains `activePaidInFull` (1 occurrence) with witness
  `sub-2` — exact match, Tier 1, invariant fires from a passive-mode row scan (no guard evaluated),
  exactly the pre-registered "guards are unevaluated in passive mode ... the cross-aggregate
  invariant is the catcher" design intent for this class. Collateral (recorded, not the pinned
  signal): the class-13 `crosscheck account_summary` instrument independently flags the same row
  (`sub-2`, read-model `status 'trialing' != lifecycle_state 'active'` — the account_summary read
  model was refreshed inside `createSubscription` before the drift's late mutation, so it still
  reads `trialing` while the subscriptions table now reads `active`).
- Ledger evidence (`violationCount: 2`) committed on the drift branch
  (`drift(c09): ledger evidence from conform --report run`).

### c10 — schema rename breaks auto-binding

**Verdict: CAUGHT-LOUD**

- Branch: `drift/c10-column-rename` (forked from work-branch tip `a67b648`).
- Edit: migration-style rename, kept internally consistent — `src/schema.sql` `seats INTEGER NOT
  NULL` → `seat_qty INTEGER NOT NULL`; `src/subscription-service.ts`: `SubscriptionRow.seats` →
  `seat_qty`, the `INSERT INTO subscriptions (...)` column list `seats` → `seat_qty`, the
  `UPDATE subscriptions SET seats = ?` → `SET seat_qty = ?`, and the one read site
  `seats: sub.seats` (in `changePlan`, carrying seat count to the new row) → `seats: sub.seat_qty`.
  Two `test/growth.test.ts` assertions that read `getSubscription(...).seats` off the row type
  were fixed to `.seat_qty` to keep the drift branch's own suite compiling and green (straggler
  fix per protocol — the rename is otherwise complete and consistent). `conform/overrides.ts` was
  NOT touched — no override exists for `Subscription.seats`, by design, so the spec field no
  longer auto-binds and has nothing to fall back on.
- `npx tsc --noEmit`: clean, no errors.
- impl-exit=0 (`/tmp/drift-c10-impl.log`). 24/24 tests passed, 8 test files — a working drifted
  service, exactly as pre-registered ("expected impl failures: none").
- conform-exit=2 (`/tmp/drift-c10-conform.log`):
  ```
  conform: unbound spec fields — add typed overrides or fix naming:
    Subscription (table subscriptions): seats
  ```
- Pre-registered signal confirmed: stderr matches `unbound spec fields` and names `Subscription`
  … `seats` — the binder fails loud (`ConformBindError`) rather than silently dropping or
  mis-mapping the field. Exit 2, never a false green.
- Ledger evidence: none. The abort happens during binding, before any snapshot is checked or the
  conformance run is recorded — a loud exit-2 CAUGHT-LOUD outcome produces no ledger delta by
  design (the run never reaches the point where it would write one). `.lattice-session-subscriptions/ledger.jsonl`
  is unchanged (`git status --short` after the run showed nothing); this absence is itself the
  expected evidence for this class, not an omission.

### c11 — stale override

**Verdict: CAUGHT-LOUD**

- Branch: `drift/c11-stale-override` (forked from work-branch tip `f8439d7`).
- Edit: renamed `invoice_payments.amount` → `amount_cents`, consistent within `src/` only —
  `src/schema.sql` column definition; `src/billing-service.ts`'s `amountPaid` (`SUM(amount_cents)`)
  and `recordPayment`'s `INSERT INTO invoice_payments (invoice_id, amount_cents, paid_at)`;
  `src/read-model.ts`'s two `SUM(p.amount_cents)` sites (`refreshAccountSummary`'s open-balance and
  lifetime-paid subqueries). Deliberately NOT touched: `conform/overrides.ts` (`Invoice.amountPaid`
  override still does `SELECT COALESCE(SUM(amount),0) ... FROM invoice_payments`) and
  `conform/crosschecks.ts` (`account_summary`'s independent recomputation still does
  `SUM(p.amount)` in two places) — both are conformance-side artifacts referencing the old column
  name; forgetting them alongside an otherwise-consistent src rename is exactly the stale-adapter
  rot this class is pre-registered to catch.
- `npx tsc --noEmit`: clean, no errors.
- impl-exit=0 (`/tmp/drift-c11-impl.log`). 24/24 tests passed, 8 test files, no stragglers needed —
  the rename is self-consistent within `src/` and no test reads the raw `amount` column name
  directly. Matches the pre-registration ("expected impl failures: none").
- conform-exit=2 (`/tmp/drift-c11-conform.log`):
  ```
  no such column: amount
  ```
- Pre-registered signal confirmed: stderr contains `no such column: amount` — the stale override's
  SQL fails hard at first evaluation (`conform/overrides.ts`'s `Invoice.amountPaid` querying the
  now-nonexistent `amount` column), exit 2, never a silently-wrong `amountPaid` value. The failure
  surfaces before `crosschecks.ts`'s parallel staleness is separately exercised — the binder/override
  layer aborts the whole run first, so only one of the two forgotten sites shows up in this log
  (recorded verbatim; both are stale, but the override fails first and the run stops there).
- Ledger evidence: none, same as c10 — the abort happens before any snapshot is checked or a
  conformance run is recorded, so a CAUGHT-LOUD exit-2 outcome produces no ledger delta by design.
  `.lattice-session-subscriptions/ledger.jsonl` is unchanged (`git status --short` after the run
  showed nothing); this absence is the expected evidence for this class.

### c12 — out-of-spec feature corrupts covered state

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c12-proration-total` (forked from work-branch tip `791b761`).
- Edit: `changeSeats` in `implementations/subscriptions/src/subscription-service.ts` gains an
  open-invoice path — replaced the draft-only guard with a three-way branch: `draft` keeps the
  original usage-amount proration (with the negative-usage guard intact), `open` now does
  `UPDATE invoices SET total_due = total_due + ? WHERE id = ?` directly, anything else throws.
  Plus the engineer's happy test (pre-registered exercising fixture) added to
  `implementations/subscriptions/test/growth.test.ts`: `activeSub()`, finalize `sub-1-inv-2` to
  open (fee 4000, usage 0), `changeSeats(db, 'sub-1', 6, 1_000)` on the open path, asserting
  `total_due` lands at 5000.
- impl-exit=0 (`/tmp/drift-c12-impl.log`). 8 test files, 25/25 tests passed (24 pre-existing + the
  drift's own happy test) — matches the pre-registration exactly ("none new beyond the drift's own
  test passing").
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c12-conform.log`:
  ```
  conform ../implementations/subscriptions
  3 violations across 24 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 69 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION activePaidInFull (invariant activePaidInFull) — witnesses [sub-1] — violated by 1/1 Subscription row(s) — anchors [hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5; w1; w2; w3; w4; w5] — source mid-cycle seat change prorates an open invoice immediately (v2 flow)
  VIOLATION totalDueAtMostParts (invariant totalDueAtMostParts) — witnesses [sub-1-inv-2] — violated by 1/2 Invoice row(s) — anchors [elicited (w1, w2); w1; w2; w3; w4; w5] — source mid-cycle seat change prorates an open invoice immediately (v2 flow)
  VIOLATION crosscheck account_summary (crosscheck account_summary) — witnesses [sub-1] — open_balance 4000 != recomputed 5000 — anchors [target crosscheck (out-of-spec read model, design §6 class 13)] — source mid-cycle seat change prorates an open invoice immediately (v2 flow)
  ```
- Pre-registered signals confirmed: **both** fired on the pinned fixture. `totalDueAtMostParts`,
  witness `sub-1-inv-2` (the drifted open invoice, `total_due` 5000 > `license_fee_amount` 4000 +
  `usage_amount` 0) — the class-12 verdict-keying signal. `activePaidInFull`, witness `sub-1` (the
  same fixture quiesces an ACTIVE sub with an open unpaid latest invoice) — pre-registered
  collateral, recorded per protocol, not the pinned signal.
- Unregistered bonus signal (recorded honestly, not part of the pre-registration): `crosscheck
  account_summary` also fired, witness `sub-1`, `open_balance 4000 != recomputed 5000` — the
  `total_due` mutation bypasses `refreshAccountSummary`, so the read model drifts from the ledger
  too. This is a genuine third catch the brief did not call out; the class-12 verdict still keys
  strictly on `totalDueAtMostParts` per protocol, but the extra signal is evidence the harness's
  independent instruments overlap in coverage here.
- Ledger evidence (`violationCount: 3`) committed on the drift branch
  (`drift(c12): ledger evidence from conform --report run`).

### c13 — stale read model

**Verdict: CAUGHT-VIOLATION**

- Branch: `drift/c13-stale-read-model` (forked from work-branch tip `791b761`).
- Edit: deleted the single line `refreshAccountSummary(db, inv.subscription_id, 0);` from
  `settle()` in `implementations/subscriptions/src/billing-service.ts` (exactly the one-line
  removal specified — no other change).
- impl-exit=0 (`/tmp/drift-c13-impl.log`). 8 test files, 24/24 tests passed — **diverges from the
  pre-registration's predicted failure mode** ("read-model tests (lifetime_paid assertions)").
  Recorded honestly, not re-scoped: `refreshAccountSummary` fully recomputes `open_balance`/
  `lifetime_paid` from scratch on every call (not incrementally), so any subsequent
  refresh-triggering call (`activate`, another `recordPayment`, `rolloverPeriod`, `expireTrials`,
  etc.) after a `settle()` self-heals the summary before a test's final assertion runs — every
  `read-model.test.ts` fixture happens to call one of those afterward. The staleness is real but
  transient in most fixtures and only persists into the DB state that conform's afterEach snapshot
  captures when `settle()` is the terminal write of a test with no follow-up call — which is the
  case for two fixtures in `billing-service.test.ts`, neither of which asserts on
  `account_summary` directly (that test file only checks invoice/subscription fields), so the impl
  suite stays green while the persisted read model is genuinely wrong.
- conform-exit=0 (`--report`; violations>0 in output is the criterion). `/tmp/drift-c13-conform.log`:
  ```
  conform ../implementations/subscriptions
  2 violations across 23 snapshots (10 invariants checked)
  residual surface: auto-bound 14/18 fields (78%), 4 overridden
  tier 2: 66 row-traces checked against the machine
  crosschecks: account_summary
  guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle
  VIOLATION crosscheck account_summary (crosscheck account_summary) — witnesses [sub-1] — status 'past_due' != lifecycle_state 'active'; open_balance 5000 != recomputed 0; lifetime_paid 5000 != recomputed 10000 — anchors [target crosscheck (out-of-spec read model, design §6 class 13)] — source payment failure marks past_due; successful retry recovers silently
  VIOLATION crosscheck account_summary (crosscheck account_summary) — witnesses [sub-1] — open_balance 3000 != recomputed 0; lifetime_paid 2000 != recomputed 5000 — anchors [target crosscheck (out-of-spec read model, design §6 class 13)] — source partial payments accrue; exact-full payment settles, emits InvoicePaid, bumps paid_invoice_count
  ```
- Pre-registered signal confirmed: both VIOLATION lines contain `crosscheck account_summary` with
  detail matching both `lifetime_paid` and `open_balance` mismatches — the class-13 instrument
  catches the stale row in both snapshots where `settle()` was the terminal write, exactly the
  fixture the brief anticipated ("any settle path"), even though the impl suite itself did not
  fail on it.
- Ledger evidence (`violationCount: 2`) committed on the drift branch
  (`drift(c13): ledger evidence from conform --report run`).

## Verdict — against the pre-registered §7 criteria

### §7.1 — Catch 13/13 drift classes (diagnostic names the violated element + ledger anchors)

| class | verdict | tier + element (pre-registered signal) |
|-------|---------|------------------------------------------|
| c01 skipped-emit | CAUGHT-VIOLATION | Tier 2, `machine Subscription.status` |
| c02 wrong-event | CAUGHT-VIOLATION | Tier 2, `machine Subscription.status` |
| c03 emit-outside-tx | CAUGHT-VIOLATION (with pre-registration phrasing error — human ruling 2026-07-15) | Tier 2, `machine Subscription.status` — real violation fired, registered detail substring did not |
| c04 weakened-guard | CAUGHT-VIOLATION | Tier 1, `activePaidInFull` |
| c05 win-back | CAUGHT-VIOLATION | Tier 2, `machine Subscription.status` |
| c06 state-rename | CAUGHT-LOUD | binder abort, `Subscription.status is null/undefined` |
| c07 partial-write | CAUGHT-VIOLATION | Tier 1, `neverOverpaidAndPaidExact` |
| c08 two-drafts | CAUGHT-VIOLATION | Tier 1, `oneDraftInvoicePerSubscription` |
| c09 upgrade-activates | CAUGHT-VIOLATION | Tier 1, `activePaidInFull` |
| c10 column-rename | CAUGHT-LOUD | binder abort, `unbound spec fields` |
| c11 stale-override | CAUGHT-LOUD | binder abort, `no such column: amount` |
| c12 proration-total | CAUGHT-VIOLATION | Tier 1, `totalDueAtMostParts` |
| c13 stale-read-model | CAUGHT-VIOLATION | crosscheck, `crosscheck account_summary` |

**Tally: 10 caught-violation + 3 caught-loud = 13/13 (12 clean on registered signal + 1 caught-with-phrasing-error, human-ruled) ✅.** Every one names the correct spec element
(machine region, invariant name, or binder field) and carries a witness/anchor a developer can
locate without additional context (see each class's `VIOLATION` or abort line above) — the §7.1
"locatable diagnostic" bar is met for all 13.

**c03 — human ruling (2026-07-15).** The registered DETAIL SUBSTRING (`do not include observed final
'trialing'` / `all 1 event(s) consumed`) did not appear in the conform output. What did appear: a
real Tier-2 violation, on the pre-registered spec element (`machine Subscription.status`), from the
pre-registered drift edit, on the pre-registered witness (`sub-1`) —
`stuck at event #2 (SubscriptionActivated, outbox seq 4) from state(s) {active, pastDue, canceled};
events=[SubscriptionActivated, SubscriptionActivated]`. The root cause (documented in the c03
outcome above) is that `conform-capture.ts` snapshots only once per test, in `afterEach`; the pinned
exercising test chains a rejected `activate` call into a successful one on the same subscription, so
the only snapshot taken shows the union of both calls (quiescent state `active`, 2 events) rather
than the isolated rejection state (`trialing`, 1 stray event) the class-3 registration predicted.
The human ruling (2026-07-15): **class-catch** — c03 is scored as caught-with-phrasing-error, not
a harness gap. The drift WAS flagged at the registered tier (Tier 2), the registered spec element
(`machine Subscription.status`), and the registered witness (`sub-1`) — only the registration's
predicted *fixture quiescent state* was wrong, not the harness's catching power. The phrasing error
stays on record in this document for post-slice analysis of test-capture granularity.

**c13 — coverage the impl suite structurally could not provide.** c13's impl suite ran fully green
(24/24, impl-exit=0) while `conform --report` independently caught 2 violations
(`crosscheck account_summary`, stale `lifetime_paid`/`open_balance`) that no impl test observed.
The root cause, in the harness author's own words from the outcome above: `refreshAccountSummary`
fully recomputes `open_balance`/`lifetime_paid` from scratch on every call (not incrementally), so
any subsequent refresh-triggering call (`activate`, another `recordPayment`, `rolloverPeriod`,
`expireTrials`, etc.) after a `settle()` self-heals the summary before a test's final assertion
runs — every `read-model.test.ts` fixture happens to call one of those afterward. The staleness only
survives into the snapshot for the two `billing-service.test.ts` fixtures where `settle()` is the
terminal write and no follow-up call self-heals it before teardown — and those fixtures don't assert
on `account_summary` at all. This is exactly the class of drift the design's §6-class-13 crosscheck
instrument was built to catch and the ordinary impl suite is structurally blind to: conform caught
it, the impl suite could not have, by construction, no matter how thorough its assertions.

**c11 — first-stale-artifact caveat.** c11's drift left two conformance-side artifacts stale
(`conform/overrides.ts`'s `Invoice.amountPaid` override AND `conform/crosschecks.ts`'s independent
`account_summary` recomputation both still reference the renamed-away `amount` column). The harness
correctly caught-loud on the first one it evaluates (`no such column: amount`, from the override),
but the binder/override layer aborts the whole run at that point — `crosschecks.ts`'s parallel
staleness was never independently exercised in this experiment, because the run never reached it.
The recorded evidence demonstrates the harness catches loud on *a* stale artifact, not that it would
also catch loud on the second one in isolation; that second claim is untested by this class.

### §7.2 — 0 false positives across 3 full harness runs on the clean impl

**0/3 ✅.** All three negative-control runs (section 2, run BEFORE any drift experiment) reported
`0 violations across 23 snapshots (10 invariants checked)`, `residual surface: auto-bound 14/18
fields (78%), 4 overridden`, `crosschecks: account_summary`, no CAUGHT-LOUD abort. No false positive
was observed on the clean impl at any point during the slice.

### §7.3 — Runtime ≤ 60s for a full `lattice conform` run over the impl suite

**✅.** Every conform run that reached the report stage printed `duration 0.0s` or `duration 0.1s`
against the 60s budget; the negative control's internal harness timer (`durationMs`) measured
56–73ms across its 3 runs — the max observed duration across all runs (negative control + all 13
drift classes) is 0.1s (73ms), roughly 3 orders of magnitude under budget. (c06, c10, c11
CAUGHT-LOUD before ever reaching the point where a duration line is printed — consistent with the
loud-abort design, not a runtime data point.)

### §7.4 — Residual surface measured and reported (kill criterion: auto-binding <50% of spec fields)

**Measured: auto-bound 14/18 fields (78%), 4 overridden** — identical across all runs where the
binder completed (negative control ×3 and every CAUGHT-VIOLATION drift class). 78% is well above
the 50% kill-criterion floor; the 4 overridden fields are `Invoice.amountPaid`,
`Subscription.status`, and the 2 more listed in `implementations/subscriptions/conform/overrides.ts`
(hand-written mapping for values not derivable by naming convention alone — e.g. `STATE_MAP` for the
enum rename c06/c10 exercise). No kill condition was triggered.

### What the drift experiments demonstrate about H-conformance

Across 13 pre-registered real-code edits plus a ×3 negative control, the target-agnostic
observe-and-check harness (outbox trace legality + state invariants + one out-of-spec-read-model
crosscheck) caught 12 of 13 drift classes on their exact registered diagnostic, produced zero false
positives on the unmodified implementation, ran in well under 1% of its runtime budget, and did so
while auto-binding 78% of spec fields without any hand-written adapter for most of the covered
surface. One class (c03) surfaced a real but differently-worded violation, traced to a test-capture
granularity limitation (one snapshot per test, at `afterEach`) rather than a gap in what the harness
can observe, and is left for human adjudication rather than resolved here. This is what was
measured: on this one engineer-shaped implementation, over this one drift corpus, non-generated code
that never calls into the spec at all can be checked from the outside for conformance to it, without
static analysis of the implementation's source, without a false-positive cost, and within a runtime
budget compatible with running on every test invocation. It does not show this generalizes to other
implementations, other languages, other drift shapes, or drift introduced by a different mechanism
(e.g. LLM-authored edits rather than the hand-authored edits used here) — none of that was tested.
