# Value

A structural type compared by its fields, not by identity — the DDD *value object*. Where an
[entity](entity.md) has a `key` and is referenced (`ref Entity`), a value has no key at all:
two values with the same field contents are the same value. A value's own [invariants](invariant.md)
are structural laws that hold at every use site, automatically — the moment a field is typed
with the value, its law is enforced there too, whether that field lives on an aggregate, a
top-level entity, or an aggregate-owned child.

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
- **No `ref`, no `List`.** A value's fields are prim, enum, or **another value**; a `ref` or `List<T>`
  field reports `value-flat`. See "Remaining limits" below for why each is out.
- **No cycles.** A chain of value-typed fields that closes on itself — `value A { b : B }` with
  `value B { a : A }`, or a self-cycle `value A { a : A }` — reports `value-cycle` at load. A value
  is a structural type flattened into its fields, so a cycle has no finite flattening: both solver
  encodings (Alloy's sub-relation flattening, Quint's nested record) recurse through value fields
  and would stack-overflow on this shape. The diagnostic names the whole loop
  (`A -> B -> A`), reported once per cycle at its alphabetically-first participant; break it by
  removing one field in the chain.
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

## Solver encoding

A value-typed field is fully solver-encoded, and its structural invariants are checked, not just
parsed. The two engines encode a value differently, matching how each represents structure:

- **Quint** encodes a value field as a nested inline record — `period: { start: int, end: int }` —
  mirroring the value's own field shape, recursing into a value-typed sub-field for as many levels
  as the declaration nests.
- **Alloy** has no nested-record type, so it flattens a value field to one sig relation per
  subfield, joined by underscore: `period_start`, `period_end` (not `period: …`). A nested value
  flattens the same way at each level — `line_net_amount`.
- **Witnesses** normalize either encoding back to a dotted key for display and exclusion-shape
  bookkeeping — `period.start`, `period.end`, `line.net.amount` — regardless of which engine
  produced them, and for a value on an aggregate-owned child as readily as one on its owner.

A value's own `invariant` blocks (e.g. `wellOrdered { start < end }` on `Period`) are **type-carried
laws**: the moment a field is typed with the value, that law is auto-adopted at that use site, named
`val<Value><Owner><Field><Invariant>` — for the `term : Period` field on `Lease` above,
`valPeriodLeaseTermWellOrdered`. There is one channel, not two: the implied derivation instantiates
the law at every use site, and template matching adopts that output verbatim rather than deriving a
second copy. These are real solver-checked invariants, not documentation — golden trace D exercises
a value law adopted and checked end-to-end with real solvers.

This holds at an aggregate-owned **child**'s use site too, exactly as it does at an aggregate's or a
top-level entity's: a child's `window : Period` derives `wellOrdered` there (named
`valPeriodLegWindowWellOrdered` for a `Leg` child, say) precisely as an aggregate's `term : Period`
derives its own instance. Solver-checked the same way in both engines — Quint folds the rule over
the owner's child map (a child has no var of its own to quantify over directly); Alloy quantifies
`all x: <Child>` over the child's own sig, since a child gets its own sig there.

A `@balance`/`@total` tag on a value-typed field resolves to that value's single solver-numeric
sub-field, so `total : Amount @total` conserves as `total.amount`. A value with zero or several
numeric sub-fields (`Int`, `Money`, `Date`, `Duration`) leaves the tag with nothing to name and
reports `ambiguous-numeric-tag` — the tag must name exactly one summable number. Without this the
tag would be silently accepted and do nothing.

## Where a value may go

A value-typed field is legal anywhere a prim is: on an aggregate, on a top-level entity, on an
aggregate-owned child, and **inside another value**. Alloy flattens each level with `_`
(`line_net_amount`); Quint nests records to match. Candidate paths follow, to whatever depth the
nesting goes — `line.net.amount` resolves hop by hop, not capped at one.

**Money sign is decided at the use site.** A `value Amount { amount : Money, currency : Currency }`
is non-negative at `Bill.total` and signed at `LedgerAccount.balance` — one tag on the declaration
could not express both even in principle, so `@signed`/`@unsigned` go on the field *typed* with the
value. A sign tag inside a value declaration reports `value-money-sign-inert`: it names a decision
that isn't the declaration's to make, and the derivation reads the use site, so the tag would
otherwise sit there doing nothing.

**Remaining limit:** a value's fields are prim, enum, or another value — never `ref` or `List`
(`value-flat`). `ref` is out on principle: a value is keyless and compared by structure, so it has
no identity for a reference to belong to, and nothing to anchor the reference's own side. `List` is
out for cost, the same cost that blocks a `List` inside a nested child — Quint has no list encoding
at all, so a collection inside a flattened structural type needs nested bounded maps and a bitwidth
revisit (see [entity](entity.md)).

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

A value nested inside another value, with the sign decided at each use site:

```lat
context Billing {
  value Amount {
    amount   : Money
    currency : Text
  }

  value LineTotals {
    net   : Amount
    gross : Amount
  }

  aggregate Invoice {
    invoiceId  : Id key
    totals     : LineTotals @unsigned
    adjustment : Amount @signed
  }
}
```

`totals` flattens to `totals_net_amount`/`totals_gross_amount` in Alloy and to a two-level record in
Quint. Its `@unsigned` derives a non-negative rule **per money path** — one for `totals.net.amount`
and one for `totals.gross.amount` — while `adjustment`, the same `Amount` type tagged `@signed` at
its own use site, derives none.

## See also

- [Field types](field-types.md)
- [Entity](entity.md)
- [Invariant](invariant.md)
- [Transition](transition.md)
- [Naming conventions](naming-conventions.md)
