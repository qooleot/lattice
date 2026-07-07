# Lattice language reference

Lattice is a DDD-flavored specification language. A `.lat` file holds one bounded `context` —
its enums, entities, aggregates, events, state machines, and invariants — and a workspace-level
`context-map.lat` indexes the contexts and the CML-style strategic relationships between them.

## Index

| Group | Pages |
|---|---|
| Overview | `README.md` (this page: index + tour), [`projections.md`](projections.md) (generated files: `spec.prose.md`, `spec.diagrams.md`, `diagrams/*.mmd`, `context-map.generated.md`) |
| Strategic | [`context-map.md`](context-map.md) (`contextMap`, `contains`/`from`), [`upstream-downstream.md`](upstream-downstream.md) (incl. `exposes`), [`open-host.md`](open-host.md), [`published-language.md`](published-language.md), [`anticorruption.md`](anticorruption.md), [`conformist.md`](conformist.md), [`partnership.md`](partnership.md), [`shared-kernel.md`](shared-kernel.md) |
| Structure | [`context.md`](context.md), [`enum.md`](enum.md), [`entity.md`](entity.md), [`aggregate.md`](aggregate.md), [`field-types.md`](field-types.md), [`event.md`](event.md) |
| Behavior | [`machine.md`](machine.md), [`transition.md`](transition.md) |
| Invariants | [`invariant.md`](invariant.md), [`invariant-forms.md`](invariant-forms.md), [`derived-invariants.md`](derived-invariants.md) |
| Meta | [`doc-comments.md`](doc-comments.md), [`naming-conventions.md`](naming-conventions.md), [`tags.md`](tags.md), [`editing.md`](editing.md) |

## A 10-line tour

A [context](context.md) declares its vocabulary — [enums](enum.md) and [entities](entity.md) — and
its consistency boundaries as [aggregates](aggregate.md) with an optional
[state machine](machine.md) and [invariants](invariant.md):

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

`total >= 0` above is actually redundant here — a `Money` field implies non-negativity on its own
(see [derived invariants](derived-invariants.md)) — but it is a clear first example of the
[predicate form](invariant-forms.md). Once a spec exists, it is hand-edited in place and
reconciled by [`engine apply`](editing.md), which re-renders every generated
[projection](projections.md).

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
