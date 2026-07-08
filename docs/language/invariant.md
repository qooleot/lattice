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

## Semantic Rules

- Context-level invariants require `on <OwnerName>`; omitting it is `missing-target`.
- In-aggregate invariants may restate the owner with `on <SameAggregate>`, which is accepted but
  flagged `redundant-target`.
- `where` on anything but a predicate body is `where-unsupported`.
- The invariant name must be camelCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier.
- Every path referenced in a predicate must resolve on the target owner; an unresolvable path
  reports `unknown-path`, a path ending at a `key` field reports `key-path`, and a path ending at
  a non-numeric field (`Text`/`Id`) reports `unrepresentable-path`.
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
