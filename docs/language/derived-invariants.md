# Derived invariants

Three families of invariant are **implied by structure** (spec P9) rather than written by hand:
declare the structure and the rule exists automatically, computed fresh from the model on every
load. They are never printed in `spec.lat` — the printer omits them — but they are first-class
everywhere else: solver emitters see them, the prose projection lists them with an "implied by
structure" note, and reconciliation treats removing the structure that implies one as an
invariant-removing edit.

## The three families

| Structure | Implied rule | Derived name | Opt out |
|---|---|---|---|
| A state `s` tagged `@terminal` in lifecycle block `r` of owner `A` | once in `s`, stays in `s` (a `terminal` body) | `terminal<A><R><S>` | Remove the `@terminal` tag. |
| Owner `A` has at least one **required** same-context `ref` field | every required same-context `ref` field on `A` resolves (a `refsResolve` body) | `refsResolve<A>` | None for a required `ref` — it must resolve. A **qualified** cross-context `ref` (see [field types](field-types.md)) and an **optional** `ref` do not trigger this, and are not among the fields it covers. |
| A `Money` field `f` on owner `A`, not tagged `@signed` | `f >= 0`, or `present(f) => f >= 0` when `f` is [optional](field-types.md) (a `statePredicate` body) | `nonNegative<A><F>` | Tag the field `@signed`. |

Derived names are deterministic, camelCase-joined from the owner, lifecycle/field, and state names —
e.g. `terminalInvoiceSettlementVoid`, `refsResolveSubscription`, `nonNegativeInvoiceTotalDue`.

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    lifecycle settlement {
      states { open @initial, void @terminal }
      transition voidIt { from open to void }
    }
  }
}
```

This one file implies two rules with no invariant block at all: `total >= 0` (from the `Money`
field, unsigned) and stays-terminal on `settlement.void` (from the `@terminal` tag). Neither
appears as text in the file; both are part of the canonical invariant set the engine reasons about.

## Optional fields: the guard form is forced

Where a derived rule meets an [optional](field-types.md) field, the shape it takes is forced by
what absence *is*, not chosen for convenience:

- **An absent amount is not a negative one.** An optional unsigned `Money` field `f` implies
  `present(f) => f >= 0` — the guard form. The assertion form (`present(f) && f >= 0`) would make
  every optional `Money` field mandatory, which is to say it would delete optionality by deriving
  it away. Nothing you declared asked for that.
- **An absent ref is not an orphan.** `refsResolve` covers only **required** same-context refs. An
  optional ref that points at nothing is exactly what `?` declares it may be; a resolve rule over
  it would forbid the state the declaration just permitted — including, commonly, an aggregate's
  own initial state. An owner whose refs are all optional or cross-context derives no `refsResolve`
  rule at all.

Both follow from the same reading of `?` the rest of the language uses: absence is a fact the model
accounts for, never a value it defaults to. Where the derived rule cannot state which it means, it
is not derived.

```lat
context Billing {
  aggregate Payment {
    paymentId      : Id key
    amount         : Money
    approvedAmount : Money?
  }
}
```

This file implies `amount >= 0` outright and `present(approvedAmount) => approvedAmount >= 0` for
the optional one. Neither is printed; both are part of the canonical invariant set.

## Restating a derived rule by hand

Writing an explicit invariant whose body is *exactly* the shape of one already implied by
structure is legal — it parses and `loadLatText` returns `ok: true` — but it is redundant, and is
reported as a `redundant-invariant` warning rather than kept as a second copy:

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    invariant nonNegativeTotal { total >= 0 }
  }
}
```

Loading this produces the warning `invariant nonNegativeTotal restates a structure-implied rule;
it is derived automatically and will not be printed` — the explicit block is dropped and the
derived rule is used instead. This is why the reference `spec.lat` example (in the
[slice-3 design](../superpowers/specs/2026-07-05-lattice-slice-3-lat-parser-design.md)) keeps
`includedUnits >= 0` on `Plan` as an explicit conjunct — `Int` fields carry no implied bound, only
`Money` does — while every `Money`/`ref`/`@terminal` rule stays implicit.

## Why this matters for editing

Because tag edits are invariant edits: removing an `@terminal` tag, adding `@signed` to a `Money`
field, or deleting a `ref` field removes a derived invariant the same way deleting an explicit
`invariant` block would. If that derived rule has ledger history, the removal goes through the
same refusal ceremony as any other removal (`--force-remove`) — see [editing](editing.md).

## See also

- [Invariant forms](invariant-forms.md)
- [Tags](tags.md)
- [Field types](field-types.md)
- [Editing](editing.md)
