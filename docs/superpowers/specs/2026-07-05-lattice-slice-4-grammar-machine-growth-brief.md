# Lattice — Slice #4 Brief: Grammar & Machine Growth

- **Date:** 2026-07-05
- **Status:** Pre-design brief — NOT an approved design. The agent picking this up must run the
  brainstorming flow with the human to resolve the open forks below, write the design spec, then
  writing-plans, then implement. This document is the accumulated context and evidence.
- **Parent design:** [`docs/plan.md`](../../plan.md) — §5.1 (`machine`/`transition` constructs),
  §9.1 (prefer encoding safety in the machine), §10.2 (template catalog), §15 (decidability
  discipline).
- **Evidence base:** `lattice/fidelity/results/REPORT.md` (grammar backlog section),
  `lattice/fidelity/results/AMENDMENT.md` (second-strike analyses), the live billing session ledger
  (`.lattice-session-subscriptions/`), and slice-1's deferral table.

---

## 1. What slice 4 is

Grow the spec schema and its elicitation coverage along the axes real usage has demanded — the
evidence-driven backlog, not speculative breadth. Two pillars:

**Pillar A — machine enrichment (the bigger one).** Today `TransitionDef` is
`{name, region, from, to, when?}` and live sessions elicit *states* but leave transitions nearly
empty. Process rules therefore get squeezed into invariants or lost — the fidelity gate proved this
class (b03 "trialing→active only after payment", b10 "retry cap then delinquent" both strained the
invariant grammar; REPORT.md's verdict: these are transition guards, not invariants; parent plan
§9.1 says prefer machine-encoded safety). Slice 4:
- extends `TransitionDef` with `requires?: Predicate`, `emits?: string` (declared event), and a
  deliberately small `effects` form (open fork §5.1 — this is the hidden-scope item);
