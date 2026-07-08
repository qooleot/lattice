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
| Owner `A` has at least one same-context `ref` field | every `ref` field on `A` resolves (a `refsResolve` body) | `refsResolve<A>` | None — a `ref` field must resolve; a **qualified** cross-context `ref` does not trigger this (see [field types](field-types.md)). |
| A `Money` field `f` on owner `A`, not tagged `@signed` | `f >= 0` (a `statePredicate` body) | `nonNegative<A><F>` | Tag the field `@signed`. |

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
