# Invariant

A rule the system enforces about an [aggregate](aggregate.md) or [entity](entity.md) — the
domain-expert-vetted core of a `.lat` spec. This page covers declaration forms, the predicate
operator table, and `where` guards; the eight distinct **bodies** an invariant can hold are
covered on [invariant forms](invariant-forms.md), and the three families the engine derives for
you automatically are covered on [derived invariants](derived-invariants.md).

## Syntax

```lat
context Billing {
  entity Plan {
    planId        : Id key
    includedUnits : Int
  }

  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    /// Nothing is ever billed negative.
    invariant nonNegativeTotal { total >= 0 }
  }

  /// Context-level: this rule is about Plan, not the enclosing context.
  invariant nonNegativeAllowance on Plan { includedUnits >= 0 }
}
```

Two declaration forms:

- **In-aggregate** — `invariant <camelId> [where <predicate>] { <body> }` written inside an
  `aggregate` block. The target is implicit: the enclosing aggregate. Writing an explicit
  `on <SameAggregate>` here is legal but redundant (`redundant-target`).
- **Context-level** — `invariant <camelId> on <OwnerName> [where <predicate>] { <body> }` written
  directly inside a `context` block, alongside enums and entities. Here `on <OwnerName>` is
  **required**: naming which entity or aggregate the rule is about. Omitting it reports
  `missing-target`.

An optional leading `///` doc comment carries the invariant's human-owned English explanation.

## Predicate/operator table

Predicates are built from comparisons, connectives, and state membership:

| Form | Meaning |
|---|---|
| `a == b`, `a != b` | equality / inequality |
| `a < b`, `a <= b`, `a > b`, `a >= b` | ordering |
| `p && q` | conjunction |
| `p \|\| q` | disjunction |
| `!p` | negation |
| `p => q` | implication ("if p then q") |
| `present(<path>)` | true when the [optional](field-types.md) field at `<path>` has a value — reads absence as a fact, not as an unknown |
| `state <lifecycle> in {<state>, …}` | true when the quantified instance's `<lifecycle>` block is currently one of the listed states |
| `now` | the current tick, usable as a term in a comparison |
| `a + b` | linear arithmetic sum, usable as a term in a comparison |

Precedence (loosest to tightest): `=>`, then `||`, then `&&`, then `!`; parentheses group
explicitly. A bare field name (`total`, `subscription.plan`) reads a path on the quantified
instance; `EnumName.value` reads an enum literal.

## `where` guards

A `where <predicate>` clause in the invariant header restricts *when* the body must hold — the
body is only required to be true for instances satisfying the guard. `where` is only meaningful
for a bare predicate body (see [invariant forms](invariant-forms.md)); attaching it to any other
body kind (e.g. `unique`, `terminal`) reports `where-unsupported`, since those bodies already have
their own scoping (a `count where …` clause, an implicit `while` state set, etc).

## Optional fields: `present()` and what absence means

A comparison and `present()` read a missing value in **opposite** ways, and that asymmetry is the
thing to hold onto:

- **A comparison treats a missing operand as unknown, and returns true.** `approvedAmount > 0` is
  *satisfied* by an aggregate that has no `approvedAmount` — unknown facts don't convict.
- **`present()` reads absence as a fact.** `present(approvedAmount)` is false exactly when the
  value is missing.

So a comparison alone can never say anything about absence, in either direction. That is why an
invariant over an optional field needs `present()` to mean anything at all, and why the language
will not pick for you: `approvedAmount <= amount` is *right* to hold vacuously when the amount is
absent, and `succeeded => approvedAmount > 0` is *silently wrong* to — and the two are
indistinguishable as spec text.

Rather than default, the loader asks. A predicate body whose path **ends at** an optional field
with no dominating `present()` is rejected with `absence-undecided`, whose message offers the two
forms it cannot choose between:

```lat
context Billing {
  aggregate Payment {
    paymentId      : Id key
    amount         : Money
    approvedAmount : Money?

    /// Guard form — the rule holds only when there is an approved amount.
    invariant approvalWithinAmount where present(approvedAmount) {
      approvedAmount <= amount
    }

    /// Assertion form — being approved *requires* an approved amount to exist.
    invariant approvedImpliesAmount {
      present(approvedAmount) && approvedAmount > 0
    }
  }
}
```

`present()` is written from both ends: the engine emits it into the one rule it derives that needs
one (an optional unsigned `Money` field implies `present(f) => f >= 0` — see
[derived invariants](derived-invariants.md)), and you write it by hand when `absence-undecided`
fires on a rule of your own.

### What counts as a dominating `present()`

