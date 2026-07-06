# Lattice — Mermaid Docs (Diagram Projection) Design

- **Date:** 2026-07-05 (revised 2026-07-06 after slice 3 landed: everything is now authored in
  `.lat`; the AST is an in-memory intermediate, never a git-facing artifact)
- **Status:** Approved design (brainstormed with Taras 2026-07-05/06). Next step: writing-plans.
- **Parent design:** [`docs/plan.md`](../../plan.md) — §5.1 (constructs incl. `service`, profile/import
  graph as the context map's tactical layer), §5.2 (worked example), §6 (projections: "Diagram —
  statechart + context map, generated"; `code → diagram` is the easy direction).
- **Builds on slice 3:** [`2026-07-05-lattice-slice-3-lat-parser-design.md`](2026-07-05-lattice-slice-3-lat-parser-design.md)
  (complete, merged) — the Langium `.lat` parser (`src/parse/`), `apply`/`sync` with ledger
  reconciliation, and decision **P1: `.lat` is the git-facing canonical spec; no spec JSON ever**.
- **Prior art researched:** Context Mapper (contextmapper.org). Findings that shaped this design
  are inlined in §2.

---

## 1. What this slice is

Build the **diagram projection** — the third of the three projections over the one AST — as
generated **Mermaid** docs, plus the **structural** language growth the desired diagrams require:
`service`, qualified cross-context refs, and a workspace **context map file** — all authored in
the Lattice language (`.lat`), parsed by the slice-3 Langium parser. The AST (`DomainModel`, new
`ContextMapModel`) is an in-memory intermediate between `.lat` and every projection; it is never
an authored or git-facing artifact (slice-3 P1; the session dir's `model.json` remains engine
working state only).

Three diagram types, per the user's scoping decisions:

1. **Context map** — CML-style strategic diagram across bounded contexts (one mermaid flowchart).
2. **Domain relationship diagram** — per context: aggregates/entities, enums, and **application
   services inside the context module** (one mermaid classDiagram).
3. **Lifecycle statecharts** — per aggregate machine region (mermaid stateDiagram-v2).

Explicitly **out**: invariant overlays/annotations on diagrams (user decision).

Also in scope (user decision, 2026-07-06): a **whole-language reference** under `docs/language/`
in the style of Context Mapper's per-pattern doc pages — one short page per construct, covering
the existing language and the constructs this slice adds (§10).

## 2. Context Mapper research — what transfers

- CML generators are **one small "Creator" class per diagram type**, doing plain typed iteration
  over the parsed model and building output text imperatively — no visitor framework, no templates
  for first-class outputs. This maps directly onto Lattice's existing `src/emit/` one-function-per-
  target pattern. We adopt it: one creator module per diagram type.
- **Generate what's modeled**: CML emits a state diagram only if an aggregate declares transitions.
  We adopt the same rule everywhere.
- CML's graphical context map needs **Graphviz installed** — a recurring support burden in their
  docs. Mermaid-as-text sidesteps layout entirely (GitHub/docs renderers do it). This is the core
  reason mermaid over their approach.
- **Mermaid is an unfilled gap in Context Mapper** — they have PlantUML + a Freemarker escape
  hatch, no dedicated mermaid generator.
- In CML, **context relationships live in a `ContextMap { }` block, not inside bounded contexts**,
  authored in the same DSL as everything else, and **the mapping detail sits on the relationship
  itself**: the upstream declares `exposedAggregates` (plus `implementationTechnology`,
  `downstreamRights`) in the relationship body — not on a module or application service. We mirror
  this: relationships live in a workspace `context-map.lat` (§4.3) and carry `exposes` there.
- CML's bracket codes (`[U,OHS,PL]->[D,ACL]`) have keyword-form equivalents in CML itself
  (`Upstream-Downstream`). We adopt keyword-only syntax (user decision): `.lat` favors readable,
  self-documenting forms, and one canonical spelling keeps `parse ∘ print = id` trivial.
- Invocation: their CLI (`cm generate -i file.cml -g plantuml -o dir`) is a thin wrapper over the
  same generator classes as the IDE plugins. We similarly put everything behind the existing
  JSON-out CLI.

## 3. Architecture — workspace of specs + a `.lat` context map index

**Chosen (user-approved):** each spec directory stays one context / one session / one canonical
`spec.lat`, as today. The context map is drawn **across** spec directories, driven by a single
authored index file **`specs/context-map.lat`** — written in the Lattice language, parsed by the
slice-3 parser, holding the context roster and the strategic relationships (CML's `ContextMap`
block, Lattice-flavored). The multi-context-`DomainModel` alternative was rejected: it ripples
through `validateModel`, `matchTemplates`, both solver emitters, session state, the fidelity
harness, and the golden traces, and collides with slice 4 — for zero verification benefit in a
structural-first slice.

This matches plan.md §5.1: "**The import graph is the context map's tactical layer** — a
cross-context reference is only legal over published/imported types."

**Depth (user-approved): structural-first.** New constructs are real language citizens — parsed,
printed (round-trip `parse ∘ print = id`, extending slice 3's property tests), validated for
well-formedness, and rendered into prose and mermaid projections — but do **not** enter the
invariant/solver grammar. Verification of services (`requires`/`ensures`/`saga`, plan §5.3) is a
later slice; including them now as unchecked strings would be decoration, not spec.

## 4. Language growth (all in `lat.langium` + `fromLangium.ts` + the `code.ts` printer)

### 4.1 `service` (per-context construct)

New `ContextItem` alternative:

```
/// Cancels an active or trialing subscription at period end.
service CancelSubscription {
  command { subscription: ref Subscription }
  result  { subscription: ref Subscription }      // optional
  emits SubscriptionCanceled                       // optional, repeatable; names declared events
}
```

AST: `ServiceDef { name, command: Field[], result?: Field[], emits?: string[], doc? }`;
`DomainModel` gains `services: ServiceDef[]` (default `[]` at load boundaries so existing session
state and fixtures load unchanged). Service names are PascalCase (matching plan §5.2's
`UpgradePlan`; warning-level `naming-convention` diagnostic like slice-3 P8).

`validateModel`: unique valid service names; command/result field types resolve like entity
fields; every `emits` entry names a declared event in the same context.

**Reconciliation class:** services are never ledger-referenced (no witness mentions them), so
service edits are structural — `apply` applies them without ceremony. Renames of
aggregates/entities/enums/events referenced from service fields or `emits` rewrite those
references (extend `renames.ts` reference-rewrite and `inferRenameSpec` accordingly; a `service`
rename scope is added, tracked like transition renames).

Deliberately deferred: `requires`, `ensures`, `saga` (verification slice, plan §5.3).

### 4.2 Qualified cross-context refs

`RefType` target may be qualified: `plan : ref Catalog.Plan`. Rules:

- **Excluded from invariant machinery, with explicit handling — never silent.** Qualified refs do
  not participate in the derived refs-resolve family (slice-3 P9) and never reach the Alloy/Quint
  encodings. `validateCandidate` rejects a candidate naming a qualified-ref path with a named
  diagnostic (`cross-context-ref-unsupported`), so an elicitation or hand-edit attempt fails
  loudly rather than mis-encodes.
- Within one context, validation checks only the *shape* of a qualified target (`Context.Type`,
  both valid identifiers). Resolution of the target type happens at workspace level (§4.4), since
  a single session cannot see sibling specs.

### 4.3 The context map file — `specs/context-map.lat`

The single authored index (user decision), in the Lattice language. The Langium entry rule
generalizes: `LatFile: LatContext | ContextMapDecl` (one grammar, two top-level forms; a `.lat`
file holds exactly one of them).

```
/// Acme billing: catalog-driven subscriptions.
contextMap AcmeBilling {
  contains Subscriptions
  contains Catalog from "catalog"        // path optional; default = decapitalized context name

  /// Subscriptions consumes plan definitions from the catalog.
  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage      // optional
    downstream roles anticorruption                  // optional; or: conformist
    exposes Plan                                     // published types (comma-separated)
  }

  // symmetric kinds (no roles/exposes direction — exposes optional, bidirectional):
  // Billing partnership with Ordering { }
  // Billing sharedKernel with Ordering { }
}
```

- **Keyword-only syntax (user decision)** — no CML bracket codes; one canonical spelling. Role
  vocabulary maps 1:1 to CML's: upstream `openHost` (OHS), `publishedLanguage` (PL); downstream
  `anticorruption` (ACL), `conformist` (CF). `exposes` mirrors CML's `exposedAggregates` — it
  belongs to the relationship, declared by the upstream — generalized to accept aggregates *and*
  entities (Lattice refs legitimately target entities); each listed type must exist in the
  upstream context. `///` docs attach to the map and to each relationship as everywhere else
  (slice-3 P5).
- AST: `ContextMapModel { name, contexts: [{ name, path }], relationships: [...] , doc? }` — new
  `src/ast/contextmap.ts`. In-memory only.
- Printed by `code.ts` like every construct (round-trip property extends to map files).

### 4.4 Workspace validation (new `src/ast/workspace.ts`)

Same never-throw, file:line:col-capable diagnostics style as slice 3. Given a parsed
`ContextMapModel` and the parsed member specs:

- every `contains` resolves to `<workspace>/<path>/spec.lat` that parses, and its `context` name
  equals the declared name; no duplicate context names; no self-relationships; relationship
  endpoints are declared contexts;
- **every qualified ref in every member spec is covered**: a relationship exists between the two
  contexts whose `exposes` includes the target type, and the upstream context actually declares
  that type (plan §5.1's published-types rule);
- a declared `exposes` type the upstream doesn't declare is a diagnostic.

## 5. Generators — `src/emit/mermaid/`

One creator module per diagram type (§2), each a pure function `AST → string` returning mermaid
source with **no filesystem access** (I/O stays in the CLI layer, as with existing emitters).
Identifier discipline: mermaid node ids are sanitized (`[^A-Za-z0-9_]` → `_`), display labels
carry the real names.

1. **`contextMap.ts`** — `contextMapToMermaid(map, models) → string`. `flowchart LR`; one node
   per context; one labeled edge per relationship using the keyword vocabulary, e.g.
   `Catalog -- "upstream (openHost, publishedLanguage) exposes Plan" --> Subscriptions`;
   partnership/shared-kernel as undirected-styled edges with their kind as label. Additionally, dashed edges for *observed*
   qualified-ref usage (`Subscriptions -.Plan.-> Catalog`) when not already implied by a declared
   relationship's label — the map shows both the declared strategy and the actual import graph.
2. **`domainDiagram.ts`** — `domainToMermaid(model) → string`. `classDiagram` with
   `namespace <Context>` as the module box. Classes: aggregates and entities with typed fields
   (`key` marked), `<<enumeration>>` classes listing values, `<<service>>` classes listing command
   fields (and result if present). Associations from `ref` fields:
   `Invoice --> Subscription : subscription`; `List<ref>` gets `"*"` multiplicity;
   service→aggregate edges from `ref` fields in command/result. Cross-context refs render as a
   class stub outside the namespace named with the qualified name and stereotyped `<<external>>`,
   plus a dashed dependency to it (`Subscription ..> Catalog_Plan : plan`), keeping foreign types
   visually distinct from local ones.
3. **`statechart.ts`** — `machineToMermaid(aggregate, region) → string`. `stateDiagram-v2`;
   `[*] --> <@initial state>`; one edge per declared transition labeled with the transition name;
   `@terminal` states get `--> [*]`; only regions with a declared machine are rendered
   (generate-what's-modeled).

Doc comments (`///`, in the AST as `doc`) render as prose in the markdown wrappers (§6), not
inside diagrams.

## 6. Outputs

User decision: **both** markdown and raw `.mmd`. All generated files begin with a
`<!-- generated by lattice; do not edit -->` header (`%%` comment form in `.mmd`).

Per spec dir (rendered by `writeProjections` — i.e. on `emit`, `apply`, and `sync`, exactly when
prose re-renders):
- `spec.diagrams.md` — headings, doc-comment prose, and embedded ```mermaid blocks: domain diagram
  first, then one statechart section per aggregate region.
- `diagrams/CD_<Context>.mmd`, `diagrams/SD_<Aggregate>_<region>.mmd` — one raw mermaid file per
  diagram (Context Mapper's naming convention, adapted).

Workspace level (written by `docs`):
- `specs/context-map.generated.md` — the context map with prose (named `.generated.md` so it can
  never be confused with the authored `context-map.lat`).
- `specs/diagrams/context-map.mmd`.

## 7. CLI

- **`writeProjections`** (existing, slice 3) additionally writes the per-spec diagram outputs;
  `written[]` in the JSON results of `emit`/`apply` lists them. Diagrams are thereby projections
  in the full slice-3 sense: hand-edit `spec.lat` → `apply`/`sync` → diagrams re-render.
- **Workspace regeneration is part of compilation, not a separate generator step (user
  decision).** After writing per-spec projections, `apply` checks whether a `context-map.lat`
  exists in the workspace root (discovered from the spec path: `dirname(dirname(latPath))`); if
  so, it re-runs workspace validation and regenerates the workspace outputs. `sync` additionally
  watches `context-map.lat` itself, so editing the map re-renders the map docs. Workspace
  diagnostics from this hook are reported in the `apply`/`sync` result but do not block the
  per-spec apply (the spec edit already reconciled; a broken sibling must not hold it hostage).
- **`docs`** (new command, the on-demand/CI entry point): `engine docs --workspace specs`.
  Parses `<workspace>/context-map.lat` and every member `spec.lat` **directly via the slice-3
  parser** (no sessions involved — `.lat` is canonical), runs workspace validation (§4.4), and on
  success writes the workspace outputs and each member's diagram set. Errors use the established
  JSON error contract (`{ error: 'workspace-invalid', diagnostics: [...] }`), diagnostics
  carrying file:line:col where the parser provides them. Same routine as the `apply`/`sync` hook
  — one workspace compile, three invocation surfaces.
- **`init --lat <spec.lat>`** (small addition): bootstrap a session from a canonical `.lat`
  instead of model JSON — parse, validate, then proceed exactly as `init --model`. Needed so new
  contexts (Catalog, below) are born from `.lat`, keeping the AST an intermediate everywhere.

## 8. Migration & compatibility

- `DomainModel.services` defaults to `[]` at load boundaries; existing session state, fixtures,
  and golden traces load unchanged.
- `astToCode` and `astToProse` learn `service` blocks and qualified refs; `.lat` output for models
  without them is byte-identical to today (golden parseback protocol unaffected). The round-trip
  property (`parse ∘ print = id`) extends over the new constructs and map files.
- Existing `emit`/`apply` consumers see strictly more files written, no changed semantics.

## 9. Demo — real end-to-end (no Stripe references anywhere; user decision)

Grow the live subscriptions spec into a real two-context workspace, dogfooding the slice-3 edit
loop:

1. **New `Catalog` context**: author `specs/catalog/spec.lat` by hand (context `Catalog`, owning
   `Plan` moved from Subscriptions); `init --lat` creates its session; template invariants
   (non-negative Money via P9, etc.) derive there. The elicited `overageImpliesRealAllowance`
   invariant concerns Plan fields only — its ledger witnesses are copied into the Catalog ledger
   as append-only entries with an explicit migration provenance note (judgments preserved, the
   human is not re-asked, history is not rewritten).
2. **Subscriptions**: hand-edit `spec.lat` — remove `Plan`, change to `plan : ref Catalog.Plan`,
   add 2–3 real services (`ActivateSubscription`, `CancelSubscription`, `RecordUsage`) — and run
   `apply`. Plan-related removals are ledger-referenced, so this exercises the slice-3
   `--force-remove` path deliberately; the migration task documents the exact invocation and the
   ledger entries affected. Nothing is deleted from the Subscriptions ledger; migrated invariants'
   provenance notes point at Catalog.
3. Author `specs/context-map.lat` (`Catalog upstream of Subscriptions { upstream roles openHost,
   publishedLanguage; exposes Plan }`).
4. Run `docs`; commit generated outputs; verify rendering on GitHub.

## 10. Language reference docs — `docs/language/`

A whole-language reference, borrowing Context Mapper's page template (studied on their
open-host-service page): each page is short (~200 words), with a one-paragraph **description**
linking related pages, a **Syntax** section with a ` ```lat ` code block, **Semantic Rules**
bullets that name the real diagnostics (`invalid-name`, `naming-convention`,
`cross-context-ref-unsupported`, …), an **Example**, and **See also** links. `docs/language/
README.md` is the index (GitHub renders it for the directory) with a grouped table of contents.

Page inventory:

| Group | Pages |
|---|---|
| Overview | `README.md` (index + 10-line tour), `projections.md` (prose/diagrams are generated; do-not-edit) |
| Strategic | `context-map.md` (contextMap, contains/from), `upstream-downstream.md` (incl. `exposes`), `open-host.md`, `published-language.md`, `anticorruption.md`, `conformist.md`, `partnership.md`, `shared-kernel.md` |
| Structure | `context.md`, `enum.md`, `entity.md`, `aggregate.md`, `field-types.md` (primitives, `List<>`, `ref`, qualified refs), `event.md`, `service.md` |
| Behavior | `machine.md` (regions, states, `@initial`/`@active`/`@terminal`), `transition.md` |
| Invariants | `invariant.md` (declaration, predicates, operators), `invariant-forms.md` (all 8 bodies: predicate, unique, refs resolve, count, terminal, monotonic, conserve, leads-to), `derived-invariants.md` (slice-3 P9: what is implied, not printed) |
| Meta | `doc-comments.md` (`///`, the `//` ban), `naming-conventions.md`, `tags.md`, `editing.md` (apply/sync, rename ceremony, ledger reconciliation from the engineer's seat) |

Like CML's role pages (Open Host Service, Conformist, …), each role keyword gets its own page:
the DDD pattern in a paragraph, then the Lattice spelling.

**Docs are held to the code's standard:** every ` ```lat ` block in `docs/language/` is extracted
and parsed in tests (context files, map files, and — for fragment examples — wrapped in a minimal
valid context first), so a grammar change that invalidates an example fails CI, and examples can
never rot into pseudo-code. A grammar change therefore ships with its page update (added to the
institutional checklist).

## 11. Testing

- **Grammar/round-trip**: slice-3 round-trip property tests extended over `service`, qualified
  refs, and `contextMap` files; parse-error tests for malformed map syntax.
- **Golden emitter tests** (vitest, alongside existing suites): fixture models → exact expected
  mermaid, covering: no machine (no statechart emitted), multiple regions, terminal/initial
  states, `List<ref>` multiplicity, enums, services with/without result, qualified refs, empty
  relationship roles, partnership/shared-kernel rendering, id sanitization (names that would
  break mermaid).
- **Workspace validation tests**: missing/unparseable member, name mismatch, undeclared
  relationship endpoint, qualified ref without covering relationship, `exposes` of a type the
  upstream doesn't declare, duplicate context names, self-relationship.
- **Mermaid syntax gate**: every generated diagram in tests is parsed with `@mermaid-js/parser`
  (dev-dependency; fall back to `mmdc` only if the parser package proves insufficient) so we never
  commit diagrams GitHub can't render.
- **CLI tests**: `emit`/`apply` write the new files; `docs` happy path + each error contract;
  `apply` inside a workspace regenerates the map (and reports, without blocking, workspace
  diagnostics from a broken sibling); `apply` outside any workspace skips the hook silently;
  `init --lat` happy path + parse-error path; generated headers present.
- **Invariant-machinery exclusion tests**: a model with a qualified ref → no derived refs-resolve
  for that field; a candidate naming a qualified-ref path → `cross-context-ref-unsupported`.
- **Reconcile tests**: service add/edit/rename applies without ceremony; renaming an aggregate
  referenced from a service command rewrites the reference.
- **Docs parse gate**: every ` ```lat ` block under `docs/language/` parses (fragments wrapped in
  a minimal context; see §10).

## 12. Slice boundaries (what this is NOT)

- No invariant overlays on diagrams (user decision).
- No `requires`/`ensures`/`saga` on services; no `acl`/`translate`/`external` constructs — the
  demo needs none of them (no Stripe), and they belong to the verification-depth slice.
- No changes to `machine`/`TransitionDef` (slice 4's territory), the invariant grammar,
  `evaluateCandidate`, solver emitters, or session/ledger machinery beyond the exclusion
  diagnostics in §4.2 and the reconcile/rename extensions in §4.1.
- No LSP/editor work for the new constructs (slice-3 P2 stands; the grammar makes it cheap later).
