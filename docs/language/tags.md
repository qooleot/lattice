# Tags

`@name` annotations attach extra meaning to a field or a lifecycle state. Some tags feed
[derived invariants](derived-invariants.md) automatically; others are informational or feed
`matchTemplates`, which adopts or seeds an invariant depending on the tag.

## Syntax

```lat
context Billing {
  aggregate Invoice {
    invoiceId        : Id key
    licenseFeeAmount : Money @total
    usageAmount      : Money @total
    totalDue         : Money @total
    amountPaid       : Money @balance @signed

    lifecycle settlement {
      states { draft @initial, open @active, paid @terminal }
      transition finalize { from draft to open }
      transition settle { from open to paid }
    }
  }
}
```

`@<tag>` follows a field's type (after an optional `key`) or a state name; a field or state may
carry more than one tag.

## The ten tags

| Tag | Applies to | Meaning |
|---|---|---|
| `@public` | field | Marks this field as part of the public API surface (opt-in; **internal is the default**). The TypeScript codegen emits `/** @public */` above the field; the Ruby backend (future slice) will include it in the public interface. May be combined with `@hookOnly`. |
| `@hookOnly` | field | Narrows public exposure to hook-only access (`@public (hook-only)` in generated JSDoc). Without `@public`, `@hookOnly` alone also implies public-but-hook-only exposure. |
| `@total` | field | Marks this field as the "total" for the conservation template — paired with ≥2 `@balance` fields on the same owner, `matchTemplates` **adopts** `conserve <balances> == <total>`: `engine init` records it with `status: 'adopted'` and a ledger entry, with no review gate. Goes on a `Money` field, or on a **value-typed** field with exactly one numeric sub-field (see below). |
| `@balance` | field | Marks this field as a "part" of that same adopted conservation rule. Same placement rule as `@total`. |
| `@signed` | field | Suppresses the [derived](derived-invariants.md) non-negative rule that would otherwise apply to a money path — use it on a field that can legitimately go negative (a running balance, a refund adjustment). A **use-site** tag (see below). |
| `@unsigned` | field | Records that this field's money sign was **decided**: it may not go negative. Inert to the language — the non-negative rule already applies by default, so `@unsigned` changes no rule and suppresses none. It exists so `engine init` can tell a decided field from an unconsidered one; `init` rejects a money field carrying neither `@signed` nor `@unsigned`. A **use-site** tag (see below). |
| `@monotonic` | field | Marks a numeric field that never decreases; `matchTemplates` adopts a `monotonic` invariant for it. Template-adopted only: `engine propose` and `engine regenerate` reject the `monotonic` candidate kind as `not-elicitable` (`UNELICITABLE_KINDS` in `cli.ts`), so tagging the field is the only route by which the engine itself introduces this rule — a spec author can still write `monotonic <path>` by hand in `.lat`, which the grammar accepts (`MonotonicBody`). |
| `@active` | state | Documents "this is a normal operating state" — no [derived](derived-invariants.md) rule reads it, but `matchTemplates` does: it seeds the tpl-7 `unique while active by (parent)` candidate and the tpl-11 deadline-bound candidate from it. |
| `@terminal` | state | Once entered, this state is never left — [derived](derived-invariants.md) automatically as a `terminal` invariant, opt out by removing the tag. |
| `@initial` | state | Marks the lifecycle block's starting state — **exactly one** per block is required (`multiple-initial` otherwise); this is the one tag that is structurally load-bearing, not just advisory. |

`@public`/`@hookOnly`/`@total`/`@balance`/`@signed`/`@unsigned`/`@monotonic` are field tags;
`@initial`/`@active`/`@terminal` are state tags. Applying a state tag to a field or vice versa is not
blocked by the grammar itself (`TagName` accepts any identifier plus the keywords `terminal`,
`monotonic`, `state`, `key`), but only the tags in the table above are read by the mapper and the
engine — anything else is inert.

## Tags on a value-typed field

A [value](value.md) type is structural — it flattens into its sub-fields — so a tag on a
value-typed field is a claim about the money *inside* it, and both money tags resolve through:

- **`@signed`/`@unsigned` are use-site tags.** They belong on the field *typed* with the value,
  never inside the value's declaration. A `value Amount { amount : Money, currency : Text }` is
  non-negative at `Bill.total` and signed at `LedgerAccount.balance` — one tag on the declaration
  could not express both even in principle. A sign tag written inside a `value` block reports
  `value-money-sign-inert`: the derivation reads the use site, so it would otherwise sit there
  doing nothing. A single tag covers **every** money path the value reaches, at whatever depth:
  `@unsigned` on `totals : LineTotals` decides `totals.net.amount` and `totals.gross.amount` alike.
- **`@balance`/`@total` resolve to the value's single numeric sub-field.** `total : Amount @total`
  conserves as `total.amount`. "Numeric" is `Int`/`Money`/`Date`/`Duration` — the types a sum means
  something for — found by walking through however many value hops it takes. Zero or several
  matches leaves the tag with nothing to name and reports `ambiguous-numeric-tag`: the tag must name
  exactly one summable number.

## Semantic Rules

- Exactly one state per lifecycle block must carry `@initial`; zero or more than one is `multiple-initial`.
- `@terminal` on a state implies a stays-terminal rule for that state unless the tag is removed;
  removing it is an invariant-removing edit if that derived rule has ledger history (see
  [editing](editing.md)).
- `@signed` on a field suppresses the implied non-negative rule for **every** money path that field
  carries — the field itself when it is a `Money` prim, or each `Money` sub-field reachable through
  it when it is value-typed. Adding `@signed` to a previously-unsigned field removes a derived
  invariant, subject to the same removal ceremony when ledger history exists.
- `@unsigned` is never required by `loadLatText` — a bare `Money` field is legal, and non-negative by
  default. Only `engine init` requires an explicit decision (`money-sign-undecided`), because a
  machine-authored model must not inherit a default nobody considered. That demand covers a
  **nested child's** money fields and a value's money sub-fields, at the use site, exactly as it
  covers an aggregate's own. A field tagged both `@signed` and `@unsigned` is
  `money-sign-contradictory` — unlike undecidedness, a contradiction is never a legal default, so
  it is rejected on **every** path, `loadLatText` and `engine init` alike; the two tags are
  mutually exclusive.
- `@total` and `@balance` are read by `matchTemplates`, which **adopts** the conservation rule from
  a `≥2 @balance` + `@total` shape at `init` — a ledger entry, no review gate, no elicitation
  involved — but the tags carry no independent semantic check of their own and never block a load.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    lifecycle standing {
      states { trialing @initial, active @active, canceled @terminal, expired @terminal }
      transition activate { from trialing to active }
      transition cancel { from active to canceled }
      transition expire { from trialing to expired }
    }
  }
}
```

## See also

- [Derived invariants](derived-invariants.md)
- [Field types](field-types.md)
- [Lifecycle](lifecycle.md)
- [Editing](editing.md)
