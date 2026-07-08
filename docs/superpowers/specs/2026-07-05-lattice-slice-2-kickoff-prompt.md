# Slice 2 Kickoff Prompt

Paste the block below as the first message of a fresh Claude Code session in
`/Users/taras/projects/spec-core`.

---

You are picking up **Lattice slice #2: conformance / anti-drift** — the hypothesis the whole
product's trust story rests on: *does the spec stay synced to real code?* Slice 1 proved specs can
be elicited from a founder; your slice proves they cannot silently rot. The parent plan calls this
the anti-Rebel keystone and its highest-risk engineering component.

Read these, in order, before doing anything else:
1. `docs/superpowers/specs/2026-07-05-lattice-slice-2-conformance-brief.md` — the pre-design
   brief: sequencing context (you run AFTER the generation slice — verify its status FIRST, §1),
   the two tiers (CI wedge of passive invariant assertions; event-trace conformance via a pure-TS
   replay checker reusing the engine's evaluator), the pre-registered drift-experiment validation
   model, the six forks, and the binding constraints including known environment quirks.
2. `docs/plan.md` §11.5 IN FULL (the conformance adapter's layered generated-first design — your
   design must state which layers you implement and must MEASURE the residual hand-written
   surface, per §21 step 2), then §11.6, §13, §19 Risk 6.
3. The current state of the parallel slices: generation
   (`2026-07-05-lattice-generation-slice-brief.md` + any design/plan it has produced), slice 3
   (`.lat` canonical — consume the AST via the loader seam, never a file format), slice 4
   (transition enrichment — use `requires`/`emits` in trace legality if landed). `main` moves
   daily in this repo; trust the docs and git log over this prompt's snapshot.

HARD GATE before designing: if no generated implementation of `specs/subscriptions/` exists yet,
STOP and put the target question to the human (wait for generation / point at an existing real
codebase / other). Do not build a toy target to test against — that was explicitly rejected unless
the human re-chooses it.

Ground rules from this project's history: the fidelity gate made ledger-anchoring BINDING — every
conformance diagnostic cites the spec element and its judged cases; the user's durable rule is no
simulated validation — drift experiments are real edits to real code (on branches, never main),
caught by really running the harness; zero false positives on the unmodified implementation is a
pre-registered requirement, not a nice-to-have (report→enforce rollout per plan §11.6).

Process (this repo's established flow — follow it exactly):
1. Brainstorm with the human, one question at a time: target confirmation first (§1), then
   trace-checker mechanism (pure-TS replay vs. Apalache ITF replay), observe() shape, the drift
   catalog (you draft it, the human approves it — it is the slice's answer key), report→enforce
   mechanics, harness location.
2. Write the design spec to
   `docs/superpowers/specs/2026-07-05-lattice-slice-2-conformance-design.md` — including
   pre-registered success/kill criteria (all drift classes caught; false positives = 0; CI runtime
   budget; diagnostic-quality bar) and an explicit mapping to §11.5's numbered layers. Self-review,
   get the human's approval on the file.
3. writing-plans → TDD implementation plan → subagent-driven development with per-task review;
   progress ledger at `.superpowers/sdd/progress.md`.

Environment facts that will save you hours: work in a worktree; run
`bash lattice/scripts/ensure-ready.sh` before first use — but know its quirks: it will NOT refresh
a stale `node_modules` (rm -rf and re-run if imports fail after merging main), golden trace B's
latency assertion is load-sensitive (no heavy parallel work during full-suite runs), and orphaned
solver JVMs accumulate across repeated runs. Before every commit:
`cd lattice && npx tsc --noEmit && npx vitest run` — golden traces stay green, assertions never
weakened. Never `git add -A`. Commit doc edits immediately — uncommitted edits have been lost to
concurrent-agent cleanups in this repo.

The definition of done to design toward: against the real generated implementation, the unmodified
service passes both tiers clean; every entry in the human-approved drift catalog — guards removed,
emits skipped, wrong events, conservation violations, spec/code renames — is caught with a
diagnostic that names the violated spec element and its ledger anchors well enough that a developer
locates the drift from the message alone; and the residual hand-written adapter surface is
measured and reported (the number plan §21 step 2 has been waiting for).

---
