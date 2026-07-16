# Lattice — Drive Rediscovery Campaign Results (pre-registered)

- **Date:** 2026-07-16
- **Work-branch commit (fork point for all `drive/cNN` throwaway branches):** `da79287702eb9236669ec9617625c10c41d780bf`
  (`fix(conform): drive output reports re-attributions; driver map consumes the generated contract (compile tripwire restored)`)
- **Plan-1 landing note:** walk + drivers + clean-impl validation landed and re-reviewed READY
  (`.superpowers/sdd/d1-final-review-report.md`, re-verdict at `da79287`): both F1 (re-attribution
  reporting) and F2 (partial compile tripwire) fixes are in, 57/57 `vitest run src/conform` green,
  `tsc --noEmit` clean in both `lattice/` and `implementations/subscriptions/`. Two adjudicated
  findings from plan 1 are folded into this registration (see "Post-plan amendments" below).
- **Criteria under test (design §5, `docs/superpowers/specs/2026-07-15-lattice-adversarial-generation-design.md`):**
  1. Drift rediscovery 13/13 against the existing `drift/*` evidence branches, driving alone (no
     test suites), zero-tuning verbatim protocol — a rediscovery failure is recorded and escalated,
     never re-scoped.
  2. Guard probing both directions: clean impl → 0 false accepts across the campaign;
     `drift/c04-weakened-guard` → the illegal probe's acceptance is caught directly.
  3. Zero false positives: clean impl, 5 seeds × 200 sequences → 0 violations (pre-registered
     before any drift run — this document's section 3).
  4. Determinism + shrinking: every failure replays exactly from its seed; shrunk lengths measured
     and reported.
  5. Runtime: default campaign (200 sequences × length 30) ≤ 60s on this target.
  6. Kill criteria: irreducible false positives kill the generator design (not tuned around); any
     class passive mode caught that driving structurally cannot is a stop-and-redesign finding.

## Post-plan amendments folded into this registration

The plan-2 document (`docs/superpowers/plans/2026-07-15-lattice-drive-plan-2-rediscovery-campaign.md`)
predates two human-ruled changes that landed during plan 1. Both are folded in here honestly rather
than left as silent staleness in the expectations table below:

**(a) Spec amendment `1fbf530` — finalize/settle `requires` dropped.** Human ruling
(2026-07-15 design + 2026-07-16 dispatch): the `finalize`/`settle` guard clauses were mis-filed edge
conditions, structurally unsatisfiable against this impl's fused compute-and-transition operations
(the BLOCKED episode plan 1 escalated rather than papered over). The spec's `Invoice` machine now
reads (`specs/subscriptions/spec.lat:64-65`):

```
transition finalize { from draft to open; emits InvoiceFinalized }
transition settle { from open to paid; emits InvoicePaid }
```

— no `requires` on either. **The machine now has exactly ONE guarded transition in the whole spec:
`activate` (`requires paidInvoiceCount >= 1`, Subscription region).** Confirmed against every clean
false-positive-control run below: every `guardedTransitionsProbed` line reads `(activate)` only,
never `finalize`/`settle`. Consequences for the table:
- c04's registered route ("direct guard probe on activate") stands unchanged — `activate` was never
  touched by the amendment.
- c05's registered route changes: `settle` is now unconditionally legal from `open` on the Invoice
  side (no guard for the walk's oracle to evaluate), so the corruption cannot be exposed as a
  guard-probe-accepted violation at all — see the class-05 row and its explicit re-attribution note.
- Any plan-2 text that reads as if `finalize`/`settle` guard probes are part of the rediscovery
  surface (there is none explicit in Task 2/3's checklists, but the design's own earlier fork
  discussion assumed a richer guarded-transition set before the amendment) is stale as of this
  registration; the false-positive control's expectations column below registers `activate` as the
  only guarded transition, verbatim from real runs, not from the pre-amendment design text.

**(b) Probe oracle post-accept re-attribution** (`fb16f44`, `62c7e83`, `91b61c2`, design §2 Oracle).
Human ruling 2026-07-16: an illegal probe that gets accepted is a violation ONLY if no legal sibling
transition (same aggregate + region) explains the observed pre→post step; if one does, it's recorded
as a narrative re-attribution, not a violation — "honest limitation, reported never hidden: drift in
one of two transitions sharing an entry point can be masked by its legal sibling." This changes how
c05 (win-back) must be registered: the win-back's Subscription-side `canceled → active` corruption
is **not** eligible for re-attribution at all, and the reasoning is recorded explicitly in the c05
row below (not just asserted): `canceled` is terminal in the Subscription machine — the machine
lists no transition with `canceled` in its `from` set (`specs/subscriptions/spec.lat:34-39`) — so
there is no legal sibling transition that could ever explain `canceled → active`, and the corruption
cannot be masked by re-attribution even in principle. (It is also, mechanically, never offered to the
re-attribution check in the first place — see the row's route column — which makes the "cannot be
masked" conclusion doubly true: not masked in practice, and not maskable in principle.)

## Branch mechanics (copied verbatim from `.superpowers/sdd/d2-protocol.md` — the recipe is part of the registration)

## Global Constraints

- **Zero tuning.** A class the driver cannot rediscover is recorded MISSED verbatim and escalated — never re-scoped, never patched mid-campaign. False positives on the clean impl STOP the plan (BLOCKED).
- **No test suites.** Rediscovery runs use ONLY `lattice conform --target ../implementations/subscriptions --drive ...` — never `vitest` in the target, never `.conform` snapshots from suites (delete `.conform` before each run so passive artifacts cannot leak in).
- **Branch mechanics per class (verbatim):**
  1. `git checkout -b drive/cNN drift/cNN-<slug>` (throwaway validation branch off the EXISTING evidence branch).
  2. `git merge --no-edit <work-branch>` — brings the plan-1 harness + driver map onto the drifted impl. Resolve conflicts ONLY in favor of keeping the drift edit intact (the drift edits and plan-1 files are disjoint except where a drift class touched conform/ artifacts — c11 left overrides stale ON PURPOSE: on conflict, keep the DRIFT branch's conform/overrides.ts and conform/crosschecks.ts verbatim; ledger.jsonl conflicts resolve as union). After merging, verify the drift edit is still present (`git diff drift/cNN-<slug> -- implementations/subscriptions/src` must be empty or show only plan-1-caused context).
  3. `rm -rf implementations/subscriptions/.conform` then run the drive campaign with the PRE-REGISTERED seeds: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences 200 --length 30 --seed 11 > /tmp/drive-cNN.log 2>&1; echo "exit=$?"` — if seed 11 finds nothing, seeds 12 and 13 are pre-authorized (record every seed tried; stopping after 3 clean seeds = MISSED).
  4. Record: verdict (REDISCOVERED / REDISCOVERED-LOUD / MISSED), exit code, the shrunk narrative + violation lines (or the loud stderr), seeds tried. Adapter classes (c06/c10/c11) are expected REDISCOVERED-LOUD (exit 2 at the first scoped observe / bind — driving cannot proceed and must not need to).
  5. `git checkout <work-branch>`; delete the throwaway (`git branch -D drive/cNN`) — the EVIDENCE stays on the original drift branches and in the results doc; the throwaway is reproducible from the recipe.
  6. Append the outcome to the results doc; commit immediately.
- Engine discipline unchanged; no full-suite runs by implementers; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## 1. Expectations table

Signals are derived from the slice-2 results doc's caught signals
(`docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md`) — same spec
elements, re-expressed for drive mode's discovery mechanism (probe-accept vs. end-of-sequence
trace/invariant/crosscheck), and updated for the two amendments above where they change what is
actually driveable.

| # | slug | expected verdict | expected signal (element + substring) | expected discovery route |
|---|------|-------------------|-----------------------------------------|----------------------------|
| c01 | skipped-emit | REDISCOVERED | Tier 2, `machine Subscription.status`, substring `do not include observed final 'active'` | any driven sequence that reaches `activate` on a trialing row: the deleted emit leaves the row's outbox one event short, so the end-of-sequence (or `--check-every`) Tier-2 trace dead-ends short of `active`. |
| c02 | wrong-event | REDISCOVERED | Tier 2, `machine Subscription.status`, substring `stuck at event #2 (SubscriptionActivated` | any driven `activate` followed by `cancel` on the same row: `cancel` emits the wrong event type, so the Subscription trace gets a second `SubscriptionActivated` instead of `SubscriptionCanceled` — end-of-sequence Tier-2 check. |
| c03 | emit-outside-tx | REDISCOVERED | Tier 2, `machine Subscription.status`; substring `do not include observed final 'trialing'` or `all 1 event(s) consumed` **registered but not guaranteed verbatim** — slice 2's own c03 outcome shows a real Tier-2 violation on this exact element/witness can fire with different detail phrasing (human-ruled caught-with-phrasing-error, `docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md` c03 section); either phrasing scores REDISCOVERED on the element+witness, per that ruling | the driver's illegal probe on `activate` (guard-violated, from-state `trialing`): the drift moves the emit before the transaction, so even a probe the walk expects to be REJECTED (and which the impl's throw does report as rejected, matching oracle expectation) leaves a stray `SubscriptionActivated` event committed against a row whose lifecycle never actually moved. Drive mode's own snapshot granularity (end-of-sequence / `--check-every`) is finer than passive mode's once-per-test capture, so the masking that produced c03's phrasing miss in slice 2 (chaining a rejected then a successful `activate` in one test) may not recur here — registered honestly as untested until run. |
| c04 | weakened-guard | REDISCOVERED via EITHER route | Route A: Tier 1, `activePaidInFull`, witness the drifted subscription. Route B (direct guard probe, post-amendment (a) — `activate` is still the one guarded transition the amendment left untouched): substring `accepted a spec-illegal command`, naming transition `activate`, anchors `transition activate` | Route A: any driven sequence that reaches `activate` on a row with an unpaid finalized invoice; the guard's removal in the impl lets the row go active unpaid, caught at end-of-sequence by the Tier-1 cross-aggregate invariant regardless of whether the probe itself was ever attempted. Route B: the walk's own illegal probe on `activate` (guard-violated pre-state) gets accepted by the drifted impl instead of rejected — no sibling transition shares `activate`'s entry point, so the oracle flags it directly, in-sequence, without waiting for the end-of-sequence sweep. |
| c05 | win-back | REDISCOVERED | Tier 2, `machine Subscription.status`, substring `do not include observed final 'active'` (all Subscription-region events consumed, reachable state `{canceled}` terminal) | ordering-dependent: `cancel` a subscription while it has an open invoice, then drive `settle` on that same invoice. Post-amendment (a), `settle` is unconditionally legal from `open` on the Invoice side (no guard survives the drop) — the walk treats it as a plain LEGAL command, not a probe, so **the oracle's post-accept re-attribution logic is never invoked for this step at all** (re-attribution only runs on the illegal-probe-accepted branch; `settle` here is legal-and-accepted from the start). The Subscription-side `canceled → active` corruption is an undeclared cross-aggregate side effect of the drifted `settle()`, invisible to the per-step legality check (which only evaluates the *targeted* Invoice transition). Even hypothetically, no legal sibling could explain it: `canceled` is terminal in the Subscription machine (`specs/subscriptions/spec.lat:34-39` — no transition lists `canceled` in its `from` set), so `canceled → active` has no legal explanation to re-attribute to. The drift can only surface via the end-of-sequence Tier-2 trace check on the Subscription row — never masked, because it was never eligible for masking. |
| c06 | state-rename | REDISCOVERED-LOUD | binder/observe abort, stderr substring `is null/undefined for row` | first scoped-observe of any row in (or driven into) `past_due` — `paymentFailed` is a one-command path from `active`, so this should be reliably reachable within 200×30; `overrides.ts`'s `STATE_MAP` has no `delinquent` key, so the projection returns `undefined` for the first such row observed and the harness aborts loud, exit 2, before any command-level legality check runs. |
| c07 | partial-write | REDISCOVERED | Tier 1, `neverOverpaidAndPaidExact`, witness the settled invoice | any driven `settle` (full-balance `recordPayment`) on an invoice that lands on the drift's non-settling branch of the botched refactor: the payment record for the exact settling payment is silently dropped, so `amountPaid` under-counts against `total_due` — caught at end-of-sequence by the Tier-1 invariant. |
| c08 | two-drafts | REDISCOVERED | Tier 1, `oneDraftInvoicePerSubscription`, set-level violation, witnesses the draft invoice ids | the drift lives in `rolloverPeriod`; the superset driver map includes `rollover` (`implementations/subscriptions/conform/drive.ts`), so any driven rollover of a subscription whose current invoice is still draft leaves two open drafts per subscription — caught at end-of-sequence by the Tier-1 set-level invariant. |
| c09 | upgrade-activates | REDISCOVERED | Tier 1, `activePaidInFull`, witness the successor subscription (plus crosscheck collateral, `crosscheck account_summary`, per slice 2) | the superset driver map's `changePlanOp` on an active (or past-due) subscription creates the successor and auto-activates it unpaid — caught at end-of-sequence by the Tier-1 cross-aggregate invariant; the read-model crosscheck may additionally fire as collateral, as it did in slice 2. |
| c10 | column-rename | REDISCOVERED-LOUD | binder abort, stderr substring `unbound spec fields`, naming `Subscription` … `seats` | bind error at campaign start — `executeSequence` calls `bindSchema` before the intention loop even begins; `seats` has no auto-bind (column renamed to `seat_qty`) and no override, so the campaign never reaches a single command. Exit 2 immediately, regardless of seed. |
| c11 | stale-override | REDISCOVERED-LOUD | stderr substring `no such column: amount` | first scoped observe of an Invoice row — `conform/overrides.ts`'s `Invoice.amountPaid` override still queries the renamed-away `amount` column and throws at first evaluation; exit 2, before any command-level legality check runs. |
| c12 | proration-total | REDISCOVERED | Tier 1, `totalDueAtMostParts`, witness the drifted open invoice (verdict-keying signal); collateral `activePaidInFull` and `crosscheck account_summary` may also fire, per slice 2 | the superset driver map's `changeSeats` on an open (not draft) invoice takes the drift's direct `total_due` mutation path — caught at end-of-sequence by the Tier-1 invariant once a driven sequence finalizes an invoice to open and then drives `changeSeats` against it. |
| c13 | stale-read-model | REDISCOVERED | crosscheck, `crosscheck account_summary`, substrings `lifetime_paid` and/or `open_balance` mismatches | any driven `settle` that is the terminal write for its subscription's account-summary refresh chain before the next full check — the deleted `refreshAccountSummary` call leaves the read model stale; caught by the end-of-sequence crosscheck sweep (same instrument as slice-2 c13, target-agnostic of whether the summary was written by a test or a driven sequence). |

## 2. False-positive control (criterion 3)

Protocol: clean work branch (`da79287702eb9236669ec9617625c10c41d780bf`), `rm -rf
implementations/subscriptions/.conform` once before the set (drive mode never reads `.conform`
snapshots — confirmed empirically below, the directory does not exist after any of the 5 runs — but
passive artifacts from any prior suite run must not be left lying around to leak into an unrelated
future passive run), then for each seed:

```
npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences 200 --length 30 --seed <N>
```

All five must be CLEAN and ≤ 60s. Any violation: STOP, BLOCKED, verbatim narrative (a shrunk repro
on the CLEAN impl is either a plan-1 bug or a real impl/spec finding — either way a human gate).

**Result: 5/5 CLEAN. No STOP triggered.**

| seed | verdict | commands (accepted/rejected/superset) | probes attempted/rejected | guarded transitions | re-attributions | duration (harness) | duration (wall) |
|------|---------|-----------------------------------------|------------------------------|------------------------|--------------------|------------------------|--------------------|
| 1 | CLEAN | 43 (19 / 0 / 0) | 24 / 21 | activate | 3 | 83ms | ~1.0s |
| 2 | CLEAN | 59 (29 / 0 / 0) | 30 / 30 | activate | 0 | 85ms | ~0.75s |
| 3 | CLEAN | 55 (26 / 0 / 0) | 29 / 29 | activate | 0 | 92ms | ~0.71s |
| 4 | CLEAN | 72 (30 / 0 / 0) | 42 / 39 | activate | 3 | 84ms | ~0.8s |
| 5 | CLEAN | 34 (18 / 0 / 0) | 16 / 16 | activate | 0 | 80ms | ~0.71s |

Notes:
- `guardedTransitionsProbed` is `activate` on every seed, never `finalize`/`settle` — confirms
  amendment (a) empirically: the clean spec has exactly one guarded transition.
- Per seed, `probesAttempted − probesRejected == reattributions` exactly (seed 1: 24−21=3; seed 4:
  42−39=3; seeds 2/3/5: all probes rejected, 0 re-attributions) — every illegal probe the clean impl
  accepted was fully explained by a legal sibling transition (`voidDraft`/`voidOpen` sharing
  `voidInvoice`, per design §2 Oracle); 0 unexplained accepts, 0 violations, consistent with CLEAN on
  every seed.
- `0 rejected` legal commands on every seed (the middle number in the `commands` column) — no legal
  command was ever refused by the clean impl, the complementary false-positive direction (impl
  stricter than spec) is also clean.
- `.conform` did not exist in `implementations/subscriptions/` after any of the 5 runs (`ls`
  confirmed no such directory) — drive mode writes no passive snapshot artifacts, matching the
  brief's note that `--drive` doesn't read `.conform` snapshots at all.
- Wall-clock durations include Node/tsx startup (~0.6–0.9s fixed cost); the harness's own internal
  timer (`durationMs`, bracketing only `runCampaign`) is the load-independent figure and is what is
  checked against the 60s budget — all five ≤ 92ms, roughly 3 orders of magnitude under budget.
- **Evidence quirk, recorded honestly, not hidden:** an initial attempt at seed 1 hit a shell
  scripting error (`date +%s%3N` unsupported on this macOS/zsh setup) that crashed the harness-driver
  loop's timing arithmetic *after* the `conform --drive` subprocess for seed 1 had already completed
  and appended its ledger entry — before the loop could reach seeds 2–5. The loop was fixed
  (Python-based wall-clock timing) and re-run cleanly for all five seeds 1–5. Seed 1 therefore has
  two ledger entries (`.lattice-session-subscriptions/ledger.jsonl`, timestamps `19:22:58.619Z` and
  `19:23:08.240Z`): both report byte-identical stats (`probesAttempted: 24, probesRejected: 21,
  reattributions: 3, violationCount: 0`), which is itself a small bonus confirmation of criterion 4
  (determinism) — replaying the same seed against the same clean state reproduces exactly. The table
  above reports the second (fully-timed, in-order-with-seeds-2-5) run for seed 1; both ledger entries
  are committed as evidence, the stray duplicate is not deleted (append-only ledger discipline: real
  runs are not retroactively edited out, even accidental ones).

Ledger evidence: 6 new lines appended to `.lattice-session-subscriptions/ledger.jsonl` (the stray
duplicate seed-1 run plus the 5 in-order seeds 1–5), each `kind: "conformance"`, `mode: "drive"`,
`violationCount: 0`, committed alongside this document.

## Outcomes

### c01 — skipped emit
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c01 drift/c01-skipped-emit`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — one conflict, in `.lattice-session-subscriptions/ledger.jsonl`,
resolved as union (both sides' lines concatenated, no lines dropped, all validated as parseable
JSON post-resolution). `git diff drift/c01-skipped-emit -- implementations/subscriptions/src` was
empty after the merge — the drift edit (the deleted `appendEvent(db, SUBSCRIPTION_ACTIVATED, ...)`
call in `activate()`, `implementations/subscriptions/src/subscription-service.ts`) survived intact.

Seeds tried: 11, 12, 13 (all three pre-authorized seeds, per "stopping after 3 clean seeds =
MISSED").

| seed | verdict | commands (accepted/rejected/superset) | guards probed | re-attributions | duration |
|------|---------|-----------------------------------------|------------------|--------------------|----------|
| 11 | CLEAN | 53 (23/0/1) | 29 across 1 (`activate`) | 1 | 0.1s |
| 12 | CLEAN | 53 (23/0/0) | 30 across 1 (`activate`) | 2 | 0.1s |
| 13 | CLEAN | 45 (17/0/0) | 28 across 0 | 2 | 0.1s |

Verbatim stdout, all three seeds:
```
drive: 200 sequences — CLEAN
commands: 53 (23 accepted, 0 rejected, 1 superset ops)
guards probed at event time: 29 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 1
duration 0.1s
```
```
drive: 200 sequences — CLEAN
commands: 53 (23 accepted, 0 rejected, 0 superset ops)
guards probed at event time: 30 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 2
duration 0.1s
```
```
drive: 200 sequences — CLEAN
commands: 45 (17 accepted, 0 rejected, 0 superset ops)
guards probed at event time: 28 attempts across 0 guarded transitions
probe re-attributions (shared entry points; sibling-masking limitation applies): 2
duration 0.1s
```

Registered substring `do not include observed final 'active'` (Tier 2, `machine
Subscription.status`) does not appear in any of the three logs — grepped directly, zero matches.
Exit code 0 on all three runs (all three commands exited clean, no violations, no loud abort).

Recorded honestly per the zero-tuning rule: this is a genuine MISS against the pre-registered
expectation, not a signal-miss/class-catch phrasing variant (unlike c03's precedent) — the
registered element+witness simply never fired across all three pre-authorized seeds. The driver map
does include `activate` (`implementations/subscriptions/conform/drive.ts:71`) and the walk clearly
attempts guard probes against it every seed (`guardedTransitionsProbed: ["activate"]` on seeds 11
and 12), so the transition is reachable as a probe target; what is not confirmed from the summary
output alone is whether the walk ever drove `activate` to a full LEGAL acceptance (requiring
`paid_invoice_count >= 1`, itself requiring a prior finalize+settle chain) within any of the 200×30
sequences across these three seeds — that is a plausible structural explanation (multi-step
precondition chain vs. the walk's exploration budget/bias) but is not verified further here, per
zero-tuning: no additional flags, no re-scoping, no extra seeds beyond the three pre-authorized ones.
Escalated as MISSED, verbatim, not patched.

### c02 — wrong event type
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c02 drift/c02-wrong-event`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — same single conflict as c01, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved identically as union (validated as
parseable JSON post-resolution). `git diff drift/c02-wrong-event -- implementations/subscriptions/src`
was empty after the merge — the drift edit (the `cancel` transition emitting
`SubscriptionActivated` instead of `SubscriptionCanceled`) survived intact.

Seeds tried: 11, 12, 13 (all three pre-authorized seeds).

| seed | verdict | commands (accepted/rejected/superset) | guards probed | re-attributions | duration |
|------|---------|-----------------------------------------|------------------|--------------------|----------|
| 11 | CLEAN | 53 (23/0/1) | 29 across 1 (`activate`) | 1 | 0.1s |
| 12 | CLEAN | 53 (23/0/0) | 30 across 1 (`activate`) | 2 | 0.1s |
| 13 | CLEAN | 45 (17/0/0) | 28 across 0 | 2 | 0.1s |

Verbatim stdout, all three seeds — byte-identical to c01's per-seed output (see c01 section for the
literal blocks; not reproduced twice here). Registered substring `stuck at event #2
(SubscriptionActivated` does not appear in any of the three logs — grepped directly, zero matches.
Exit code 0 on all three runs.

Recorded honestly per the zero-tuning rule: another genuine MISS. **Notable pattern, recorded
plainly and not smoothed over:** the per-seed command-trace statistics (accepted/rejected/superset
counts, guards-probed counts, re-attribution counts) for c02 are identical to c01's at every one of
the three seeds. This is consistent with the walk's next-command choice being driven purely by the
PRNG seed plus the *spec* model (legality per spec, not per observed implementation behavior) —
the same seed produces the same command trace regardless of which single-line drift is injected,
as long as the drift does not itself change what the walk perceives as legal/illegal (neither c01's
nor c02's drift touches guard evaluation). Combined with c01, this raises a real question about
whether `activate` is being driven to a full LEGAL acceptance at all within 200×30 sequences at
these three seeds — flagged as a concern for the campaign write-up, not resolved by tuning here.

### c03 — emit outside the transaction
**Verdict: REDISCOVERED**

Branch mechanics: `git checkout -b drive/c03 drift/c03-emit-outside-tx`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — same single ledger.jsonl conflict, union-resolved and validated.
`git diff drift/c03-emit-outside-tx -- implementations/subscriptions/src` was empty after the merge
— the drift edit (the emit hoisted outside the transaction in `activate()`) survived intact.

Seeds tried: 11 (caught on the first pre-registered seed).

Verbatim stdout, seed 11:
```
drive: 3 sequences — FAILED (seed 11)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 11
commands: 57 (29 accepted, 0 rejected, 0 superset ops)
guards probed at event time: 28 attempts across 1 guarded transitions (activate)
probe re-attributions: 0
duration 0.0s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 1 event(s) consumed, reachable state(s) {active, pastDue, canceled} do not include observed final 'trialing'; events=[SubscriptionActivated] — anchors [transition activate] — source drive:2
```
Exit code: 1.

Verdict vs. the registered signal: the registered element+witness is `Tier 2, machine
Subscription.status`, with either of two pre-registered substrings — this run's detail line
contains BOTH `do not include observed final 'trialing'` and `all 1 event(s) consumed` verbatim.
The registered route matches exactly: shrunk narrative shows the driver's illegal probe of
`activate` from the trialing pre-state (`legality=illegal -> rejected` — the oracle correctly
reports the *command* as rejected, matching spec expectation for the probe itself), yet the stray
`SubscriptionActivated` event the drift committed outside the transaction still landed in the
row's outbox, so the end-of-sequence Tier-2 trace check dead-ends on it — exactly the "rejected
command, stray committed event" mechanism the registration anticipated. No phrasing-variant issue
arose (the slice-2 c03 precedent's masking concern did not recur here, as the registration flagged
as possible).

### c04 — weakened guard
**Verdict: REDISCOVERED (Route B)**

Branch mechanics: `git checkout -b drive/c04 drift/c04-weakened-guard`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — same single ledger.jsonl conflict, union-resolved and validated.
`git diff drift/c04-weakened-guard -- implementations/subscriptions/src` was empty after the merge
— the drift edit (the removed `paidInvoiceCount >= 1` guard clause on `activate`) survived intact.

Seeds tried: 11 (caught on the first pre-registered seed).

Verbatim stdout, seed 11:
```
drive: 3 sequences — FAILED (seed 11)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 11
commands: 57 (23 accepted, 6 rejected, 0 superset ops)
guards probed at event time: 28 attempts across 0 guarded transitions
probe re-attributions: 0
duration 0.0s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> accepted (VIOLATION)
VIOLATION transition activate (transition activate) — witnesses [d-subscription-1] — impl accepted a spec-illegal command: 'activate' was illegal from the observed pre-state but the driver accepted it without throwing — anchors [transition activate] — source drive:2
```
Exit code: 1.

Verdict vs. the registered signal: matches Route B exactly — substring `accepted a spec-illegal
command` present, naming transition `activate`, anchor `transition activate`. The walk's own
illegal probe of `activate` (guard-violated pre-state — no paid invoice) gets accepted by the
drifted impl instead of rejected, and the oracle flags it directly, in-sequence, on the very first
probe attempt of the campaign — no need to wait for the end-of-sequence sweep (Route A,
`activePaidInFull`, was not exercised — the direct probe fired first).

### c05 — terminal resurrection (win-back)
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c05 drift/c05-win-back`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — same single ledger.jsonl conflict, union-resolved and validated.
`git diff drift/c05-win-back -- implementations/subscriptions/src` was empty after the merge — the
drift edit (the win-back `canceled → active` cross-aggregate side effect on `settle`) survived
intact.

Seeds tried: 11, 12, 13 (all three pre-authorized seeds).

| seed | verdict | commands (accepted/rejected/superset) | guards probed | re-attributions | duration |
|------|---------|-----------------------------------------|------------------|--------------------|----------|
| 11 | CLEAN | 53 (23/0/1) | 29 across 1 (`activate`) | 1 | 0.1s |
| 12 | CLEAN | 53 (23/0/0) | 30 across 1 (`activate`) | 2 | 0.1s |
| 13 | CLEAN | 45 (17/0/0) | 28 across 0 | 2 | 0.1s |

Registered substring `do not include observed final 'active'` does not appear in any of the three
logs — grepped directly, zero matches. Exit code 0 on all three runs.

Recorded honestly per the zero-tuning rule: a third MISS, and — same pattern as c01/c02 — the
per-seed command-trace statistics are again identical to c01's/c02's at every seed. The registered
route for c05 requires a specific ordering (`cancel` a subscription while it has an open invoice,
then drive `settle` on that same invoice) that is itself downstream of the invoice reaching `open`
(a `finalize`), which is a deeper multi-step scenario than either c01's or c02's routes. Consistent
with the c01/c02 note: this looks like the walk's exploration at these three specific seeds simply
not reaching the necessary precondition chain within 200×30, rather than anything specific to the
win-back drift itself — flagged, not tuned around.

### c06 — state-name drift
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c06 drift/c06-state-rename`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — clean auto-merge, no conflicts this time (unlike c01–c05: the
ledger.jsonl divergence pattern on this branch pair didn't collide on the same lines; git merged
it automatically, 21 lines added, all validated as parseable JSON). `git diff drift/c06-state-rename
-- implementations/subscriptions/src` was empty, and `git diff drift/c06-state-rename --
implementations/subscriptions/conform/overrides.ts` was also empty — the drift edit (the
`STATE_MAP` renamed-away `delinquent`/`past_due` key in `overrides.ts`) survived intact. (The
non-empty `conform/` diff seen against other conform files, e.g. the new `drive.ts`/`spec-state.ts`,
is expected plan-1-added context per the recipe's own carve-out — those files didn't exist on the
pre-plan-1 drift branch at all.)

Seeds tried: 11, 12, 13 (all three pre-authorized seeds).

| seed | verdict | commands (accepted/rejected/superset) | guards probed | re-attributions | duration |
|------|---------|-----------------------------------------|------------------|--------------------|----------|
| 11 | CLEAN | 53 (23/0/1) | 29 across 1 (`activate`) | 1 | 0.1s |
| 12 | CLEAN | 53 (23/0/0) | 30 across 1 (`activate`) | 2 | 0.3s |
| 13 | CLEAN | 45 (17/0/0) | 28 across 0 | 2 | 0.2s |

Registered stderr substring `is null/undefined for row` does not appear in any of the three logs —
grepped directly, zero matches. Exit code 0 (not 2) on all three runs — the campaign never aborted
loud, meaning no row was ever scoped-observed in (or driven into) `past_due`.

Recorded honestly per the zero-tuning rule and per the class checklist's own pre-registered honesty
clause for this exact scenario ("if no sequence reaches past_due under seeds 11–13, that is a
MISSED to record honestly"). Same pattern as c01/c02/c05: per-seed command-trace statistics are
identical to those classes' at every seed. `paymentFailed` requires a subscription first to reach
`active` (one command away from there), and the c01 investigation already noted `activate` does not
appear to be driven to a full LEGAL acceptance within 200×30 at these three seeds — this is
consistent with that same root cause rather than anything specific to the state-rename drift. Not
tuned around; escalated as MISSED.

### c07 — partial write on settle
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c07 drift/c07-partial-write`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` — same single ledger.jsonl conflict as c01/c02/c03/c04/c05,
union-resolved and validated. `git diff drift/c07-partial-write -- implementations/subscriptions/src`
was empty after the merge — the drift edit (the dropped payment record on the exact-settling
branch of the botched `recordPayment` refactor) survived intact.

Seeds tried: 11, 12, 13 (all three pre-authorized seeds).

| seed | verdict | commands (accepted/rejected/superset) | guards probed | re-attributions | duration |
|------|---------|-----------------------------------------|------------------|--------------------|----------|
| 11 | CLEAN | 53 (23/0/1) | 29 across 1 (`activate`) | 1 | 0.1s |
| 12 | CLEAN | 53 (23/0/0) | 30 across 1 (`activate`) | 2 | 0.1s |
| 13 | CLEAN | 45 (17/0/0) | 28 across 0 | 2 | 0.1s |

Registered element `neverOverpaidAndPaidExact` does not appear in any of the three logs — grepped
directly, zero matches. Exit code 0 on all three runs.

Recorded honestly per the zero-tuning rule: a fourth MISS. Per-seed command-trace statistics are
again identical to c01's/c02's/c05's at every seed — the fifth class in this batch to show this
exact pattern. The registered route requires a driven `settle` (full-balance `recordPayment`) on a
finalized (open) invoice, which is itself downstream of `finalize`; whether these three seeds ever
drive that far down the invoice lifecycle within 200×30 is not confirmed from summary output alone
(consistent with the same reachability question flagged in c01/c02/c05/c06, not resolved here per
zero-tuning). Escalated as MISSED, not tuned around.

---

## Task 2 summary (c01–c07)

| class | verdict | seeds tried | notes |
|-------|---------|-------------|-------|
| c01 skipped-emit | MISSED | 11, 12, 13 | registered substring never appeared |
| c02 wrong-event | MISSED | 11, 12, 13 | registered substring never appeared; trace identical to c01's |
| c03 emit-outside-tx | REDISCOVERED | 11 | matched both pre-registered substrings, registered route exactly |
| c04 weakened-guard | REDISCOVERED (Route B) | 11 | direct probe-accept, matched registered substring/anchor exactly |
| c05 win-back | MISSED | 11, 12, 13 | registered substring never appeared; trace identical to c01's |
| c06 state-rename | MISSED | 11, 12, 13 | exit 0 not 2 — no row ever driven into `past_due`; class checklist's own pre-registered honesty clause for this exact scenario |
| c07 partial-write | MISSED | 11, 12, 13 | registered substring never appeared; trace identical to c01's |

**2/7 REDISCOVERED, 5/7 MISSED.** Both catches (c03, c04) fire on illegal-probe mechanisms that
don't require reaching a full legal `activate` (c03: probe rejected but stray event still
committed; c04: probe itself accepted). All five misses share element/witness routes that require
either a legal `activate` acceptance (c01, c02 use it as a precondition; c05/c06/c07 require it
transitively via `active`/`past_due`/settle chains) — and across every miss, the per-seed
command-trace statistics (accepted/rejected/superset counts, guards-probed counts) are byte-identical
across classes at the same seed, which is expected (the walk's command choice is seed+spec-driven,
not observation-driven) but also means the underlying question — does `activate` ever get legally
accepted within 200×30 at seeds 11/12/13 — was not independently confirmed or refuted from the CLI's
summary-only output for any of the five MISSED classes. Flagged here as the single open question
this task's evidence raises; not investigated further within Task 2's scope (zero tuning: no extra
flags, no extra seeds beyond the three pre-authorized, no source changes).

### c08 — widened uniqueness (two drafts)
**Verdict: PENDING**

### c09 — cross-aggregate activation
**Verdict: PENDING**

### c10 — schema rename breaks auto-binding
**Verdict: PENDING**

### c11 — stale override
**Verdict: PENDING**

### c12 — out-of-spec feature corrupts covered state
**Verdict: PENDING**

### c13 — stale read model
**Verdict: PENDING**

---

## Campaign #2 (instrument repaired)

Campaign #1 above (the "instrument-defect record") is retained **verbatim**, unedited — 2/7
REDISCOVERED, 5/7 MISSED, with the open reachability question it raised
("does `activate` ever get legally accepted within 200×30 at seeds 11/12/13?"). That question was
answered by `.superpowers/sdd/d2-coverage-investigation.md` (measurement-only, no fixes) and
resolved by `.superpowers/sdd/d2-instrument-repair-report.md` (four measured fixes + one
human-ruled opt-out, implemented). This section registers campaign #2 against the repaired
instrument, at work-branch tip `ab3ea4d` (fork point for all `drive/cNN` throwaway branches).

### 1. Amendment record

Two commits land the repair between campaign #1 and campaign #2:

- **`a803a71` — `fix(conform/drive): length floor, create/superset targeting, paymentFailed
  drive-skip`.** Four fixes, each justified by a quantitative finding in the investigation doc:
  1. **Length floor.** `lattice/src/conform/drive/campaign.ts`'s `runCampaign` now builds the
     intention array with `fc.array(intentionArb(...), { minLength: Math.max(1,
     Math.floor(opts.length * 2 / 3)), maxLength: opts.length })` instead of no `minLength` at
     all. The investigation measured a mean generated length of 4.4–5.1 against a configured
     `--length 30` with fast-check's default size schedule — 94–95% of sequences executed zero
     commands. This is the direct fix for the reachability question campaign #1 flagged and never
     resolved: c01/c02/c05/c06/c07 all MISSED with byte-identical per-seed command-trace stats,
     consistent with `activate` structurally never getting past the length bias.
  2. **Create restriction.** `intentionArb` gained a required `createable: string[]` parameter;
     `createArb` now samples only aggregates the target's driver map can actually create
     (`Object.keys(drivers.drivers.create)`) instead of every plan aggregate uniformly. Fixes the
     measured ~50–56% of the `create` budget wasted on `Invoice` (which has no create driver —
     created only internally by `Subscription`'s create driver).
  3. **Superset binding.** `intentionArb` gained an optional `supersetTargets: Record<string,
     string>` (op name → aggregate); a mapped superset op now always gets its declared aggregate
     instead of an independent random draw. `implementations/subscriptions/conform/drive.ts`
     exports `supersetAggregates` for all six superset ops
     (`recordUsage`/`changeSeats`/`rollover`/`changePlanOp` → `Subscription`,
     `partialPayment` → `Invoice`, `dunningSweep` → `Subscription`). Fixes the measured 33–59%
     (pooled ~50%) of superset attempts wasted on a mismatched aggregate.
  4. **Driver-skip mechanism** (see §2 below — registered separately since it is itself a
     pre-registered, human-ruled protocol element, not just an instrument bug fix).
- **`ab3ea4d` — `chore(ledger): conformance evidence lines from the drive-repair sanity runs`.**
  Append-only ledger evidence from the repair's own verification (seed 21/400-sequence sanity run,
  `driverSkips: 1`, CLEAN — plus one earlier seed-11 entry from the same session).

**Human rulings referenced:** the repair report's own framing — "four approved fixes + one
approved opt-out mechanism" — records that items 1–3 above and the driver-skip mechanism (§2) were
each reviewed and approved before landing, not unilaterally decided. The finalize/settle
`requires`-drop (amendment (a), campaign #1) and the probe-oracle re-attribution rule (amendment
(b), campaign #1) both carry forward unchanged into campaign #2 — neither was touched by `a803a71`.

### 2. The pre-registered `paymentFailed` skip

The investigation's §4a finding was a genuine hazard: naively fixing the length bias (item 1 above)
alone would flip the 5×200 false-positive control from CLEAN to FAILED, because
`paymentFailed` is spec-legal unconditionally from `active` (`specs/subscriptions/spec.lat:36`,
no `requires` clause) but the real `recordPaymentFailure`
(`implementations/subscriptions/src/dunning.ts:16`) throws unless the subscription's *current*
invoice is still `open` — an implicit cross-aggregate precondition (current invoice's settlement
state) the spec's single-aggregate `Subscription` machine cannot express and the walk's oracle
cannot see (it only scoped-observes the targeted aggregate). Reaching `active` at all already
requires `paidInvoiceCount >= 1`, i.e. the current invoice was already settled to `paid` — so a
legally-generated `paymentFailed` on a freshly-`active` row can genuinely have nothing open to
fail.

This was adjudicated (option (c) of the repair report's three options: driver-harness limitation,
not a spec-text gap or an impl bug) and implemented as a **driver-skip**, not a spec change or an
impl change:

- **Mechanism** (`lattice/src/conform/drive/walk.ts`): a driver may throw
  `Error('drive-skip: <reason>')`. Honored **only** in the LEGAL branch's catch (the branch that
  runs when the walk's own pre-state oracle already determined the intention was spec-legal) — on
  a `drive-skip:`-prefixed throw there, `stats.driverSkips++`, a narrative line is pushed, and
  **no violation is recorded**, and the step is **not** counted as `commands`/`accepted`/`rejected`.
  The illegal/probe branch's catch is a separate, untouched code path that does not inspect the
  error message — a `drive-skip:`-prefixed throw from an illegal probe is counted as an ordinary
  rejected probe, indistinguishable from any other rejection. This was pinned by a dedicated
  fixture (two new `walk.test.ts` tests) proving the signal cannot mask a weakened-guard catch: a
  drift that weakens `activate`'s guard cannot hide behind `drive-skip` because the skip path is
  categorically unreachable from the illegal-probe branch.
- **Applied driver**, `implementations/subscriptions/conform/drive.ts`'s `paymentFailed`: it now
  checks whether the subscription's current invoice exists **and** has `settlement_state = 'open'`
  before calling `recordPaymentFailure`; if not, it throws, verbatim:

  ```
  'drive-skip: no open invoice — a payment cannot fail when nothing is owed (pre-registered impl-strictness finding, campaign #2)'
  ```

  — the reason string itself names this campaign, because the skip was pre-registered here before
  campaign #2's runs, not discovered mid-run and patched around.
- **Always-printed audited line:** `formatCampaign` now prints `driver skips (impl preconditions,
  audited): N` unconditionally, even at `N = 0` — the same "reported never hidden" discipline
  already used for `probe re-attributions`. `DriveStats.driverSkips` also reaches the session
  ledger (`LedgerEntry.driverSkips`), not just the console, so skip evidence is auditable
  after the fact from `.lattice-session-subscriptions/ledger.jsonl` alone.
- **The command-vs-event semantics question** — whether `paymentFailed` ought to be modeled as a
  spec-level command the walk drives directly at all, versus an event that only ever arises as a
  side effect of a billing/dunning process (rollover, dunning sweep) acting on an aggregate the
  single-aggregate `Subscription` machine can't see — is **not resolved by this mechanism**. The
  drive-skip is a harness-side audit trail for the impl-strictness gap as it exists today; it does
  not adjudicate whether the spec's `paymentFailed` transition is mis-modeled as a command. That
  question is recorded here as **folded into the ensures brief** (deferred, out of scope for this
  campaign's zero-tuning discipline; not re-opened or re-scoped mid-campaign).

### 3. Amended budget + protocol

- **Rediscovery seeds:** 21, 22, 23 per class (stop at first catch; 3 clean seeds across all three
  = MISSED) — replaces campaign #1's 11/12/13 (chosen fresh so campaign #2 is not silently
  re-running the exact seeds that produced campaign #1's length-biased MISSes under the old
  instrument).
- **Command:** `--sequences 1600 --length 30` — replaces campaign #1's `--sequences 200 --length
  30`. The 1600 figure follows the investigation's §3 root-cause measurement directly: `activate`
  was confirmed reachable at a ~4.6% per-sequence hit rate (74/1612 acceptances) once the length
  floor was in place, an order of magnitude above the 200-sequence budget that produced 0/600
  reachability across three seeds. 1600 sequences give each seed comparable exploratory power to
  that measurement while staying cheap (the §5 control below measures actual wall time).
- **Branch mechanics:** identical recipe to campaign #1's — "Branch mechanics (copied verbatim from
  `.superpowers/sdd/d2-protocol.md`)" section above governs unchanged; not re-copied here.
- **Zero-tuning rules:** unchanged from campaign #1 — a class the driver cannot rediscover at all
  three seeds is recorded MISSED verbatim and escalated, never re-scoped; false positives on the
  clean impl STOP the plan (BLOCKED); no test suites; `.conform` wiped before each run.

### 4. Expectations — carried forward from campaign #1's registration

Same 13 signals/routes as campaign #1's expectations table (§1 above), reproduced here for
campaign #2 because the routes are what campaign #2's runs will be graded against — not
re-derived, not re-scoped. One route's reasoning changes materially at the new depth, noted
inline; all others are unedited carries.

| # | slug | expected verdict | expected signal (element + substring) | expected discovery route |
|---|------|-------------------|-----------------------------------------|----------------------------|
| c01 | skipped-emit | REDISCOVERED | Tier 2, `machine Subscription.status`, substring `do not include observed final 'active'` | any driven sequence that reaches `activate` on a trialing row (now confirmed reachable at depth — investigation §3, ~4.6%/sequence): the deleted emit leaves the row's outbox one event short, so the end-of-sequence Tier-2 trace dead-ends short of `active`. |
| c02 | wrong-event | REDISCOVERED | Tier 2, `machine Subscription.status`, substring `stuck at event #2 (SubscriptionActivated` | any driven `activate` followed by `cancel` on the same row: `cancel` emits the wrong event type, producing a second `SubscriptionActivated` instead of `SubscriptionCanceled` — end-of-sequence Tier-2 check. Strictly downstream of c01's route (needs `activate` to succeed, then one more hop). |
| c03 | emit-outside-tx | REDISCOVERED | Tier 2, `machine Subscription.status`; substring `do not include observed final 'trialing'` or `all 1 event(s) consumed` (either scores REDISCOVERED, per campaign #1's ruling) | the driver's illegal probe on `activate` from `trialing` (guard-violated): already confirmed REDISCOVERED at seed 11 in campaign #1 — this route does not depend on the length-bias fix (it fires on the very first probe of a sequence) and is carried forward unchanged. |
| c04 | weakened-guard | REDISCOVERED via EITHER route | Route A: Tier 1, `activePaidInFull`. Route B: substring `accepted a spec-illegal command`, naming transition `activate`, anchors `transition activate` | already confirmed REDISCOVERED (Route B) at seed 11 in campaign #1, on the first probe of the campaign — carried forward unchanged; depth-independent. |
| c05 | win-back | REDISCOVERED | Tier 2, `machine Subscription.status`, substring `do not include observed final 'active'` (Subscription-region, reachable state `{canceled}` terminal) | `cancel` a subscription while it has an open invoice, then drive `settle` on that same invoice — requires the invoice to reach `open` (`finalize`) first, a multi-hop chain campaign #1 could not confirm reachable at 200×30. At 1600×30 with the length floor, `finalize`+`settle` chains are directly measured reachable (investigation §3: 104/1612 settle-acceptances at comparable volume) — the ordering constraint (cancel before settle) is not separately measured but is no longer gated behind the same length-bias root cause that explained all five campaign #1 MISSes. |
| c06 | state-rename | REDISCOVERED-LOUD | binder/observe abort, stderr substring `is null/undefined for row` | **route reasoning changes at depth** — campaign #1 registered "`paymentFailed` is a one-command path from `active`," reachable directly via the transition driver. Post-repair, that direct route is now largely closed off by the `paymentFailed` drive-skip (§2): a freshly-`active` row's current invoice is normally already `paid` (activation itself required a prior settle), so the walk's own `paymentFailed` driver will skip-not-transition on it, exactly the intended audited behavior. The row now more plausibly reaches `past_due` via a **different** mechanism, traced to source: `rolloverPeriod` (`implementations/subscriptions/src/subscription-service.ts:94-111`, driven by the `rollover` superset op) internally calls `recordPaymentFailure` directly on the just-closed invoice when its synthetic `charge()` callback declines (`implementations/subscriptions/conform/drive.ts`'s `rollover` superset entry: `charge: () => int(gen, 0, 1) === 1`, i.e. a coin flip) — this is an impl-internal call, not routed through the walk's `paymentFailed` driver at all, so it is never subject to the drive-skip check and can flip a row to `past_due` as a side effect of a driven `rollover`. `dunningSweep`'s sweeps over existing `past_due` rows are a secondary contributor once a row is already there. Net: `past_due` is now expected reachable "via failed rollovers/dunning at volume" rather than via a direct `paymentFailed` command — same expected signal, different expected route, registered honestly before the run rather than discovered and rationalized after. |
| c07 | partial-write | REDISCOVERED | Tier 1, `neverOverpaidAndPaidExact`, witness the settled invoice | any driven `settle` (full-balance `recordPayment`) on the drift's non-settling branch — already measured reachable at comparable volume in the investigation (§3: 104/1612 settle-acceptances, "borderline… reliably reachable at the 1600-sequence budget"), directly supporting the amended budget choice for this route specifically. |
| c08 | two-drafts | REDISCOVERED | Tier 1, `oneDraftInvoicePerSubscription`, set-level violation | unchanged from campaign #1's registration — depends on `rollover`'s superset volume, which the superset-binding fix (§1 item 3) improves (no longer ~50% wasted on the wrong aggregate) independent of the length floor. |
| c09 | upgrade-activates | REDISCOVERED | Tier 1, `activePaidInFull`, witness the successor subscription (plus crosscheck collateral) | unchanged; `changePlanOp` superset volume benefits from the same superset-binding fix. |
| c10 | column-rename | REDISCOVERED-LOUD | binder abort, stderr substring `unbound spec fields`, naming `Subscription` … `seats` | unchanged — fires at campaign start (`bindSchema`, before the intention loop), depth-independent. |
| c11 | stale-override | REDISCOVERED-LOUD | stderr substring `no such column: amount` | unchanged — fires at first scoped Invoice observe, depth-independent. |
| c12 | proration-total | REDISCOVERED | Tier 1, `totalDueAtMostParts`, witness the drifted open invoice | unchanged; depends on `changeSeats` on an already-open invoice — benefits from both the length floor (reaching `open`) and the create/superset fixes. |
| c13 | stale-read-model | REDISCOVERED | crosscheck, `crosscheck account_summary`, substrings `lifetime_paid` and/or `open_balance` mismatches | unchanged; depends on a driven `settle`, same reachability improvement as c07. |

### 5. The 5-seed false-positive control at the new depth

Protocol: work-branch tip `ab3ea4d`, `rm -rf implementations/subscriptions/.conform` once before
the set (confirmed empty/absent both before and after all 5 runs — drive mode still writes no
passive snapshot artifacts at this depth either), then for each seed:

```
npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences 1600 --length 30 --seed <N>
```

**Result: 5/5 CLEAN. No STOP triggered.**

| seed | verdict | commands (accepted/rejected/superset) | probes attempted/rejected | guarded transitions | re-attributions | driver skips | duration (harness) | duration (wall) |
|------|---------|-----------------------------------------|------------------------------|------------------------|--------------------|-----------------|------------------------|--------------------|
| 21 | CLEAN | 11688 (2608 / 0 / 211) | 8869 / 8532 | activate | 337 | 6 | 8.1s (8097ms) | 10.59s |
| 22 | CLEAN | 12161 (2782 / 0 / 193) | 9186 / 8817 | activate | 369 | 5 | 4.2s (4207ms) | 6.90s |
| 23 | CLEAN | 12189 (2728 / 0 / 187) | 9274 / 8894 | activate | 380 | 3 | 4.3s (4320ms) | 6.24s |
| 24 | CLEAN | 11693 (2655 / 0 / 205) | 8833 / 8498 | activate | 335 | 1 | 4.4s (4420ms) | 5.98s |
| 25 | CLEAN | 12199 (2785 / 0 / 214) | 9200 / 8834 | activate | 366 | 5 | 3.1s (3085ms) | 4.58s |

Notes:
- All five exit code 0, `violationCount: 0` in every ledger entry — no STOP, no BLOCKED.
- Command volume is roughly 200–300× campaign #1's (11688–12199 vs. 34–72 at seeds 1–5, §2 above)
  at the same target — direct confirmation the length-floor + create/superset fixes convert the
  overwhelming majority of generated intentions into executed commands instead of `no-rows`/
  `no-driver` skips.
- `guardedTransitionsProbed` is `activate` on every seed, still the only guarded transition —
  amendment (a) (finalize/settle `requires`-drop) continues to hold at this depth, confirmed
  empirically again.
- Per seed, `probesAttempted − probesRejected == reattributions` exactly (seed 21: 8869−8532=337;
  22: 9186−8817=369; 23: 9274−8894=380; 24: 8833−8498=335; 25: 9200−8834=366) — every illegal probe
  the clean impl accepted was fully explained by a legal sibling transition, 0 unexplained accepts,
  0 violations, on every seed, at ~24–29× campaign #1's probe volume. Amendment (b) (re-attribution
  rule) holds cleanly at depth.
- **Driver skips are present and nonzero on every seed (1–6) — and none of them are violations.**
  This is the whole point of the mechanism (§2): every one of these is the `paymentFailed`
  drive-skip firing (`no open invoice` — a freshly-`active` row's current invoice already `paid`,
  the same impl-strictness gap the investigation predicted at depth). Because the skip fires from
  the LEGAL branch and is honored there, it is counted in `driverSkips`, printed on the always-on
  audited line, and folded into the session ledger — but it is **not** counted as a `command`, not
  as `probesAttempted`/`probesRejected`, and critically not as a `violation`. Grepped directly
  across all five logs: zero `VIOLATION` lines, zero occurrences of `impl rejected a spec-legal
  command` (the violation phrasing the unguarded throw would have produced pre-repair). Confirms
  the §4a false-positive the investigation predicted would appear at depth is instead caught and
  reported as an audited skip, exactly as designed — not a violation, not hidden, not silently
  dropped.
- `.conform` did not exist in `implementations/subscriptions/` before the set or after any of the 5
  runs.
- Runtime: harness-internal `durationMs` ranges 3085–8097ms across all five seeds — the original
  60s budget (criterion 5) was registered against a 200×30 campaign, not this amended 1600×30
  budget, so it is not re-asserted verbatim here; reported honestly as roughly 8× more sequences at
  roughly 40–95× campaign #1's wall time, still comfortably sub-11s end-to-end including Node/tsx
  startup.

Ledger evidence: 5 new lines appended to `.lattice-session-subscriptions/ledger.jsonl` (seeds
21–25 in order), each `kind: "conformance"`, `mode: "drive"`, `sequences: 1600`, `violationCount:
0`, each carrying the new `driverSkips` field, committed alongside this document.

### 6. Campaign #2 outcomes

### c01 — skipped emit
**Verdict: REDISCOVERED**

Branch mechanics: `git checkout -b drive/c01 drift/c01-skipped-emit`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c01-skipped-emit -- implementations/subscriptions/src` was empty after the merge — the drift
edit survived intact. `rm -rf implementations/subscriptions/.conform` before the run; absent both
before and after.

Seed tried: 21 (first pre-authorized seed — caught on first try, no need for 22/23 per "stop at
first catch").

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 1 (FAILED, not a loud abort — matches expected verdict
REDISCOVERED, not REDISCOVERED-LOUD).

Verbatim stdout:
```
drive: 323 sequences — FAILED (seed 21)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 21
commands: 3084 (755 accepted, 0 rejected, 51 superset ops)
guards probed at event time: 2278 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 75
driver skips (impl preconditions, audited): 0
duration 0.6s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition finalize on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition settle on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 0 event(s) consumed, reachable state(s) {trialing, expired} do not include observed final 'active'; events=[] — anchors [spec:machine Subscription.status] — source drive:16
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 0 event(s) consumed, reachable state(s) {trialing, expired} do not include observed final 'active'; events=[] — anchors [spec:machine Subscription.status] — source drive:17
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 0 event(s) consumed, reachable state(s) {trialing, expired} do not include observed final 'active'; events=[] — anchors [spec:machine Subscription.status] — source drive:18
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 0 event(s) consumed, reachable state(s) {trialing, expired} do not include observed final 'active'; events=[] — anchors [spec:machine Subscription.status] — source drive:19
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 0 event(s) consumed, reachable state(s) {trialing, expired} do not include observed final 'active'; events=[] — anchors [spec:machine Subscription.status] — source drive:20
```

Registered substring `do not include observed final 'active'` (Tier 2, `machine
Subscription.status`) appears verbatim, 5 times, all against `machine Subscription.status`, exactly
the pre-registered signal — the narrative shows the exact route registered for campaign #2: the
sequence reaches `finalize` then `settle` on the invoice (paying it), then a legal `activate` is
accepted (`legality=legal -> accepted`), and the deleted-emit drift leaves the Subscription's Tier-2
event trace one event short of `active`, so the end-of-sequence replay dead-ends at `{trialing,
expired}`. Confirms the length-floor fix (campaign #2 amendment) closed exactly the reachability gap
that produced this class's campaign #1 MISS — `activate` is reached directly, well within the first
323 (of 1600 budgeted) sequences at seed 21. `.conform` confirmed absent after the run (no snapshot
artifact leaked). No collateral violations — all 5 VIOLATION lines are the same registered signal
against the same witness (`d-subscription-1`), differing only by `source drive:NN` sequence index.

### c02 — wrong event type
**Verdict: REDISCOVERED**

Branch mechanics: `git checkout -b drive/c02 drift/c02-wrong-event`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c02-wrong-event -- implementations/subscriptions/src` was empty after the merge — the drift
edit survived intact. `rm -rf implementations/subscriptions/.conform` before the run; absent both
before and after.

Seed tried: 21 (first pre-authorized seed — caught on first try).

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 1 (FAILED, matches expected verdict REDISCOVERED).

Verbatim stdout:
```
drive: 753 sequences — FAILED (seed 21)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 21
commands: 6701 (1527 accepted, 0 rejected, 162 superset ops)
guards probed at event time: 5012 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 166
driver skips (impl preconditions, audited): 1
duration 1.6s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition finalize on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  probe settle on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=legal -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  superset changePlanOp on Subscription#d-subscription-1 (rowPick=0, seed=0) -> accepted
  probe activate on Subscription#d-gen-1001080-266429 (rowPick=0, seed=0) legality=illegal -> rejected
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — stuck at event #2 (SubscriptionActivated, outbox seq 4) from state(s) {active, pastDue, canceled}; events=[SubscriptionActivated, SubscriptionActivated] — anchors [transition activate] — source drive:19
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — stuck at event #2 (SubscriptionActivated, outbox seq 4) from state(s) {active, pastDue, canceled}; events=[SubscriptionActivated, SubscriptionActivated] — anchors [transition activate] — source drive:20
```

Registered substring `stuck at event #2 (SubscriptionActivated` (Tier 2, `machine
Subscription.status`) appears verbatim, twice, both against the expected witness
(`d-subscription-1`) — the trace's `events=[SubscriptionActivated, SubscriptionActivated]` shows
two `SubscriptionActivated` events where the spec's status machine expects a
`SubscriptionCanceled` at the second slot, consistent with the registered mechanism (`cancel`
emitting the wrong event type, downstream of c01's route). The shrunk narrative shows one legal
`activate` acceptance (line 18) plus a `changePlanOp` superset op (line 27) before the violation
fires; the exact command producing the second `SubscriptionActivated` is not itself narrated by
name (the narrative lists driven commands, not raw outbox writes) but the outbox trace is
unambiguous about the drift's effect. One driver skip is visible in the summary line (`driver
skips (impl preconditions, audited): 1`) — audited data per the campaign's zero-tuning rule, not a
violation. `.conform` confirmed absent after the run.

### c03 — emit outside the transaction
**Verdict: REDISCOVERED**

Branch mechanics: `git checkout -b drive/c03 drift/c03-emit-outside-tx`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c03-emit-outside-tx -- implementations/subscriptions/src` was empty after the merge — the
drift edit survived intact. `rm -rf implementations/subscriptions/.conform` before the run; absent
both before and after.

Seed tried: 21 (first pre-authorized seed — caught on first try, and on the very first driven
sequence, consistent with this route's depth-independence carried forward from campaign #1).

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 1 (FAILED, matches expected verdict REDISCOVERED).

Verbatim stdout (head + first violations; log continues with 10 more VIOLATION lines of the same
shape as the driver keeps probing `activate` after the first catch):
```
drive: 1 sequences — FAILED (seed 21)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 21
commands: 702 (106 accepted, 0 rejected, 54 superset ops)
guards probed at event time: 542 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 46
driver skips (impl preconditions, audited): 0
duration 0.1s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  ... (7 more illegal-rejected/probe-rejected activate attempts) ...
  superset recordUsage on Subscription#d-subscription-1 (rowPick=0, seed=0) -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 1 event(s) consumed, reachable state(s) {active, pastDue, canceled} do not include observed final 'trialing'; events=[SubscriptionActivated] — anchors [transition activate] — source drive:9
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — stuck at event #2 (SubscriptionActivated, outbox seq 2) from state(s) {active, pastDue, canceled}; events=[SubscriptionActivated, SubscriptionActivated] — anchors [transition activate] — source drive:10
```

Both registered substrings (either scores REDISCOVERED per campaign #1's ruling) appear: `all 1
event(s) consumed` and `do not include observed final 'trialing'` both fire verbatim on the first
VIOLATION line (`source drive:9`), against the expected witness (`d-subscription-1`). Fires on the
driver's very first illegal probe of `activate` from `trialing` — this route does not depend on
the length-bias fix and is depth-independent, exactly as registered. Note the drive stopped after
1 sequence (`drive: 1 sequences — FAILED`) since the walk halts on first violation; the trailing
`stuck at event #2 (SubscriptionActivated...` lines are the same underlying drift (emit-outside-tx
leaves a duplicated/leaked event on retried illegal probes) continuing to fire as the driver
exhausts the rest of that one sequence's probes before reporting FAILED — collateral of the same
class, not a second signal. `.conform` confirmed absent after the run.

### c04 — weakened guard
**Verdict: REDISCOVERED (Route B)**

Branch mechanics: `git checkout -b drive/c04 drift/c04-weakened-guard`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c04-weakened-guard -- implementations/subscriptions/src` was empty after the merge — the
drift edit survived intact. `rm -rf implementations/subscriptions/.conform` before the run; absent
both before and after.

Seed tried: 21 (first pre-authorized seed — caught on first try, on the driver's very first probe
of the campaign, consistent with this route's depth-independence carried forward from campaign
#1).

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 1 (FAILED, matches expected verdict REDISCOVERED).

Verbatim stdout:
```
drive: 1 sequences — FAILED (seed 21)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 21
commands: 677 (54 accepted, 0 rejected, 54 superset ops)
guards probed at event time: 569 attempts across 0 guarded transitions
probe re-attributions (shared entry points; sibling-masking limitation applies): 46
driver skips (impl preconditions, audited): 25
duration 0.2s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> accepted (VIOLATION)
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  ... (7 more rejected activate attempts, 1 superset recordUsage accepted) ...
VIOLATION transition activate (transition activate) — witnesses [d-subscription-1] — impl accepted a spec-illegal command: 'activate' was illegal from the observed pre-state but the driver accepted it without throwing — anchors [transition activate] — source drive:9
```

Route B fires: substring `accepted a spec-illegal command` present verbatim, naming transition
`activate`, anchor `transition activate` — exactly the registered signal, on the driver's very
first transition attempt after `create` (narrative line 10, `legality=illegal -> accepted
(VIOLATION)`). Depth-independent, exactly as registered — no dependence on the length-floor fix.
25 driver skips are visible in the summary line (audited, not violations, per the campaign's
zero-tuning rule). `.conform` confirmed absent after the run.

### c05 — terminal resurrection (win-back)
**Verdict: REDISCOVERED**

Branch mechanics: `git checkout -b drive/c05 drift/c05-win-back`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff drift/c05-win-back
-- implementations/subscriptions/src` was empty after the merge — the drift edit survived intact.
`rm -rf implementations/subscriptions/.conform` before the run; absent both before and after.

Seed tried: 21 (first pre-authorized seed — caught on first try). This is the class campaign #1
could not confirm reachable at 200×30 (the multi-hop `finalize`+`cancel`+`settle` chain); at
1600×30 it fires well within budget.

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 1 (FAILED, matches expected verdict REDISCOVERED).

Verbatim stdout:
```
drive: 59 sequences — FAILED (seed 21)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 21
commands: 4778 (1139 accepted, 0 rejected, 11 superset ops)
guards probed at event time: 3628 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 199
driver skips (impl preconditions, audited): 0
duration 1.3s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  ... (4 more rejected/probed illegal activate attempts) ...
  probe finalize on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe cancel on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  create Subscription#d-subscription-2 (seed=0) -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition settle on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 1 event(s) consumed, reachable state(s) {canceled} do not include observed final 'active'; events=[SubscriptionCanceled] — anchors [transition cancel] — source drive:19
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 1 event(s) consumed, reachable state(s) {canceled} do not include observed final 'active'; events=[SubscriptionCanceled] — anchors [transition cancel] — source drive:20
VIOLATION machine Subscription.status (machine Subscription.status) — witnesses [d-subscription-1] — no legal path: Subscription 'd-subscription-1' region 'status' — all 1 event(s) consumed, reachable state(s) {canceled} do not include observed final 'active'; events=[SubscriptionCanceled] — anchors [transition cancel] — source drive:21
```

Registered substring `do not include observed final 'active'` (Tier 2, `machine
Subscription.status`, Subscription-region terminal `{canceled}`) appears verbatim, 3 times,
against the expected witness (`d-subscription-1`) — and the narrative shows exactly the registered
route in order: `finalize` on the invoice (line 16, legal, accepted), `cancel` on the subscription
while the invoice was open (line 18, legal, accepted — the row is now terminal `canceled`), then
`settle` on that same invoice (line 27, legal, accepted) — the win-back drift resurrects the
terminal row to `active` on the settle, which the spec's Tier-2 status machine cannot reach from
`{canceled}`. Confirms the amended budget's reasoning directly: this multi-hop chain, unconfirmed
reachable at campaign #1's 200×30, is reached within 59 of 1600 budgeted sequences at seed 21.
`.conform` confirmed absent after the run.

### c06 — state-name drift
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c06 drift/c06-state-rename`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — clean auto-merge, no conflicts this
time (unlike c01–c05). `git diff drift/c06-state-rename -- implementations/subscriptions/src` was
empty after the merge — the drift edit survived intact. The drift itself: `'past_due'` renamed to
`'delinquent'` consistently across `implementations/subscriptions/src/{billing-service.ts,
dunning.ts, subscription-service.ts, schema.sql}` (impl-internal representation only — the
conform/observe layer's binding still expects the literal `'past_due'`). `rm -rf
implementations/subscriptions/.conform` before the run; absent both before and after.

Seeds tried: 21, 22, 23 (all three pre-authorized seeds — all CLEAN, no LOUD abort, no violation;
per "stopping after 3 clean seeds = MISSED").

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed <21|22|23>`. Exit code 0 on all three runs.

Verbatim stdout, all three seeds:
```
drive: 1600 sequences — CLEAN
commands: 11688 (2608 accepted, 0 rejected, 211 superset ops)
guards probed at event time: 8869 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 337
driver skips (impl preconditions, audited): 6
duration 3.1s
```
```
drive: 1600 sequences — CLEAN
commands: 12161 (2782 accepted, 0 rejected, 193 superset ops)
guards probed at event time: 9186 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 369
driver skips (impl preconditions, audited): 5
duration 2.7s
```
```
drive: 1600 sequences — CLEAN
commands: 12189 (2728 accepted, 0 rejected, 187 superset ops)
guards probed at event time: 9274 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 380
driver skips (impl preconditions, audited): 3
duration 2.9s
```

Every field (commands/accepted/superset, guard-probe volume, re-attributions, driver skips) is
byte-identical, per seed, to the corresponding row of §5's 5-seed false-positive control on the
*clean* implementation (seed 21: 11688/2608/0/211, 337 reattr, 6 skips; seed 22:
12161/2782/0/193, 369 reattr, 5 skips; seed 23: 12189/2728/0/187, 380 reattr, 3 skips) — the drift
produced observably indistinguishable command-generation behavior from the clean impl at all three
seeds. No `is null/undefined for row` stderr, no exit code 2, no violation, at any seed.

Recorded honestly per the pre-briefed caveat: this class's amended route (registered at §4 of the
campaign-#2 table) needs a `past_due`/now-`delinquent` row to exist before the observe/bind layer
can trip over the renamed literal — and that state only arises in-sequence, via `rollover`'s
internal coin-flip decline (`implementations/subscriptions/src/subscription-service.ts:94-111`)
or via the (now largely-skipped) direct `paymentFailed` driver. The driver-skip counts present in
all three runs (6/5/3) are `paymentFailed`'s pre-registered skip (§2), not evidence either way
about whether `rollover`'s internal decline path fired — and the byte-identical match to the clean
control's numbers is the strongest available signal that no row reached the renamed state along
any of the three driven runs: had `lifecycle_state` ever flipped to `'delinquent'`, the observer
would attempt to read the (now-absent) `'past_due'` state on `settle`/`cancel`/report and abort
loud, which did not happen. Escalated as MISSED, verbatim, not patched — this is a reachability
gap in the driven walk for this specific route (rollover's decline coin-flip did not land, or the
row never got a subsequent settle/cancel/report to trip the bind), not a re-scoping of the
expected LOUD signal. `.conform` confirmed absent after all three runs.

### c07 — partial write on settle
**Verdict: REDISCOVERED**

Branch mechanics: `git checkout -b drive/c07 drift/c07-partial-write`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `e608123`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c07-partial-write -- implementations/subscriptions/src` was empty after the merge — the
drift edit survived intact. `rm -rf implementations/subscriptions/.conform` before the run; absent
both before and after.

Seed tried: 21 (first pre-authorized seed — caught on first try). Campaign #1 measured this route
"borderline… reliably reachable at the 1600-sequence budget" (investigation §3); confirmed here.

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 1 (FAILED, matches expected verdict REDISCOVERED).

Verbatim stdout (head + first two violation pairs; log continues with 8 more repeats of the same
two-invariant pair as the driver keeps probing `activate` against the same already-violated rows):
```
drive: 42 sequences — FAILED (seed 21)
replay: lattice conform --target ../implementations/subscriptions --drive --seed 21
commands: 1259 (334 accepted, 0 rejected, 10 superset ops)
guards probed at event time: 915 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 15
driver skips (impl preconditions, audited): 0
duration 0.2s
narrative:
  create Subscription#d-subscription-1 (seed=0) -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe finalize on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  transition settle on Invoice#d-subscription-1-inv-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=legal -> accepted
  transition activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
  probe activate on Subscription#d-subscription-1 (rowPick=0, seed=0) legality=illegal -> rejected
VIOLATION neverOverpaidAndPaidExact (invariant neverOverpaidAndPaidExact) — witnesses [d-subscription-1-inv-1] — violated by 1/1 Invoice row(s) — anchors [elicited (w1, w2, w3); w1; w2; w3; w4; w5] — source drive:12
VIOLATION activePaidInFull (invariant activePaidInFull) — witnesses [d-subscription-1] — violated by 1/1 Subscription row(s) — anchors [hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5; w1; w2; w3; w4; w5] — source drive:13
VIOLATION neverOverpaidAndPaidExact (invariant neverOverpaidAndPaidExact) — witnesses [d-subscription-1-inv-1] — violated by 1/1 Invoice row(s) — anchors [elicited (w1, w2, w3); w1; w2; w3; w4; w5] — source drive:13
```

Registered signal fires: Tier 1, `neverOverpaidAndPaidExact`, witness the settled invoice
(`d-subscription-1-inv-1`) — exactly the registered element+witness, first appearing at `source
drive:12`, immediately after the driven `settle` (narrative line 15, `legality=legal -> accepted`)
that the partial-write drift under-records. `finalize`+`settle` on the same invoice fires within
42 of 1600 budgeted sequences at seed 21, directly confirming the amended-budget reasoning
(investigation §3: 104/1612 settle-acceptances at comparable volume). Collateral: `activePaidInFull`
(Tier 1) also violates on the same Subscription row on every repeat — labeled collateral, not the
registered signal, but consistent (the under-recorded settle leaves the subscription's paid-in-full
invariant violated too, once `activate` is later legally accepted on line 16). `.conform` confirmed
absent after the run.

### c08 — widened uniqueness (two drafts)
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c08 drift/c08-two-drafts`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `99a1863`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c08-two-drafts -- implementations/subscriptions/src` was empty after the merge — the drift
edit survived intact (the deleted `if (needsBilling) finalizeInvoice(...)` / charge block in
`rolloverPeriod`, `implementations/subscriptions/src/subscription-service.ts`). `rm -rf
implementations/subscriptions/.conform` before the run; absent both before and after.

Seeds tried: 21, 22, 23 (all three pre-authorized seeds — all CLEAN, no violation; per "stopping
after 3 clean seeds = MISSED").

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed <21|22|23>`. Exit code 0 on all three runs.

Verbatim stdout, all three seeds:
```
drive: 1600 sequences — CLEAN
commands: 11688 (2608 accepted, 0 rejected, 211 superset ops)
guards probed at event time: 8869 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 337
driver skips (impl preconditions, audited): 6
duration 2.0s
```
```
drive: 1600 sequences — CLEAN
commands: 12161 (2782 accepted, 0 rejected, 193 superset ops)
guards probed at event time: 9186 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 369
driver skips (impl preconditions, audited): 5
duration 2.8s
```
```
drive: 1600 sequences — CLEAN
commands: 12189 (2728 accepted, 0 rejected, 187 superset ops)
guards probed at event time: 9274 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 380
driver skips (impl preconditions, audited): 3
duration 2.0s
```

Registered element `oneDraftInvoicePerSubscription` (Tier 1, set-level) does not appear in any of
the three logs — grepped directly (`oneDraftInvoicePerSubscription\|VIOLATION`), zero matches.
Exit code 0 (not 1) on all three runs.

Every field (commands/accepted/superset, guard-probe volume, re-attributions, driver skips) is
byte-identical, per seed, to the corresponding row of §5's 5-seed false-positive control on the
*clean* implementation (seed 21: 11688/2608/0/211, 337 reattr, 6 skips; seed 22:
12161/2782/0/193, 369 reattr, 5 skips; seed 23: 12189/2728/0/187, 380 reattr, 3 skips) — same
pattern already seen at c06: the drift produced observably indistinguishable command-generation
behavior from the clean impl at all three seeds (expected, since the walk's command choice is
seed+spec-driven, not observation-driven, and this drift changes neither the spec-legality surface
nor the set of commands the walk will attempt).

Recorded honestly per the zero-tuning rule: the registered route requires a driven `rollover`
(superset op, `supersetAggregates.rollover = 'Subscription'`) to land on a subscription whose
*current* invoice is still `draft` (`needsBilling` in the pre-drift code) at the moment of the
call — `rolloverPeriod`'s own precondition, not gated by the walk's per-step legality oracle (the
walk only classifies superset ops as attempted/accepted, it does not know whether the drift's
specific double-draft condition was hit inside). Since the drift only changes internal behavior
when `needsBilling` is true and command volume/ordering is otherwise byte-identical to clean, this
run does not distinguish "the precondition was never hit across all three seeds' 1600×30 budget"
from "it was hit but `oneDraftInvoicePerSubscription` happened not to be violated by that
particular pairing" — no further investigation performed here, per zero-tuning (no extra flags, no
extra seeds beyond the three pre-authorized, no source changes, no verbose/report-mode reruns).
Escalated as MISSED, verbatim, not patched. `.conform` confirmed absent after all three runs.

### c09 — cross-aggregate activation
**Verdict: MISSED**

Branch mechanics: `git checkout -b drive/c09 drift/c09-upgrade-activates`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `5322cb3`) — one conflict, in
`.lattice-session-subscriptions/ledger.jsonl`, resolved as union (both sides' lines concatenated,
no lines dropped, all validated as parseable JSON post-resolution). `git diff
drift/c09-upgrade-activates -- implementations/subscriptions/src` was empty after the merge — the
drift edit survived intact (`changePlan`'s added block that finalizes the successor's first
invoice, force-sets `lifecycle_state = 'active'`, and emits `SubscriptionActivated` when the source
subscription is `active`/`past_due` — `implementations/subscriptions/src/subscription-service.ts`).
`rm -rf implementations/subscriptions/.conform` before the run; absent both before and after.

Seeds tried: 21, 22, 23 (all three pre-authorized seeds — all CLEAN, no violation; per "stopping
after 3 clean seeds = MISSED").

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed <21|22|23>`. Exit code 0 on all three runs.

Verbatim stdout, seed 21:
```
drive: 1600 sequences — CLEAN
commands: 11688 (2608 accepted, 0 rejected, 211 superset ops)
guards probed at event time: 8869 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 337
driver skips (impl preconditions, audited): 6
duration 3.7s
```
Verbatim stdout, seed 22:
```
drive: 1600 sequences — CLEAN
commands: 12161 (2781 accepted, 0 rejected, 193 superset ops)
guards probed at event time: 9187 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 370
driver skips (impl preconditions, audited): 5
duration 2.8s
```
Verbatim stdout, seed 23:
```
drive: 1600 sequences — CLEAN
commands: 12189 (2728 accepted, 0 rejected, 187 superset ops)
guards probed at event time: 9274 attempts across 1 guarded transitions (activate)
probe re-attributions (shared entry points; sibling-masking limitation applies): 380
driver skips (impl preconditions, audited): 3
duration 3.0s
```

Registered element `activePaidInFull` (Tier 1) and the crosscheck collateral (`crosscheck
account_summary`) do not appear in any of the three logs — grepped directly
(`VIOLATION\|activePaidInFull\|account_summary`), zero matches. Exit code 0 on all three runs.

Seeds 21 and 23 are byte-identical to the corresponding rows of §5's clean-impl control (seed 21:
11688/2608/0/211, 337 reattr, 6 skips; seed 23: 12189/2728/0/187, 380 reattr, 3 skips) — same
"observably indistinguishable from clean" pattern already seen at c06/c08. **Seed 22 is the one
exception recorded honestly across the campaign so far: it diverges from the clean control by a
small margin** (accepted 2781 vs. clean's 2782; guard-probe attempts 9187 vs. 9186; re-attributions
370 vs. 369 — all other fields identical: commands 12161, superset ops 193, driver skips 5,
rejected 0). This is the first seed in campaign #2 whose command-trace statistics are not
byte-identical to the clean control, which is evidence the drift's extra `changePlan` code path
(finalize + force-activate the successor) DID execute somewhere in this run and shifted at least
one subsequent legality classification (most plausibly: a later probe against the
force-activated successor row was classified `illegal` in the clean impl — successor still
`draft` — but the drift makes that row observably `active`, changing the oracle's per-step
legality read for a downstream command touching it). Despite that divergence, no `VIOLATION` line
appears and exit code is 0 — the registered `activePaidInFull` end-of-sequence sweep did not flag
the force-activated successor as unpaid-active in this run.

Recorded honestly per the zero-tuning rule: a genuine MISS, but not a clean one — seed 22's
divergence is the strongest evidence in the c08/c09/c06 MISS cluster that a drift's mutation path
actually fired during a driven run without producing the registered violation, as opposed to the
route's precondition simply never being reached. No further investigation performed here (no
extra flags, no extra seeds beyond the three pre-authorized, no source changes, no verbose/report
reruns) — escalated as MISSED, verbatim, with the seed-22 anomaly flagged plainly rather than
smoothed over. `.conform` confirmed absent after all three runs.

### c10 — schema rename breaks auto-binding
**Verdict: REDISCOVERED-LOUD**

Branch mechanics: `git checkout -b drive/c10 drift/c10-column-rename`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `bf135cb`) — clean auto-merge, no conflicts (same
as c06 — the ledger.jsonl divergence pattern on this branch pair didn't collide on the same lines).
`git diff drift/c10-column-rename -- implementations/subscriptions/src` was empty after the merge —
the drift edit survived intact (`seats` column renamed to `seat_qty` consistently across
`implementations/subscriptions/src/schema.sql` and `subscription-service.ts`;
`conform/overrides.ts` deliberately left untouched, per the drift's own commit message, so the spec
field `seats` no longer auto-binds and has no override). `rm -rf
implementations/subscriptions/.conform` before the run; absent both before and after (the run
aborts before any command executes, so no ledger entry or `.conform` artifact is written at all).

Seed tried: 21 (first pre-authorized seed — aborts loud immediately, depth-independent, as
registered; no need for 22/23).

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 2.

Verbatim stdout/stderr:
```
conform: unbound spec fields — add typed overrides or fix naming:
  Subscription (table subscriptions): seats
```

Registered signal fires exactly: substring `unbound spec fields`, naming `Subscription` … `seats`
— both present verbatim. Matches the registered route precisely: `executeSequence` calls
`bindSchema` before the intention loop even begins, so the campaign never reaches a single driven
command regardless of seed or sequence/length budget — exit 2 immediately, before any narrative,
before any command counter. `.conform` confirmed absent after the run (no working-tree changes at
all from this run — the abort happens before any session/ledger write).

### c11 — stale override
**Verdict: REDISCOVERED-LOUD**

Branch mechanics: `git checkout -b drive/c11 drift/c11-stale-override`, `git merge --no-edit
claude/silly-tereshkova-a4e54b` (work-branch tip `8d163ec`) — clean auto-merge, no conflicts.
`git diff drift/c11-stale-override -- implementations/subscriptions/src` was empty after the merge
— the drift edit (schema.sql + billing-service.ts + read-model.ts renaming `invoice_payments.amount`
to `amount_cents`) survived intact. Per the recipe's explicit c11 carve-out, verified directly
rather than assumed: the merged `conform/overrides.ts` still contains `SELECT COALESCE(SUM(amount),
0) ... FROM invoice_payments` (the drift branch's stale override querying the renamed-away `amount`
column) — the auto-merge did not silently pull in a work-branch-side rewrite of this file, so the
staleness IS the drift, present verbatim as intended. `rm -rf
implementations/subscriptions/.conform` before the run; absent both before and after.

Seed tried: 21 (first pre-authorized seed — aborts loud immediately, depth-independent, as
registered; no need for 22/23).

Command: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences
1600 --length 30 --seed 21`. Exit code 2.

Verbatim stdout/stderr:
```
no such column: amount
```

Registered stderr substring `no such column: amount` fires exactly, verbatim. Matches the
registered route precisely: the first scoped observe of an Invoice row evaluates the
`Invoice.amountPaid` override, which throws immediately against the renamed-away column — exit 2,
before any command-level legality check runs, depth-independent. `.conform` confirmed absent after
the run (no working-tree changes from this run — the abort happens before any session/ledger
write).

### c12 — out-of-spec feature corrupts covered state
**Verdict: PENDING (campaign #2)**

### c13 — stale read model
**Verdict: PENDING (campaign #2)**
