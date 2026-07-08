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

## See also

- [Aggregate](aggregate.md)
- [Field types](field-types.md)
- [Tags](tags.md)
- [Naming conventions](naming-conventions.md)
