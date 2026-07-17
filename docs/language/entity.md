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
- Nested entities carry prim, enum, `ref`, and value-typed fields. A child's `ref` must name a
  **top-level** aggregate or entity: an owned child has no identity to reference, so a `ref` naming
  one reports `ref-target-nested-child` — whoever holds it, child or top-level owner alike. Both
  solver encodings inline a child into its owner, with no id pool to draw from. Reference the
  owning aggregate instead, or promote the child to a top-level entity. (The one exception is the
  owned-collection declaration itself — `List<Child>` on the child's own aggregate — which is what
  ownership is written with, not a reference to a child.)
- A `List` field inside a child reports `nested-entity-flat` — a child cannot own a collection.
  This is **not yet implemented rather than deliberate**: Alloy would encode it directly (its child
  sigs are flat), but Quint has no list encoding at all (`fieldQType` returns `null` for a list), so
  two-level collections need nested bounded maps, an `OWNED_BOUND²` state blowup, and a revisit of
  the bitwidth policy that already rises to 7 for a single-level sum. That is its own slice with its
  own solver-fidelity risk. If you have a spec that needs it — a bill line with a per-line tax
  breakdown is the usual one — that is the evidence, and the cost above is what it has to buy.
- A nested entity's name joins the same flat namespace as top-level enums/entities/aggregates —
  it must be unique context-wide (`duplicate-name`) and is itself a valid `ref` target: a bare
  field type naming a nested entity resolves as a reference to it, the same as a top-level owner.
- Exactly one owned-collection field per child entity: two `List<Child>` fields on the same
  aggregate targeting the same child report `duplicate-owned-collection-target` — the solver
  encodings key children by entity name, so a second field would collide.
- Every child must be owned: a nested entity that no `List<...>` field on its aggregate ranges over
  reports `unowned-nested-entity`. A child is reachable *only* through an owned collection — Quint
  inlines it into its owner with no id pool of its own, Alloy emits its sig only for a collection
  that ranges over it, and nothing may `ref` one — so an unowned child is unreachable in every
  encoding, a declaration nothing can read or constrain. Give the aggregate a `List<Child>` field,
  or declare the entity at context level.
- Owned collections are solver-encoded: Quint gives the owner a bounded `<field>: int -> { … }` map
  plus a `<field>Count: int` companion; Alloy gives the child its own sig with an `owner: one
  <Parent>` relation. A list field that is *not* an owned collection (`List<Int>`, `List<ref
  TopLevel>`) is still dropped before solving — Quint's `fieldQType` returns `null` for a list and
  Alloy's sig emitter has no list branch.
- A multi-segment candidate path *through* any collection fails to resolve and reports
  `unknown-path` — a list is not a hop. A single-segment path *at* a list field is not currently
  rejected: it resolves and then contributes nothing, which is a gap rather than a design.

### What a child can hold

A child carrying both a `ref` to a top-level entity and a value-typed money field — the shape a
double-entry ledger needs, where each posting names the account it hits and the amount it moves:

```lat
context Ledger {
  value Amount {
    amount   : Money
    currency : Text
  }

  entity LedgerAccount {
    accountId : Id key
    balance   : Amount @signed
  }

  aggregate JournalEntry {
    entryId  : Id key
    total    : Amount @total @unsigned
    postings : List<Posting>

    entity Posting {
      postingId : Id key
      account   : ref LedgerAccount
      amount    : Amount @unsigned
    }

    invariant totalMatchesPostings { total.amount == sum(postings, amount.amount) }
  }
}
```

`Posting.account` is legal because `LedgerAccount` is top-level; a `ref Posting` from anywhere —
including another `Posting` — would report `ref-target-nested-child`. `Posting.amount` is a value
type flattened at each level (`amount_amount` in Alloy, a nested record in Quint), and its `Money`
sub-field derives `Posting.amount.amount >= 0` per path, from the `@unsigned` written at the use
site. The same `value Amount` is `@signed` at `LedgerAccount.balance` — sign belongs to the field,
not the type (see [value](value.md)).

## See also

- [Aggregate](aggregate.md)
- [Value](value.md)
- [Field types](field-types.md)
- [Tags](tags.md)
- [Naming conventions](naming-conventions.md)
