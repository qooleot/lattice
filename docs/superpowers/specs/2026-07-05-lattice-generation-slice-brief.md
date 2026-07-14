# Lattice — Generation Slice Brief: Spec → Implementation

- **Date:** 2026-07-05
- **Status:** SUPERSEDED — the approved design is [`2026-07-09-lattice-generation-slice-design.md`](2026-07-09-lattice-generation-slice-design.md); this brief remains as historical context only.
- **Parent design:** [`docs/plan.md`](../../plan.md) — §5.3 (services are verified commands; RPC is
  a generated projection), §11.5 (the conformance adapter's generated-first architecture — several
  of its layers PRESUPPOSE this slice), §11.6 (the CI wedge this slice's generated tests feed),
  §13 (events vs transitions — the outbox is the semantic event stream).
- **Why this slice exists:** it completes the founder story (describe domain → judged spec →
  RUNNING SERVICE), and it manufactures the real implementation that the conformance slice
  (anti-drift, plan §11.5) needs as a target. Conformance was deliberately re-sequenced AFTER
  generation on 2026-07-04–05 because §11.5's adapter assumes generated surfaces exist.

---

## 1. Input contract (and the `.lat`-canonical decision)

Generation consumes the **AST**: `DomainModel` + adopted `CandidateInvariant`s + their ledger
anchors (`lattice/src/ast/domain.ts`, `invariant.ts`; session shapes in `src/engine/session.ts`).

**Storage decision (user, 2026-07-05): `.lat` is becoming the source of truth for spec content**
(slice 3 builds the parser; see the DECIDED block in
`2026-07-05-lattice-slice-3-lat-parser-brief.md` §4). The ledger stays canonical for
verdicts/anchors. Consequence for THIS slice: consume the AST through a loader seam —
today that's the session store / a derived `spec.json` cache; after slice 3 it's `parse(spec.lat)`
producing the same AST. Design the generator against the AST type, never against a file format,
and the seam absorbs the transition. (If `spec.json` emission doesn't exist yet when this slice
starts, adding it to `engine emit` is an authorized small prerequisite — it's the derived cache
the slice-3 decision already calls for.)

## 2. What the generator plausibly emits (scope to be cut in brainstorming)

From the Subscriptions spec (the committed real spec at `specs/subscriptions/`):

- **Entity + value types** from the domain model (TS types; identifier hygiene already enforced).
- **Repository layer** — persistence fork §4.1.
- **Command handlers from transitions**: `requires` → precondition check (structured rejection),
  state change, `emits` → domain event appended to an **outbox** (a table/log — this is the §13
  semantic event stream and the future conformance slice's primary interface).
- **Invariant enforcement at commit**: adopted invariants checked after every command — fork §4.3
  on how they're compiled. This is plan §11.6's "passive assertions" born generated instead of
  retrofitted.
- **A generated test suite**: guards reject bad commands, invariants hold after generated command
  sequences, events land in the outbox; plus provenance comments tying each generated check to its
  spec element and ledger anchors.
- **NOT in v1** (recommend): HTTP/OpenAPI surface (plan §5.3 calls it a projection — in-process
  invocation is enough to prove the thesis); sagas/`external` calls; migrations beyond
  create-schema.

## 3. The hard dependency: transitions (slice-4 Pillar A)

Command handlers are born from transitions, and today's machines are nearly transition-empty;
`TransitionDef` lacks `requires`/`emits` until slice 4's machine enrichment lands. **Check slice-4
status first.** Two honest cuts to brainstorm:
- **Wait/coordinate:** consume slice-4's enriched schema (preferred if it's landing soon — the
  generation demo is dramatically better with verbs).
- **Scope v1 to what exists:** entities + repositories + invariant enforcement + a generic
  `applyStateChange` command per region (guards absent) — "a database with rules." Honest but
  anticlimactic; if chosen, say so plainly in the design.
Do NOT build machine enrichment inside this slice — slice 4 owns it (coordination rule from its
brief §6).

## 4. The forks for brainstorming (one at a time, with the human)

0. **`service` surface syntax — RESOLVED (user, 2026-07-07, slice-4 design §3.6):** the user
   objected to the `command` param vocabulary in plan §5.3's sketch; slice 4 now defines the
   construct as **methods with typed parameters** that *reference* machine transitions
   (`performs Aggregate.transition`), plus `creates`/`read-only` kinds and method-level
   `requires` over params. This slice is a pure CONSUMER of that surface: it builds execution
   semantics (handlers, atomicity, outbox, transport projection) and the data-write method story
   (needs effects), not the declaration syntax. See the slice-4 design's §3.6 and deferred-work
   registry before brainstorming forks here.

1. **Persistence**: in-memory + SQLite (better-sqlite3) vs an ORM (parent product spec-core is
   MikroORM-shaped — plan §11.5.4 assumes a generated persistence mapping that can be read in
   reverse; a real mapping strengthens the future conformance story). YAGNI pressure vs.
   conformance-seam value — a genuine trade.
2. **The regeneration story** (THE classic codegen fork): recommended v1 = generated code is
   NEVER hand-edited (clearly marked output dir; extension via separate non-generated files);
   alternatives (protected regions, diff/merge) are drift factories — note that *deliberate*
   hand-edits to generated code are exactly the drift the conformance slice will later detect, so
   the boundary must be crisp. Also: determinism — same AST ⇒ byte-identical output (test it).
3. **Invariant compilation**: generate readable standalone checks vs. link the engine's
   `evaluateCandidate` as a runtime dependency. (Readable generated checks are the product story;
   the evaluator is the semantics oracle — a differential test between the two is cheap and
   powerful. Consider: generate readable checks, differential-test them against the evaluator.)
4. **Output location & lifecycle**: `generated/<slug>/` in-repo? Its own package.json? How regen
   interacts with git (clean dir per regen).
5. **Which spec drives the demo**: Subscriptions (committed, real) — presumably yes; rev-rec after
   its measured run lands.

## 5. Seams to leave (for the conformance slice — do not build)

- The outbox is an append-only, replayable event log — event-trace conformance (§11.5.2) will diff
  it against spec traces. Keep its schema stable and documented.
- Repositories expose a read path suitable for a future `observe()` projection (§11.6).
- Generated tests are structured so the CI wedge can later evaluate invariants over states the
  suite already produces.

## 6. Validation (real end-to-end, per the durable no-simulation rule)

- Generate from `specs/subscriptions/`; the generated package's own test suite passes for real.
- A demo script drives real commands: a guard rejection, a successful transition with an outbox
  event, an invariant violation attempt rejected at commit — all against the real generated
  service and real persistence, no mocks.
- Determinism test: regenerate → byte-identical.
- Differential test (if fork §4.3 goes that way): generated checks agree with `evaluateCandidate`
  on the ledger's judged witnesses — the spec's own evidence re-used as the generator's test
  oracle. (This is the slice's most Lattice-flavored test: the judged cases follow the spec into
  the implementation.)

## 7. Constraints binding this slice (inherited, non-negotiable)

- Gate binding: generated artifacts carry provenance (which spec element, which anchors); nothing
  presented as verified beyond what the ledger supports.
- The engine is not forked: generator lives beside the other emitters (`lattice/src/emit/` family
  or a sibling `lattice/src/generate/` — brainstorm), consuming the same AST.
- TypeScript strict; before every commit `cd lattice && npx tsc --noEmit && npx vitest run` (real
  solvers, serialized); golden traces A/B/C stay green, never weakened. The generated package has
  its OWN test/typecheck gates too.
- Worktree bootstrap: `bash lattice/scripts/ensure-ready.sh` before first use.
- Never `git add -A`; conventional commits.
- Coordination: shares AST types with slice 4 (schema producer) and the loader seam with slice 3
  (`.lat` canonical). Highest-collision file: `src/ast/domain.ts`. Rebase often; raise sequencing
  with the human rather than guessing.

## 8. Pointers

- AST + adopted invariants: `lattice/src/ast/*.ts`, `src/engine/session.ts` (SessionState,
  LedgerEntry), the committed session `.lattice-session-subscriptions/`.
- Emitter family to sit beside: `lattice/src/emit/{alloy,quint,prose,code}.ts`.
- Evaluator (semantics oracle): `src/engine/evaluate.ts`.
- Worked narratives: plan §5.2–5.3 (what generated code is FOR), §11.5 (what conformance will
  need from it), §16–17.
