# Context

The top-level unit of a `.lat` file: one bounded `context` per file, holding its enums, entities,
aggregates, events, and context-level invariants. A workspace is many contexts tied together by a
[context map](context-map.md).

## Syntax

```lat
/// A tiny billing context.
context Billing {
  ticksPerDay = 24

  enum Status { draft, active, closed }

  aggregate Invoice {
    invoiceId : Id key
    total     : Money
    status    : Status
    invariant nonNegative { total >= 0 }
  }
}
```

`context <PascalId> { <item>* }` where an item is an `enum`, `entity`, `event`, `aggregate`,
context-level `invariant`, `ticksPerDay`, or a [`module`](module.md) grouping block. The file holding this context lives at
`specs/<path>/spec.lat`, one context per file — the workspace's [context map](context-map.md)
declares which path backs which context name (`contains Billing from "billing"` →
`billing/spec.lat`).

`ticksPerDay` sets the time granularity used by `Date`/`Duration` fields and by `now` in
predicates — a tick is the smallest unit of simulated time. It defaults to 24 (a tick is one hour)
when omitted.

A leading `///` doc comment attaches to the context itself and carries the one-paragraph
description that appears at the top of the generated prose projection.

## Semantic Rules

- The context name must be a valid identifier and not a [reserved word](naming-conventions.md)
  (`invalid-name`, `reserved-word`).
- At the workspace level (checked by the `docs` command, not by parsing alone): a member's
  `context` name must match the name declared for it in the `contains` entry
  (`context-name-mismatch`).
- `ticksPerDay` is a plain integer; it never appears in the closed invariant grammar itself — only
  `now` reads it, indirectly, when a predicate is evaluated.

## Example

```lat
context Scheduling {
  ticksPerDay = 24

  enum Priority { low, high }

  entity Task {
    taskId   : Id key
    priority : Priority
  }
}
```

## See also

- [Context map](context-map.md)
- [Module](module.md)
- [Enum](enum.md)
- [Entity](entity.md)
- [Aggregate](aggregate.md)
- [README](README.md)
