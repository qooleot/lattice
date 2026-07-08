# Entity

A structural type with identity but no consistency boundary of its own — a value referenced from
an [aggregate](aggregate.md) (or another entity) by `ref`, not a thing directly mutated by a
[lifecycle](lifecycle.md) or protected by its own [invariants](invariant.md). Compare with aggregate,
which owns both.

## Syntax

```lat
/// Pricing definition: per-seat license fee plus usage billing in one of two modes.
context Billing {
  enum UsagePricing { overage, allUnits }

  entity Plan {
    planId        : Id key
    licenseFee    : Money
    usageRate     : Money
    includedUnits : Int
    pricingMode   : UsagePricing
  }
}
```

`entity <PascalId> { <field>* }`, with an optional leading `///` doc. Each field is
`<camelId> : <type> [key] [@<tag>]*` — see [field types](field-types.md) for the type grammar and
[tags](tags.md) for the `@`-annotations.

## Semantic Rules

- Exactly one field must carry `key` — the field that marks the entity's identity, the one other
  owners reference by `ref EntityName`. An entity with no `key` field reports `missing-key`.
- The entity name must be PascalCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier (`invalid-name`, `reserved-word`).
- Field names must be camelCase by convention and valid identifiers; a field named `state` is
  rejected outright (`reserved-field-name`) — `state` is reserved for lifecycle-state accessors
  (`<Lifecycle>.state`).
- A field's type must resolve: an enum name must be declared (`unresolved-enum`), and an
  unqualified `ref Target` must name a real entity or aggregate in the same context
  (`unresolved-ref`).
- Duplicate top-level names (an entity sharing a name with an enum or aggregate) report
  `duplicate-name`.

## Example

```lat
context Billing {
  entity Customer {
    customerId : Id key
    name       : Text
  }
}
```

## Nested in an aggregate

An entity can also be declared *inside* an [aggregate](aggregate.md) body instead of at context
level:

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    lines     : List<InvoiceLine>

    entity InvoiceLine {
      lineId : Id key
      amount : Money
    }
  }
}
```

This is ownership, not a reference: `InvoiceLine` exists only as part of its owning `Invoice` and
has no consistency boundary of its own — compare with a top-level entity, which is a standalone
value referenced by `ref`. A parent field typed `List<Child>`, where `Child` is a nested entity
declared in the same aggregate, is an **owned collection** — the aggregate holds zero or more
`Child` instances, keyed by the child's own key field.

- Same key rule as a top-level entity: exactly one field must carry `key`, or the nested entity
  reports `missing-key`.
- Nested entities carry **prim/enum fields only** in v1 — no `ref` and no `List` fields inside a
  child. A child field of either kind reports `nested-entity-flat`; this keeps owned collections
  one level deep until there's evidence to go further.
- A nested entity's name joins the same flat namespace as top-level enums/entities/aggregates —
  it must be unique context-wide (`duplicate-name`) and is itself a valid `ref` target: a bare
  field type naming a nested entity resolves as a reference to it, the same as a top-level owner.
- Exactly one owned-collection field per child entity: two `List<Child>` fields on the same
  aggregate targeting the same child report `duplicate-owned-collection-target` — the solver
  encodings key children by entity name, so a second field would collide.
- No solver encoding yet: owned collections are structurally validated and round-trip through the
  printer, but list-typed fields are dropped before solving (quint/alloy) and candidate paths that
  reach into a collection are rejected.

## See also

- [Aggregate](aggregate.md)
- [Field types](field-types.md)
- [Tags](tags.md)
- [Naming conventions](naming-conventions.md)
