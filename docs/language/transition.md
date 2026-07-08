# Transition

An edge in a [lifecycle](lifecycle.md) block: a named move from one or more source states to a
target state, optionally triggered by a declared [event](event.md).

## Syntax

```lat
context Billing {
  event PaymentReceived {
    invoiceId : Id key
  }

  aggregate Invoice {
    invoiceId : Id key

    lifecycle settlement {
      states { open @initial, paid @terminal }
      transition settle { from open to paid; when PaymentReceived }
    }
  }
}
```

`transition <camelId> { from <s> (, <s>)* to <s> (; when <EventName>)? }`. The `from`/`to` and
optional `when` clauses are separated by `;` inside the braces, in that order. `from` names one or
more source states and `to` names a single target state, all declared in the enclosing
`lifecycle` block; `when`, if present, names a declared [event](event.md) — the domain fact that
causes this transition to fire.

Multiple `from` states (`from a, b to c`) collapse several distinct transitions that all land on
the same target into a single named edge — the transition fires whenever the instance is in *any*
of the listed source states.

## Semantic Rules

- Every state in `from`, and `to`, must name a state declared in the enclosing `lifecycle` block;
  otherwise `unknown-transition-state` (reported once per unresolved state).
- `from` may not repeat the same source state twice — `duplicate-source`.
- `to` may not also appear in `from` — self-loops need evidence before the grammar admits them,
  so this reports `self-loop`.
- `when`, if given, must name a declared [event](event.md); an undeclared name reports
  `unknown-event`.
- The transition name must be camelCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    lifecycle standing {
      states { trialing @initial, active @active, pastDue @active, canceled @terminal }
      transition activate { from trialing to active }
      transition cancel { from trialing, active, pastDue to canceled }
    }
  }
}
```

## See also

- [Lifecycle](lifecycle.md)
- [Event](event.md)
- [Aggregate](aggregate.md)
- [Tags](tags.md)
