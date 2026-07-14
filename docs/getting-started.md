# Getting started

Lattice is a specification language and elicitation engine: you chat with an AI agent about a
domain, it converges on a solver-checked `.lat` spec through concrete cases you judge, and that
spec can generate a running TypeScript service. See [`docs/plan.md`](plan.md) for the full design
and motivation, and [`docs/language/README.md`](language/README.md) for the language reference.

This guide is the from-scratch path: clone, bootstrap, elicit a spec, generate a service.

## Prerequisites

- **Node ≥ 20.**
- **macOS.** The solver bootstrap (`scripts/fetch-solvers.sh`) resolves a JDK 17+ via
  `/usr/libexec/java_home`, with a no-admin local-JDK fallback if that fails — both are macOS
  mechanisms. Linux/Windows are not currently supported by the bootstrap script.
- **Network, for the first bootstrap only.** The first run fetches a vendored JDK + the Alloy 6
  jar (~350MB total, gitignored, cached after the first fetch). Apalache (used by `quint verify`)
  is fetched separately by Quint itself on the first solver-verify call, not by the bootstrap
  script.

## Bootstrap

```sh
cd lattice && bash scripts/ensure-ready.sh
```

This installs node deps (`npm ci`) if `node_modules` is missing, links solver binaries
(`vendor/alloy.jar`, `vendor/jdk`) from the main checkout if you're in a linked git worktree
(so each worktree doesn't re-download ~350MB), falls back to `scripts/fetch-solvers.sh` if
nothing is found anywhere, generates the langium parser if needed, and finally runs the solver
doctor. It is idempotent — safe to re-run.

All-green doctor output looks like:

```json
{
  "java": { "ok": true, "version": "openjdk version \"21.0.11\" ...", "path": "/path/to/java" },
  "alloyJar": true,
  "quint": true
}
```

`java.ok: true` means a verified JDK 17+ was found; `alloyJar`/`quint` mean the Alloy jar and the
Quint CLI are present. If any of these are `false`, stop and fix it before continuing — the
elicitation loop depends on real Alloy + Quint/Apalache runs, never a simulation.

**Known quirk:** the script won't refresh a stale `node_modules` after a pull that changed
dependencies. If imports start failing after `git pull`, run `rm -rf lattice/node_modules` first,
then re-run `ensure-ready.sh`.

## Your first spec (the chat path)

Open Claude Code at the repo root and say:

> Use the elicit-spec skill — I want to build a spec for `<your domain>`.

What happens next (see `.claude/skills/elicit-spec/SKILL.md` for the full protocol the agent
follows):

1. **Structure questions** (no solver) — the agent proposes aggregates, entities, enums,
   lifecycle states/transitions, guards, events, and service methods for your domain, one
   question at a time; you correct it. This is recorded to a session ledger as it happens.
2. **Free template invariants** — once the structure is initialized, a set of invariants come
   for free from field tags (e.g. `@balance`, `@monotonic`) and lifecycle shape (e.g.
   terminal-state, no-skip-transition rules). You're shown the list and can object.
3. **Solver-generated concrete cases** — for everything else, the engine proposes a candidate
   invariant, asks Alloy or Quint/Apalache for the single most-informative concrete case, and
   presents it to you as a witness table. You judge each case **permit**, **forbid**, or
   **we-haven't-decided** (parked as an open decision) — never write formulas yourself.
4. **Convergence** — once no distinguishing case remains, the candidate is adopted, cited by the
   judged cases (witnesses) that anchor it.

Expect **~1s** per Alloy question and **~5s** per Apalache/Quint question — these are real solver
calls, not canned answers.

What appears where, once you converge (`engine emit --out specs/<slug>/`):

- `specs/<slug>/spec.lat` — the spec itself (source of truth).
- `specs/<slug>/spec.prose.md` — a generated human-readable rendering.
- `specs/<slug>/spec.diagrams.md` + `specs/<slug>/diagrams/*.mmd` — generated mermaid diagrams.
- `.lattice-session-<slug>/` at the repo root — the session ledger: every structure Q&A, proposed
  candidate, judged verdict, and classification, append-only. This is the evidence trail behind
  the spec; it is not itself the spec.

## The committed example

`specs/subscriptions/` is a real elicited spec (hybrid license-fee + usage-based subscription
billing), not a toy — read `specs/subscriptions/spec.prose.md` for the human-readable rendering
and `specs/subscriptions/spec.lat` for the source, and look at `.lattice-session-subscriptions/`
for the ledger behind it, before running your own elicitation.

## Editing the spec

Once a spec exists, hand-edit `spec.lat` directly (it's a plain text file — see
[`docs/language/README.md`](language/README.md) for syntax), then reconcile it back into the
session:

```sh
cd lattice && npx tsx src/cli.ts apply --session <session-dir> --lat <path/to/spec.lat>
```

(`--lat`, not `--spec` — verify against `lattice/src/cli.ts` if this has changed since.)

`apply` re-parses the `.lat` file and diffs it against the session's stored model and adopted
invariants. Additions and renames (with `--rename Owner.old=new`) reconcile cleanly. But an edit
that **contradicts an already-judged case** — e.g. you loosen an invariant a witness explicitly
forbade — is refused by witness name (the ledger entry that judged it), not silently accepted;
you either revert the edit or explicitly force past it (`--force-remove`) once you've confirmed
the judgment no longer applies. This is the mechanism that keeps the `.lat` file and the ledger's
evidence from silently diverging.

## Generating a service

```sh
cd lattice && npx tsx src/cli.ts generate --session <session-dir> --out ../generated/<slug>
```

(Flags as of this writing: `--session` and `--out` only. Check `lattice/src/cli.ts`'s `generate`
case for the current flag set — a `--spec`-based variant that reads directly from a `.lat` file
instead of a session may exist by the time you read this.)

Then run and exercise the generated service:

```sh
cd generated/<slug> && npm install && npm test && npx tsx demo.ts
```

`npm test` runs the generated Vitest suite (guard rejection, successful transitions + outbox
events, invariant-triggered rollback). `demo.ts` drives the same three scenarios against a real
on-disk SQLite database with no mocks: a guard-rejected call, a successful transition that appends
an outbox event, and a guard-passing call whose post-state invariant fails at commit time, rolling
the whole transaction back. See `generated/subscriptions/demo.ts` for the real example.

## Where to go next

- [`docs/language/README.md`](language/README.md) — the language reference, including a 10-line
  tour of the syntax.
- [`docs/superpowers/specs/`](superpowers/specs/) — per-slice design docs for how each piece
  (elicitation engine, `.lat` parser, grammar growth, generation, inference) was built.
- **Not yet built:** conformance/anti-drift checking — spec vs. real code staying in sync — brief
  at `docs/superpowers/specs/2026-07-05-lattice-slice-2-conformance-brief.md`. Also not built: an
  app/UI beyond the Claude Code skill + CLI — brief at
  `docs/superpowers/specs/2026-07-05-lattice-app-ui-brief.md`.
