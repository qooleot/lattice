# Slice 4 Kickoff Prompt

Paste the block below as the first message of a fresh Claude Code session in
`/Users/taras/projects/spec-core`.

---

You are picking up **Lattice slice #4: grammar & machine growth** in this repo.

Read these, in order, before doing anything else:
1. `docs/superpowers/specs/2026-07-05-lattice-slice-4-grammar-machine-growth-brief.md` — the
   pre-design brief. It is your context payload: the two pillars (machine enrichment with
   transition guards/events; evidence-gated invariant-grammar growth), the seven-point
   institutional checklist every new grammar form MUST ship with (distilled from five live masking
   bugs — skipping any point reintroduces a known bug class), the honest semantics ceiling, the
   open forks, and the coordination warnings. Treat its constraints section as non-negotiable.
2. `docs/plan.md` §5.1, §9.1, §10.2, §15 — the parent design's machine constructs, machine-first
   safety principle, template catalog, and decidability discipline.
3. `lattice/fidelity/results/REPORT.md` (grammar backlog section) and the live session ledger
   `.lattice-session-subscriptions/ledger.jsonl` — the evidence that scopes this slice.

State of the world: slice 1 is complete and merged (elicitation engine, Alloy + Quint/Apalache
adapters, three passing golden traces, 132+ tests, plus five post-merge fixes from live usage). The
fidelity gate closed at 29% subtle-wrong → the ledger-canonical pivot is BINDING. A slice-3 agent
(`.lat` parser) and possibly a generation-slice agent may be working in parallel — read the brief's
§6 coordination warning FIRST and raise the sequencing question with the human before designing;
this slice touches the repo's highest-collision files.

Process (this repo's established flow — follow it exactly):
1. Brainstorm with the human FIRST: the brief's §5 lists the open forks — start with sequencing
   vs. slice 3 (§5.5), then the effects-language scope (§5.1, the hidden-scope item; smallest
   honest v1 may be `requires` + `emits` with no effects at all). One question at a time.
2. Write the design spec to
   `docs/superpowers/specs/2026-07-05-lattice-slice-4-grammar-machine-growth-design.md`,
   self-review, get the human's approval on the file.
3. writing-plans → TDD implementation plan with complete code per task; then subagent-driven
   development with per-task review; progress ledger at `.superpowers/sdd/progress.md`.

Environment facts that will save you an hour: work in a worktree; run
`bash lattice/scripts/ensure-ready.sh` before first use; full test runs use real solvers,
serialized (~2 min); before every commit: `cd lattice && npx tsc --noEmit && npx vitest run` —
golden traces A/B/C stay green, assertions never weakened; never `git add -A`.

The definition of done to design toward: (1) phase 0 elicits guarded transitions on the committed
Subscriptions spec and they render correctly in prose and .lat; (2) the gate's rule b02 ("line
items sum to invoice total"), re-formalized one-shot by a fresh context against the grown grammar,
now passes its own cases and survives an end-to-end elicitation with real solvers in a mini golden
trace; (3) every new grammar form demonstrably satisfies all seven checklist points, with masking-
class regression tests; (4) the closed-grammar surfaces (skill wording, `not-elicitable` guard,
grammar docs) are updated in the same commits that grow the grammar.

---
