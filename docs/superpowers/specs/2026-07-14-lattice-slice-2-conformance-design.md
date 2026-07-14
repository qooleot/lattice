# Lattice — Slice #2 Design: Conformance / Anti-Drift

- **Date:** 2026-07-14
- **Status:** APPROVED design (brainstormed with the human 2026-07-14; all forks below resolved by
  the human). Next step: writing-plans.
- **Brief:** [`2026-07-05-lattice-slice-2-conformance-brief.md`](2026-07-05-lattice-slice-2-conformance-brief.md)
- **Parent design:** [`docs/plan.md`](../../plan.md) — §11.5 (conformance adapter), §11.6 (CI-first
  wedge), §13 (outbox = the conformance interface), §19 Risk 6, §21 step 2.
- **Hypothesis (as re-chosen):** H-conformance — *can code that is NOT purely generated stay
  provably synced to the spec?*

## 0. Thesis and the re-chosen target

The brief's default target was the generated implementation (`generated/subscriptions/`). The human
re-chose fork 1 (2026-07-14): the generated impl is a *seed*, not the target. On purely generated
code, `observe()` is near-identity and the residual adapter is ~zero — the anti-drift thesis is
never stressed. This slice instead builds **an engineer-shaped implementation** — real business
code, hand-maintained from day one, with **no anchored invariant checks of its own** — and a
**target-agnostic conformance harness** that watches it from outside. The slice's claim is
falsified or confirmed by **13 pre-registered drift experiments** (real edits on branches) plus a
**zero-false-positive negative control**.

**How drift is caught, at a high level.** The harness does NOT parse or reverse-engineer the
implementation's TypeScript — static analysis of hand-written code is exactly the brittle,
per-refactor-rotting approach §11.5 rejects. Instead it observes the implementation's **runtime
behavior** through two read-only channels, then checks those observations against the spec:

