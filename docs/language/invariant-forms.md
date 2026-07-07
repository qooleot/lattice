# Invariant forms

An [invariant](invariant.md)'s `{ <body> }` is one of eight closed forms (the "closed candidate
grammar," spec §6.1 — growing this set is a versioned act, not something a spec author can do
locally). Each is shown below with a complete, parseable example.

Two of the eight — `refs resolve` and `terminal r.s` — normally arrive for free as
[derived invariants](derived-invariants.md); writing them out explicitly is legal (they still
parse) but is usually redundant. The examples below show each form in a context where writing it
by hand is legitimate: `refs resolve` stated explicitly still loads (flagged
`redundant-invariant`, a warning — `loadLatText` returns `ok: true` with warnings); `terminal` is
shown on a state that is **not** tagged `@terminal`, where it is not implied by anything and is
the only way to assert stays-terminal for that state.

## 1. `statePredicate` — a bare predicate

The default form: any [predicate](invariant.md#predicateoperator-table), optionally scoped by a
header `where` guard.

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    invariant nonNegativeTotal { total >= 0 }
  }
}
```

## 2. `unique` — at most one match per key, while in given states

`unique while <region> in {<state>, …} by (<path>, …)` — while the instance's `<region>` is one of
the listed states, no two instances may share the same value(s) for the `by` path(s).

```lat
context Billing {
  entity Subscription {
    subId : Id key
  }

  aggregate Invoice {
    invoiceId    : Id key
    subscription : ref Subscription

    machine {
      region settlement { states { draft @initial, open @active, paid @terminal } }
      transition finalize { region settlement; from draft to open }
      transition settle { region settlement; from open to paid }
    }

    invariant oneDraftPerSubscription { unique while settlement in {draft} by (subscription) }
  }
}
```

## 3. `refsResolve` — every ref on this owner resolves

`refs resolve` — every `ref` field on the owner must resolve to a real instance. Normally implied
automatically by the presence of any `ref` field (see [derived invariants](derived-invariants.md));
writing it explicitly still parses and loads successfully, flagged as redundant.

```lat
context Billing {
  entity Plan {
    planId : Id key
  }

  aggregate Subscription {
    subId : Id key
    plan  : ref Plan

    invariant planRefResolves { refs resolve }
  }
}
```

## 4. `cardinality` — bounded count

`count [where <predicate>] <= <int>` — at most `<int>` instances (optionally restricted to those
matching `where`) may exist at once.

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    invariant atMostFive { count where total > 0 <= 5 }
  }
}
```

## 5. `terminal` — a state, once entered, is never left

`terminal <region>.<state>`. Normally implied automatically for every state tagged `@terminal`
(see [derived invariants](derived-invariants.md)) — writing it explicitly only adds information
when the state is *not* tagged `@terminal`, as here:

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    machine {
      region lifecycle { states { trialing @initial, active @active, paused @active } }
      transition activate { region lifecycle; from trialing to active }
      transition pause { region lifecycle; from active to paused }
    }

    invariant pausedIsSticky { terminal lifecycle.paused }
  }
}
```

## 6. `monotonic` — a field never decreases

`monotonic <path>` — the named numeric field never decreases across any transition.

```lat
context Billing {
  aggregate Subscription {
    subId        : Id key
    accruedUnits : Int

    invariant usageNeverDecreases { monotonic accruedUnits }
  }
}
```

## 7. `conservation` — parts sum exactly to a total

`conserve <path> + <path> [+ …] == <path>` — the sum of the listed parts equals the total, exactly,
at all times.

```lat
context Billing {
  aggregate Invoice {
    invoiceId        : Id key
    licenseFeeAmount : Money
    usageAmount      : Money
    totalDue         : Money

    invariant partsSumToTotal { conserve licenseFeeAmount + usageAmount == totalDue }
  }
}
```

## 8. `leadsTo` — eventual progress under fairness

`from <predicate> leads to <predicate> under fairness "<text>"` — starting from any state
satisfying the first predicate, the system eventually reaches a state satisfying the second,
assuming the named fairness condition. This form is printable and parseable, but is
**template-instantiated only**: the elicitation CLI (`propose`/`regenerate`) refuses it as a
freeform candidate (`not-elicitable`) exactly the way it refuses any LLM-authored `leadsTo` —
hand-writing it directly in `.lat`, as below, is how it actually gets authored.

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    machine {
      region lifecycle { states { trialing @initial, active @active, canceled @terminal } }
      transition activate { region lifecycle; from trialing to active }
      transition cancel { region lifecycle; from active to canceled }
    }

    invariant trialEventuallyResolves {
      from state lifecycle in {trialing} leads to state lifecycle in {active}
        under fairness "activate is enabled infinitely often"
    }
  }
}
```

## See also

- [Invariant](invariant.md)
- [Derived invariants](derived-invariants.md)
- [Machine](machine.md)
- [Tags](tags.md)
