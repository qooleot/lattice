# spec-core

A verifiable, domain-driven **specification language for the AI-agent era** (working name: **Lattice**).

The premise: markdown spec-driven development has no semantics (agents drift); classical formal
methods have an adoption cliff (humans quit before payoff). If the *agent* pays the formalization
tax and the human only ever *judges concrete cases*, a spec can be simultaneously readable by
domain experts, precise enough for an agent to implement with confidence, and mechanically checkable.

**Status (2026-07-15):** built and running — not a design doc anymore. Implemented: the elicitation
engine (chat → judged spec, real Alloy 6 + Quint/Apalache solvers, 679 engine tests), the `.lat`
language with parser/round-trip + ledger reconciliation (`.lat` is the spec's source of truth; the
verdict ledger is the evidence's), grammar & machine growth (guards, services, value objects,
sum-over-collection, `const`), spec→implementation generation (`lattice generate` → a running
SQLite-backed TypeScript service with guards, outbox events, invariant enforcement — see
`generated/subscriptions/`), inference (entailment classification + CTI-guided strengthening),
generated mermaid docs, conformance Tiers 1+2 (auto-bound `observe()` + machine-reachability
trace checking over captured suite states via `lattice conform`, runs recorded to the ledger;
negative control clean), and adversarial driving (lattice conform --drive: seeded command campaigns
with guard probing and shrinking to close the guard-evaluation gap). All 13 pre-registered drift
experiments caught (one with a pre-registration phrasing error, human-adjudicated) against a
hand-maintained engineer-shaped implementation — see
[`docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md`](docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md).
The drive-mode rediscovery campaign (undirected driving, no test suites) closes 11/13 of those same
classes across three campaigns, zero false positives across 81,000 clean-impl sequences; the 2
remaining misses are a measured budget ceiling (MISSED-COVERAGE-BOUNDED), not a structural gap —
see [`docs/superpowers/specs/2026-07-15-lattice-drive-rediscovery-results.md`](docs/superpowers/specs/2026-07-15-lattice-drive-rediscovery-results.md).
Not yet done: the app/UI — briefs in `docs/superpowers/specs/`. A real elicited spec lives at
`specs/subscriptions/spec.lat`.

## Getting started

Two commands: `cd lattice && bash scripts/ensure-ready.sh` to bootstrap (installs deps, fetches
solvers), then open Claude Code at the repo root and say "Use the elicit-spec skill — I want to
build a spec for `<your domain>`." Full walkthrough, from clone to a generated running service, in
**[docs/getting-started.md](docs/getting-started.md)**.

**The whole system reduces to three things:**

1. **One language** — an AST with prose / code / diagram projections.
2. **One elicitation loop** — *recognition over recall*: propose a candidate invariant → ask the
   single cheapest, most-informative question → the human judges a concrete case → prune → verify.
3. **One oracle** — the same invariants compiled to four targets: design-time model check,
   conformance/property tests, runtime monitors, and deterministic simulation testing.

See **[docs/plan.md](docs/plan.md)** for the full design: motivation, prior-art positioning
(Quint, Fizzbee, P, Alloy 6, CML, Rebel, Antithesis, mypyvy), the language and worked Billing
example, architecture, the invariant-template catalog, risk analysis, and the first de-risking
experiment.

Status: design plan. Not yet built.