1. **The outbox event stream.** The impl already writes domain events (`SubscriptionActivated`,
   `InvoicePaid`, …) to its `outbox` table inside each command's transaction — not for the
   harness's benefit, but because the outbox is the service's own integration mechanism (plan §13:
   the outbox IS the public event interface). The harness merely reads that table after the fact.
   Zero instrumentation is added to running code, and the events cannot lie about ordering or
   about surviving a rollback, because they commit (or don't) atomically with the state they
   describe.
2. **Direct state reads via `observe()`.** Events alone are NOT verbose enough for the rich
   problem: only 4 of the 11 spec transitions emit events, and no event carries full aggregate
   state, so an event-only checker would be blind to silent transitions and to state-level
   invariants (`amountPaid <= totalDue`, uniqueness, cross-aggregate agreement). The second
   channel therefore reads the impl's SQLite database directly — at quiescence (test teardown),
   never mid-flight — and projects it into spec-shaped state via an auto-derived, self-checking
   mapping (§4.1–4.3).

Drift is then detected by two checks over those observations: **trace legality** (does the
observed event sequence, anchored by observed initial/final states, correspond to a path the spec
machine allows? — catches skipped/wrong/reordered emits and impossible state histories) and
**invariant evaluation** (do the adopted invariants hold over every observed state? — catches
weakened guards and corrupted state regardless of which code path, spec-known or not, produced
them). Both channels are passive readers of artifacts the impl produces anyway, so the harness
cannot perturb the code under test; and because it checks *behavior* rather than source text, a
refactor that preserves behavior passes untouched while any edit that changes spec-visible
behavior — however it is expressed in code — surfaces as an illegal trace or a violated invariant.

## 1. Fork resolutions (all human-approved 2026-07-14)

| # | Fork | Resolution |
|---|------|-----------|
| 1 | Target | **New engineer-maintained codebase**, seeded from `generated/subscriptions`'s ideas, expanded with real behaviors/parameters/logic. It is the drift target. |
| 1b | Spec↔impl relation | **Superset**: impl covers everything the spec models (11 transitions, 6 invariants, 4 events) AND adds behavior the spec doesn't know. Conformance checks the covered surface and reports honestly what it can't see. |
| 1c | Architecture | **TS + better-sqlite3 + outbox, engineer-shaped**: service classes, its own richer snake_case schema, derived-not-stored values; keeps emitting the spec's domain event names to an outbox. |
| 2 | Checker mechanism | **Pure-TS replay checker** (machine legality + `evaluateCandidate`); no solver in the checking path. ITF/Apalache replay rejected (slow, JVM churn); adversarial command generation deferred. |
| 3 | observe() shape | **Convention-based auto-binding + typed overrides, elicited by need** (see §4). |
| 4 | Drift catalog | **All 12 classes approved** + class 13 (read-model divergence) added with the richer impl scope. |
| 5 | Report→enforce | **CLI report + CI gate + audited opt-outs, PLUS ledger write-back** of findings as a new `conformance` entry kind. |
| 6 | Harness location | **Engine-side `lattice/src/conform/`** + thin per-impl config; CLI `lattice conform`. |
| 7 | Impl scope | **Richer**: payments ledger, dunning scheduler, period rollover, seat-change proration, plan changes (upgrade/downgrade), denormalized account-summary read model. |

## 2. Grounding (state of the repo this design builds on)

- `generated/subscriptions/` exists on main (deterministic codegen; own tsc+vitest gates) — the seed.
- `.lat` is source of truth (`specs/subscriptions/spec.lat`, slice 3); ledger at
  `.lattice-session-subscriptions/ledger.jsonl` (89 entries). Consume the AST via the loader seam
  (`lattice/src/generate/load.ts` pattern), never a file format.
- `TransitionDef` carries `requires` + `emits` (`lattice/src/ast/domain.ts`) — only 4 of 11
  transitions declare `emits`; **7 transitions are silent**. The checker must be honest about this
  (see §5), not blind to it.
- The invariant oracle is `evaluateCandidate` (`lattice/src/engine/evaluate.ts`), already
  differential-tested against the generated checks.

## 3. The target codebase — `implementations/subscriptions/`

Repo-root sibling of `generated/` and `specs/`, own `package.json` + tsc/vitest gates. Written the
way engineers write services, NOT the way the generator writes them:

- **Schema diverges deliberately but plausibly**: snake_case (`subscriptions.lifecycle_state`,
  `seat_count`); `amountPaid` materialized nowhere (= `SUM(invoice_payments.amount)`);
  `retryCount` materialized nowhere (= `COUNT(dunning_attempts)`).
- **Spec-covered core**: all 11 transitions reachable through service methods; the 4 declared
  events emitted to an `outbox` table inside the command's transaction.
- **Superset features** (spec has never heard of them): partial payments via the payments ledger;
  a dunning/retry job; period rollover (close invoice → open next draft); seat-change proration;
  plan upgrade/downgrade; an `account_summary` read model (denormalized — the §11.5 layer-5
  stressor).
- **No anchored checks**: normal input validation only. The conformance harness is what enforces
  the spec — that is the experiment.
- **Its own ordinary test suite** — the states Tier 1 evaluates over.

Built by subagents this slice; hand-maintained thereafter. Drift experiments hand-edit it on
branches/worktrees only; main stays clean.

## 4. The harness — `lattice/src/conform/` (engine-side, target-agnostic)

The impl carries only two small files: `conform.config.ts` (DB location, suite hook wiring,
opt-outs — each opt-out requires a recorded reason and every report prints the registry) and
`conform.overrides.ts` (see below). Components:

**4.1 Binder (`bind.ts`).** Introspects the impl's SQLite schema and auto-binds spec fields to
columns by naming convention (exact, camel↔snake, `subId`→`id` on the owning table). Bindings are
**verified, not trusted**: each must pass type + enum-domain validation against live rows (a
column whose values fall outside the spec enum's domain fails the bind loudly). Coverage is
ternary per field: auto-bound / overridden / **unbound = hard failure** (no silent gaps). The
binding manifest is emitted and committed, so schema movement shows up in diffs.

**4.2 Generated spec-state contract.** A small `generate` extension emits `spec-state.ts` from the
AST: per-aggregate TS types of the spec-shaped state (the shape `evaluateCandidate` consumes),
emitted into the impl's conform directory (committed; refreshed by `lattice conform --contract`).
Regenerating the spec changes this type — a stale override **fails to compile** (§11.5.5 guardrail).

**4.3 observe() runner (`observe.ts`).** Auto-bindings + typed overrides → spec-shaped snapshot.
Overrides are per-field functions typed against the generated contract:

```ts
export const overrides = defineOverrides<SubscriptionsSpec>({
  Subscription: { status: r => STATE_MAP[r.lifecycle_state] },
  Invoice: {
    amountPaid: (db, r) => sumPayments(db, r.id),
    retryCount: (db, r) => countAttempts(db, r.id),
  },
});
```

The overrides file **is the measured residual surface** (plan §21 step 2). Self-checks that keep it
honest, for free: round-trip test (write via impl → read via observe() → spec expectation) and
event↔state cross-validation (an outbox `SubscriptionActivated` whose aggregate observes anything
but `active` is a contradiction — a lying projection fails against the event stream).

**4.4 Trace checker — Tier 2 (`trace.ts`).** Pure TS, deterministic. Per aggregate: given the
observed outbox sequence (rowid order) and the observed initial/final states, **does a legal path
exist through the Machine where declared-emit transitions must align exactly with their events and
silent transitions are free moves?** This single reachability rule catches: skipped emits (a
declared-emit transition cannot be taken silently), wrong event types, emit-without-state-change
(emit outside the tx), terminal-state resurrection (no path out of `canceled`), and impossible
histories. `requires` guards are evaluated wherever the needed pre-state is observable (creation
state, quiescence snapshots); where it is not, the report **says so explicitly** — no silent
coverage claims (§11.6 no-silent-caps).

**4.5 Tier 1 — passive invariant assertions.** A vitest teardown hook in the impl's suite
snapshots via observe() at quiescence and runs `evaluateCandidate` over every adopted invariant.
Report mode first (collect all violations across the suite), then enforce. Invariant state-guards
(`where state status in {...}`) auto-skip mid-construction junk, per plan.

**4.6 Reporter + CLI (`report.ts`, CLI verb `lattice conform --target <dir> [--report|--enforce]`).**
Every violation names: the spec element, its ledger anchors, and a concrete witness (row ids,
event-sequence position, observed vs. allowed). Report mode exits 0; enforce exits non-zero.
Run summaries and violations append to the session ledger as a new **`conformance` entry kind** —
conformance history joins the spec's evidence trail.

## 5. Mapping to plan §11.5's numbered layers (kickoff requirement)

| §11.5 layer | This slice |
|---|---|
| 1. command→entry-point generated | **Not needed in v1** — the harness is passive (observes the impl's own suite and outbox); it never drives commands. Becomes real only with adversarial command generation (deferred, §8). |
| 2. event-layer conformance, no state map | **Tier 2 — the primary check** (§4.4). |
| 3. runtime monitors | Out of scope (later slice); same invariants + observe() graduate with no rework. |
| 4. state read via generated persistence mapping | **Replaced by the binder** (§4.1): this impl's persistence is not generated, so the reverse-read is *derived by convention + validated against live data* instead of generated. This is the slice's main novelty vs. the parent plan, forced by the re-chosen target. |
| 5. residual hand-written adapter | **The overrides file** (§4.3): scoped, typed against the generated contract (compile-breaks on regen), self-checking (round-trip + event↔state cross-validation). Its size is measured and reported. |

## 6. Drift catalog (pre-registered; human-approved; each = one real edit on one branch)

Event layer (Tier 2): **1** skipped emit (`activate` succeeds, append deleted); **2** wrong event
type (`cancel` emits `SubscriptionActivated`); **3** emit outside the transaction (event survives
rollback).
Transition/guard (Tier 2): **4** weakened guard (`activate` without `paidInvoiceCount >= 1` —
expected catch: Tier 1 `activePaidInFull`, and Tier 2 guard-eval where pre-state observable);
**5** illegal transition (win-back: `recover` from `canceled`); **6** state-name drift
(`pastDue` → `delinquent` in code only — caught by enum-domain bind validation).
Invariant (Tier 1): **7** partial write (payment recorded, invoice not settled at
`amountPaid == totalDue`); **8** widened uniqueness (second `draft` invoice per subscription);
**9** cross-aggregate drift (activated while latest invoice unpaid).
Adapter (§11.5.5 guardrails): **10** schema rename (`lifecycle_state` renamed — binder must fail
LOUD, never map garbage); **11** stale override (`invoice_payments` restructured — round-trip /
cross-validation must contradict it).
Superset boundary: **12** out-of-spec feature corrupts covered state (proration writes
`totalDue > licenseFeeAmount + usageAmount`); **13** read-model divergence (`account_summary`
disagrees with base tables on spec-covered fields).

**Negative control:** the unmodified impl passes clean — zero violations.

**Protocol:** every experiment is a branch off main containing exactly the drift edit; the harness
runs for real (never mocked comparisons — the user's durable no-simulation rule); the result
(diagnostic text included) is recorded in the results doc. Expected-catching-tier is pre-registered
above; a class caught by a *different* tier than predicted is a finding to record, not a failure.

## 7. Pre-registered success / kill criteria (human-approved numbers)

1. **Catch 13/13** drift classes, each with a diagnostic naming the violated spec element + ledger
   anchors, locatable by a developer from the message alone. Any structurally uncatchable class is
   reported as a design finding and stops the slice for redesign with the human — never quietly
   re-scoped.
2. **0 false positives** on the clean impl across **3** full harness runs.
3. **Runtime ≤ 60s** for a full `lattice conform` run over the impl suite (CI-tolerable; no
   solvers in the checking path).
4. **Residual surface measured and reported**: fields auto-bound / overridden / uncovered, and the
   overrides line count. **Kill criterion:** if auto-binding covers <50% of spec fields on a
   codebase *designed to be reasonable*, the convention approach is killed, not tuned until it
   passes. Expectation: ≥75% auto-bound; overrides ≈ 3 fields / ~a dozen lines.

## 8. Out of scope (recorded, honest)

Runtime monitors (target ③) and DST (④); quint/Apalache-generated adversarial command sequences
(the checker mechanism deliberately keeps solvers out of the checking path; generation-time use is
a follow-up); multi-language targets; impl-event→spec-event renaming maps (impl emits spec event
names this slice); growing the spec to cover superset features (a future elicitation pass).

## 9. Constraints (inherited, non-negotiable)

- Diagnostics cite spec elements AND ledger anchors; never claim coverage beyond what was checked.
- Drift experiments are real edits to real code on branches; main stays clean; the impl's own gates
  pass except where an experiment intentionally breaks them.
- Engine discipline: TS strict; before every commit `cd lattice && npx tsc --noEmit && npx vitest
  run` (real solvers, serialized); golden traces stay green; assertions never weakened.
- Environment quirks: `ensure-ready.sh` won't refresh stale `node_modules`; golden trace B latency
  is load-sensitive; orphan JVMs accumulate; never `git add -A`; conventional commits; commit doc
  edits immediately.
