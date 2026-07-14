# Lattice — Inference Slice Brief: Entailment, Guard Analysis & CTI

- **Date:** 2026-07-08
- **Status:** SUPERSEDED — the approved design is [`2026-07-09-lattice-inference-slice-design.md`](2026-07-09-lattice-inference-slice-design.md); this brief remains as historical context only.
- **Parent design:** [`docs/plan.md`](../../plan.md) — §9.1 (mypyvy-style inference, CTI, the
  entailment classifier), §14 (the race/crash analysis the machine's guards feed), §15
  (decidability discipline — bounded checking is the floor, induction is the reach).
- **Evidence base:** the slice-4 design's deferred-work registry
  (`2026-07-07-lattice-slice-4-grammar-machine-growth-design.md` §11.1 — three rows name this
  slice), the committed Subscriptions spec (guards + coupling invariants landed 2026-07-08,
  commit `b8fecf7`, ledger entries #80–87), golden trace D, and the slice-4 honest-ceiling
  statements (§3.3/§3.4/§11 of that design).
- **Why this slice exists now:** slice 4's registry said "write this brief once slice 4 ships and
  real guard usage exists." It shipped. The corpus §9.1 classifies is no longer hypothetical:
  `specs/subscriptions/spec.lat` carries three transition guards, two cross-aggregate coupling
  invariants, four `emits` links, and a service with `performs` methods — all currently
  *declarative-only* at the analysis level.

---

## 1. What the inference slice is

Slice 4 grew the machine's **structure**; this slice makes the solvers **reason about** that
structure. Three pillars, in rough dependency order:

**Pillar A — the entailment classifier (plan §9.1's smallest deliverable).** For each adopted
invariant, check against the machine and label it **entailed** (follows from guards + transition
structure — dead weight or regression anchor), **independent** (load-bearing), or **violated**
(counterexample exists). The evidence is already sitting in the committed spec: `settle`'s guard
`amountPaid == totalDue` makes the `state settlement in {paid} => amountPaid == totalDue`
conjunct of `neverOverpaidAndPaidExact` a candidate for *entailed* — slice 4's design (§11)
explicitly kept it un-classified ("we keep the invariants as regression anchors rather than
classifying them"). This pillar is the classifier that earns the right to say so. Output surface:
a per-invariant label in `engine status`/prose ("entailed by settle's guard — kept as anchor"),
never silent deletion.

**Pillar B — guard analysis.** Three checks the machine's new structure makes meaningful:
- **Guard-completeness / stuck-state detection:** a state whose every out-transition is guarded
  false in some reachable data valuation is a trap (plan §9.1's CTI example is literally "your
  rule holds here but one step breaks it — forgot a guard?"). Today nothing asks this.
- **Reachability:** can `paid` be reached at all once `finalize`'s parts-sum guard and `settle`'s
  exact-payment guard compose? Template #10's by-construction no-skip made the transition *set*
  closed; nothing yet checks the guarded set stays *live*.
- **Guards as solver-loop candidates (slice-4 fork 6, explicitly deferred):** distinguishing
  questions *about* guards ("would you permit settle when amountPaid > totalDue?") so elicited
  guards get the same witness-anchored treatment invariants get. Requires guard candidates as
  first-class hypothesis objects — the piece slice 4 declined to build.

**Pillar C — CTI-guided strengthening (mypyvy-style, the reach goal).** Find a
counterexample-to-induction: a state satisfying the candidate that steps to a violation;
generalize; repeat (plan §9.1). The CTI is a first-class elicitation witness. Honest triage
question for brainstorming: whether Pillar C is IN this slice at all, or whether A+B alone are
this slice and C is its own follow-up once A's labels exist (recommend brainstorming this FIRST —
it is this slice's §6-scale sequencing fork; C without A has nothing to strengthen toward).

**Also owned by this slice (registry row):** method-guard ⊨ transition-guard entailment — a
`performs` method whose `requires` is weaker than its transition's guard is advertising calls
that will always be rejected; one whose `requires` is stronger silently narrows the API. Both are
pure entailment queries over carried structure (no method execution semantics needed — that stays
with generation).

## 2. The corpus (what exists to classify, concretely)

| Artifact | Where | What the slice does with it |
|---|---|---|
| `activate` guard `paidInvoiceCount >= 1`; `finalize` guard `totalDue == licenseFeeAmount + usageAmount`; `settle` guard `amountPaid == totalDue` | `specs/subscriptions/spec.lat` | Pillar B analysis subjects; Pillar A premises |
| `neverOverpaidAndPaidExact` (its paid⇒exact conjunct vs `settle`'s guard) | same | Pillar A's first real classification — the worked example |
| Coupling invariants `retryCapWhilePastDue`, `activePaidInFull` over `latestInvoice` ref | same | Independent-by-construction? (no guard mentions them — good negative controls) |
| `dunningExhausted` UNGUARDED (human decision, ledger #80–87) | same + ledger | Guard-completeness probe target: is pastDue exit-live under all valuations? |
| Trace D's adopted `totalDue == sum(lines, amount)` + `finalize` guard `totalDue >= 0` | `test/golden-trace-d.test.ts` fixture | Regression corpus for A/B over sums |
| `SubscriptionService` methods with no `requires` performing guarded transitions | spec.lat | Method⊨transition entailment: methods weaker than guards — flag shape |
| Money non-negativity template adoptions | session ledger | Classic §9.1 example: entailed-or-independent vs `paidInvoiceCount`-style counters |

## 3. Solver reality (keep the ceiling honest — verified capabilities, not hopes)

- **Quint/Apalache** is the behavioral engine. Bounded checking is what slice 1–4 use; Apalache
  ALSO supports **inductive-invariant mode** (check `init ⇒ Inv` and `Inv ∧ step ⇒ Inv'` as two
  bounded queries — 1-step induction). Entailment (Pillar A) and CTI (Pillar C) both reduce to
  induction-shaped queries; the design must verify the adapter can run Apalache's induction mode
  (or encode the two implications as separate 1-step checks with the current adapter — likely
  sufficient and simpler). Fold-only discipline (§15) unchanged.
- **Data-evolution blind spot inherited from slice 4 (§3.4):** non-enum data fields are
  init-nondeterministic and FROZEN in Quint traces; only region states and enum fields step.
  Consequence: "guard over a machine-evolved counter" dynamics (b10's accumulate-then-cap) are
  STILL unmodeled — entailment over such guards is only as strong as the frozen-field model.
  State this in every Pillar A label ("entailed under frozen-data semantics") or gate which
  invariant/guard pairs are classifiable at all. This is the effects-language dependency: full
  dynamics arrive when generation demands effects (registry row), not here.
- **Alloy** stays structural (slice-1 division, reaffirmed slice 4 §6): entailment of purely
  structural invariants (unique/cardinality/refsResolve) against guards is mostly vacuous —
  triage which kinds even route to Pillar A.
- **Guards read own scalars only** (slice-4 §5.2.1): no params (service slice), no ref-hops.
  Method requires MAY carry params — method⊨transition entailment must treat params as
  universally quantified (∀ delta: methodGuard(delta, state) ⇒ transitionGuard(state)) — linear,
  decidable, but a new query shape for the emitter.

## 4. Institutional constraints (hard-won, inherited verbatim)

- The seven-point checklist (slice-4 brief §2) applies to any NEW candidate form this slice adds
  (guard-candidates in the loop are a new form; entailment LABELS are not — they are metadata on
  existing adopted invariants and must be append-only ledger facts with provenance).
- Ledger canonical; labels/classifications are ledger entries, never silent state mutations;
  an *entailed* invariant is never auto-deleted (regression-anchor doctrine, slice-4 §11).
- Closed grammar stays closed: Pillars A/B add ANALYSIS, not surface syntax. If brainstorming
  concludes a surface is needed (e.g. `@anchor` marking an entailed-but-kept invariant), that is
  a versioned grammar act with the full ceremony.
- TypeScript strict; `cd lattice && npx tsc --noEmit && npx vitest run` (real solvers) before
  every commit; goldens A–D never weakened; no simulated validation — entailment verdicts get
  real Apalache round-trips in tests; never `git add -A`.
- `lattice/src/parse/generated/` is gitignored — run `npx langium generate` after any checkout
  before diagnosing tsc errors.

## 5. Open forks for brainstorming (one at a time, with the human)

1. **Scope cut:** A only / A+B / A+B+C? (Recommend settling this first; see §1's Pillar C note.
   The smallest honest slice is A + the method⊨transition check — both pure entailment.)
2. **Induction encoding:** Apalache induction mode vs. two bounded 1-step queries through the
   existing adapter. (Affects solver adapter surface; verify with a spike before designing.)
3. **Where labels live:** ledger entry kind (`classified`?) + prose rendering + `engine explain`
   integration — and does `engine status` re-classify on every apply, or on demand?
4. **Frozen-data honesty:** classify-with-caveat vs. refuse-to-classify for guard/invariant pairs
   whose semantics need data evolution (the b10 shape). This is the fork where overclaiming is
   the failure mode the fidelity gate exists to prevent.
5. **Guard candidates in the loop (Pillar B3):** full hypothesis objects with distinguishing
   questions, or a lighter "guard probe" flow that asks boundary questions without candidate
   plumbing? (The five-bug masking family says: if guards become candidates, the whole checklist
   applies — salient dims for guard facts, shape rebuilders, masking regressions.)
6. **Stuck-state semantics:** is a reachable valuation with no enabled out-transition a
   diagnostic (warn), a solver-loop question ("is this state intended to be terminal?"), or an
   error? Domain truth: some guarded dead-ends are intended (awaiting external payment).
7. **Sequencing with the generation slice** — see §6.

## 6. Coordination (multiple agents may be in flight)

- **Generation slice**: pure consumer of slice-4's schema; this slice is ANALYSIS over the same
  schema. Low file collision (generation lives in `src/generate/` or an emitter sibling; this
  slice lives in `src/engine/` + solver adapters + `src/emit/quint.ts` query shapes). The real
  coupling is conceptual: generation compiles guards into precondition checks — if Pillar A
  reveals a guard/invariant contradiction in the committed spec, generation inherits it. Running
  concurrently is plausible; decide explicitly with the human, don't let it happen by accident.
- **Highest-collision files for THIS slice:** `src/emit/quint.ts` (new query shapes),
  `src/engine/planner.ts`/`hypothesis.ts` (if Pillar B3 lands), `src/engine/session.ts` (ledger
  entry kinds), `src/cli.ts`. Small PRs, rebase often.
- **Do not build:** effects/`do` (generation-evidence-gated), cross-aggregate guards or
  latest-of-list selectors (grammar-growth rows with their own triggers), method execution
  semantics (generation), `emits` trace semantics (conformance slice).

## 7. Validation ideas (design-time, cheap, real)

- **The worked classification:** run Pillar A on the committed Subscriptions spec; assert
  `neverOverpaidAndPaidExact`'s paid-conjunct classifies *entailed* (under frozen-data caveat
  policy from fork 4) and both coupling invariants classify *independent* — with real Apalache
  queries, in a test.
- **A seeded violation:** mutate a fixture guard (e.g. `settle` requires `amountPaid >= totalDue`)
  and assert the classifier flags the overpayment invariant *violated* with a concrete witness.
- **Method⊨transition:** `SubscriptionService.activate` (no requires) vs `activate`'s
  `paidInvoiceCount >= 1` guard → the "method weaker than guard" flag renders in prose/status.
- **Stuck-state probe (if B lands):** a fixture where `finalize`'s guard is unsatisfiable
  (`totalDue == licenseFeeAmount + usageAmount` with fields constrained apart) → draft is stuck;
  the diagnostic names the guard and the valuation.

## 8. Pointers

- Classifier home: `lattice/src/engine/` beside `hypothesis.ts`/`planner.ts`; evaluator stays the
  ground truth for witnesses (`src/engine/evaluate.ts`).
- Quint query construction: `src/emit/quint.ts` (`astToQuint` — actions already encode guards as
  conjuncts, commit 7cb8e12); adapter: `src/solvers/quint-adapter.ts` (ITF parsing, port
  isolation pattern).
- The corpus: `specs/subscriptions/spec.lat`, `.lattice-session-subscriptions/ledger.jsonl`
  (entries #80–87 are the slice-4 structure decisions incl. the declined cross-aggregate guard),
  `lattice/test/golden-trace-d.test.ts`.
- Honest-ceiling text to extend, not contradict: slice-4 design §3.3/§3.4/§5.2.1/§11 + its §11.1
  registry (three rows resolve INTO this slice; update them to point at this brief).
- Worked narratives: plan §9.1 (CTI example `reserve requires available >= delta`), §16 (the
  question-minimizing conversation entailment feeds), §14 (races the guard analysis abuts).
