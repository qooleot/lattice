# Lattice — Mermaid Docs (Diagram Projection) Design

- **Date:** 2026-07-05
- **Status:** Approved design (brainstormed with Taras 2026-07-05). Next step: writing-plans.
- **Parent design:** [`docs/plan.md`](../../plan.md) — §5.1 (constructs incl. `service`, profile/import
  graph as the context map's tactical layer), §5.2 (worked example), §6 (projections: "Diagram —
  statechart + context map, generated"; `code → diagram` is the easy direction).
- **Prior art researched:** Context Mapper (contextmapper.org). Findings that shaped this design
  are inlined in §2.

---

## 1. What this slice is

Build the **diagram projection** — the third of the three projections over the one AST — as
generated **Mermaid** docs, plus the minimal **structural** language growth the desired diagrams
require (services, qualified cross-context refs, and a workspace context-map index).

Three diagram types, per the user's scoping decisions:

1. **Context map** — CML-style strategic diagram across bounded contexts (one mermaid flowchart).
2. **Domain relationship diagram** — per context: aggregates/entities/values-of-record, enums, and
   **application services inside the context module** (one mermaid classDiagram).
3. **Lifecycle statecharts** — per aggregate machine region (mermaid stateDiagram-v2).

Explicitly **out**: invariant overlays/annotations on diagrams (user decision).

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
- In CML, **context relationships live in a `ContextMap { }` block, not inside bounded contexts**.
  We mirror this: relationships live in the workspace index file (§4), not in per-context models.
- Invocation: their CLI (`cm generate -i file.cml -g plantuml -o dir`) is a thin wrapper over the
  same generator classes as the IDE plugins. We similarly put everything behind the existing
  JSON-out CLI.

## 3. Architecture decision — workspace of specs + index file

**Chosen (user-approved):** each spec directory stays one context / one session / one model, as
today. The context map is drawn **across** spec directories, driven by a single authored **index
file** `specs/context-map.json`. The multi-context-`DomainModel` alternative was rejected: it
ripples through `validateModel`, `matchTemplates`, both solver emitters, session state, the
fidelity harness, and the golden traces, and collides with queued slices 3 (.lat parser) and 4
(machine growth) — for zero verification benefit in a structural-first slice.

This matches plan.md §5.1: "**The import graph is the context map's tactical layer** — a
cross-context reference is only legal over published/imported types."

**Depth (user-approved): structural-first.** New constructs are real AST citizens — parsed,
validated for well-formedness, round-tripped through `.lat` / prose / mermaid projections — but do
**not** enter the invariant/solver grammar. Verification of services (`requires`/`ensures`/`saga`,
plan §5.3) is a later slice; including them now as unchecked strings would be decoration, not spec.

## 4. Language & model growth

### 4.1 `ServiceDef` (per-context AST, `src/ast/domain.ts`)

```ts
export interface ServiceDef {
  name: string;
  command: Field[];        // reuses Field/TypeRef
  result?: Field[];
  emits?: string[];        // names of declared EventDefs in the same context
  doc?: string;
}
// DomainModel gains: services: ServiceDef[]   (default [] — see §8 migration note)
```

Deliberately deferred: `requires`, `ensures`, `saga` (verification slice, plan §5.3).

`validateModel` additions: service names are valid identifiers and unique; command/result field
types resolve (same rules as entity fields); every `emits` entry names a declared event in the
same context.

### 4.2 Qualified cross-context refs

`TypeRef`'s `ref` target may be qualified: `"Catalog.Plan"`. Rules:

- **Excluded from invariant machinery, with explicit handling — never silent.** Qualified refs do
  not match the NoOrphan template (tpl-9) and never reach the Alloy/Quint encodings. Any code path
  that walks `ref` fields for solver purposes skips qualified targets; `validateCandidate` rejects
  a candidate that names a qualified-ref path with a named diagnostic (e.g.
  `cross-context-ref-unsupported`), so an elicitation attempt fails loudly rather than mis-encodes.
- Within one session, `validateModel` checks only the *shape* of a qualified target
  (`Context.Type`, both valid identifiers). Resolution of the target type happens at workspace
  level (§4.3), since a single session cannot see sibling specs.

### 4.3 The workspace index — `specs/context-map.json`

The single authored "index" file (user decision). JSON now because the `.lat` parser is slice 3;
once that lands the index gets a `.lat` rendering like everything else.

```json
{
  "name": "AcmeBilling",
  "contexts": [
    { "name": "Subscriptions", "path": "subscriptions" },
    { "name": "Catalog",       "path": "catalog" }
  ],
  "relationships": [
    { "kind": "upstream-downstream",
      "upstream": "Catalog", "downstream": "Subscriptions",
      "upstreamRoles": ["OHS", "PL"], "downstreamRoles": [],
      "exposes": ["Plan"],
      "doc": "Subscriptions consumes plan definitions" }
  ]
}
```

- `kind`: `upstream-downstream` (with optional roles from CML's vocabulary — upstream: `OHS`,
  `PL`; downstream: `ACL`, `CF`) | `partnership` | `shared-kernel` (symmetric: use
  `left`/`right` instead of `upstream`/`downstream`; no roles; `exposes` optional and
  bidirectional).
- **Validation** (new `src/ast/workspace.ts`, same never-throw diagnostics style as
  `validateModel`):
  - every `contexts[].path` resolves to a spec dir containing a readable `model.json` whose
    `context` equals the declared `name`;
  - relationship endpoints are declared contexts; no self-relationships; no duplicate context
    names;
  - **every qualified ref in every member model is covered**: there is a relationship between the
    two contexts whose `exposes` includes the target type, and the target context actually
    declares that type. This enforces plan §5.1's published-types rule.
  - a declared `exposes` type that doesn't exist in the upstream context is a diagnostic.

## 5. Generators — `src/emit/mermaid/`

One creator module per diagram type (§2), each a pure function `model(s) → string` returning
mermaid source with **no filesystem access** (I/O stays in the CLI layer, as with existing
emitters). Identifier discipline: mermaid node ids are sanitized (`[^A-Za-z0-9_]` → `_`), display
labels carry the real names.

1. **`contextMap.ts`** — `contextMapToMermaid(index, models) → string`. `flowchart LR`; one node
   per context; one labeled edge per relationship, e.g.
   `Catalog -- "[U: OHS,PL] → [D] exposes Plan" --> Subscriptions`; partnership/shared-kernel as
   undirected-styled edges with their kind as label. Additionally, dashed edges for *observed*
   qualified-ref usage (`Subscriptions -.Plan.-> Catalog`) when not already implied by a declared
   relationship's label — the map shows both the declared strategy and the actual import graph.
2. **`domainDiagram.ts`** — `domainToMermaid(model) → string`. `classDiagram` with
   `namespace <Context>` as the module box. Classes: aggregates and entities with typed fields
   (`key` marked, e.g. `+planId : Id «key»`), `<<enumeration>>` classes listing values,
   `<<service>>` classes listing command fields (and result if present). Associations from `ref`
   fields: `Invoice --> Subscription : subscription`; `list of ref` gets `"*"` multiplicity;
   service→aggregate edges from `ref` fields in command/result. Cross-context refs render as a
   class stub outside the namespace named with the qualified name and stereotyped `<<external>>`,
   plus a dashed dependency to it (`Subscription ..> Catalog_Plan : plan`), keeping foreign types
   visually distinct from local ones.
3. **`statechart.ts`** — `machineToMermaid(aggregate, region) → string`. `stateDiagram-v2`;
   `[*] --> <initial>`; one edge per declared transition labeled with the transition name;
   `@terminal` states get `--> [*]`; only regions with a declared machine are rendered
   (generate-what's-modeled).

Doc comments (`doc` fields) render as prose in the markdown wrapper (§6), not inside diagrams.

## 6. Outputs

User decision: **both** markdown and raw `.mmd`.

Per spec dir (written by `emit`):
- `spec.diagrams.md` — headings, doc-comment prose, and embedded ```mermaid blocks: domain diagram
  first, then one statechart section per aggregate region.
- `diagrams/CD_<Context>.mmd`, `diagrams/SD_<Aggregate>_<region>.mmd` — one raw mermaid file per
  diagram (Context Mapper's naming convention, adapted).
- `model.json` — AST snapshot (new; see §7 — decouples docs generation from live sessions).

Workspace level (written by `docs`):
- `specs/context-map.generated.md` — the context map with prose (named `.generated.md` to avoid
  any collision/confusion with the authored `context-map.json` index).
- `specs/diagrams/context-map.mmd`.

All generated files begin with a `<!-- generated by lattice; do not edit -->` header (or `%%`
comment in `.mmd`).

## 7. CLI

- **`emit`** (existing command, extended): in addition to `spec.prose.md` + `spec.lat`, writes
  `model.json` and the per-spec diagram outputs (§6). `written[]` in the JSON result lists them.
- **`docs`** (new command): `engine docs --workspace specs [--out specs]`. Loads
  `<workspace>/context-map.json`, loads every member `model.json`, runs workspace validation
  (§4.3), and on success writes the workspace outputs and **regenerates every member context's
  diagram set** from its `model.json`. Errors use the established JSON error contract
  (`{ error: 'workspace-invalid', diagnostics: [...] }` etc.). `docs` does not require sessions —
  only emitted spec dirs.

## 8. Migration & compatibility

- `DomainModel.services` is optional-with-default-`[]` at load boundaries so existing session
  state, fixtures, and golden traces load unchanged (same treatment as other optional fields).
- `astToCode` (`.lat`) and `astToProse` learn to render `service` blocks and qualified refs;
  `.lat` output for models without services is byte-identical to today (golden parseback protocol
  unaffected).
- Existing `emit` consumers see strictly more files written, no changed semantics.

## 9. Demo — real end-to-end (no Stripe references anywhere; user decision)

Grow the live subscriptions spec into a real two-context workspace:

1. New **Catalog** context: its own session, owning `Plan` (moved from Subscriptions). Template
   invariants (NonNegative licenseFee/usageRate, etc.) re-derive there via `init`'s template
   matching. The elicited `Overage_Implies_Real_Allowance` invariant concerns Plan fields only —
   it moves to the Catalog session; the migration task documents exactly which ledger entries are
   re-established and how (re-adoption in the Catalog session with provenance noting the
   migration), rather than silently rewriting history.
2. **Subscriptions** model: `Plan` entity removed; `plan : ref Catalog.Plan`; add 2–3 real
   services (`ActivateSubscription`, `CancelSubscription`, `RecordUsage`) with real command fields
   and `emits` where the machine already implies events.
3. Author `specs/context-map.json` (Catalog upstream `[OHS, PL]` → Subscriptions downstream,
   exposes `Plan`).
4. Run `emit` on both sessions + `docs`; commit generated outputs; verify rendering on GitHub.

The session split is its own migration task in the implementation plan with explicit care notes —
witnesses in the Subscriptions ledger that mention Plan fields stay valid history there; nothing
is deleted.

## 10. Testing

- **Golden emitter tests** (vitest, alongside existing suites): fixture models → exact expected
  mermaid, covering: no machine (no statechart emitted), multiple regions, terminal/initial states,
  `list of ref` multiplicity, enums, services with/without result, qualified refs, empty
  relationship roles, partnership/shared-kernel rendering, id sanitization (names that would break
  mermaid).
- **Workspace validation tests**: missing path, name mismatch, undeclared relationship endpoint,
  qualified ref without covering relationship, `exposes` of a type the upstream doesn't declare,
  duplicate context names, self-relationship.
- **Mermaid syntax gate**: every generated diagram in tests is parsed with `@mermaid-js/parser`
  (dev-dependency; fall back to `mmdc` only if the parser package proves insufficient) so we never
  commit diagrams GitHub can't render.
- **CLI tests**: `emit` writes the new files; `docs` happy path + each error contract; generated
  headers present.
- **Invariant-machinery exclusion tests**: a model with a qualified ref → tpl-9 does not adopt for
  that field; a candidate naming a qualified-ref path → `cross-context-ref-unsupported`.

## 11. Slice boundaries (what this is NOT)

- No invariant overlays on diagrams (user decision).
- No `requires`/`ensures`/`saga` on services; no `acl`/`translate`/`external` constructs — the
  demo needs none of them (no Stripe), and they belong to the verification-depth slice.
- No changes to `machine`/`TransitionDef` (slice 4's territory), the invariant grammar,
  `evaluateCandidate`, solver emitters, or session/ledger machinery beyond the exclusion
  diagnostics in §4.2.
- No `.lat` parsing (slice 3); the index stays JSON until slice 3 lands.
