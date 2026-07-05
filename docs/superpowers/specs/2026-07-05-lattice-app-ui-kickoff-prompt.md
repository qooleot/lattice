# App/UI Track Kickoff Prompt

Paste the block below as the first message of a fresh Claude Code session in
`/Users/taras/projects/spec-core`.

---

You are picking up the **Lattice App/UI track**: designing the product application for the
elicitation experience — the founder-facing app where someone describes their domain in chat and
walks away with a judged, anchored, human-readable + machine-checkable spec. Your assignment is to
THINK and design with the human, not to build: brainstorm → design spec → approval → plan. No code,
no scaffolding, no mockup implementation until the design is approved.

Read these, in order, before doing anything else:
1. `docs/superpowers/specs/2026-07-05-lattice-app-ui-brief.md` — the pre-design brief: what exists
   (the app is a client of a real, session-backed engine protocol — never a rebuild, never a
   simulation), the seven interactions real usage says the UI must serve, the architecture forks,
   what's out of scope, and the binding constraints.
2. `.claude/skills/elicit-spec/SKILL.md` — the behavioral spec of the app's agent (this protocol,
   including the gate-binding rules, moves into a Claude Agent SDK agent).
3. `.lattice-session-subscriptions/ledger.jsonl` + `specs/subscriptions/` — a complete real
   session; design against these actual artifacts, not imagined ones.
4. `docs/plan.md` §16 and §17 — the two worked narratives the app makes tangible.

Ground rules from this project's history you must not violate: the engine is real and stays the
only source of truth (no simulated witnesses, no fake solver states, no invariant shown as adopted
without its ledger anchors — the fidelity gate closed at 29% subtle-wrong and made ledger-anchoring
BINDING); the deterministic witness table renders verbatim (prose is additive sugar); solver
latency is shown honestly (~1s Alloy, ~5s Apalache, 45s worst budget). Engine slices own the
engine — if the UI needs protocol additions (streaming progress, model-delta events), write a
short protocol-change proposal for the human to route to an engine slice.

Process:
1. Brainstorm with the human, one question at a time, starting with the two biggest forks:
   hosting/runtime model (hosted engine service vs. local-first vs. hybrid — the solver toolchain
   is ~350MB, which shapes everything) and v1 audience (founder-only vs. founder+engineer views).
   Then: chat-first-with-cards vs. canvas-with-chat-rail, session/workspace model, end-of-session
   story. The brief's §3 lists all forks. If a question is genuinely clearer shown than described
   (layout comparisons, witness-card mockups), the visual companion is appropriate at that moment.
2. Write the design spec to `docs/superpowers/specs/2026-07-05-lattice-app-ui-design.md`:
   product narrative, v1 scope cut, architecture (agent runtime, engine integration, session
   model), the witness-judging interaction in detail (including temporal/timeline witnesses and
   the undecided/parked flow), provenance click-through, latency states, and a protocol-change
   appendix if needed. Self-review, then get the human's approval on the file.
3. writing-plans → implementation plan. The frontend-design skill applies at implementation time.

Definition of success for the design (not the app): the human can read the spec and see exactly
what v1 is and is not, every engine touchpoint maps to an existing CLI command or a named protocol
proposal, and the billing session in the repo could be replayed through the described UI screen by
screen without inventing anything the engine doesn't do.

---
