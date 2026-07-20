# Enum

A closed set of named values — the vocabulary a [field](field-types.md) can hold when it isn't a
number, date, or reference. Enums are declared at the [context](context.md) level and referenced
by name from any entity, aggregate, or event field.

## Syntax

```lat
context Billing {
  /// Billing cadence for a subscription plan.
  enum BillingPeriod { monthly, annual }

  entity Plan {
    planId : Id key
    period : BillingPeriod
  }
}
```

`enum <PascalId> { <camelId>, <camelId>, … }` — at least one value, comma-separated. A leading
`///` doc comment is supported (it attaches to the enum declaration and round-trips). Values are
read back with `EnumName.value` in a predicate, e.g. `period == BillingPeriod.monthly`.

## Sum-type (payload) variants

A variant may carry a **payload type**, making the enum a sum type / tagged union:

```lat
context Billing {
  builtin Amount = "Opus::Monetary::Core::Types::Amount"
  type CustomUnit = { unitId : Id  qty : Int }

  enum CreditGrantAmount { monetary(Amount), customPricingUnit(CustomUnit), none }
}
```

The payload is **carried** — dropped from solving (the solver still sees the variant names). Codegen
*lowers* the enum to each language's idiom: TypeScript emits a **discriminated union** tagged by
`kind`, with the payload under `value` — `{ kind: 'monetary'; value: Amount } | … | { kind: 'none' }`
— since TS has no positional ADT variant. A plain enum (no payloads) still lowers to a string-literal
union. A payload type that names nothing declared reports `unresolved-enum`.

## Semantic Rules

- The enum name must be PascalCase by convention (`naming-convention`, warning-level) and must be
  a valid identifier, not a [reserved word](naming-conventions.md) (`invalid-name`,
  `reserved-word`).
- Each value must be camelCase by convention (`naming-convention`) and a valid, non-reserved
  identifier.
- A field typed with an undeclared enum name reports `unresolved-enum` at load.
- A leading `///` doc comment attaches to the enum and is stored on `EnumDef.doc`. It round-trips
  through the printer and is emitted by the TypeScript codegen as a `/** doc */` JSDoc block above
  the `export type` line.

## Example

```lat
context Billing {
  /// How usage overage is priced for this plan.
  enum UsagePricing { overage, allUnits }

  entity Plan {
    planId      : Id key
    pricingMode : UsagePricing
  }
}
```

## See also

- [Field types](field-types.md)
- [Entity](entity.md)
- [Naming conventions](naming-conventions.md)
- [Doc comments](doc-comments.md)
