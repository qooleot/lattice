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
**Verdict: PENDING**

### c07 — partial write on settle
**Verdict: PENDING**

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
