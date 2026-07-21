# CML → Lattice Representability Coverage

**Purpose.** This document records how well lattice (as of Slices 1–6) can represent the real
billing CML corpus. The goal is empirical confidence before building the Ruby `T::Struct`
backend — proof-by-corpus rather than proof-by-inspection — and a prioritized list of what
is still missing.

**Confidentiality.** The CML files being analysed are internal specs. This document contains
only construct-kind vocabulary, coarse prevalence buckets, and the lattice-mapping table. No
real domain names, field names, type names, or module names appear here. Synthetic/generic
names (`Amount`, `LineItem`, `Foo`) are used where an example is helpful.

---

## How the inventory was gathered

**Mechanism: text scan (`rg`) over the 25 `.cml` files** under `pay-server/lib/billing`.
Each construct kind and annotation was matched with a regex pattern; counts are aggregate
(no file- or context-level breakdown). This approach was chosen over the Ruby parser path
because:
1. It requires no devbox/autoloader plumbing and produces aggregate counts reliably.
2. The parser path is laborious to bootstrap standalone and provides no benefit for a
   prevalence audit.
3. The text-scan results were cross-checked against a handful of hand-reads for sanity.

The scan covered all 25 CML files (one `ContextMap` file + 24 context/sub-context files).

---

## Aggregate inventory (coarse — order of magnitude only, no names)

Counts are deliberately bucketed to order of magnitude — `none` / `one` / `single digits` /
`dozens` / `hundreds` — not precise figures.

### Declaration kinds

| Construct        | Order of magnitude | Prevalence      |
|------------------|--------------------|-----------------|
| `BoundedContext` | dozens             | pervasive (one per file) |
| `Module`         | dozens             | pervasive       |
| `Aggregate`      | dozens             | common          |
| `Entity`         | dozens             | common          |
| `ValueObject`    | dozens             | pervasive       |
| `Enum`           | hundreds           | pervasive       |
| `Type` (record)  | hundreds           | pervasive       |
| `TypeAlias`      | none               | absent          |
| `Service`        | hundreds           | pervasive       |
| `Hooks` block    | one                | rare            |
| `Repository`     | none               | absent          |
| `import`         | dozens             | pervasive (one per context) |
| `ContextMap`     | one                | rare (one workspace file) |

### Type surface

| Type form                    | Order of magnitude | Prevalence |
|------------------------------|--------------------|------------|
| `String`                     | hundreds           | pervasive  |
| `int` / `Integer`            | dozens             | common     |
| `Boolean` / `boolean`        | dozens             | common     |
| `Amount`                     | dozens             | common     |
| `Currency`                   | single digits      | rare       |
| `Decimal`                    | dozens             | common     |
| `Time`                       | hundreds           | pervasive  |
| `TimeRange`                  | dozens             | common     |
| `Metadata`                   | dozens             | common     |
| `double` / `float`           | none               | absent     |
| `List<T>`                    | hundreds           | pervasive  |
| `Optional<T>`                | hundreds           | pervasive  |
| `Map<K,V>`                   | dozens             | common     |
| `Result<T,E>`                | dozens             | common     |
| Union `A \| B`               | dozens             | common     |
| Qualified `Agg::Type`        | dozens (see note)  | concentrated |
| `@external(ref: "…")`        | hundreds           | pervasive  |

### Enum shape

| Shape                                        | Order of magnitude | Prevalence |
|----------------------------------------------|--------------------|------------|
| Plain enum (bare variant names only)         | the majority of enums | pervasive |
| Sum-type enum (variants with payload)        | present in ~a dozen files | common |

### Annotations and method qualifiers

| Annotation / qualifier                       | Order of magnitude | Prevalence |
|----------------------------------------------|--------------------|------------|
| `@public(doc: "…")` on field                 | hundreds           | pervasive  |
| `@public` (bare, on field/variant)           | hundreds           | pervasive  |
| `@hook-only` (standalone annotation on type) | dozens             | common     |
| `@public_doc` (on Enum or Type declaration)  | dozens             | common     |
| `@internal_comment`                          | dozens             | rare       |
| `public_doc(text: "…")` (inline block stmt in `Type` body) | dozens | common |
| `hook(…)` (method qualifier with parameters) | single digits      | rare       |
| Service `type = APP_PRIVATE/DOMAIN`          | dozens             | pervasive  |
| Method `documentation(text: "…")`            | dozens             | pervasive  |
| Method `read-only`                           | dozens             | common     |
| Method `write`                               | dozens             | pervasive  |
| Method `pessimistic_lock` / `lock_exempt`    | none               | absent     |
| Method `billing_context`                     | none               | absent     |
| `aggregateRoot` flag inside `Entity`         | dozens             | common     |

---

## Construct-by-construct mapping table

