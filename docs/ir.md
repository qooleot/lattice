# The lattice IR (intermediate representation)

The **IR** is the stable, versioned, language-neutral contract that external code
generators consume. Lattice's job ends at the IR: it parses `.lat`, verifies the model,
and emits `ir.json`. Downstream generators — in whatever repo and language a team owns
(e.g. a Ruby `T::Struct` generator in pay-server, a Java AutoValue generator in
zoolander) — read the IR and project it into their own folder/architecture conventions.

Nothing team-specific or language-specific lives in lattice. The IR is the plugin seam.

## Why a separate type from `DomainModel`

`DomainModel` (`src/ast/domain.ts`) is the engine's own working representation. It is free
to evolve alongside the parser, solver, and derivation internals. `IR` (`src/ir/schema.ts`)
is a deliberate seam **in front of** it, so those internal changes do not break downstream
consumers. Callers depend on `IR` / `toIR`, never on `DomainModel` directly.

IR **v1** mirrors the AST's `Def` types exactly (it reuses them by import rather than
redeclaring an identical shape). A future **v2** may diverge — flatten `TypeRef`, drop
AST-only fields, etc. — and that divergence is absorbed by the `IR` interface + `toIR`
function, announced via an `irVersion` bump.

## Emitting

```
engine emit-ir --spec path/to/spec.lat [--ledger session-dir] --out ir.json
engine emit-ir --session session-dir --out out-dir/         # writes out-dir/ir.json
```

Mirrors the `codegen` command's input handling exactly (same `--spec`/`--session` pair,
same parse and derived-name-collision gates). It has no `--lang` flag — the IR is
language-neutral by construction. If `--out` ends in `.json` it is used as the exact file;
otherwise `ir.json` is written inside the given directory.

## Shape

The top-level envelope (`IR` in `src/ir/schema.ts` is the source of truth):

```ts
interface IR {
  irVersion: string;        // "1"
  context: string;
  doc?: string;
  ticksPerDay?: number;
  builtins: BuiltinDef[];    // normalized: always present (possibly [])
  typeAliases: TypeAliasDef[];
  records: RecordDef[];
  enums: EnumDef[];
  values: ValueDef[];
  entities: EntityDef[];
  aggregates: AggregateDef[];
  events: EventDef[];
  services: ServiceDef[];
}
```

`builtins`, `typeAliases`, and `records` are **optional on the AST** (absent when none are
declared) but **normalized to always-present arrays on the IR**, so a consumer never has to
branch on `?? []`.

### Types (`TypeRef`)

Every field/param/return type is a `TypeRef`, a discriminated union with exactly **10**
kinds. A consumer's type mapper must handle all ten:

| kind | payload | consumer note |
|---|---|---|
| `prim` | `prim`: Int·Text·Date·Duration·Money·Id·Boolean | map to the target's scalar |
| `enum` | `enum`: name | reference the emitted enum |
| `ref` | `target`: owner name, or `Context.Type` (cross-context) | foreign identifier |
| `value` | `value`: name | reference the emitted value type |
| `list` | `of`: TypeRef | owned collection |
| `optional` | `of`: TypeRef | nullable/absent (head `Optional<T>` is normalized to `Field.optional`) |
| `map` | `key`, `of`: TypeRef | associative |
| `generic` | `ctor`: name, `args`: TypeRef[] | e.g. `Result<T,E>` |
| `union` | `arms`: TypeRef[] | `A \| B` |
| `carrier` | `name`: opaque builtin/external type | import, don't emit a definition |

`src/ir/schema.ts` carries a compile-time drift guard (`assertKnownTypeRef`, exhaustive over
`kind`) so adding an 11th kind to the AST without updating the IR fails `tsc`.

### Declarations

- **`EnumDef`** — `values: string[]`; optional sum-type `payloads` (`{ variant: TypeRef }`)
  lowered by consumers to a discriminated union / sealed subclasses.
- **`ValueDef`** — structural value type; `fields`; optional `invariants` (own-field laws,
  each `{ name, body: Predicate, doc? }`).
- **`RecordDef`** — free-form carried struct (`type Name = { … }`).
- **`TypeAliasDef`** — `type Name = T` (inlined at use sites; retained for round-trip).
- **`EntityDef`** / **`AggregateDef`** — `fields`; aggregates add optional child `entities`
  and a `machine` (`regions` + `transitions`).
- **`EventDef`** — event schema `fields`.
- **`ServiceDef`** — `methods` (each with `params`, optional `returns`, a `kind` of
  `readOnly` / `performs` / `creates`, and optional `requires` guard), optional `tier`
  (`appPublic` · `appPrivate` · `domain`).
- **`Field`** — `name`, `type`, and optional `key` / `const` / `optional` / `tags` / `doc`.
- **`BuiltinDef`** — opaque carrier; optional `ref` (external FQN to import instead of emit).

All declarations carry an optional `module` grouping label.

## Versioning policy

- `irVersion` is bumped only when the IR shape changes in a way a v1 consumer could not
  read. Additive, backward-compatible fields do not require a bump.
- A shape change ships with migration notes and an updated golden fixture
  (`test/fixtures/ir/abstract.ir.json`; regeneration steps are in `test/cli-emit-ir.test.ts`).

## Confidentiality

The golden fixtures and this doc use abstract names only (`Widget`, `Gadget`, `Amount`, …).
Real domain specs and their emitted IR live only in the consuming repos, never here.
