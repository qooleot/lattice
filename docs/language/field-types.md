# Field types

The type grammar shared by [entity](entity.md), [aggregate](aggregate.md), and
[event](event.md) fields.

## Syntax

```lat
context Billing {
  enum UsagePricing { overage, allUnits }

  entity Plan {
    planId : Id key
  }

  aggregate Subscription {
    subId        : Id key
    plan         : ref Plan
    seats        : Int
    label        : Text
    periodStart  : Date
    trialLength  : Duration
    balance      : Money
    pricingMode  : UsagePricing
    history      : List<Int>
  }
}
```

A field is `<camelId> : <type> [key] [const] [@<tag>]*`. `<type>` is one of:

- **Primitives:** `Int`, `Text`, `Date`, `Duration`, `Money`, `Id`.
- **An enum name** — any [enum](enum.md) declared in the same context.
- **A [value](value.md) name** — any `value` declared in the same context. Structural, keyless,
  and flat (prim/enum fields only) — see `value.md` for its own rules.
- **`ref <Target>`** — a same-context reference: `<Target>` must be an entity or aggregate
  declared in this file.
- **`ref Context.Type`** — a qualified, cross-context reference (see below).
- **`List<T>`** — a homogeneous list of any of the above, including nested lists.

A bare identifier resolves in this order: primitive → declared value → declared entity/aggregate
(`ref`) → enum (the fallback, `unresolved-enum` if it matches nothing declared).

`key` (unquoted, after the type) marks the field as the owner's identity field — see
[entity](entity.md)/[aggregate](aggregate.md) for the `missing-key` rule. `const` (unquoted, after
`key` if both are present) follows next; `@`-tags follow that — see [tags](tags.md).

## `const` fields

`const` (unquoted, after an optional `key` and before any `@`-tags) marks a field as immutable
after the owning entity/aggregate is created — the field may be set at creation but is never
reassigned afterward:

```lat
context Billing {
  aggregate Subscription {
    subId      : Id key
    plan       : ref Catalog.Plan const
    maxRetries : Int const
    seats      : Int
  }
}
```

- Any field type may carry `const` — primitives, enums, values, `ref`, and `List<T>` alike.
- It has no bearing on validation or invariants; `diff.ts` and the derived-invariant machinery
  treat `const` as a modifier only, the same way they treat `key`.
- Generation (`engine generate`) renders a `const` field as a `readonly` property on the
  corresponding TypeScript interface in the generated package's `types.ts`.
- Abstract-evolution analysis (Plan 3) treats `const` fields as frozen: they are excluded from the
  monotone-evolution defaults applied to plain mutable numeric fields.

## Cross-context refs are structural only

`ref Context.Type` (a dotted target) declares that this field points at a type owned by *another*
context. It is accepted by the grammar and by per-file validation, but it is structural only:

- It is excluded from [derived invariants](derived-invariants.md) — a qualified `ref` does not
  imply a refs-resolve rule the way a same-context `ref` does.
- It cannot appear in any invariant path. Attempting to reach through one —
  `subscription.plan.licenseFee` where `plan : ref Catalog.Plan` — is rejected with
  `cross-context-ref-unsupported` at the point the path tries to hop across the qualified ref.
- At the workspace level (checked by the `docs` command), the qualifying context and type pair
  must be covered by a declared relationship: some [context map](context-map.md) entry must
  `exposes` that type from that context to this one, or the workspace reports
  `uncovered-cross-context-ref`. A per-file load does not check this — only workspace compilation
  does, since it requires seeing the map and the exposing context's declarations.

## Semantic Rules

- An unqualified `ref Target` must name a real entity or aggregate declared in the same context
  (`unresolved-ref`); a qualified `ref Context.Type` is checked shape-only per file (each segment
  must be a valid identifier) and resolved against the workspace's `exposes` declarations only at
  `docs`-compile time.
- A value-typed field must name a declared value (`unresolved-value`) — see [value](value.md).
- An enum-typed field must name a declared enum (`unresolved-enum`).
- `List<T>` recurses: the element type `T` is validated by the same rules.
- A field named `state` is always rejected (`reserved-field-name`), regardless of type — `state`
  is reserved for lifecycle-state path accessors.

## Example

```lat
context Catalog {
  entity Plan {
    planId : Id key
  }
}
```

```lat
context Billing {
  aggregate Subscription {
    subId : Id key
    plan  : ref Catalog.Plan
  }
}
```

## See also

- [Enum](enum.md)
- [Value](value.md)
- [Entity](entity.md)
- [Tags](tags.md)
- [Context map](context-map.md)
- [Invariant](invariant.md)
