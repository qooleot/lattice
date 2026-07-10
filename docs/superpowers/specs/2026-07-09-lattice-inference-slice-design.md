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

## 3. Decisions (locked with the human, 2026-07-09)

### 3.1 Scope = A + B + C (brief fork 1) — DECIDED

Full slice: all three pillars, plus method⊨transition and abstract-evolution modeling. This is a
large slice; it ships as **small sequenced PRs** (§12), but the design is one coherent unit because
the pillars share machinery (C's pruning reuses A's induction queries; B's stuck-state reuses the
reachability shape).

### 3.2 Query encoding = Apalache-induction throughout (brief fork 2) — DECIDED

Entailment (A), consecution (C), and reachability (B) are all encoded as real 1-step induction /
reachability queries through `quint verify --inductive-invariant` (+ a custom `--init` for
consecution-from-arbitrary-state, so a CTI need not be reachable-from-init). Rationale: the spike
made the rigorous option cheap. We do **not** fall back to bounded-from-init reachability as the
primary mode; bounded checking remains available where a property is not inductive-shaped.

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

### 4.1 `src/solvers/quint-adapter.ts` — induction mode

Extend `runQuint` (or add a sibling `runQuintInduction`) to pass `--inductive-invariant <Inv>` and,
for consecution-from-arbitrary-state, a custom `--init` predicate that constrains the start state to
satisfy `Inv` (rather than the machine's real `init`). The result surface stays
`{ violated, witness, ms }`; a violated consecution query returns the **CTI** as its witness. Honor
the existing port-isolation pattern and the known orphan-JVM / load-sensitive-latency quirks
(golden trace B) — induction queries may be slower; budget for it in tests.

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

For each adopted invariant `I`, flip it from **assumption** to **goal** and run induction with the
machine's guards + all *other* adopted invariants as assumptions:

- **entailed** — `I` is inductive and redundant (`¬I` unreachable without asserting `I`). The
  guards + structure already force it. This is the `settle`-guard case: `paid ⇒ amountPaid == totalDue`
  holds because the only step into `paid` is `settle`, guarded `amountPaid == totalDue`. Kept as a
  **regression anchor** — never auto-deleted (slice-4 §11 doctrine).
- **independent** — `¬I` is reachable without `I`, but `I` is maintained once asserted. Load-bearing;
  it genuinely narrows the machine. The coupling invariants (`retryCapWhilePastDue`,
  `activePaidInFull`) are the expected examples — no guard establishes them.
- **violated** — a CTI exists: a state satisfying `I` (and peers) steps to `¬I` under a
  guard-permitted transition. This is plan §9.1's "your rule holds here but one step breaks it —
  forgot a guard?" The CTI is a first-class elicitation witness.

Output is a per-invariant label with provenance; **never silent deletion**, even for *entailed*.

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

- **region/`inState` predicate** → enum fact → **Tier 1** (fully sound under induction; no caveat).
- **data field** → look at its declared role: `@balance`/`@total` → high-confidence evolving →
  abstract step + violation-caveat; annotation-less counters (`accruedUnits`, `retryCount`,
  `paidInvoiceCount`) → treated as evolving (**conservative default**); config-like (`maxRetries`,
  `seats`), keys, refs → static-ish.

**Classification is per-conjunct, not per-invariant.** `neverOverpaidAndPaidExact` splits across
tiers: conjunct `paid ⇒ amountPaid == totalDue` is pinned to `settle`'s guard (Tier-1-like /
sound), while `amountPaid <= totalDue` is the abstract-accrual one. The classifier reports at
conjunct granularity.

**Tightening knob (also cuts questions):** emit *other* adopted invariants and adopted guards as
assumptions alongside the abstract step, so the over-approximation is no looser than necessary —
fewer spurious CTIs → fewer false boundary questions. Never the invariant-under-test (circular).

## 7. Labels, ledger & CLI

### 7.1 The `classified` ledger entry (fork 3)

A new **append-only** ledger kind:

```
{ kind: 'classified', at, invariant: <name/id>, conjunct?: <index/path>,
  verdict: 'entailed' | 'independent' | 'violated',
  tier: 'sound' | 'abstract',           // from the §6.4 gate
  caveat?: <string>,                     // present for abstract-tier violations
  witness?: <CaseState>,                 // the CTI, for violated
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

- **Stuck-state (fork 6):** find reachable states whose every out-transition is guarded-false. Gate
  by lifecycle annotation: `@terminal` stuck → silent; non-terminal stuck → boundary question naming
  the state and the blocking valuation. Never a hard error.
- **Reachability:** for each guarded state, check it remains reachable once guards compose (e.g., can
  `paid` still be reached once `finalize`'s and `settle`'s guards compose). An unreachable guarded
  state is surfaced (dead transition / over-strong guard).

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

Pillars A/B/C add **analysis**, not surface syntax — the closed grammar stays closed. The one item
that deserves scrutiny: **abstract-evolution modeling (§6) gives the *existing* `@balance`/`@total`
annotations a new *solver semantics*.** No new syntax is introduced, but assigning operational
meaning to existing annotations is arguably a grammar-semantics act. **Decision for the review
pass:** treat it as an emitter/semantics change documented in `docs/language/*.md` (no `.langium`
change, no reserved-word change), *unless* the human judges it warrants the full versioned-grammar
ceremony. Flagged, not silently assumed.

## 10. Honest ceiling (what this slice does NOT claim)

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
   `paid`-conjunct classifies **entailed** (Tier-1/sound); both coupling invariants classify
   **independent**; the `amountPaid <= totalDue` conjunct classifies via abstract accrual.
2. **Seeded violation:** mutate `settle` to `requires amountPaid >= totalDue` → the overpayment
   invariant classifies **violated** with a concrete witness.
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
