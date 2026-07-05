# Generation Slice Kickoff Prompt

Paste the block below as the first message of a fresh Claude Code session in
`/Users/taras/projects/spec-core`.

---

You are picking up the **Lattice generation slice: spec → implementation**. The goal: a generator
that turns a judged, ledger-anchored Lattice spec into a REAL running TypeScript service —
entities, repositories, command handlers with guards, an outbox of domain events, invariant
enforcement at commit, and a generated test suite that passes for real. This slice completes the
founder story (describe domain → spec → running service) and manufactures the implementation the
future conformance slice will test for drift.

Read these, in order, before doing anything else:
1. `docs/superpowers/specs/2026-07-05-lattice-generation-slice-brief.md` — the pre-design brief:
   input contract (consume the AST through a loader seam — `.lat` is becoming canonical via
   slice 3, ledger stays canonical for evidence), plausible output surface, the hard dependency on
   slice-4's transition enrichment (CHECK ITS STATUS FIRST — §3 gives the two honest cuts), the
   five forks, the conformance seams to leave, and the real-validation bar. Constraints are
   non-negotiable.
2. `docs/plan.md` §5.3, §11.5, §11.6, §13 — what generated code is for, and what the conformance
   slice will later demand from its shape.
3. The committed real spec you will generate from: `specs/subscriptions/` +
   `.lattice-session-subscriptions/ledger.jsonl` (its 45-entry evidence base).
4. The slice-4 brief (`2026-07-05-lattice-slice-4-grammar-machine-growth-brief.md`) §6 and the
   slice-3 brief §4 DECIDED block — your coordination neighbors: slice 4 owns machine enrichment
   (you consume, never rebuild); slice 3 owns the `.lat` parser (you consume the AST, not files).

Ground rules from this project's history: the fidelity gate closed at 29% subtle-wrong and made
ledger-anchoring BINDING — generated artifacts carry provenance to spec elements and judged cases,
and nothing is presented as verified beyond what the ledger supports. The user's durable rule: no
simulated validation — the generated service runs for real (real persistence, real guard
rejections, real outbox writes), and the flagship test is differential: generated invariant checks
must agree with the engine's `evaluateCandidate` on the ledger's own judged witnesses.

Process (this repo's established flow — follow it exactly):
1. Brainstorm with the human, one question at a time. FIRST question: slice-4 status and which cut
   of §3 applies (wait for enriched transitions vs. scope v1 to entities+invariants). Then the
   forks in brief §4: persistence (in-memory/SQLite vs MikroORM-shaped — weigh the §11.5.4
   conformance seam), the regeneration story (recommended: generated dir is never hand-edited;
   determinism test mandatory), invariant compilation (readable generated checks
   differential-tested against the evaluator is the recommended shape), output location, demo spec.
2. Write the design spec to
   `docs/superpowers/specs/2026-07-05-lattice-generation-slice-design.md`, self-review, get the
   human's approval on the file.
3. writing-plans → TDD implementation plan with complete code per task → subagent-driven
   development with per-task review; progress ledger at `.superpowers/sdd/progress.md`.

Environment facts that will save you an hour: work in a worktree; run
`bash lattice/scripts/ensure-ready.sh` before first use; full engine test runs use real solvers,
serialized (~2 min); before every commit: `cd lattice && npx tsc --noEmit && npx vitest run` —
golden traces A/B/C stay green, assertions never weakened — and the generated package must pass
its OWN typecheck + tests; never `git add -A`.

The definition of done to design toward: one command generates a service from
`specs/subscriptions/`; the generated package's own tests pass; a demo script performs, for real:
a guard rejection, a successful transition that lands a domain event in the outbox, and an
invariant-violating write rejected at commit; regeneration is byte-identical for an unchanged
spec; and every generated check cites the spec element and ledger anchors it enforces.

---
