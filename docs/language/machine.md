# Machine

An [aggregate](aggregate.md)'s lifecycle: one or more independent **regions**, each a set of named
**states**. A machine models a state that changes discretely and whose transitions are meaningful
to the domain — not every aggregate needs one.

## Syntax

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key

    machine {
      region settlement {
        states { draft @initial, open @active, paid @terminal, void @terminal }
      }
      transition finalize { region settlement; from draft to open }
      transition settle { region settlement; from open to paid }
      transition voidDraft { region settlement; from draft to void }
    }
  }
}
```

`machine { <region>+ <transition>* }` — at least one region, any number of transitions (including
zero, though a machine with no transitions can never leave its initial state). A region is
`region <camelId> { states { <state> (, <state>)* } }`, and a state is `<camelId> [@tag]*` — see
[tags](tags.md) for `@initial`/`@active`/`@terminal`. [Transition](transition.md) syntax and rules
are covered on its own page.

Multiple regions model independent, concurrently-tracked dimensions of the same aggregate (e.g. a
`lifecycle` region and a separate `billingCycle` region) — each has its own states and its own
`@initial` state, and transitions name which region they belong to.

## Semantic Rules

- Every region must have **exactly one** state tagged `@initial`. Zero or more than one reports
  `multiple-initial` (the message covers both the zero and the many case).
- `@active` and `@terminal` are informational tags read by [derived invariants](derived-invariants.md):
  every state tagged `@terminal` implies a stays-terminal rule (once entered, that state is never
  left) unless the tag is removed. `@active` carries no derived rule; it documents "this is a
  normal operating state" for readers and downstream tooling.
- State names must be camelCase by convention (`naming-convention`) and valid,
  non-[reserved](naming-conventions.md) identifiers.
- Region names follow the same convention and identifier rules.
- A [transition](transition.md) naming a region that doesn't exist on this aggregate reports
  `unknown-region`; naming a `from`/`to` state that isn't declared in that region reports
  `unknown-transition-state`.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    machine {
      region lifecycle {
        states { trialing @initial, active @active, canceled @terminal }
      }
      transition activate { region lifecycle; from trialing to active }
      transition cancel { region lifecycle; from active to canceled }
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
