# Kickoff prompt — Lattice inference slice (entailment, guard analysis, CTI)

You are picking up the Lattice inference slice. Read the brief at
`docs/superpowers/specs/2026-07-08-lattice-inference-slice-brief.md` (context payload; constraints
non-negotiable), then docs/plan.md §9.1/§14/§15, the slice-4 design's honest-ceiling sections
(§3.3/§3.4/§5.2.1/§11) and its §11.1 deferred-work registry, and the committed corpus
(`specs/subscriptions/spec.lat`, ledger entries #80–87, golden trace D).

Slice 4 is merged; the generation slice may be in flight — raise the brief's §6 coordination
question with the human before designing. Process: brainstorm the forks one at a time (scope cut
A/A+B/A+B+C FIRST — it is the sequencing fork; then the induction-encoding spike, fork 2, before
any design is written), design spec → approval → writing-plans → subagent-driven with per-task
review. Environment: worktree + ensure-ready.sh; `npx langium generate` after checkout; tsc
--noEmit + full vitest run (real solvers) before every commit; goldens A–D never weakened; never
`git add -A`.

Definition of done is settled in brainstorming, but the brief's §7 validation ideas are the
floor: the worked classification on the committed Subscriptions spec (paid-conjunct entailed
under the fork-4 caveat policy, coupling invariants independent), a seeded-violation test with a
real witness, and the method⊨transition flag rendering — all against real solvers; entailment
labels are append-only ledger facts; an entailed invariant is never auto-deleted.
