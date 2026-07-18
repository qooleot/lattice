# Module

A `module` block groups declarations inside a [`context`](context.md). It is a **grouping label**,
not a new name scope — declaration names remain context-globally unique, and references resolve
exactly as they would without modules. A module name may even coincide with a declaration name,
exactly as in CML.

## Syntax

```lat
context Billing {
  enum Status { draft, active }

  module BillingEngine {
    value Amount {
      amount : Money
    }
    aggregate Invoice {
      invoiceId : Id key
      total     : Money @unsigned
      status    : Status
    }
  }

  module ItemTimelines {
    entity LineItem {
      lineId : Id key
      amount : Money @unsigned
    }
  }
}
```

`module <PascalId> { <item>* }` where an item is an `enum`, `entity`, `event`, `aggregate`,
`value`, `service`, `builtin`, or `type` declaration. Context-level cross-cutting items
(`ticksPerDay`, `invariant`) are **not** allowed inside a module block.

## Semantics

- Module is a **grouping label only** — the model stays flat. Each declaration inside a module
  gains an optional `module` label (e.g. `invoice.module === 'BillingEngine'`), but name
  resolution, ref validation, and the solver are completely unaffected.
- A module name may coincide with a declaration name — per CML precedent, modules occupy their
  **own namespace** and are NOT in the type duplicate-name pool. `module Invoice` alongside
  `aggregate Invoice` is legal.
- **No nesting** — `ModuleDecl` is not a valid `ModuleItem`. Nested sub-modules are out of scope.
- **Empty modules** are allowed by the grammar but not retained in the model (a module with no
  members contributes nothing and will not be emitted by the serializer).

## Codegen

### TypeScript

The TS emitter (`renderTsTypes`) stays flat — no `namespace` wrapper. Before a module's types it
emits a banner comment:

```
// ── module: BillingEngine ──
export interface Amount { ... }
export interface Invoice { ... }
```

Top-level (module-less) types are emitted first, exactly as today. Types within a module follow
in first-appearance order of the module.

### Ruby (future)

The Ruby backend (a later slice) will nest module members inside `module BillingEngine ... end`
blocks, producing the idiomatic Ruby namespace path `Opus::Billing::BillingEngine::Invoice`.

## Serializer round-trip

`astToCode` groups declarations by module on output. Top-level declarations (no module) are
emitted first by kind; then each module block is emitted in first-appearance order:

```
  module BillingEngine {
    value Amount { ... }
    aggregate Invoice { ... }
  }
```

Parsing the output restores the same model with the same module labels.

## Naming rules

- Module names must be valid identifiers and not a [reserved word](naming-conventions.md)
  (`invalid-name`, `reserved-word`).
- PascalCase is conventional for module names (`naming-convention` warning if violated).
- Two modules with the same name in the same context is `duplicate-module` (hard error).

## See also

- [Context](context.md)
- [Naming conventions](naming-conventions.md)
- [README](README.md)
