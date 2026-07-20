# Doc comments

`.lat` has exactly one comment form: `///`. There is no `//` and no `/* */` — a plain `//` is not
merely discouraged, it is a parse error.

## Syntax

```lat
/// Acme billing: catalog-driven subscriptions.
context Billing {
  /// The billing cadence for a subscription.
  enum BillingPeriod { monthly, annual }

  /// Pricing definition: per-seat license fee plus usage billing.
  entity Plan {
    planId : Id key
    /// The external customer-facing plan identifier.
    /// Visible to API consumers.
    externalId : Text @public
  }

  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    /// Nothing is ever billed negative.
    invariant nonNegativeTotal { total >= 0 }
  }
}
```

A `///` line attaches to the construct that immediately follows it: the `context`, an `enum`,
`entity`, `aggregate`, `event`, `invariant`, or an individual **field**. Multiple consecutive
`///` lines join into one string (space-joined) on that construct's `doc` field. The doc
round-trips: it is stored on the AST, re-emitted by the printer, and rendered into the generated
`spec.prose.md` projection alongside each construct's English description.

Field-level `///` docs are emitted by the TypeScript codegen as a JSDoc block above the property
(`/** <doc> */`, optionally with a `@public` / `@public (hook-only)` visibility marker if the field
carries `@public` or `@hookOnly` tags — see [tags](tags.md)). Enum-level `///` docs are emitted
as a `/** <doc> */` JSDoc block above the `export type` line.

`///` doc comments are not supported on lifecycle blocks, states, or transitions; the
grammar has no `doc` slot for those constructs.

## `//` is banned

A plain `//` anywhere in a `.lat` file — even as a would-be inline comment — is rejected before
parsing even starts, with a diagnostic suggesting `///`:

```
context Billing {
  // TODO: revisit this threshold
  aggregate Invoice {
    invoiceId : Id key
  }
}
```

This produces `comment-banned` — "`'//' comments are not part of the language — use '///' for
documentation (it becomes part of the spec)`". The scan happens ahead of the Langium parse (so a
`//` inside a string literal, e.g. a `fairness "..."` message, is correctly not flagged — the
scanner tracks string boundaries) and short-circuits: any `//` in the file is reported before any
other diagnostic, and no `///`-doc attachment or grammar rule is even attempted.

## Semantic Rules

- `///` immediately preceding `context`, `enum`, `entity`, `aggregate`, `event`, `invariant`, or
  a **field** attaches as that construct's doc; consecutive `///` lines join into one doc string.
- Any `//` (not inside a string literal) anywhere in the file is `comment-banned`, checked before
  the grammar parse runs.
- Docs are free-form text — they are exempt from identifier validation (`invalid-name`,
  `reserved-word`) since they are prose, not names.

## See also

- [Enum](enum.md)
- [Invariant](invariant.md)
- [Projections](projections.md)
