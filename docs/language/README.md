# Lattice language reference

Lattice is a DDD-flavored specification language. A `.lat` file holds one bounded `context` —
its enums, entities, aggregates, events, state machines, and invariants — and a workspace-level
`context-map.lat` indexes the contexts and the CML-style strategic relationships between them.

## Index

| Group | Pages |
|---|---|
| Overview | `README.md` (this page: index + tour) |
| Strategic | [`context-map.md`](context-map.md) (`contextMap`, `contains`/`from`), [`upstream-downstream.md`](upstream-downstream.md) (incl. `exposes`), [`open-host.md`](open-host.md), [`published-language.md`](published-language.md), [`anticorruption.md`](anticorruption.md), [`conformist.md`](conformist.md), [`partnership.md`](partnership.md), [`shared-kernel.md`](shared-kernel.md) |

Structure, Behavior, Invariants, and Meta pages (`context.md`, `enum.md`, `entity.md`,
`aggregate.md`, `field-types.md`, `event.md`, `machine.md`, `transition.md`, `invariant.md`,
`invariant-forms.md`, `derived-invariants.md`, `doc-comments.md`, `naming-conventions.md`,
`tags.md`, `editing.md`) land in later reference batches.

## A 10-line tour

A context declares its vocabulary — enums and entities — and its consistency boundaries as
aggregates with an optional state machine and invariants:

```lat
/// A tiny billing context.
context Billing {
  enum Status { draft, active, closed }
  aggregate Invoice {
    invoiceId : Id key
    total     : Money
    status    : Status
    invariant nonNegative { total >= 0 }
  }
}
```

Multiple contexts are tied together by a [context map](context-map.md), which declares the
roster of contexts and their [strategic relationships](upstream-downstream.md) — who is
upstream of whom, what each side exposes, and whether the relationship is a plain
upstream-downstream, a [partnership](partnership.md), or a [shared kernel](shared-kernel.md).

## Two invariants of these docs

- **Examples always parse.** Every ` ```lat ` block on every page is a complete, parseable
  `context` or `contextMap` file, and CI extracts and parses every one
  (`lattice/test/docs-blocks.test.ts`). Deliberately-invalid syntax is shown in a plain fence,
  never a ` ```lat ` one.
- **Grammar changes ship with page updates.** A change to `lattice/src/parse/lat.langium` that
  invalidates an example fails that CI check — the docs cannot silently rot into pseudo-code.
