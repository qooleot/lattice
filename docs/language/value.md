# Value

A structural type compared by its fields, not by identity — the DDD *value object*. Where an
[entity](entity.md) has a `key` and is referenced (`ref Entity`), a value has no key at all:
two values with the same field contents are the same value. A value's own [invariants](invariant.md)
are structural laws that hold at every use site, automatically — the moment a field is typed
with the value, its law is enforced there too.

## Syntax

```lat
context Billing {
  value Period {
    start : Date
    end   : Date

    invariant wellOrdered { start < end }
  }

  aggregate Lease {
    leaseId : Id key
    term    : Period
  }
}
```

`value <PascalId> { <field>* <invariant>* }`, with an optional leading `///` doc. Fields use the
same `<camelId> : <type> [@<tag>]*` grammar as an entity's, minus `key` — see below. Any number of
`invariant` blocks follow, each an ordinary [invariant](invariant.md) predicate body scoped to the
value's own fields (no `on`, no `where` — see Semantic Rules).

A value's name is then usable as a field type anywhere an entity or enum name would be —
`term : Period` above gives `Lease` a field whose type is `{ kind: 'value', value: 'Period' }`.

## Semantic Rules

- **No key.** A value field marked `key` reports `value-no-key` — values carry no identity;
  structural equality replaces it. (Contrast with [entity](entity.md), which requires exactly one.)
- **Flat.** Value fields are prim or enum types only in v1 — no `ref`, no `List<T>`, and no
  value-typed field nested inside another value. A field of any other kind reports `value-flat`.
- **Own-fields-only invariants.** A value's `invariant` blocks may reference only that value's own
  fields — the same own-scope discipline as a [transition](transition.md) guard, just applied to
  the value instead of an aggregate. A path leaving that scope reports `value-cross-field`.
- **No `on`/`where`.** A value invariant is always about its own value and always unconditional —
  writing `on <Target>` or a `where <predicate>` header reports `value-invariant-plain`.
- The value name must be PascalCase by convention and a valid, non-[reserved](naming-conventions.md)
  identifier; it joins the same flat duplicate-name pool as enums, entities, and aggregates
  (`duplicate-name`). Field names must be camelCase by convention.
- A field typed with an undeclared value name reports `unresolved-value`. Type-name resolution
  order for a bare identifier is: primitive → declared value → declared entity/aggregate (`ref`) →
  enum — see [field types](field-types.md).

## No solver encoding yet

This is deliberately a surface, AST, validation, and printer feature only: a value-typed field
parses, validates, and round-trips, but the quint and Alloy emitters do not yet encode it — it is
silently dropped from the solver-facing model, the same way `List<T>` fields are today. A value
invariant is likewise not yet checked by the solver-backed elicitation flow. Both are planned
follow-up work once the surface has real usage to learn from.

## Example

```lat
context Billing {
  value Money2 {
    amount   : Money
    currency : Text
  }

  aggregate Invoice {
    invoiceId : Id key
    price     : Money2
  }
}
```

## See also

- [Field types](field-types.md)
- [Entity](entity.md)
- [Invariant](invariant.md)
- [Transition](transition.md)
- [Naming conventions](naming-conventions.md)
