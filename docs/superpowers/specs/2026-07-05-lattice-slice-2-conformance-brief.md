# Lattice — Slice #2 Brief: Conformance / Anti-Drift

- **Date:** 2026-07-05
- **Status:** Pre-design brief — NOT an approved design. Brainstorm the forks with the human,
  write the design spec, get approval, then writing-plans. Do not build first.
- **Parent design:** [`docs/plan.md`](../../plan.md) — §11.5 (the conformance adapter: the
  "whole anti-Rebel thesis hangs here" section — read it in full), §11.6 (the CI-first wedge),
  §13 (the outbox event stream IS the conformance interface), §19 Risk 6, §21 step 2.
- **Hypothesis:** H-conformance — *does the spec stay synced to real code?* Slice 1 proved specs
  can be elicited; this slice proves they can't silently rot. The parent plan rates this the
  highest-risk engineering component and the keystone of the product's trust story.

---

## 1. Sequencing context (why this slice runs now, and what it needs)

Conformance was deliberately re-sequenced AFTER spec→implementation generation (2026-07-04–05):
plan §11.5's adapter is *generated-first* — its layers assume generated surfaces exist (command→
entry-point, outbox, persistence mapping). **First action: check the generation slice's status**
(`docs/superpowers/specs/2026-07-05-lattice-generation-slice-brief.md` and whatever design/plan
docs it has produced since; also check slice-3/slice-4 state — the repo has multiple agents in
flight and `main` moves daily).

- **If a generated implementation of `specs/subscriptions/` exists:** it is the target. Its outbox
  and repository read-path were explicitly left as seams for this slice.
- **If generation hasn't landed:** STOP and put the target question to the human before designing
  (the original fork, never fully answered: wait for generation / point at a real existing
  codebase such as the spec-core product if it exists somewhere / other). Do not build a toy
  implementation just to have a target — that was explicitly rejected as grading our own homework
  unless the human re-chooses it.

## 2. What slice 2 builds (the two tiers, per plan §11.6/§11.5)

**Tier 1 — the CI wedge (passive invariant assertions).** Evaluate every adopted invariant over
the states the target's EXISTING test suite already produces, via an `observe()` projection
(near-identity when reading generated repositories). Report mode first (collect violations across
the suite), then enforce. Escape hatches per plan: invariant state-guards auto-skip
mid-construction junk; explicit opt-out requires a recorded reason. Key asset already in hand: the
pure-TS `evaluateCandidate` (`lattice/src/engine/evaluate.ts`) is the invariant oracle — the wedge
is observe() + a teardown hook + the evaluator, not new checking machinery.

**Tier 2 — event-trace conformance (the primary anti-drift check, no state map).** The
implementation's outbox event stream is compared against what the spec allows. Recommended v1
mechanism (fork §4.2): a pure-TS **trace checker** that replays the impl's recorded events and
state snapshots against the machine's transition legality (declared transitions, guards where
slice 4 landed them) plus invariant evaluation at each step — reusing `evaluateCandidate` and the
machine model directly. Apalache/quint enter only for *generating* adversarial command sequences
(stateful-property style), not for checking observed traces — keep the checker deterministic,
fast, and debuggable.

**Explicitly out of scope:** runtime monitors in staging/prod (target ③) and DST (target ④) —
later slices; this slice is design-time + CI conformance (target ② in the plan's taxonomy).

## 3. Validation = pre-registered drift experiments (the heart of the slice)

The slice's claim is falsifiable only via real drift. Pre-register a **drift catalog** — N
deliberate hand-modifications to the target implementation, each a realistic maintenance accident,
e.g.: remove/weaken a guard; skip an outbox emit; emit the wrong event type; reorder emit vs.
commit; violate conservation in an update path (partial write); widen a uniqueness check; change a
state name in code but not spec. For each: the conformance harness must CATCH it with a diagnostic
naming the violated spec element and its ledger anchors. Also the negative control: the
UNMODIFIED implementation passes clean — zero false positives (a wedge that cries wolf gets
reverted; plan §11.6's report-then-enforce exists for exactly this).

Suggested success criteria / kill criteria to pre-register in the design (numbers to be set with
the human): all drift classes in the catalog caught; false-positive count on clean impl = 0;
wedge runtime budget over the generated suite (CI-tolerable); diagnostic quality bar (a developer
can locate the drift from the message alone).

## 4. Forks for brainstorming (one at a time, with the human)

1. **Target confirmation** (§1) — generated impl vs. alternatives; which spec (Subscriptions;
   rev-rec later if its measured run has landed).
2. **Trace-checker mechanism** — pure-TS replay checker (recommended) vs. quint-connect-style ITF
   replay through Apalache. Weigh debuggability and CI speed vs. reuse of solver machinery.
3. **observe() shape** — generic (walk generated repositories) vs. generated-per-spec. Plan
   §11.6's principle: observe at the layer where semantic state already exists; the map is
   elicited by need, not built speculatively.
4. **Drift catalog contents and size** — which classes, how many, who authors them (the human
   should approve the catalog; the agent drafts it).
5. **Report→enforce mechanics** — output format, how violations reference ledger anchors, opt-out
   registry.
6. **Where the harness lives** — inside the generated package's test suite vs. a separate
   `lattice/src/conform/` module invoked against any target. (Lean: the checker is engine-side and
   target-agnostic; the wiring is generated.)

## 5. Constraints binding this slice (inherited, non-negotiable)

- Gate binding: diagnostics cite spec elements AND ledger anchors; nothing claims coverage beyond
  what was checked (report honestly what the wedge does/doesn't see — §11.6's no-silent-caps rule).
- User's durable rule: no simulated validation — drift experiments are real edits to real code,
  caught by really running the harness; never mocked comparisons.
- Engine discipline: TypeScript strict; before every commit `cd lattice && npx tsc --noEmit &&
  npx vitest run` (real solvers, serialized); golden traces stay green, assertions never weakened;
  the target package's own gates must also pass (except where a drift experiment intentionally
  breaks them — keep drift on branches/worktrees, never on main).
- Worktree bootstrap: `bash lattice/scripts/ensure-ready.sh` before first use. Known environment
  quirks: it won't refresh a stale `node_modules` (rm -rf and re-run if imports fail after a
  merge); golden trace B's latency assertion is load-sensitive (don't run heavy parallel work
  during full-suite runs); orphaned solver JVMs can accumulate (check/kill between repeated runs).
- Never `git add -A`; conventional commits; commit doc edits immediately (uncommitted controller
  edits have been lost to concurrent-agent cleanups in this repo before).

## 6. Pointers

- The invariant oracle: `lattice/src/engine/evaluate.ts` (evaluateCandidate; witness/state
  conventions documented in slice-1 design §Task-3 interfaces).
- Spec + evidence to conform against: `specs/subscriptions/` + `.lattice-session-subscriptions/`
  (and the AST loader seam — note `.lat` is becoming source of truth via slice 3; consume the AST,
  not a file format).
- Machine model for trace legality: `lattice/src/ast/domain.ts` (Machine/TransitionDef — check
  whether slice 4's `requires`/`emits` enrichment has landed and use it if so).
- The parent plan's §11.5 numbered layers — the design should explicitly say which layers this
  slice implements (expect: 1 via generation, 2 as Tier 2, 5 only if a residual map proves
  necessary — measure and REPORT the residual surface; plan §21 step 2 asks for exactly that
  measurement).