- teaches phase 0 to elicit transitions recognition-over-recall ("what makes a Subscription go
  Trialing→Active? Can it skip straight to Canceled?"), with structure Q&A recorded to the ledger
  as today;
- routes process-rule candidates to the machine instead of the invariant grammar (the b03 lesson);
- unlocks template #10 (ordered lifecycle / no-skip) which needs transition structure to exist.

**Pillar B — invariant-grammar growth (evidence-gated).**
- `sum-over-collection` (gate rule b02, twice not-formalizable: "line items sum to invoice total").
  Child-entity aggregation over a ref/list relationship. Touches: grammar types + shape validation,
  `evaluateCandidate`, quint emitter (fold — respecting the plan's fold-only decidability
  discipline §15), alloy emitter (`sum`), salient extraction, BOTH shape rebuilders.
- Cross-entity counting (b03) is explicitly NOT grammar growth — it routes to Pillar A guards.
- Remaining templates, honestly triaged: **#10 in** (fits Pillar A). **#4 idempotency, #12 saga
  net-zero: recommend defer** — they require `external`/saga constructs, a slice of their own.
  **#5 reservation-release: evaluate** — `leadsTo` exists template-only; the template needs a
  `@reservation` tag convention but no new checking machinery at bounded depth.

## 2. The institutional checklist (hard-won — do not skip)

Five live bugs in slice 1's aftermath were all one family: a grammar form whose salient/exclusion/
constraint plumbing was partial (unique masking → Task 17; kind-gated reuse → Task 18; inState dims
→ live session; multi-subject contradiction; composite-invalid witnesses). Therefore: **every new
candidate form or transition feature ships with ALL of:**
1. `validateCandidate` structural shape + semantic checks (never throws; `ill-typed`/named codes);
2. `evaluateCandidate` semantics (the pure-TS ground truth used by pruning, admit, fidelity);
3. an encoding in BOTH emitters or an explicit routing restriction with a rejection diagnostic;
4. salient-dim extraction for its distinguishing facts (with the all-subjects-agree guard);
5. shape REBUILD in both `shapeToQuint` and `shapeToPred`;
6. participation in adopted-invariant witness constraints (or a documented, justified skip like
   terminal/monotonic);
7. regression tests for the masking class: a judged shape must never cancel a genuinely distinct
   pair, and exclusion shapes must never be broader than the judged violation.

Growing the grammar is a versioned act: update the closed-grammar list in
`.claude/skills/elicit-spec/SKILL.md` (elicitable kinds), the `not-elicitable` guard in
`src/cli.ts`, and grammar docs together.

## 3. Machine semantics scope (keep the ceiling honest)

Pillar A adds *structure*, not a model-checking upgrade: `requires` guards are validated and
carried (and consumed by phase-0 elicitation, projections, and the future generation slice), and
the quint emitter should honor declared guarded transitions (it already emits guarded actions for
declared transitions; extend for `requires`/`emits`). Full guard-completeness checking, entailment
classification (§9.1), and reachability analysis remain future work — say so in the design rather
than implying them.

## 4. Validation ideas (design-time, cheap, real)

- Re-run the gate's b02 formalizer prompt (fresh context, same protocol) against the grown grammar:
  does sum-over-collection now formalize and pass its own cases? A one-rule smoke, not a gate re-run.
- Extend golden trace C's fixture or a new mini-trace: an invoice-lines domain where the residual
  invariant is a sum-over-collection form, elicited end-to-end with real solvers.
- A transition-elicitation demo on the committed Subscriptions spec: phase 0 asks the machine
  questions, the machine gains guarded transitions, prose/lat render them (prose lifecycle renderer
  already handles declared transitions correctly as of e0c0ef9).

## 5. Open forks for brainstorming (one at a time, with the human)

1. **The effects language** on transitions — assignments of what shape? (`field = term` only? which
   terms?) This is slice 4's hidden-scope item, analogous to slice 3's predicate concrete syntax.
   Smallest honest v1 may be: no effects at all, only `requires` + `emits` (guards and events are
   what elicitation and generation consume first).
2. Sum-over-collection surface: via list-typed fields, via reverse-ref ("all Invoices whose
   subscription = self"), or both? (b02's model used `lines: List<ref>`; the live session modeled a
   pre-aggregated counter instead — evidence both appear.)
3. Template triage confirmation (#5 in or out).
4. Phase-0 transition elicitation UX and question budget.
5. Sequencing with slice 3 (parser) — see §6.
6. Whether guard candidates participate in the solver loop (distinguishing questions about guards)
   in this slice, or guards are elicitation-only until the entailment work lands.

## 6. Coordination warning (multiple agents in flight)

- **Slice 3 (`.lat` parser)** parses the concrete syntax this slice EXTENDS (transitions gain
  `requires/emits/effects`; new invariant form). Running them concurrently means the parser chases
  a moving grammar. Preferred sequencing: slice 4's schema lands first (or slice 3 scopes to the
  current grammar and slice 4 extends the Langium grammar as part of its own definition of done —
  decide explicitly with the human; do not let it happen by accident).
- **The generation slice** (spec→implementation, may be brainstormed separately) is a pure CONSUMER
  of Pillar A's schema. If slice 4 lands first, generation's "phase 0 machine enrichment" is
  already done — the generation agent should be told so.
- Merge discipline: this slice touches `src/ast/*`, both emitters, salient/planner plumbing —
  the highest-collision files in the repo. Small PRs/commits, rebase often onto main.

## 7. Constraints binding this slice (inherited, non-negotiable)

- Gate binding: ledger canonical; adopted invariants render with anchors; no unprobed formalization
  presented as settled.
- Closed grammar remains closed: growth is explicit, versioned, and gated by `validateCandidate`.
- TypeScript strict; before every commit `cd lattice && npx tsc --noEmit && npx vitest run` (real
  solvers, serialized); golden traces A/B/C stay green, assertions never weakened.
- Worktree bootstrap: `bash lattice/scripts/ensure-ready.sh` before first use.
- User preference (durable): no simulated validation — new forms get real solver round-trips.
- Never `git add -A`; conventional commits.

## 8. Pointers

- AST/grammar: `lattice/src/ast/{domain,invariant,grammar,validate}.ts`.
- Emitters: `lattice/src/emit/{alloy,quint}.ts` (note `shapeToQuint`/`shapeToPred` + the
  adopted-constraint conjunction added in b0cb710); evaluator `src/engine/evaluate.ts`; salient
  `src/engine/salient.ts` (all-subjects-agree guard, splitPathStr merge note).
- Elicitable-kind guard: `src/cli.ts` (`not-elicitable`); skill: `.claude/skills/elicit-spec/SKILL.md`.
- Evidence: `lattice/fidelity/results/{REPORT.md,AMENDMENT.md,first-shot/}`, live ledger
  `.lattice-session-subscriptions/ledger.jsonl`.
