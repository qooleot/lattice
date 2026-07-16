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
    cancelledOn  : Date?
  }
}
```

A field is `<camelId> : <type>[?] [key] [const] [@<tag>]*`. `<type>` is one of:

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

A trailing `?` (immediately after the type, before `key`/`const`/tags) marks the field
**optional**: the owner may exist with no value for it at all. Optionality is a property of the
*field*, not a type of its own — `Money?` is not a distinct type, it is a `Money` field that may be
absent — so it composes with everything above except keys, lists, and value types (see Semantic
Rules). What absence *means* for a rule is never inferred: an invariant reading an optional field
must say, with `present()`, which it means — see [invariant](invariant.md).

`key` (unquoted, after the type and any `?`) marks the field as the owner's identity field — see
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

- Any field type may carry `const` — primitives, enums, `ref`, and `List<T>` alike. (On a *value*
  sub-field it is rejected with `value-no-const`, since value types are immutable by structure; on a
  `key` field it is tolerated but redundant.)
- It has no bearing on *invariant/semantic* validation or on rename/diff detection: `diff.ts` hashes
  a field by its type only, and the derived-invariant machinery ignores modifiers — `const` is
  treated the same way as `key`. (It does drive the `value-no-const` rule above.)
- Generation (`engine generate`) renders a `const` field as a `readonly` property on the
  corresponding TypeScript interface in the generated package's `types.ts`.
- `const` on a `ref` field is **not** shown in the mermaid class diagram (refs render as associations,
  not class members, so the `«readonly»` stereotype appears only on non-ref const fields).
- Abstract-evolution analysis (the inference slice's Plan 3, landed) treats `const` fields as
  **frozen**, excluding them from the monotone-up over-approximation the classifier applies to plain
  mutable numeric fields. Only non-`const` `Int`/`Money` fields evolve; `const` fields, `Date`/
  `Duration`, refs, and enums are frozen. This affects the classifier's solver model only — it has no
  bearing on generation or on non-classifier emission.

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

## `Text?`/`Id?` is structural only

`?` on a `Text` or `Id` field is accepted by the grammar and by validation, and it is real to
generation and to the prose — but it is structural only, for the same reason cross-context refs
are: the underlying field is already invisible to both solvers.

- `Text`/`Id` fields carry no solver encoding at all. Quint's `fieldQType` returns `null` for any
  non-`Int`-family primitive, and Alloy's sig emitter only pushes a prim field when `isIntPrim` —
  so a `Text`/`Id` field is dropped from the solver-facing model whether or not it is optional.
  There is no field for a companion presence flag to sit beside.
- It cannot appear in any invariant path. A path ending at a `Text`/`Id` field is already rejected
  with `unrepresentable-path` (see [invariant](invariant.md)), and `?` does not change that — so
  `present(label)` on `label : Text?` is rejected exactly like `label > 0` is. The two checks are
  independent and both run over the same body, so they can stack: `label > 0` reports
  `unrepresentable-path` **and** `absence-undecided`, because the absence gate consults only the
  field's optionality, never its representability. `present(label)` reports `unrepresentable-path`
  alone. The rejection stands either way — where the gate does fire here, it is redundant, not
  load-bearing.
- It is excluded from [derived invariants](derived-invariants.md) — but so is every `Text`/`Id`
  field, optional or not. The only family optionality changes is the `Money` one.

So `?` on `Text`/`Id` is documentation of intent, not a constraint: nothing the solvers check, and
nothing an invariant can appeal to. `Money?`, `Int?`, `Date?`, `Duration?`, enum, and `ref` fields
are the ones where optionality carries semantic weight — `present(owner)` on `owner : ref Other?`
is accepted, Alloy gives the field a `lone` relation, and Quint gives it a real presence flag
(`ownerPresent`), so both solvers agree on whether absence is reachable. Value types are not on
that list, at either level: `?` on a `value`-typed field **and** `?` on a sub-field of a `value`
declaration are both rejected outright (`optional-value`, see Semantic Rules). A value flattens
into `<field>_<sub>` sig relations for Alloy, which has no multiplicity left to vary at either
level — it would emit `one` whatever the marker said, making `present(window.end)` a tautology
while Quint made it a real flag, and the two solvers would then disagree about the very thing
this list promises they agree on. So the list is exhaustive — every type `?` is *legal* on either
carries semantic weight or is `Text`/`Id`.

## Semantic Rules

- An unqualified `ref Target` must name a real entity or aggregate declared in the same context
  (`unresolved-ref`); a qualified `ref Context.Type` is checked shape-only per file (each segment
  must be a valid identifier) and resolved against the workspace's `exposes` declarations only at
  `docs`-compile time.
- A value-typed field must name a declared value (`unresolved-value`) — see [value](value.md).
- An enum-typed field must name a declared enum (`unresolved-enum`).
- `List<T>` recurses: the element type `T` is validated by the same rules.
- A `key` field cannot be optional (`optional-key`) — identity is never absent.
- A `List<T>` field cannot be optional (`optional-list`) — an absent list and an empty list are the
  same fact; `List<T>` already means zero or more.
- A `value`-typed field cannot be optional (`optional-value`) — a value type flattens into its
  sub-fields for the solvers (`window : Window` becomes Alloy's `window_len`, not a `window`
  relation), so there is no single field for the optionality marker to attach to.
- Neither can a **sub-field of a `value` declaration** (`optional-value` again, reported on the
  value): `value Window { end : Int? }` is rejected for the same reason one level down — the
  sub-field is already a flattened `one` relation with no multiplicity of its own to carry.
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
