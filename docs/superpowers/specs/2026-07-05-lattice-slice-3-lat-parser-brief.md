# Lattice — Slice #3 Brief: The `.lat` Parser (Engineer Authoring)

- **Date:** 2026-07-05
- **Status:** SUPERSEDED — the approved design is [`2026-07-05-lattice-slice-3-lat-parser-design.md`](2026-07-05-lattice-slice-3-lat-parser-design.md); this brief remains as historical context only.
- **Parent design:** [`docs/plan.md`](../../plan.md) — esp. §6 (projections & the authoring
  boundary), §5.5 (doc comments), §19 Risk 4 (round-trip).
- **Prior slice:** [`2026-07-03-lattice-elicitation-slice-1-design.md`](2026-07-03-lattice-elicitation-slice-1-design.md)
  (complete, merged; see its §6 for why the parser was deferred — decision D6).

---

## 1. What slice 3 is

Make the `.lat` code projection **read-write**. Today `.lat` is output-only (pretty-printed by
`lattice/src/emit/code.ts`); the source of truth is the AST held as structured data. Slice 3 adds
the reverse direction so an engineer can hand-edit `.lat` in their editor and have the edit flow
back into the canonical store and out through every other projection:

```
engineer edits .lat
   → Langium parser → parsed AST
   → DIFF against stored AST
   → validation:  well-formedness (validateModel)
                  grammar closure (validateCandidate — same closed grammar §6.1)
                  LEDGER RECONCILIATION (see §3 — the load-bearing novelty)
   → canonical store updated
   → all projections re-render (prose, .lat re-normalized, later: generated code)
```

Recommended tooling: **Langium** (TypeScript-native; one grammar file yields parser + validation +
LSP/editor support + formatter). The grammar's `ID` terminal must equal the identifier rule already
enforced at the AST layer (`/^[A-Za-z_][A-Za-z0-9_]*$/`, diagnostic `invalid-name` in
`src/ast/validate.ts`) — one rule, two enforcement points, never two definitions.

## 2. Why it was deferred, and why now

Slice 1's D6: in the elicitation flow, no human ever types `.lat` — Claude submits structured JSON,
the engine builds AST nodes directly, `.lat` is a rendering. A parser guards a door nobody walks
through. Slice 3 opens that door for engineers. Sequencing note from the 2026-07-05 discussion: the
edit loop's payoff is largest once spec→implementation generation exists (editing the spec then
regenerates the service); generation is being pursued as its own slice. Slice 3 does not depend on
generation and can proceed in parallel — but its demo should acknowledge what an edit *drives*
today (revalidation + re-rendered projections) vs. later (regeneration).

## 3. Ledger reconciliation — the load-bearing design element

The verdict ledger is the **canonical spec artifact** (fidelity-gate outcome, binding — see the
GATE OUTCOME block in `docs/superpowers/plans/2026-07-03-lattice-slice-1.md` Global Constraints,
and `lattice/fidelity/results/REPORT.md`). An engineer's `.lat` edit is a semantic claim that must
be reconciled with the judged cases behind each adopted invariant, using the SAME machinery the
loop uses (`evaluateCandidate` in `src/engine/evaluate.ts`, consistency check as in
`ledgerConflicts` in `src/engine/hypothesis.ts`). Three outcomes:

| Edit class | Treatment |
|---|---|
| Structural (add field/state/transition, rename, add enum value) | validate well-formedness → apply → re-render. Renames must rewrite references AND consider ledger witnesses that mention old names (design question: migrate witness field keys, or record a rename mapping?) |
| Invariant edit, consistent with every judged case | apply; provenance updated (e.g. `hand-edited <date>, consistent with w1–w9`) |
| Invariant edit contradicting a verdict | **reject loudly**, naming the witness and verdict: "this edit permits the state in w3, judged forbid on 07-05 — re-judge with the domain expert or revert." The engineer cannot silently overrule the founder. |

`///` doc comments parse INTO `doc` fields (parent plan §5.5) — never dropped. `//` plain comments:
decide policy (likely: legal but not round-tripped; warn on save that they will be lost — or ban
them in favor of `///`; a fork for brainstorming).

## 4. The storage fork (user decision required in brainstorming)

Which artifact is git-facing canonical?