| CML construct | Prevalence | Lattice status | Notes |
|---|---|---|---|
| `BoundedContext` | pervasive | ✅ | `context Name { … }` |
| `Module` | pervasive | ✅ | `module Name { … }` nested inside context |
| `Aggregate` | common | ✅ | `aggregate Name { … }` |
| `Entity` | common | ✅ | `entity Name { … }` — top-level or nested inside aggregate |
| `ValueObject` | pervasive | ✅ | `value Name { … }` — solver-verified structural type |
| `Enum` (plain) | pervasive | ✅ | `enum Name { A, B, C }` |
| `Enum` (sum-type with payload) | common | ✅ | `enum Name { Variant(PayloadType) }` — lowers to discriminated union |
| `Type` record `Type Foo { … }` | pervasive | ✅ | `type Foo = { field : T … }` |
| `TypeAlias` (`Type A B`) | absent | ✅ | `type A = B` — not needed in practice |
| `Service` declaration + methods | pervasive | ✅ (partial) | `service Name { … }` with methods; see service-annotation gaps below |
| `@external(ref: "…")` | pervasive | ✅ | `builtin Name = "ref"` (opaque carrier + external ref) |
| `String` | pervasive | ✅ | `Text` primitive |
| `int` / `Integer` | common | ✅ | `Int` primitive |
| `Boolean` / `boolean` | common | ✅ | `Boolean` primitive (solver-dropped) |
| `Amount` / `Currency` / `Metadata` / `Time` / `TimeRange` / `Decimal` | common–pervasive | ✅ | `builtin` carriers (often via `@external`) |
| `double` / `float` | absent in corpus | ✅ (no gap needed) | Not used; if introduced, must be modeled as opaque `builtin` |
| `List<T>` / `Optional<T>` / `Map<K,V>` | pervasive | ✅ | Direct generics |
| `Result<T,E>` / other generics | common | ✅ | Carried generic constructor (`NamedType` with args) |
| Union `A \| B` | common | ✅ | `TypeUnion` in lattice grammar |
| Field `@public(doc: "…")` | pervasive | ✅ | Tag on `FieldDecl` — `@public`; doc text via `///` |
| Field `@hook-only` | common | ✅ | `@hookOnly` tag on `FieldDecl` |
| `@internal_comment` | rare | ⚠️ | No lattice equivalent for internal-only field docs; maps to `///` (public) — **internal vs public doc distinction deferred** (rare; see gap list) |
| `@public_doc` on a **Type/record** decl | common | ✅ | `///` doc comment on the `type` declaration (Slice 5) |
| `@public_doc` on an **Enum** decl | common | ✅ | `///` doc comment on the `enum` declaration (Slice 8) |
| `public_doc(text: "…")` inline block stmt inside `Type` body | common | ⚠️ | CML allows a free-standing `public_doc()` call as the first statement in a `Type` body (type-level doc separate from field docs). Lattice maps the same to `///` on the `type` declaration; the inline-block form has no equivalent — **`type-body-doc-inline`** |
| `aggregateRoot` flag inside `Entity` | common | ✅ (implicit) | Lattice's `aggregate` construct treats all its nested `entity` children as owned; the aggregate IS the root — semantic equivalent, no flag needed |
| `Qualified Agg::Type` ref | concentrated/dozens (translation convention — see note) | ✅ (convention) | Earlier audit overcounted this by including Ruby FQN segments inside `@external(ref: "…")` strings. Real `Agg::Type` refs in type positions are ~dozens, concentrated, and each short type name sits under a single aggregate — a namespacing/ownership convention, not cross-aggregate disambiguation. Translation: hoist the aggregate-scoped type to a uniquely-named context- or `module`-level `type`/`value`/`enum`; the qualifier resolves to that name (prefix only on a rare genuine collision). No language feature needed — see translation conventions below. |
| Method `read-only` | common | ✅ | `read-only` on `MethodDecl` |
| Method `write` | pervasive | ✅ | `performs` / `creates` on `MethodDecl` covers write semantics |
| Method `documentation(text: "…")` | pervasive | ✅ | `///` doc comment on `MethodDecl` |
| Service `type = APP_PRIVATE / DOMAIN` | pervasive | ✅ | `tier = appPublic \| appPrivate \| domain` on `ServiceDecl` (Slice 8) |
| Method `pessimistic_lock` / `lock_exempt` | absent | ❌ | Not observed in corpus; defined in CML grammar. No lattice equivalent — low priority |
| Method `billing_context` | absent | ❌ | Not observed in corpus. No lattice equivalent — low priority |
| `@TypeName` prefix on method return type / parameter type | common | ⚠️ | CML allows `@TypeName method(…)` and `method(@TypeName param)` as an alternative return-type notation. This is syntactic sugar for the same type system — the underlying types are representable. Lattice uses plain `method(param : T) : ReturnType` syntax. **Syntactic gap only; no semantic gap.** |
| `hook(phase:, input_type:, output_type:, extension_interface:, …)` method qualifier | rare | ❌ | Full hooks system (phase/extension interface/resource type/selection/project/release phase). Not represented in lattice at all — **`hooks-system`** |
| `Hooks` block declaration | rare (1 instance) | ❌ | Scoped block grouping hook-related types and methods. No lattice equivalent — subsumed by **`hooks-system`** gap |
| `import` (multi-file within a context) | pervasive | ❌/different | CML splits one logical context across files and joins with `import`. Lattice: one `.lat` file per context + a `contextMap` workspace file that uses `contains A from './a.lat'`. Structurally equivalent, but translation is non-trivial — **`multi-file-import`** |
| `ContextMap` with `[U]->[D]` relationships | rare (1 workspace file) | ✅ (partial) | Lattice has `contextMap Name { contains A from '…'; A upstream of B { … } }`. CML's `[U]->[D]` expresses directionality without named roles; lattice relationship roles (`anticorruption`, `conformist`, `openHost`, `publishedLanguage`) are optional. Basic upstream/downstream mapping works; role semantics are unenforced. ⚠️ **partial** |
| `Repository` block | absent | ❌ (low priority) | Zero occurrences in corpus; theoretically defined in CML grammar. Lattice auto-generates persistence in its reference service; no repository declaration needed. **Arguably out of scope.** |