Dominance is **syntactic and conservative** — it is a walk over the predicate's shape, not a
solver query. A `present(f)` covers a read of `f`:

- in the **body**, when the `where` guard contains it;
- across a **`&&`**, symmetrically — both `present(f) && f > 0` and `f > 0 && present(f)` are
  accepted, and coverage from an enclosing `&&` reaches nested predicates;
- in a **consequent**, when the antecedent contains it: `present(f) => f > 0`.

A `present()` under **`||`** or **`!`** covers nothing — `present(f) || f > 0` still reports
`absence-undecided`. Neither connective can establish the value is there for the read that follows,
so neither is credited.

The gate is reported for the invariant's **body**. Some [invariant forms](invariant-forms.md) have
no predicate to attach a guard to, and reject an optional path outright with `absence-undecided`
rather than offering a form: `unique`'s `by` paths, `monotonic`'s `field`, `conservation`'s `parts`
and `total`, and `sumOverCollection`'s summed child field and `total`. For these, make the field
required or drop it from the rule.

### The gate reaches a path's *end*, not its middle

`absence-undecided` fires on a path's **terminal** field. A path that reads *through* an optional
ref and ends at a **required** field does not fire at all — and the invariant it forms **can never
fail**:

```lat
context Billing {
  entity PayMethod {
    pmId : Id key
    fee  : Money
  }

  aggregate Payment {
    paymentId     : Id key
    paymentMethod : ref PayMethod?

    /// No diagnostic — and no way for this to be violated by a Payment with no payment method.
    invariant feeIsPositive { paymentMethod.fee > 0 }
  }
}
```

`fee` is required, so nothing is undecided about *it*; the optional thing is the hop. A `Payment`
with no `paymentMethod` does not fail this rule — it satisfies it, silently, forever. **Read that
line again, because you cannot see it in the text of `paymentMethod.fee > 0`.** If what you meant
is "when there is a payment method, its fee must be positive," this is already exactly that rule
and you need do nothing. If what you meant is "a Payment must **not** be able to sit here without a
fee," this form cannot say it — the thing the rule truly depends on is the payment method's
existence, and it has to be read directly, with `present(paymentMethod)` in the rule.

This is not a second rule bolted on for optionality. **Every ref-hop in this language already
resolves vacuously when its target is absent**, and has since before optional fields existed: the
evaluator returns `undefined` for a hop it cannot resolve and its comparison then permits
(`evaluate.ts`), and the Quint emitter wraps each comparison as `allExist implies cmp` so Apalache
cannot manufacture a counterexample by reading through a record no action ever created. An absent
optional ref is the same fact as a ref pointing at nothing, so it gets the same answer. Making the
end of a path explicit while leaving its hops vacuous is what keeps optionality from silently
re-deciding rules already written.

The cost is real and was accepted knowingly: **the language has two absence rules — explicit at a
path's end, vacuous through its hops.** Unifying them would change the meaning of every
ref-crossing invariant already written, so it needs its own slice and a migration, not a quiet
widening of this one.

## Semantic Rules

- Context-level invariants require `on <OwnerName>`; omitting it is `missing-target`.
- In-aggregate invariants may restate the owner with `on <SameAggregate>`, which is accepted but
  flagged `redundant-target`.
- `where` on anything but a predicate body is `where-unsupported`.
- The invariant name must be camelCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier.
- Every path referenced in a predicate must resolve on the target owner; an unresolvable path
  reports `unknown-path`, a path ending at a `key` field reports `key-path`, and a path ending at
  a non-numeric field (`Text`/`Id`) reports `unrepresentable-path` — including inside `present()`,
  so `present(f)` on a `Text?`/`Id?` field is rejected like any other read of one (see
  [field types](field-types.md)).
- A predicate body reading a path that **ends at** an optional field, with no dominating
  `present()`, reports `absence-undecided`. A path that ends at a required field does not, even if
  it hops through an optional ref — see above.
- A predicate whose shape exactly matches a [derived invariant](derived-invariants.md) is not
  rejected — it loads, but is reported as `redundant-invariant` (a warning, not an error) and is
  not printed; the derived rule already covers it.

## Example

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money
    paid      : Money

    lifecycle settlement {
      states { open @initial, closed @terminal }
      transition close { from open to closed }
    }

    invariant paidMatchesOnClose {
      state settlement in {closed} => paid == total
    }
  }
}
```

## See also

- [Invariant forms](invariant-forms.md)
- [Derived invariants](derived-invariants.md)
- [Aggregate](aggregate.md)
- [Doc comments](doc-comments.md)
