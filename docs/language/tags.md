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

## The eight tags

| Tag | Applies to | Meaning |
|---|---|---|
| `@total` | field | Marks this `Money` field as the "total" for the conservation template — paired with ≥2 `@balance` fields on the same owner, `matchTemplates` **adopts** `conserve <balances> == <total>`: `engine init` records it with `status: 'adopted'` and a ledger entry, with no review gate. |
| `@balance` | field | Marks this `Money` field as a "part" of that same adopted conservation rule. |
| `@signed` | field | Suppresses the [derived](derived-invariants.md) non-negative rule that would otherwise apply to a `Money` field — use it on a field that can legitimately go negative (a running balance, a refund adjustment). |
| `@unsigned` | field | Records that this `Money` field's sign was **decided**: it may not go negative. Inert to the language — the non-negative rule already applies by default, so `@unsigned` changes no rule and suppresses none. It exists so `engine init` can tell a decided field from an unconsidered one; `init` rejects a `Money` field carrying neither `@signed` nor `@unsigned`. |
| `@monotonic` | field | Marks a numeric field that never decreases; `matchTemplates` adopts a `monotonic` invariant for it. Template-adopted only: `engine propose` and `engine regenerate` reject the `monotonic` candidate kind as `not-elicitable` (`UNELICITABLE_KINDS` in `cli.ts`), so tagging the field is the only route by which the engine itself introduces this rule — a spec author can still write `monotonic <path>` by hand in `.lat`, which the grammar accepts (`MonotonicBody`). |
| `@active` | state | Documents "this is a normal operating state" — no [derived](derived-invariants.md) rule reads it, but `matchTemplates` does: it seeds the tpl-7 `unique while active by (parent)` candidate and the tpl-11 deadline-bound candidate from it. |
| `@terminal` | state | Once entered, this state is never left — [derived](derived-invariants.md) automatically as a `terminal` invariant, opt out by removing the tag. |
| `@initial` | state | Marks the lifecycle block's starting state — **exactly one** per block is required (`multiple-initial` otherwise); this is the one tag that is structurally load-bearing, not just advisory. |

`@total`/`@balance`/`@signed`/`@unsigned`/`@monotonic` are field tags; `@initial`/`@active`/`@terminal`
are state tags. Applying a state tag to a field or vice versa is not blocked by the grammar itself
(`TagName` accepts any identifier plus the keywords `terminal`, `monotonic`, `state`, `key`), but only
the tags in the table above are read by the mapper and the engine — anything else is inert.

## Semantic Rules

- Exactly one state per lifecycle block must carry `@initial`; zero or more than one is `multiple-initial`.
- `@terminal` on a state implies a stays-terminal rule for that state unless the tag is removed;
  removing it is an invariant-removing edit if that derived rule has ledger history (see
  [editing](editing.md)).
- `@signed` on a `Money` field suppresses that field's implied non-negative rule; adding `@signed`
  to a previously-unsigned field removes a derived invariant, subject to the same removal ceremony
  when ledger history exists.
- `@unsigned` is never required by `loadLatText` — a bare `Money` field is legal, and non-negative by
  default. Only `engine init` requires an explicit decision (`money-sign-undecided`), because a
  machine-authored model must not inherit a default nobody considered. A field tagged both `@signed`
  and `@unsigned` is `money-sign-contradictory` at `init`; the two are mutually exclusive.
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
