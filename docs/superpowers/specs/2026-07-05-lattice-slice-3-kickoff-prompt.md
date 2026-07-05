# Slice 3 Kickoff Prompt

Paste the block below as the first message of a fresh Claude Code session in
`/Users/taras/projects/spec-core`.

---

You are picking up **Lattice slice #3: the `.lat` parser (engineer authoring)** in this repo.

Read these, in order, before doing anything else:
1. `docs/superpowers/specs/2026-07-05-lattice-slice-3-lat-parser-brief.md` — the pre-design brief.
   It is your context payload: what the slice is, the ledger-reconciliation semantics, the storage
   fork, the round-trip correctness property, the six open scope questions, and the binding
   constraints. Treat its "constraints" section as non-negotiable.
2. `docs/plan.md` §6, §5.5, and §19 Risk 4 — the parent design's authoring boundary and round-trip
   risk analysis.
3. `docs/superpowers/specs/2026-07-03-lattice-elicitation-slice-1-design.md` §6 — why the parser
   was deferred and what already exists instead.

State of the world: slice 1 is complete and merged to main (elicitation engine, two real solver
adapters, three passing golden traces, 132+ tests). A real elicited spec exists at
`specs/subscriptions/` with its canonical 45-entry ledger at `.lattice-session-subscriptions/`.
The fidelity gate closed at 29% subtle-wrong → the ledger-canonical pivot is BINDING (see the GATE
OUTCOME block in `docs/superpowers/plans/2026-07-03-lattice-slice-1.md`). A separate
spec→implementation generation slice may be in flight; slice 3 is independent of it — do not block
on it, do not build it.

Process (this repo's established flow — follow it exactly):
1. Brainstorm with the human FIRST: the brief's §6 lists the open forks (LSP scope, CLI surface,
   rename-vs-ledger semantics, comment policy, predicate concrete syntax). The storage fork is
   ALREADY DECIDED by the user: `.lat` is the source of truth — see the brief's §4 DECIDED block
   for the binding consequences (ledger stays canonical for evidence; spec.json is a derived
   cache; degraded-state story required for parse errors; predicate concrete syntax is now CORE
   scope, not optional). One question at a time; the predicate-syntax question (§6.6) is the
   biggest scope item — surface its cost honestly before the design is fixed.
2. Write the design spec to `docs/superpowers/specs/2026-07-05-lattice-slice-3-lat-parser-design.md`,
   self-review, get the human's approval on the file.
3. writing-plans → a TDD implementation plan with complete code per task; then subagent-driven
   development with per-task review, progress ledger at `.superpowers/sdd/progress.md`.

Environment facts that will save you an hour: work in a worktree; run
`bash lattice/scripts/ensure-ready.sh` before first use (installs deps, links vendored JDK/Alloy
from the main checkout); full test runs use real solvers and are serialized (~2 min); before every
commit: `cd lattice && npx tsc --noEmit && npx vitest run` — golden traces A/B/C must stay green
and their assertions must never be weakened; never `git add -A`.

The one-sentence definition of done to design toward: an engineer edits
`specs/subscriptions/spec.lat` by hand — a rename, a new transition, and an invariant change that
contradicts a judged case — and the system applies the first two with provenance, rejects the third
naming the exact witness and verdict, and every projection re-renders from the updated canonical
store, with round-trip identity (`parse ∘ print = id`) property-tested across all committed specs
and fixtures.

---
