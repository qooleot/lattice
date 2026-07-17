# Derived invariants

Four families of invariant are **implied by structure** (spec P9) rather than written by hand:
declare the structure and the rule exists automatically, computed fresh from the model on every
load. They are never printed in `spec.lat` — the printer omits them — but they are first-class
everywhere else: solver emitters see them, the prose projection lists them with an "implied by
structure" note, and reconciliation treats removing the structure that implies one as an
invariant-removing edit.

## The four families

| Structure | Implied rule | Derived name | Opt out |
|---|---|---|---|
| A state `s` tagged `@terminal` in lifecycle block `r` of owner `A` | once in `s`, stays in `s` (a `terminal` body) | `terminal<A><R><S>` | Remove the `@terminal` tag. |
| Owner `A` has at least one same-context `ref` field, required or optional | every same-context `ref` field on `A` resolves when present (a `refsResolve` body) | `refsResolve<A>` | None. A **qualified** cross-context `ref` (see [field types](field-types.md)) is never among the fields it covers. An absent **optional** `ref` is skipped, not convicted; a present one must still resolve. |
| A **money path** `p` on owner `A`, whose head field is not tagged `@signed` | `p >= 0`, or `present(f) => p >= 0` when the head field `f` is [optional](field-types.md) (a `statePredicate` body) | `nonNegative<A><P…>` | Tag the head field `@signed`. |
| A field `f : V` on an **aggregate, top-level entity, or aggregate-owned child**, where [value](value.md) `V` declares its own `invariant` | each of `V`'s laws, instantiated at this use site with every path prefixed `f.` | `val<V><A><F><Inv>` | Remove the law from `V`, or stop using `V` here. |

"Owner" means an aggregate, a top-level entity, **or an aggregate-owned child**. All four families
derive at a child's use site exactly as they do at an aggregate's or a top-level entity's. Only an
aggregate has a lifecycle, so `terminal` is aggregates-only. A child is a nameable subject even
though nothing can reference it (see [field types](field-types.md)), so `refsResolve` fires on a
`Posting.account : ref LedgerAccount` with the child as its own subject — `refsResolvePosting` — a
child's own money fields derive non-negativity like any other owner's, through a value and at
whatever depth it nests (`nonNegativePostingAmountAmount`), and a value-typed field on a child
derives its value's laws there too: given `value Period { … invariant wellOrdered { start < end } }`,
an aggregate's `term : Period` derives `valPeriodInvoiceTermWellOrdered` and a child's
`window : Period` derives `valPeriodPostingWindowWellOrdered` just the same. Solver-checked
identically in both engines: Quint folds the rule over the owner's child map (a child has no var of
its own to quantify over), and Alloy quantifies over the child's own sig.

A **value** is not an owner. Its `invariant` blocks are type-carried laws instantiated at every use
site rather than rules about the value itself, which is the fourth row above — see
[value](value.md).

## Non-negativity derives per money path

A **money path** is any path from an owner's field down to a `Money` prim — `[f]` for a plain
`Money` field, and `[f, …sub]` for each `Money` sub-field reachable through a value-typed field, at
whatever depth the values nest. `total : Amount` where `value Amount { amount : Money, currency :
Text }` yields the path `total.amount`, exactly where `total : Money` would yield `total`. Each path
derives its own rule: an `@unsigned` `totals : LineTotals` carrying two `Amount`s derives two,
`nonNegativeInvoiceTotalsNetAmount` and `nonNegativeInvoiceTotalsGrossAmount`.

Sign is read off the **use site** and only the use site — the tag on the owner's field, never on the
value declaration, which cannot know whether this use is a bill total or a ledger balance (see
[tags](tags.md), and `value-money-sign-inert`).

Derived names are deterministic, camelCase-joined from the owner, lifecycle/field/path, and state
names — e.g. `terminalInvoiceSettlementVoid`, `refsResolveSubscription`, `nonNegativeInvoiceTotalDue`,
`nonNegativeInvoiceTotalAmount` for the value-hop path `total.amount`.

**When two derived rules collide on one name**, the model is rejected with `derived-name-collision`
at `init`/`apply`. The segments join with no separator, so a plain `totalAmount : Money` and a
value-typed `total : Amount { amount : Money }` on one owner both mint
`nonNegativeInvoiceTotalAmount` — two distinct rules, one name, the second silently shadowing the
first in every id- and name-keyed lookup. No separator fixes this (names fold through `toCamelName`,
which splits on `_` and re-camelCases, so the collision returns) and a disambiguating suffix would
tax the non-colliding majority to serve the exception. So it is reported rather than repaired: only
the author can say which field should be renamed.

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
- **An absent ref is not an orphan — but a present one must resolve.** `refsResolve` names every
  same-context `ref` field on the owner, required or optional alike; unlike the `Money` case above,
  there is no guard written into the invariant body itself. The guard instead lives in how the
  field is read: the judge's `refsResolve` arm only convicts a field holding a string that names no
  entity, and skips a field whose key is simply absent. An optional ref that points at nothing is
  exactly what `?` declares it may be — including, commonly, an aggregate's own initial state — so
  that state stays legal. A ref that *is* set but dangles is exactly the orphan this rule exists to
  catch, whether the field is required or optional.

Both follow the same reading of `?` the rest of the language uses: absence is a fact the model
accounts for, never a value it defaults to. Where `Money` expresses that fact as a guard in the
invariant body, `refsResolve` expresses it as a distinction the judge draws between a missing key
and a dangling one — but neither ever asks an absent optional field to behave as if it were set.

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
