# spec-core

A verifiable, domain-driven **specification language for the AI-agent era** (working name: **Lattice**).

The premise: markdown spec-driven development has no semantics (agents drift); classical formal
methods have an adoption cliff (humans quit before payoff). If the *agent* pays the formalization
tax and the human only ever *judges concrete cases*, a spec can be simultaneously readable by
domain experts, precise enough for an agent to implement with confidence, and mechanically checkable.

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
