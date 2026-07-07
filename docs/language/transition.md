# Transition

An edge in a [machine](machine.md): a named move from one state to another within a single
region, optionally triggered by a declared [event](event.md).

## Syntax

```lat
context Billing {
  event PaymentReceived {
    invoiceId : Id key
  }

  aggregate Invoice {
    invoiceId : Id key

    machine {
      region settlement { states { open @initial, paid @terminal } }
      transition settle { region settlement; from open to paid; when PaymentReceived }
    }
  }
}
```

`transition <camelId> { region <r>; from <s> to <s> (; when <EventName>)? }`. The `region`,
`from`/`to`, and optional `when` clauses are separated by `;` inside the braces, in that order.
`from` and `to` name states declared in the named region; `when`, if present, names a declared
[event](event.md) — the domain fact that causes this transition to fire.

## Semantic Rules

- `region` must name a region declared on the enclosing aggregate's machine; otherwise
  `unknown-region`.
- Both `from` and `to` must name states declared in that region; otherwise
  `unknown-transition-state` (reported once per unresolved state).
- `when`, if given, must name a declared [event](event.md); an undeclared name reports
  `unknown-event`.
- The transition name must be camelCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier.
- A transition's `from`/`to` may name the same state (a self-transition) — the grammar does not
  forbid it, and no diagnostic flags it.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    machine {
      region lifecycle { states { trialing @initial, active @active, canceled @terminal } }
      transition activate { region lifecycle; from trialing to active }
      transition cancel { region lifecycle; from active to canceled }
    }
  }
}
```

## See also

- [Machine](machine.md)
- [Event](event.md)
- [Aggregate](aggregate.md)
- [Tags](tags.md)
