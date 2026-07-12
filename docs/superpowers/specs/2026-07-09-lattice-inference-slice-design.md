# Lattice — Inference Slice Design: Entailment, Guard Analysis & CTI

- **Date:** 2026-07-09
- **Status:** Approved design (brainstormed with the human 2026-07-09; all seven brief forks below
  are marked DECIDED). **Implementation is GATED on the generation slice landing** (fork 7) — the
  design is complete and ready; coding waits until generation finishes and we can rebase onto
  whatever it touched in the shared files (`cli.ts`, `session.ts`).
- **Brief:** [`2026-07-08-lattice-inference-slice-brief.md`](2026-07-08-lattice-inference-slice-brief.md)
- **Parent design:** [`docs/plan.md`](../../plan.md) — §9.1 (mypyvy-style inference, CTI, the
  entailment classifier), §14 (race/crash analysis the guards feed), §15 (decidability discipline),
  §16 (the question-minimizing conversation).
- **Predecessor:** [`2026-07-07-lattice-slice-4-grammar-machine-growth-design.md`](2026-07-07-lattice-slice-4-grammar-machine-growth-design.md)
  §3.3/§3.4/§5.2.1/§11 (honest-ceiling text this slice extends, never contradicts) and its §11.1
  deferred-work registry (three rows resolve INTO this slice).
