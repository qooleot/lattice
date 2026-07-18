# Enum

A closed set of named values — the vocabulary a [field](field-types.md) can hold when it isn't a
number, date, or reference. Enums are declared at the [context](context.md) level and referenced
by name from any entity, aggregate, or event field.

## Syntax

```lat
context Billing {
  enum BillingPeriod { monthly, annual }

  entity Plan {
    planId : Id key
    period : BillingPeriod
  }
}
```

`enum <PascalId> { <camelId>, <camelId>, … }` — at least one value, comma-separated. Values are
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

Enums do **not** accept a `///` doc comment: the grammar has no doc-comment slot on `EnumDecl`, so
attaching one is a dedicated parse error rather than a generic syntax error:

```
/// Billing cadence.
enum BillingPeriod { monthly, annual }
```

This produces `enum-doc-unsupported` — "`///` docs cannot attach to an enum — move the doc onto
the context, an entity, event, aggregate, or invariant, or remove it." Put the explanatory doc on
the entity or aggregate that uses the enum instead.

## Semantic Rules

- The enum name must be PascalCase by convention (`naming-convention`, warning-level) and must be
  a valid identifier, not a [reserved word](naming-conventions.md) (`invalid-name`,
  `reserved-word`).
- Each value must be camelCase by convention (`naming-convention`) and a valid, non-reserved
  identifier.
- A field typed with an undeclared enum name reports `unresolved-enum` at load.
- `///` immediately before `enum` is rejected at parse time (`enum-doc-unsupported`), before
  semantic validation runs.

## Example

```lat
context Billing {
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