- **A. `spec.json` canonical, `.lat` parsed-on-save and re-normalized.** Safest; the AST stays the
  single truth; `.lat` diffs are always normalizer-clean. Requires emitting `spec.json` (AST +
  adopted invariants + provenance) — a small shared prerequisite also wanted by the generation
  slice; `engine emit` currently writes only `spec.prose.md` + `spec.lat`.
- **B. `.lat` canonical, JSON derived.** Matches "diff-able, PR-able" engineer ergonomics most
  directly; but the ledger and provenance don't live in `.lat`, so truth is split across two files
  anyway; parse errors make the store unreadable.

**DECIDED (user, 2026-07-05): Option B — `.lat` is the source of truth.** Consequences the
slice-3 design must honor:
- The ledger (`ledger.jsonl`) REMAINS canonical for verdicts/anchors (gate binding): judged
  evidence is never editable via text. `.lat` owns the spec content; the ledger owns the evidence;
  provenance comments in `.lat` are renders of ledger data, ignored (not trusted) on parse.
- `spec.json` demotes to a derived cache (still worth emitting for machine consumers like the
  generation slice — regenerate it on every successful parse).
- Parse errors now mean the canonical store is temporarily unreadable — the design needs an
  explicit degraded-state story (last-good AST cache + loud diagnostics, never silent fallback).
- The predicate concrete syntax (§6.6) is now unavoidable in v1: if `.lat` is truth, every adopted
  invariant body must have a complete, parseable textual form — budget it as core scope, not an
  option.

## 5. The core correctness property (must be a test from day one)

Round-trip identity, property-tested over real specs and fixtures:

- `parse(astToCode(ast)) ≡ ast` (print→parse = identity on AST, modulo provenance comments)
- `astToCode(parse(text)) ≡ normalize(text)` (parse→print = normalization on text)

Run it against: `specs/subscriptions/spec.lat` (real elicited spec, committed), the three golden
fixture domains (`lattice/fixtures/domains/*.json` → printed → parsed), and hand-written negative
cases (syntax errors, unknown constructs, out-of-grammar invariant forms → structured diagnostics,
never crashes — same never-throw discipline as the CLI).

## 6. Scope questions for brainstorming (one at a time, with the human)

1. Storage fork (§4).
2. LSP/editor support in-slice or deferred? (Langium gives it nearly free; the demo value is high,
   but it's still scope.)
3. CLI surface: `engine load --lat <file>` vs `engine sync` watching the file; how conflicts with a
   concurrently-running elicitation session are handled (likely: refuse when a session holds the
   model, or re-init flow).
4. Rename semantics vs. ledger witnesses (§3 table, row 1).
5. Comment policy (`//` vs `///`).
6. Whether `unique while <states> by (...)` and invariant bodies get full concrete syntax now, or
   whether invariants beyond `unique` render as opaque anchored comments in v1 (they currently
   print as `invariant Name {}  // <english> // ⚓ <provenance>` — parsing THAT back requires a
   concrete syntax for predicate bodies that `astToCode` does not yet emit. This is the biggest
   hidden-scope item in the slice: a real predicate syntax for statePredicate/cardinality/
   conservation bodies, both printed and parsed. Budget it explicitly.)

## 7. Constraints binding this slice (inherited, non-negotiable)

- Gate binding: ledger canonical; no silent overrules; provenance renders in projections.
- Closed grammar: the parser accepts nothing `validateCandidate` rejects; structured diagnostics.
- TypeScript strict; `npx tsc --noEmit` clean and full `npx vitest run` green (real solvers,
  serialized; golden traces A/B/C must not be weakened) before every commit.
- Worktree bootstrap: run `bash lattice/scripts/ensure-ready.sh` before first engine/test use.
- User preference (durable): no Wizard-of-Oz/simulated validation — real parser, real round-trips.
- Never `git add -A`; conventional commits.

## 8. Pointers

- Engine layout: `lattice/src/{ast,engine,emit,solvers}/`, CLI `lattice/src/cli.ts`, skill
  `.claude/skills/elicit-spec/SKILL.md`.
- Printer to make bidirectional: `lattice/src/emit/code.ts`.
- Real spec to dogfood against: `specs/subscriptions/` + `.lattice-session-subscriptions/`
  (45-entry ledger).
- Slice-1 process artifacts (how slices are executed here): brainstorm → spec in
  `docs/superpowers/specs/` → writing-plans → subagent-driven development with per-task review;
  progress ledger pattern in `.superpowers/sdd/progress.md` (gitignored scratch).