- **Evidence:** the committed Subscriptions spec (`specs/subscriptions/spec.lat`, guards + coupling
  invariants, ledger entries #80–87), golden trace D, and a live feasibility spike run during
  brainstorming (2026-07-09) — see §2.

---

## 1. Summary

Slice 4 grew the machine's **structure** (guards, coupling invariants, `emits`, services). This
slice makes the solvers **reason about** that structure. Three pillars:

- **A — entailment classifier.** For each adopted invariant, label it **entailed** / **independent**
  / **violated** against the machine's guards + transition structure, via real Apalache induction.
- **B — guard analysis.** Stuck-state detection (annotation-gated) and reachability of guarded
  states.
- **C — CTI-guided strengthening.** Counterexamples-to-induction become guard proposals, elicited
  through **first-class guard candidates with solver-first auto-pruning**.

Plus method⊨transition entailment (a `performs` method whose `requires` is weaker/stronger than its
transition's guard) and **abstract-evolution modeling**: giving `@balance`/`@total`/counter fields a
sound over-approximate evolution shape so C is honest and non-trivial over *data*, not just
lifecycle states.

The slice adds **analysis and one modeling refinement, not surface syntax** — the closed grammar
stays closed (see §9 for the one ceremony flag).

## 2. Context that changed since the brief — the feasibility spike (2026-07-09)

The brief's fork 2 said "verify with a spike before designing" whether the adapter can run
Apalache's induction mode. The spike was run during brainstorming and **resolved the fork
favorably**:

- `quint verify` in this repo (Quint **0.26.0**) already exposes **`--inductive-invariant`**, plus
  `--init`, `--step`, `--invariant`. This is real Apalache 1-step induction (checks `init ⇒ Inv`
  **and** `Inv ∧ step ⇒ Inv′`) delivered through the Quint path lattice already uses.
- No standalone Apalache is needed: Quint auto-manages Apalache **0.47.2**; Java 25 is present (the
  JVM the Apalache server runs on).

**Consequence:** "Apalache-induction throughout" (fork 2) is a *modest extension* of the existing
`quint-adapter.ts`, **not** a new direct-Apalache adapter or a new solver dependency. This is the
central de-risk of the slice.

**Still spike-gated at implementation time (plan step 1):** an actual induction round-trip on the
committed Subscriptions spec, to confirm `--inductive-invariant` behaves over our *emitted shape*
(frozen data, owned collections, refs). Everything below rests on that behaving.

### 2.1 Generation reconciliation (added 2026-07-09, after generation merged to `main`)

The generation slice merged to `main` and this branch was rebased onto it. Generation's footprint is
almost entirely disjoint: it lives in new dirs (`lattice/src/generate/`, `generated/`) and touches
`src/cli.ts` by only +10 lines (an additive `generate` case). **None** of this slice's core files —
`session.ts`, `emit/quint.ts`, `hypothesis.ts`, `planner.ts`, `quint-adapter.ts` — were modified.
So fork 7's shared-file collision worry largely evaporated. Three concrete reconciliations:

- **The §3.7 coupling is confirmed, not hypothetical.** Generation compiles transition guards into
  runtime preconditions: `render/commands.ts` reads `t.requires`, renders it via `predToTs`, and
  emits `if (!(<guard>)) throw { rejected: '<t>: requires guard failed', anchors: t.anchors.provenance }`.
  So a guard this slice adopts is real enforced code downstream, and a guard/invariant contradiction
  Pillar A reveals *is* inherited by generated code. **Design refinement (§8):** guard adoption must
  set the transition's `requires` **and** carry provenance anchors, because generation surfaces
  `t.anchors.provenance` in both compiled comments and rejection payloads. The `classified` ledger
  entry's `pinnedBy`/`provenance` (§7.1) feed this.
- **Abstract-evolution never touches the evaluator.** §6's abstract steps are a Quint-*emission*
  concern; `src/engine/evaluate.ts` (the model-free oracle over concrete witnesses) is unchanged.
  Generation's `differential.test.ts` asserts generated invariant checks agree with that oracle —
  so it stays green. **DoD invariant (§12):** abstract-evolution changes emission only; `evaluate.ts`
  and the generation differential test are untouched.
- **Reuse the loader seam & additive dispatch.** Generation added `loadGenInput` over
  `loadState`/`readLedger` (`session.ts`); the classifier reads the same `s.model` + adopted
  candidates and should reuse `loadState`. The `classified` ledger kind is append-only/additive —
  generation's `GenInput.ledger` consumption reads only the kinds it needs and ignores the rest.

## 3. Decisions (locked with the human, 2026-07-09)

### 3.1 Scope = A + B + C (brief fork 1) — DECIDED

Full slice: all three pillars, plus method⊨transition and abstract-evolution modeling. This is a
large slice; it ships as **small sequenced PRs** (§12), but the design is one coherent unit because
the pillars share machinery (C's pruning reuses A's induction queries; B's stuck-state reuses the
reachability shape).

### 3.2 Query encoding = 1-step induction via a havoc-init harness (brief fork 2) — DECIDED, mechanism refined by the spike

The human's decision is real 1-step induction (not bounded-from-init reachability). The Task-1 spike
(2026-07-09, [`2026-07-09-inference-spike-notes.md`](2026-07-09-inference-spike-notes.md)) established
that the `quint verify --inductive-invariant` **flag is unusable on our emitted machine** (its Phase 1
rejects the emitter's permissive nondet `init`; its Phase 2 cannot bind the map/record state). The
working, validated mechanism delivers the *same* semantics by hand:

- Emit a **havoc `--init indInit` action** that assigns *and* havocs every state variable over its
  domain and asserts the induction hypothesis, then `quint verify --init indInit --invariant I
  --max-steps 1`. This is genuine consecution-from-an-arbitrary-state — real induction, just encoded
  through `--init` instead of the flag.
- **Reachability** (the escalation probe of §5) reuses the *existing* bounded `runQuint` from the real
  `init`.

So "induction throughout" stands; only the flag changes. See §4.1/§5 for the mechanism and §2.1-adjacent
spike notes for the raw evidence.

### 3.3 Frozen-data honesty = abstract-evolution over-approximation (brief fork 4) — DECIDED

The brief's fork 4 offered classify-with-caveat / refuse / structural-gate. We chose a **fourth
option surfaced in brainstorming**: instead of *refusing* data-evolving invariants, model the
evolution **abstractly** as a sound over-approximation and classify them. Full treatment in §6.

### 3.4 Guard machinery = first-class candidates + solver-first auto-pruning (brief fork 5) — DECIDED

Guards proposed by C (or flagged by B) are **first-class candidate objects** run through the same
distinguish/prune loop invariants use, but with a **solver-first pruning layer** that eliminates
variants automatically (using A's induction queries) so the user is asked only the irreducible,
genuinely-ambiguous boundary questions. Full treatment in §8. This is the correctness-and-
question-minimization win: robustness from the first-class substrate, tightness from letting the
solver decide everything it can.

### 3.5 Label timing = on every apply, incremental (brief fork 3) — DECIDED

Classification recomputes on **every `apply`** so labels are always fresh. To keep the load-sensitive
Apalache path off the critical loop, recomputation is **incremental**: only labels whose
dependencies (the changed invariant/guard/field and anything that references them) are recomputed;
unaffected labels are carried forward. Full treatment in §7.

### 3.6 Stuck-state semantics = annotation-gated question (brief fork 6) — DECIDED

A reachable state with no enabled out-transition is filtered by lifecycle annotations: `@terminal`
stuck → silent (intended); non-terminal stuck → a **boundary question** ("reachable with no way out
— intended wait/terminal state, or missing transition / over-strong guard?"). Never a hard error —
legitimate wait states (awaiting an external event) exist. Full treatment in §7.3.

### 3.7 Sequencing = generation-first (brief fork 7) — DECIDED

The generation slice is **in progress**. This slice waits until it lands. The design is captured now
while fresh; implementation begins after generation completes, rebasing onto its changes to the
shared files. Rationale: generation compiles guards into precondition checks, so it would inherit
any guard/invariant contradiction this slice reveals — but the human's call is to let the in-flight
work finish rather than interleave.

## 4. Solver adapter & emitter changes

### 4.1 `src/solvers/quint-adapter.ts` — custom-`--init` verify

Generalize the adapter to run `quint verify` with a **custom `--init` action name**, a chosen
`--invariant`, and `--max-steps` (the spike showed `--inductive-invariant` itself is unusable here —
§3.2). Concretely: extract a shared spawn/retry/port core, keep `runQuint(em, maxSteps)` (bounded,
default `init`/invariant) as the reachability primitive, and add `runQuintVerify(em, { init?,
invariant?, maxSteps })` for the consecution/entailment probes. The result surface is unchanged
`{ violated, witness, ms }`; the spike confirmed a **consecution CTI writes an ITF and exits non-zero**,
so violation detection reuses `runQuint`'s exact `exit != 0 && existsSync(itf)` path — no new branch.
Honor the existing per-call ephemeral-port isolation and the orphan-JVM / load-sensitive-latency
quirks (golden trace B) — induction probes spawn a JVM each; budget generous timeouts in tests.

### 4.2 `src/emit/quint.ts` — new query shapes + abstract-evolution steps

- **Classification query (A):** emit with `adoptedAll = {guards + all *other* adopted invariants}`
  and the invariant-under-test `I` as the inductive-invariant goal. The under-test invariant is
  **excluded** from the assumptions (using it would be circular); `adoptedAll` already models this
  exclusion cleanly.
- **Abstract-evolution steps (§6):** for `@balance`/`@total`/counter fields, add the corresponding
  nondeterministic data-step to the emitted `step` action.
- **Guard-variant queries (§8):** "under guard-variant H, is transition T enabled in this state?"
  and "does adopting H contradict `adoptedAll`?" — reusing the induction/reachability adapter.

Guards already encode as action conjuncts (`all { fromChk, guard }`, commit `7cb8e12`); the new
work is emitting *candidate* guards and the abstract steps, not re-plumbing existing guards.

## 5. Pillar A — the entailment classifier

For each adopted invariant `I`, classify it with **two probes: consecution + reachability-from-real-init**
(fork-1 label decision "Option 3" as corrected 2026-07-10 by the Plan-2b Task-1 finding — see the
correction note below). Both probes assume the machine's guards + all *other* adopted invariants
(`peers`) — never `I` itself (circular).

**Why reachability, not a 0-step entailment probe (the correction).** A first attempt used a second
havoc probe at `--max-steps 0` to check "is `I` implied by `peers`?". That is **structurally blind to
guards**: the havoc `indInit` draws region states *arbitrarily* (e.g. straight into `settlement=paid`)
and takes **no `step`**, but transition guards only fire *inside* `step`. So a 0-step havoc probe can
fabricate a `paid` invoice with `amountPaid≠totalDue` that no guard-respecting run reaches, and
mislabels the guard-forced `paid`-conjunct as `independent`. "Forced by the guards" instead means
**`¬I` is unreachable from the *real* `init`** — and the real `init` sets region states to their
`@initial` literal (`draft`), so `paid` is reachable *only* via the guarded `settle`. Reachability from
the real `init` is therefore the correct discriminator.

**The two probes (both run at classify time — same 2-call cost as the earlier base):**

- **Probe 1 — consecution (inductive?):** havoc-`indInit` asserting `peers ∧ I`, `--init indInit
  --invariant q_I --max-steps 1`. *Holds* ⇒ `I` is 1-step inductive; *fails* ⇒ not inductive (the CTI
  names the step that breaks it — Pillar C's input).
- **Probe 2 — reachability (`¬I` reachable from real init?):** `--init init --invariant q_peersImpliesI
  --max-steps N` (bounded). A violation ⇒ a peer-consistent state violating `I` is reachable.

**Labels (from the two probe results):**

- **`¬I` reachable** → **violated** (the machine's own transitions reach a state breaking `I` — a real
  gap; the reachable witness is attached). Plan §9.1's "forgot a guard?".
- **`¬I` unreachable (to bound `N`) *and* inductive** → **entailed** — the guards force `I`; it is a
  redundant **regression anchor**, never auto-deleted (slice-4 §11). This is the `settle`-guard case:
  `paid ⇒ amountPaid == totalDue`.
- **`¬I` unreachable (to bound `N`) *and* not inductive** → **independent** — holds on every reachable
  state within `N` but is not 1-step inductive: load-bearing/fragile, no guard enforces it (the CTI is
  unreachable within the bound). Carries the consecution CTI for context.

The reachability bound `N` makes *violated*/*entailed* sound up to depth `N`; consecution supplies the
unbounded inductive argument for *entailed*. `not-inductive` is no longer a standalone verdict — it
folds into *independent* (holds-reachably-but-not-inductive); the `classified` ledger enum retains the
string for forward-compatibility but the classifier emits *entailed*/*independent*/*violated*.

> **Correction to an earlier assumption.** The committed coupling invariants are **not** guard-enforced.
> `activePaidInFull` classifies **violated** — `recover`/`activate` reach `active` with an unpaid
> `latestInvoice`, a reachable counterexample. That the machine's own transitions can violate an adopted
> invariant is a genuine finding this slice surfaces — a missing guard or intended-pending-guards,
> resolved by the human.

Output is a per-invariant (per-conjunct, §6.4) label with provenance; **never silent deletion**, even
for *entailed*.

**Method⊨transition entailment.** A `performs` method's `requires` is checked against its
transition's guard as a pure entailment query, treating method params as universally quantified
(`∀ delta: methodReq(delta, state) ⇒ transitionGuard(state)` — linear, decidable, slice-4 §5.2.1
own-scalar discipline extended with params). A method weaker than its guard advertises calls that
will always be rejected (flag); stronger silently narrows the API (flag). On the committed spec,
`SubscriptionService.activate` has no `requires` while `activate` requires `paidInvoiceCount >= 1`
→ the "method weaker than guard" flag is the worked example.

Output is a per-invariant (per-conjunct, §6.4) label with provenance; **never silent deletion**, even
for *entailed*.

**Method⊨transition entailment.** A `performs` method's `requires` is checked against its
transition's guard as a pure entailment query, treating method params as universally quantified
(`∀ delta: methodReq(delta, state) ⇒ transitionGuard(state)` — linear, decidable, slice-4 §5.2.1
own-scalar discipline extended with params). A method weaker than its guard advertises calls that
will always be rejected (flag); stronger silently narrows the API (flag). On the committed spec,
`SubscriptionService.activate` has no `requires` while `activate` requires `paidInvoiceCount >= 1`
→ the "method weaker than guard" flag is the worked example.

## 6. Abstract-evolution modeling (the fidelity refinement)

### 6.1 The problem

Data fields are init-nondeterministic and **frozen** in Quint traces (slice-4 §3.4); only
region/enum states step. So consecution `Inv ∧ step ⇒ Inv′` **cannot see data mutation** — any
data-only fact is trivially preserved because nothing moves it. Reporting such an invariant
"inductive/holds" is an **overclaim**: it holds only because the model omits the very dynamics
(payment accrual, usage accrual) that could falsify it. Example: `amountPaid <= totalDue` "holds"
trivially under frozen data, but exists precisely to constrain the accrual the model doesn't
simulate.

### 6.2 The refinement — model the *shape* of change, not the *rule*

Give `@balance`/`@total`/counter fields a sound over-approximate evolution step in `step`:

- **`@balance`** (`amountPaid`) and **documented accumulators / counters** (`accruedUnits`,
  `retryCount`, `paidInvoiceCount`) → **monotone-up**: may increase by an arbitrary non-negative
  amount while the aggregate is non-terminal.
- **`@total`** (`totalDue`, `licenseFeeAmount`, `usageAmount`) → **set-once**: nondeterministic
  until the aggregate is finalized, frozen thereafter.

These are **unconditional** abstract steps — no event, no "by how much." That is the line that
keeps this *out* of the effects language: **transition-conditioned** data changes ("resets to 0 *at
rollover*", "increases *by* the event amount") are effects and stay out of scope (slice-4 §3.4).

> **Resolved rule (implemented, §6.4):** the per-tag shapes above (`@balance`/counter monotone-up
> vs `@total` set-once) motivated the design but the *implemented* rule is the coarser, uniform one:
> **every non-`const` `Int`/`Money` field is monotone-up.** `@total`'s set-once nuance is subsumed by
> monotone-up (a sound over-approximation of "set once then frozen"); precise set-once would need
> effects. Only `Int`/`Money` evolve (D2) and `const` fields (Plan 3a) are frozen.

### 6.3 Why this is honest — the direction of error

Abstract accrual admits *strictly more* behaviors than reality (real payments are a subset of
"arbitrary non-negative increases"). Therefore:

| Model | Behaviors vs reality | "holds" verdict | "fails" verdict |
|---|---|---|---|
| Frozen data (today) | fewer (data can't move) | **untrustworthy** (false confidence) | trustworthy |
| Abstract accrual (this slice) | superset | **trustworthy** | *possible* (may be a false alarm) |

Frozen data errs toward **false confidence** — the overclaim the fidelity gate exists to prevent.
Abstract accrual errs toward **false alarms** — a verifier's safe failure. So **caveats attach to
*violations*** ("abstract over-approximation; the real payment rule may rule this out"), while
**holds are trustworthy**. This is a sound over-approximation, not a simulation — it claims nothing
about the actual payment logic.

Re-run of the examples under abstract accrual:

- `amountPaid <= totalDue`: `amountPaid` can climb past `totalDue` while `open` → induction finds a
  CTI → **violable: no guard prevents overpayment during accrual** (the truth, and the input C
  strengthens from).
- `accruedUnits >= 0`: monotone-up from a `≥ 0` init → preserved every step → **entailed**, and
  trustworthy (reset-to-0, unmodeled, also preserves `≥ 0`). We got the right answer *without*
  modeling the reset.

### 6.4 The structural gate & per-conjunct classification

A static walk over the candidate AST (the `{"kind":"field","path":[...]}` nodes) classifies each
referenced fact:

- **region/`inState` predicate, or a reference only to non-evolving fields** (refs, enums, `const`
  fields, `Date`/`Duration`) → **`sound` tier** (decided soundly by the frozen model; no caveat).
- **a reference to an *evolving* field** → **`abstract` tier**. The evolution model gives every
  **non-`const` `Int`/`Money`** field an abstract monotone-up step (may increase by an arbitrary
  non-negative amount while the aggregate is non-terminal); `const` fields (Plan 3a) and every
  non-`Int`/`Money` field (`Date`/`Duration`, refs, enums) stay **frozen**. **The tier is aligned to
  exactly this evolving set (D1):** a conjunct is `abstract` iff it references a field the model
  actually evolves — a single predicate (`isEvolvingField`) is the shared source of truth for both
  the emitted `evolve_` actions and the gate, so a violated *structural* conjunct (e.g. `unique … by
  [<ref>]`, an enum comparison) is **`sound`** and is *not* mislabeled with an accrual caveat. A
  conjunct that references an evolving field rests on the over-approximation, so its **`violated`**
  verdict carries the over-approximation caveat, while its `entailed`/`independent` verdicts are
  trustworthy (a hold survives arbitrary accrual) and carry no caveat. (**D2:** the evolving set is
  `Int`/`Money` only — temporal fields do not take arbitrary steps independent of `now`/`tick`.)

**Classification is per-conjunct, not per-invariant.** `neverOverpaidAndPaidExact` splits into two
conjuncts that share the `abstract` tier (both reference data fields) but land on opposite verdicts:
`paid ⇒ amountPaid == totalDue` is pinned to `settle`'s guard → **entailed** (a hold under arbitrary
accrual → no caveat), while `amountPaid <= totalDue` is not guard-forced → the abstract monotone-up
step drives `amountPaid` past `totalDue` → **violated** with the over-approximation caveat. The
classifier reports at conjunct granularity.

**Tightening knob (also cuts questions):** emit *other* adopted invariants and adopted guards as
assumptions alongside the abstract step, so the over-approximation is no looser than necessary —
fewer spurious CTIs → fewer false boundary questions. Never the invariant-under-test (circular).

## 7. Labels, ledger & CLI

### 7.1 The `classified` ledger entry (fork 3)

A new **append-only** ledger kind:

```
{ kind: 'classified', at, invariant: <name/id>, conjunct?: <index/path>,
  verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated',
  tier: 'sound' | 'abstract',           // from the §6.4 gate
  caveat?: <string>,                     // present for abstract-tier findings
  witness?: <CaseState>,                 // the CTI, for not-inductive/violated
  reachable?: <boolean>,                 // set by escalation: true ⇒ promoted to violated
  pinnedBy?: [<invariant names>],        // what forced an entailed/auto-adopted verdict
  provenance: <string> }
```

Append-only and canonical (slice-4 doctrine); labels are ledger facts, never silent state
mutations. An *entailed* invariant is never auto-deleted.

### 7.2 Incremental recompute on apply (fork 3)

On each `apply`, build the dependency set of the change (the touched invariant/guard/field + any
invariant or guard whose body/scope references it) and recompute only those labels; carry the rest
forward. This preserves always-fresh labels while keeping full Apalache sweeps off the interactive
path. A `--no-classify` escape hatch on `apply` is provided for batch/replay scenarios.

### 7.3 Guard analysis (Pillar B)

Two analyses over the transition machine, both **findings** (never hard errors, fork 6): surfaced by
the solver-heavy `classify` command, persisted to the ledger, counted in `status`, detailed in
`explain`. Both reuse the existing reachability-from-real-`init` probe — no new solver-adapter work.

**Strategy — structural pre-filter, then solver on the residual (decided 2026-07-11).** A purely
*structural* check disposes of the easy majority for free; the solver is reserved for the genuinely
hard residual and for all reachability. The payoff is concrete on the committed `subscriptions`
spec: **every non-terminal state already has an unguarded escape** — `trialing` (`expireTrial`,
`cancel`), `active` (`paymentFailed`, `cancel`), `pastDue` (`recover`, `cancel`, `dunningExhausted`),
`draft` (`voidDraft`), `open` (`voidOpen`, `writeOff`) — so the structural filter clears the entire
model with **zero solver calls**. A solver probe earns its keep only on a state whose out-transitions
are *all* guarded (the residual). The alternative — a **pure per-state solver sweep** — is simpler
and uniform (always yields a witness), but spends ~N solver calls (~15 s each) per run even when the
answer is structurally obvious, which is unacceptable on the load-sensitive golden/apply budget. The
hybrid also matches the slice's question-minimization / solver-first-pruning theme (§8.2).

**7.3.1 Stuck-state.** A state `S` is *stuck* when its every out-transition is guarded-false.
- **Structural filter (no solver):** if any out-transition from `S` is *unguarded*, `S` is never
  stuck — drop it. Only states whose out-transitions are *all* guarded (or which have *no*
  out-transition — the terminal shape) survive to the solver.
- **Solver confirm (residual only):** is a config with an instance in `S` and every out-guard false
  *reachable* from real `init`? Assert `¬stuck_O_r_S` as the invariant; a **violation ⇒ reachable
  stuck state**, and the CTI trace is the "blocking valuation" the finding names.
- **Annotation gating:** `@terminal` stuck → silent (expected). Non-terminal stuck → a finding
  naming the state and the blocking valuation.
- *Worked residual example:* if `voidOpen`/`writeOff` were removed, `open`'s only exit is the guarded
  `settle` (`amountPaid == totalDue`). The structural filter flags `open`; the solver then confirms a
  reachable `open` invoice with `amountPaid ≠ totalDue` and hands back that concrete record — the
  actionable boundary question a structural check alone cannot produce.

**7.3.2 Guarded-state reachability.** For each state reached only through guarded transitions, is it
still reachable once the guards compose? Assert `¬reach_O_r_S`; here a **"holds" verdict ⇒ `S`
unreachable within `N`** (a dead transition / over-strong guard, carrying the bounded-`N` caveat),
while a violation ⇒ reachable (fine).
- *Worked example:* `active` is entered only via `activate` (`requires paidInvoiceCount >= 1`).
  Whether `active` is reachable turns on whether `paidInvoiceCount` can climb to `1` — a
  satisfiability-over-the-reachable-range question the structural filter cannot answer but a solver
  probe settles. (And the answer depends on the machine choice below.)

**7.3.3 Which machine — frozen vs abstract-evolution (§6).** The choice materially changes answers,
so it is called out rather than assumed:
- On the **frozen** machine, fields cannot move, so reachability *under-approximates* (e.g. `active`
  looks unreachable unless `init` happens to draw `paidInvoiceCount ≥ 1`) → many **false**
  dead-transition alarms; and stuck-state *over-approximates* (flags a state as stuck whenever the
  fields it needs can't move) → noisier but safe.
- On the **abstract-evolution** machine (the same one Pillar A's classifier runs on), accrual can
  satisfy numeric guards, so reachability has *far fewer false positives* (a state still flagged
  unreachable *even granting arbitrary accrual* is genuinely suspect — an over-strong guard), and a
  stuck-state flag means "stuck *even under generous accrual*" — i.e. escapable only by an *event*
  the model doesn't have. **Decision: run both analyses on the abstract-evolution machine** — for
  consistency with the classifier and because it yields high-confidence, low-false-positive findings.
  Its blind spot (a state escapable only via accrual the *real* rule wouldn't actually produce) is a
  documented honest-ceiling item (§10), not silently assumed. *Illustration:* in the residual `open`
  example above, the frozen machine calls `open` stuck (`amountPaid` frozen ≠ `totalDue`); the
  abstract-evolution machine does **not** (accrual drives `amountPaid` to `totalDue`, `settle` fires)
  — the honest reading is "not stuck under the modeled accrual; a payment *event* is what unsticks
  it," so we do not spam the author with a stuck finding for the ordinary unpaid-invoice case.

**7.3.4 Encoding — `astToQuintGuard`.** A thin emitter twin (mirroring `astToQuintClassify`): take
the base `astToQuint` machine's `head` (module through the `step` line, `abstractEvolution: true`),
append the `stuck_O_r_S` / `reach_O_r_S` `val` definitions for the states under analysis, and name
the negated predicate as the `--invariant`, run from real `init` at `--max-steps N`. No new query
`kind`; no change to the golden/unflagged emission.

**7.3.5 Surface — ledger + CLI.** A new append-only `guard-finding` ledger entry (state, kind =
`stuck` | `unreachable`, blocking valuation / witness, provenance) so the read-only `status` can
report outstanding counts without a solver run, and `explain` can render a state's finding detail.
`classify` (the solver-heavy command) computes and appends them, alongside the invariant
classifications and method-guard checks.

### 7.4 CLI rendering

- `engine status` — classification summary (counts: N entailed / M independent / K violated; plus
  guard-analysis warnings/questions outstanding).
- `engine explain <inv>` — full per-invariant story: verdict, tier, caveat, the CTI witness (for
  violated), and `pinnedBy` provenance. Extends the existing `explain` narrative (provenance +
  elicitation chain), does not replace it.

## 8. Pillar C + first-class guard candidates (fork 5)

### 8.1 Guard candidates as a Candidate kind

A guard is **not** an invariant — it is an enabling condition evaluated on a transition's pre-state
with own-field-only scope (slice-4 §5.2.1), conjoined into the action. The new `guard` Candidate
kind carries the predicate **and** its transition context, and its evaluator/emitter treat it as a
transition-enablement condition, **not** an always-property. This boundary is explicit to avoid the
abstraction-leak risk of widening the invariant `Candidate` union past its contract (salient
extraction and masking logic must not assume always-property semantics for guards).

### 8.2 Solver-first auto-pruning (the question-minimization mechanism)

When C surfaces a CTI (or B a boundary), for the relevant transition:

1. **Generate** the guard-variant family over own-field predicates (the shape lattice — the
   rebuilders; e.g. for the overpayment boundary: `== totalDue`, `>= totalDue`, `<= totalDue`).
2. **Auto-prune with A's induction queries — no user input** — dropping variants that are
   (a) inconsistent with adopted invariants, (b) don't close the CTI, or (c) equivalent to a
   survivor over all reachable states.
3. **Resolve:**
   - **1 survivor** → auto-adopt; ledger-note it as pinned (`pinnedBy`). *Zero questions.*
   - **0 survivors** → surface a real inconsistency ("the needed guard contradicts invariant X") —
     a finding, not a question.
   - **≥2 survivors** → one distinguish question **per genuinely-separating reachable witness**, and
     only those (the existing planner distinguish/probe loop).

Worked example (the fork-5 payoff): the overpayment CTI generates `==` / `>=` / `<=`; the adopted
`neverOverpaidAndPaidExact` (`paid ⇒ exact`) prunes `>=` and `<=` (both reach `paid` with
`amountPaid ≠ totalDue`, violating it); `==` is the lone survivor → **auto-adopted with zero user
questions**. Probe would have asked one (possibly wrong-shaped) question; naive first-class would
have asked two.

### 8.3 The loop quiets over time

Adopted guards feed back as assumptions (§6.4 tightening knob), so each adopted guard prunes more of
the next CTI's variant space. The elicitation loop gets *quieter* as the spec fills in, rather than
re-asking.

### 8.4 Masking coverage

Because guards live in the candidate substrate, the masking-regression machinery (the five-bug
family) covers them: a newly-adopted guard that makes an existing invariant entailed-by-accident is
detected, not silent. This is the correctness reason for first-class over probe (which would have
re-opened masking blindness for guards).

## 9. Closed-grammar ceremony (flag for the review pass)

Pillars A/B/C add **analysis**, not surface syntax — the closed grammar stays closed. As landed
(D1/D2), abstract-evolution keys off **field *type* (`Int`/`Money`) and the `const` modifier**, not
off the `@balance`/`@total` annotations — so no existing annotation gained a new solver semantics.
The one deliberate grammar act was the **`const` keyword itself (Plan 3a)**, which *did* go through
the full versioned-grammar ceremony (`.langium` + reserved word + lockstep projections + committed-
spec migration). The abstract-evolution emitter change is otherwise a pure emitter/semantics change
documented in `docs/language/*.md`. Flagged, not silently assumed.

## 10. Honest ceiling (what this slice does NOT claim)

- **~~Pre-Plan-3 data-field soundness is provisional.~~ (RETIRED — superseded by the §6.4 structural
  gate, Plan 3.)** This slice originally attached a blanket provisional `caveat` to every
  `entailed`/`independent` data-field verdict, on the grounds that pre-abstract-evolution soundness
  rested only on bounded `INT_POOL` sampling. Plan 3 landed abstract-evolution modeling and the
  per-conjunct structural gate, so that provisional caveat is **removed**: the caveat now attaches to
  the correct direction — **`abstract`-tier `violated` findings** (the over-approximation's one safe
  false-alarm direction, per §6.3) — and `entailed`/`independent` holds are trustworthy and
  uncaveated. See the "Abstract accrual over-approximates" bullet below for the current rule.
- **Equal-records slice.** The classifier's havoc-init (`astToQuintClassify`, `mapBy`) binds every
  instance of an aggregate to an *identical* drawn record, so the consecution probe checks induction
  over the "all-instances-of-an-aggregate-equal" slice of the state space, not the full state space.
  `entailed`/`independent`/`violated` are sound **over that slice**; a per-verdict note records this.
- **Reachability is bounded to depth `N`.** *violated* (a reachable `¬I`) and *entailed* (`¬I`
  unreachable) are sound only up to the reachability bound `N`; a deeper counterexample could exist
  beyond `N`. Consecution (inductive) supplies the unbounded argument for *entailed*; a labelled
  *entailed* means "inductive **and** no shallow (≤N) reachable violation."
- **Auto-reclassify-on-apply covers invariant-body changes only.** The apply-time hook (§7.2)
  reclassifies invariants whose *body* changed/was added; a **guard-only edit** on an existing
  transition produces no invariant diff, so it does **not** refresh labels — cached verdicts can go
  stale until an explicit `classify` (whose verdict is always freshly computed). Follow-up: a cheap
  guard-before/after check could emit a "classifications may be stale" warning on such an apply, and
  newly-materialized `implied-` invariants are likewise only classified on explicit `classify`.
- **Induction is 1-step and bounded by the emitted model.** It proves inductiveness relative to the
  machine-as-modeled, not full temporal correctness.
- **Abstract accrual over-approximates.** A "violated" verdict on an abstract-tier conjunct may be a
  false alarm the real (unmodeled) payment/usage logic would rule out — this is stated in the caveat
  on every such verdict. "Holds/entailed" verdicts are trustworthy; "violated" ones are
  "possible — confirm or add a guard."
- **No effects language.** Transition-conditioned data changes (resets, exact-amount updates) remain
  unmodeled (slice-4 §3.4). Abstract-evolution models field *shape*, not effect *rules*.
- **Guards read own scalars only** (slice-4 §5.2.1); method `requires` may carry params (universally
  quantified). No cross-aggregate guards, no latest-of-list selectors (their own grammar-growth
  rows).
- **Spurious-CTI discipline:** C presents abstract-tier strengthenings as "the model permits this;
  add a guard or tell me it's impossible," never as a confirmed bug.
- **Guard analysis (Pillar B) is bounded and machine-relative.** Both analyses run on the
  abstract-evolution machine (§7.3.3) at reachability depth `N`. A guarded state's *unreachable*
  finding is sound only to depth `N` (it could be reachable via a longer trace); a *stuck-state*
  finding means "stuck even under generous accrual" — its blind spot is a state escapable only by
  accrual the real update rule would not actually produce (which the frozen machine would flag but
  the abstract one does not). Findings are boundary *questions*, never hard errors. The structural
  pre-filter's soundness rests on "an unguarded out-transition is always fireable," which holds by
  construction (an unguarded transition's only precondition is the `from`-state it already occupies).

## 11. Deferred-work registry (every ceiling item has an address)

| Deferred item | Trigger to build it | Owner slice |
|---|---|---|
| Effects / `do` language (transition-conditioned data mutation; reset-at-rollover; by-event-amount) | generation demands effects | generation / a future effects slice |
| Full multi-step / temporal induction (beyond 1-step) | a property needs it and 1-step is insufficient | future inference follow-up |
| Cross-aggregate guards; latest-of-list selectors | grammar-growth rows with their own triggers | grammar-growth |
| `emits` trace semantics | conformance slice | conformance |
| Distinguishing-question tuning for guard variants beyond own-scalar shapes | guard elicitation proves it needed | this slice's follow-up |

Updates slice-4 §11.1: the three rows naming this slice (entailment classifier, guard analysis, CTI)
are **resolved here**.

## 12. Validation & definition of done

All verdicts get **real Apalache round-trips in tests** (no simulated validation). `cd lattice &&
npx tsc --noEmit && npx vitest run` (real solvers) before every commit; run `npx langium generate`
after checkout (`src/parse/generated/` is gitignored). Goldens A–D never weakened; never
`git add -A`.

1. **Worked classification** on the committed Subscriptions spec: `neverOverpaidAndPaidExact`'s
   `paid`-conjunct classifies **entailed** (consecution holds; `¬I` unreachable from real `init`
   because `settle` gates `paid`); the coupling invariant `activePaidInFull` classifies **violated**
   (`¬I` reachable — `recover`/`activate` reach `active` unpaid) — asserting the §5 correction; the
   `amountPaid <= totalDue` conjunct classifies via abstract accrual.
2. **Seeded violation:** mutate `settle` to `requires amountPaid >= totalDue` → the overpayment
   invariant classifies **violated** with a concrete reachable witness.
2b. **Independent (unreachable-CTI) control:** an invariant that is not 1-step inductive but whose
   `¬I` is unreachable from real `init` (e.g. the `active ⇒ paidInvoiceCount >= 1` shape, blocked by
   `activate`'s guard on the frozen counter) classifies **independent** — consecution fails, but
   reachability finds no counterexample within the bound.
3. **Method⊨transition:** `SubscriptionService.activate` (no `requires`) vs `activate`'s
   `paidInvoiceCount >= 1` guard → the "method weaker than guard" flag renders in `status`/prose.
4. **Stuck-state probe:** a fixture with an unsatisfiable `finalize` guard → draft is stuck; the
   diagnostic names the guard and the valuation and asks the annotation-gated question.
5. **Auto-prune payoff:** the overpayment CTI auto-prunes to `== totalDue` with **zero** user
   questions (asserts the fork-5 mechanism end-to-end).

**Plan step 1 (spike gate):** the §2 induction round-trip on the committed spec must pass before the
rest of the plan proceeds.

## 13. Sequencing & PR shape

Generation-first (§3.7): implementation begins after the generation slice lands. Then, small PRs,
rebase often, highest-collision files (`cli.ts`, `session.ts`, `emit/quint.ts`) landed in focused
changes. Suggested order: (1) spike + adapter induction mode; (2) Pillar A classifier + `classified`
ledger kind + `status`/`explain`; (3) abstract-evolution emission + structural gate; (4) Pillar B
guard analysis; (5) Pillar C + first-class guard candidates + auto-pruning.

## 14. Out of scope

Effects/`do`; cross-aggregate guards; latest-of-list selectors; method execution semantics
(generation); `emits` trace semantics (conformance); multi-step temporal induction; any surface-
syntax addition.
