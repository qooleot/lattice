# Upstream-downstream

The most common strategic relationship: one context's model influences another's, but not the
reverse. The **upstream** context changes on its own schedule; the **downstream** context must
react to those changes. Declared inside a [context map](context-map.md) with `upstream of`, it
may carry role annotations — [open host](open-host.md), [published language](published-language.md)
on the upstream side; [anticonruption layer](anticorruption.md), [conformist](conformist.md) on
the downstream side — and an `exposes` list naming the types the upstream publishes.

## Syntax

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  /// Subscriptions consumes plan definitions from the catalog.
  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    downstream roles anticorruption
    exposes Plan
  }
}
```

`exposes` mirrors CML's `exposedAggregates`: it belongs to the relationship, is declared by the
upstream side, and names the aggregates/entities the downstream is permitted to reference. Roles
on both sides are optional — a bare `Catalog upstream of Subscriptions { }` is a valid,
role-less relationship.

## Semantic Rules

- Both `left` (upstream) and `right` (downstream) must be declared contexts
  (`unknown-relationship-endpoint`); a context cannot be upstream of itself (`self-relationship`).
- Each name in `exposes` must be declared as an entity or aggregate in the upstream context —
  checked at workspace level, not per-file (`unknown-exposed-type`).
- A qualified `ref Catalog.Plan` field in a downstream spec is only legal when a relationship
  exposes that type from that context to the referencing one; otherwise the workspace reports
  `uncovered-cross-context-ref`.
- Role names are drawn from a closed set: `openHost`, `publishedLanguage` (upstream);
  `anticorruption`, `conformist` (downstream) — anything else is a parse error, not a diagnostic.

## Example

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    exposes Plan
  }
}
```

## See also

- [Context map](context-map.md)
- [Open host](open-host.md)
- [Published language](published-language.md)
- [Anticorruption layer](anticorruption.md)
- [Conformist](conformist.md)
