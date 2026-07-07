# Tags

`@name` annotations attach extra meaning to a field or a machine state. Some tags feed
[derived invariants](derived-invariants.md) automatically; others are informational or change
how a template-matched invariant is proposed.

## Syntax

```lat
context Billing {
  aggregate Invoice {
    invoiceId        : Id key
    licenseFeeAmount : Money @total
    usageAmount      : Money @total
    totalDue         : Money @total
    amountPaid       : Money @balance @signed

    machine {
      region settlement { states { draft @initial, open @active, paid @terminal } }
      transition finalize { region settlement; from draft to open }
      transition settle { region settlement; from open to paid }
    }
  }
}
```

`@<tag>` follows a field's type (after an optional `key`) or a state name; a field or state may
carry more than one tag.

## The six tags

| Tag | Applies to | Meaning |
|---|---|---|
| `@total` | field | Marks this `Money` field as a "total" candidate for the conservation template — paired with ≥2 `@balance` fields, the elicitation flow proposes `conserve <balances> == <total>`. |
| `@balance` | field | Marks this `Money` field as a "part" candidate for the same conservation template. |
| `@signed` | field | Suppresses the [derived](derived-invariants.md) non-negative rule that would otherwise apply to a `Money` field — use it on a field that can legitimately go negative (a running balance, a refund adjustment). |
| `@active` | state | Documents "this is a normal operating state" — informational only; no derived rule reads it. |
| `@terminal` | state | Once entered, this state is never left — [derived](derived-invariants.md) automatically as a `terminal` invariant, opt out by removing the tag. |
| `@initial` | state | Marks the region's starting state — **exactly one** per region is required (`multiple-initial` otherwise); this is the one tag that is structurally load-bearing, not just advisory. |

`@total`/`@balance`/`@signed` are field tags; `@initial`/`@active`/`@terminal` are state tags.
Applying a state tag to a field or vice versa is not blocked by the grammar itself (`TagName`
accepts any identifier plus the keywords `terminal`, `monotonic`, `state`, `key`), but only the
tags in the table above are read by the mapper and the engine — anything else is inert.

## Semantic Rules

- Exactly one state per region must carry `@initial`; zero or more than one is `multiple-initial`.
- `@terminal` on a state implies a stays-terminal rule for that state unless the tag is removed;
  removing it is an invariant-removing edit if that derived rule has ledger history (see
  [editing](editing.md)).
- `@signed` on a `Money` field suppresses that field's implied non-negative rule; adding `@signed`
  to a previously-unsigned field removes a derived invariant, subject to the same removal ceremony
  when ledger history exists.
- `@total` and `@balance` only affect template matching during elicitation (which invariants get
  *proposed*) — they carry no independent semantic check of their own and never block a load.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    machine {
      region lifecycle {
        states { trialing @initial, active @active, canceled @terminal, expired @terminal }
      }
      transition activate { region lifecycle; from trialing to active }
      transition cancel { region lifecycle; from active to canceled }
      transition expire { region lifecycle; from trialing to expired }
    }
  }
}
```

## See also

- [Derived invariants](derived-invariants.md)
- [Field types](field-types.md)
- [Machine](machine.md)
- [Editing](editing.md)
