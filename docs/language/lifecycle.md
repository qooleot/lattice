# Lifecycle

An [aggregate](aggregate.md)'s lifecycle: one or more independent named **lifecycle blocks**, each
a set of named **states** plus the [transitions](transition.md) that move between them. A
lifecycle block models a state that changes discretely and whose transitions are meaningful to the
domain — not every aggregate needs one.

## Syntax

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key

    lifecycle settlement {
      states { draft @initial, open @active, paid @terminal, void @terminal }
      transition finalize { from draft to open }
      transition settle { from open to paid }
      transition voidDraft { from draft to void }
    }
  }
}
```

`lifecycle <camelId> { states {…} <transition>* }` — a name, its set of states, and any number of
transitions (including zero, though a lifecycle with no transitions can never leave its initial
state). A state is `<camelId> [@tag]*` — see [tags](tags.md) for `@initial`/`@active`/`@terminal`.
[Transition](transition.md) syntax and rules are covered on its own page; transitions declared
inside a `lifecycle` block implicitly belong to that block — there is no separate `region` param.

Multiple `lifecycle` blocks on the same aggregate model independent, concurrently-tracked
dimensions (e.g. a `standing` block and a separate `billingCycle` block) — each has its own states
and its own `@initial` state. The block's name is what [`state <name> in {…}`](invariant.md) and
[`unique while <name> in {…}`](invariant-forms.md) reference elsewhere in the aggregate.

## Semantic Rules

- Every `lifecycle` block must have **exactly one** state tagged `@initial`. Zero or more than one
  reports `multiple-initial` (the message covers both the zero and the many case).
- `@active` and `@terminal` are informational tags read by [derived invariants](derived-invariants.md):
  every state tagged `@terminal` implies a stays-terminal rule (once entered, that state is never
  left) unless the tag is removed. `@active` carries no derived rule; it documents "this is a
  normal operating state" for readers and downstream tooling.
- State names must be camelCase by convention (`naming-convention`) and valid,
  non-[reserved](naming-conventions.md) identifiers.
- Lifecycle block names follow the same convention and identifier rules — in particular, a block
  cannot be named `lifecycle` itself, since `lifecycle` is a grammar keyword.
- A [transition](transition.md)'s `from`/`to` naming a state that isn't declared in its enclosing
  `lifecycle` block reports `unknown-transition-state`.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    lifecycle standing {
      states { trialing @initial, active @active, canceled @terminal }
      transition activate { from trialing to active }
      transition cancel { from active to canceled }
    }
  }
}
```

## See also

- [Transition](transition.md)
- [Tags](tags.md)
- [Aggregate](aggregate.md)
- [Derived invariants](derived-invariants.md)
- [Invariant forms](invariant-forms.md)
