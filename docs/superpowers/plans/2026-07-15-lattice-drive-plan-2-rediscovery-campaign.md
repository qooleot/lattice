# Adversarial Generation Plan 2: The Pre-Registered Rediscovery Campaign

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate `lattice conform --drive` against the design's pre-registered criteria: rediscover all 13 slice-2 drift classes on their existing `drift/*` evidence branches by DRIVING ALONE (no test suites, no fixtures), prove guard probing in both directions, establish the 5×200 zero-false-positive control, and render the tier-2b verdict.

**Architecture:** Same evidentiary discipline as slice 2 plan 4: pre-register expectations BEFORE running; execute per-class on the existing drift branches (checkout → drive → record verbatim → return); zero tuning inside experiments; verdict against the criteria. New wrinkle: drift branches predate plan 1, so each class run cherry-picks the plan-1 harness commits onto a throwaway branch (`drive/cNN` off the drift branch) rather than re-creating drift.

**Tech Stack:** Everything from plan 1; git.

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

## File Structure

- Create `docs/superpowers/specs/2026-07-15-lattice-drive-rediscovery-results.md` — pre-registration + outcomes + verdict (Tasks 1–4).
- Throwaway branches `drive/c01`…`drive/c13` (created and deleted per class).

---

### Task 1: Pre-registration + the 5×200 false-positive control

**Files:**
- Create: `docs/superpowers/specs/2026-07-15-lattice-drive-rediscovery-results.md`

- [ ] **Step 1: Write the pre-registration**

Sections, in order:
1. Header: date, work-branch commit the campaign forks from (`git rev-parse HEAD`), plan-1 landing note, the design-§5 criteria under test, and the branch mechanics (copy the Global Constraints recipe verbatim — the recipe is part of the registration).
2. **Expectations table** — one row per class, columns: `#`, `slug`, `expected verdict (REDISCOVERED / REDISCOVERED-LOUD)`, `expected signal (element + substring)`, `expected discovery route (one line: which command pattern exposes it)`. Derive the signals from the slice-2 results doc's caught signals (same elements — e.g. c01 `machine Subscription.status`; c04 now has a SECOND route: the direct guard probe `accepted a spec-illegal command` on `transition activate` — register BOTH, either suffices); c06/c10/c11 expect the same loud stderr lines as slice 2 (`is null/undefined for row`, `unbound spec fields`, `no such column: amount`). Routes are honest predictions (e.g. c01: "any sequence reaching activate"; c05: "settle an open invoice of a canceled sub — requires cancel-with-open-invoice ordering"; c13: "any settle, then end-of-sequence crosscheck").
3. **False-positive control (criterion 3):** the clean work branch, seeds 1–5, `--sequences 200 --length 30` each: record per seed — clean/violations, probes attempted/rejected, guarded transitions covered, duration. All five must be CLEAN and ≤ 60s. Any violation: STOP, BLOCKED, verbatim narrative (a shrunk repro on the CLEAN impl is either a plan-1 bug or a real impl/spec finding — either way a human gate).
4. Empty `## Outcomes` with 13 PENDING stubs.

- [ ] **Step 2: Run the control, fill section 3** (five real runs; the ledger gains five drive entries — commit them as evidence).

- [ ] **Step 3: Commit** — results doc + ledger, `docs(conform): drive rediscovery pre-registration + 5-seed false-positive control` (with trailer).

---

### Task 2: Rediscovery c01–c07

Execute the Global-Constraints branch mechanics per class, in order c01…c07. For each: record the outcome section (seeds tried, exit, shrunk narrative or loud stderr, verdict vs the registered signal) and commit the results doc on the work branch before the next class.

- [ ] c01 skipped-emit — expect REDISCOVERED (`machine Subscription.status`, tier-2 at end-of-sequence check)
- [ ] c02 wrong-event — expect REDISCOVERED (stuck-event detail)
- [ ] c03 emit-outside-tx — expect REDISCOVERED (this is the class passive mode needed a hand-pinned fixture for: the driver's illegal-probe on activate leaves the stray event with the row still trialing, then the end-of-sequence trace check fires — the registered route)
- [ ] c04 weakened-guard — expect REDISCOVERED via EITHER route (direct probe accept, or Tier-1 activePaidInFull)
- [ ] c05 win-back — expect REDISCOVERED (ordering: cancel with open invoice, then settle)
- [ ] c06 state-rename — expect REDISCOVERED-LOUD (first scoped observe of a past_due row; if no sequence reaches past_due under seeds 11–13, that is a MISSED to record honestly — the registered route says paymentFailed is a one-command path from active, so this should be reliably reachable)
- [ ] c07 partial-write — expect REDISCOVERED (Tier-1 neverOverpaidAndPaidExact after a driven settle)

---

### Task 3: Rediscovery c08–c13

Same mechanics.

- [ ] c08 two-drafts — expect REDISCOVERED (the drift lives in `rolloverPeriod`; plan 1's driver map includes the `rollover` superset op, so any driven rollover of a draft-current subscription exposes the two-draft state → Tier-1 oneDraftInvoicePerSubscription)
- [ ] c09 upgrade-activates — expect REDISCOVERED (plan 1's `changePlanOp` superset op on an active sub creates the auto-activated successor → Tier-1 activePaidInFull, and/or the crosscheck collateral seen in slice 2)
- [ ] c10 column-rename — expect REDISCOVERED-LOUD (bind error at campaign start)
- [ ] c11 stale-override — expect REDISCOVERED-LOUD (`no such column: amount` at first scoped observe of an Invoice)
- [ ] c12 proration-total — expect REDISCOVERED (superset changeSeats on an open invoice → Tier-1 totalDueAtMostParts)
- [ ] c13 stale-read-model — expect REDISCOVERED (end-of-sequence crosscheck after any driven settle)

---

### Task 4: Verdict + docs

**Files:** the results doc, `README.md`, `docs/superpowers/specs/2026-07-15-lattice-adversarial-generation-design.md`

- [ ] **Step 1: Verdict section** against design §5, real numbers: criterion 1 (N/13 rediscovered, per-class table, MISSED classes quoted verbatim and marked for the human); criterion 2 (clean-impl probe stats from Task 1 + c04's direct-probe result); criterion 3 (5×200 = 0 FPs); criterion 4 (every failure's seed replay verified during the runs — state it per class; shrunk lengths table); criterion 5 (durations). Kill-criteria assessment. Final paragraph limited to measurements.
- [ ] **Step 2:** README + design status lines (driving validated: N/13 rediscovery, guard probing both directions).
- [ ] **Step 3:** Gates on the work branch (impl + conform suites + tsc) and commit `docs(conform): drive rediscovery verdict — tier-2b criteria` (with trailer).

---

## Self-review checklist (controller, after Task 4)

1. 13 outcomes + control recorded; every MISSED escalated to the human before the verdict is called final.
2. No throwaway `drive/cNN` branches remain (`git branch --list 'drive/c*'` empty); drift evidence branches untouched.
3. Full engine suite once (controller).
4. The driver map's superset section carries `rollover` and `changePlanOp` (plan 1 Task 6) — verify before Task 1's pre-registration commit; if plan 1 somehow landed without them, adding them BEFORE pre-registration is a legitimate completeness fix, after is not.
