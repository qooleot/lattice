# spec-core

A verifiable, domain-driven **specification language for the AI-agent era** (working name: **Lattice**).

The premise: markdown spec-driven development has no semantics (agents drift); classical formal
methods have an adoption cliff (humans quit before payoff). If the *agent* pays the formalization
tax and the human only ever *judges concrete cases*, a spec can be simultaneously readable by
domain experts, precise enough for an agent to implement with confidence, and mechanically checkable.

## Getting started

Two commands: `cd lattice && bash scripts/ensure-ready.sh` to bootstrap (installs deps, fetches
solvers), then open Claude Code at the repo root and say "Use the elicit-spec skill — I want to
build a spec for `<your domain>`." Full walkthrough, from clone to a generated running service, in
**[docs/getting-started.md](docs/getting-started.md)**.

## Learn more

- **[docs/getting-started.md](docs/getting-started.md)** — the full walkthrough: bootstrap,
  elicitation, editing a spec, generating and running a service.
- **[docs/plan.md](docs/plan.md)** — the full design: motivation, prior-art positioning (Quint,
  Fizzbee, P, Alloy 6, CML, Rebel, Antithesis, mypyvy), the language and worked Billing example,
  architecture, the invariant-template catalog, risk analysis.
- **[docs/language/README.md](docs/language/README.md)** — the `.lat` language reference.
- **[docs/superpowers/specs/](docs/superpowers/specs/)** — per-slice design docs and drift-experiment
  results for how each piece was built.