---

## Prioritized gap list

Ordered by prevalence × materiality. Each entry names the gap, its prevalence bucket,
and a one-line description of the slice that would close it.

| # | Gap id | Prevalence | One-line slice sketch |
|---|--------|------------|-----------------------|
| 1 | `multi-file-import` | pervasive | Document and tool the one-file-per-context + `contextMap contains … from` pattern as the canonical translation of CML `import`; add a migration-aid CLI command. |
| 2 | `type-body-doc-inline` | common | Treat `public_doc()` inline block as type-level doc; map to a leading `///` on the `type` declaration. Translation is straightforward; the inline form can be folded to the decl doc at parse time. |
| 3 | `internal-vs-public-doc` | rare | Add an `@internal` doc tag to distinguish `@internal_comment` (not emitted to public API) from `///` (public). Currently both collapse to `///`. |
| 4 | `hooks-system` | rare | New slice: `hook(…)` method qualifier carrying phase/extension_interface/input_type/output_type/selection/resource_type/project/release-phase. Requires grammar extension + codegen target. Large scope — justified only when hooks are actively used beyond the current single instance. |
| 5 | `pessimistic_lock` / `billing_context` | absent | Low priority: not observed in corpus; defer until a real need surfaces. |

### Syntactic gaps (not semantic gaps)

- **`@TypeName` return/param prefix**: CML allows `@TypeName method(@ParamType p)` as an
  alternative return-type and parameter-type notation. The underlying types are fully
  representable in lattice; only the `@`-prefix syntax differs. A CML→lattice translator
  simply strips the `@` and moves the return type to lattice's `: ReturnType` position.
  No language change needed.

---

## Translation conventions

These patterns have no dedicated language feature in lattice; they translate by convention.

### `Agg::Type` qualified references

CML uses `Agg::Type` to scope a short type name to a named aggregate — a namespacing/ownership
convention. Each short name sits under a single aggregate; there are no genuine cross-aggregate
collisions.

**Translation:** hoist the aggregate-scoped type to a uniquely-named context- or `module`-level
`type`/`value`/`enum` declaration. The qualifier resolves to that name. On the rare genuine
collision (two aggregates each define a local type with the same short name), prefix the lattice
declaration: `AggFooBar` instead of `Bar`.

This is analogous to multi-file `import` (below): both are structural conventions without
requiring new language syntax.

### `public_doc(text: "…")` inline block inside a `Type` body

CML allows a free-standing `public_doc()` call as the first statement in a `Type` body, providing
a type-level doc separate from field docs.

**Translation:** map to a leading `///` on the lattice `type` declaration. The inline-block form
folds to the declaration doc at parse time, with no semantic distinction from a top-level `///`.

### Multi-file `import` (one context split across files)

CML splits one logical context across multiple files joined with `import`.

**Translation:** one `.lat` file per context + a `contextMap` workspace file that uses
`contains A from "path/to/a.lat"`. Structurally equivalent; each file is a complete parseable
context.

---

## Already covered: data-model layer is complete

The core DDD data-model surface is fully representable:

- All structural declaration kinds: `context`, `module`, `aggregate`, `entity`, `value`,
  `enum` (plain and sum-type, with `///` doc), `type` (record and alias), `builtin` carriers.
- Full type system: all primitives actually observed in the corpus (`String`/`Int`/`Boolean`/
  `Amount`/`Decimal`/`Time`/`TimeRange`/`Metadata`/`Currency`), `List`/`Optional`/`Map`/
  `Result` generics, union types (`A | B`), `@external` → `builtin` with ref.
- Field visibility and docs: `@public`, `@hookOnly`, `///` field, type, and enum docs.
- `aggregateRoot` semantics: implicit in lattice's aggregate-as-root model.
- Service methods: `read-only`, `performs`/`creates` (write), `///` doc, `tier` annotation.
- Workspace-level `contextMap` with upstream/downstream relationships.
- `Agg::Type` intra-context qualifiers: translation convention (hoist to named decl).

The remaining gaps are concentrated in the **hooks/extension system** — explicit scope for a
future slice and does not block the data-model backend work. The internal-vs-public doc
distinction (`@internal_comment` vs `@public_doc`) is deferred as a rare case.
