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

**Verdict: MISSED** (the pre-registered detail signal did not fire — a real but different Tier-2
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
fixture in the corpus.

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
