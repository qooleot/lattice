# Aggregate

The DDD consistency boundary: a cluster of state that changes together, guarded by its own
[invariants](invariant.md) and (optionally) driven by a [machine](machine.md) of lifecycle states.
Where an [entity](entity.md) is a referenced value, an aggregate is a thing the system enforces
rules about directly.

## Syntax

```lat
/// A customer's subscription to a Plan; usage accrues per billing period.
context Billing {
  entity Plan {
    planId : Id key
  }

  aggregate Subscription {
    subId        : Id key
    plan         : ref Plan
    accruedUnits : Int

    machine {
      region lifecycle { states { trialing @initial, active @active, canceled @terminal } }
      transition activate { region lifecycle; from trialing to active }
      transition cancel { region lifecycle; from active to canceled }
    }

    invariant nonNegativeUsage { accruedUnits >= 0 }
  }
}
```

`aggregate <PascalId> { <field>* <machine>? <invariant>* }`, with an optional leading `///` doc.
Fields use the same grammar as an entity's; the `machine` block (see [machine](machine.md)) is
optional — an aggregate with no lifecycle is legal — and any number of `invariant` blocks follow,
implicitly scoped to this aggregate (no `on` needed; see [invariant](invariant.md)).

## Semantic Rules

- Exactly one field must carry `key`, same as an entity; an aggregate with no key field reports
  `missing-key`.
- The aggregate name must be PascalCase by convention and a valid, non-reserved identifier
  (`invalid-name`, `reserved-word`); field names must be camelCase by convention, and a field
  named `state` is rejected (`reserved-field-name`).
- Field types resolve the same way as an entity's (`unresolved-enum`, `unresolved-ref`).
- An in-aggregate `invariant` block that redundantly names `on <SameAggregate>` is flagged
  `redundant-target` — the target is already implicit.
- If present, the `machine` block's own rules apply in full — see [machine](machine.md) and
  [transition](transition.md) for `multiple-initial`, `unknown-region`,
  `unknown-transition-state`, and `unknown-event`.
- An aggregate with a `Money` field, a `ref` field, or an `@terminal` state carries
  [derived invariants](derived-invariants.md) automatically — non-negativity, refs-resolve, and
  stays-terminal respectively — without any invariant block needing to state them.

## Example

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    invariant nonNegativeTotal { total >= 0 }
  }
}
```

## See also

- [Entity](entity.md)
- [Machine](machine.md)
- [Invariant](invariant.md)
- [Derived invariants](derived-invariants.md)
- [Tags](tags.md)
