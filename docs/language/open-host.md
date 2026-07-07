# Open host service

A DDD pattern for an upstream context with many downstream consumers: instead of negotiating a
bespoke integration with each one, the upstream publishes a single, stable service or protocol
that any consumer can adopt. It trades per-consumer customization for a shared, well-known
interface — the standard way an upstream scales past one or two downstreams.

In Lattice, `openHost` is one of the [upstream-downstream](upstream-downstream.md) role
keywords, listed under `upstream roles` in a [context map](context-map.md) relationship.

## Syntax

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  /// Catalog is the open host for every plan consumer.
  Catalog upstream of Subscriptions {
    upstream roles openHost
    exposes Plan
  }
}
```

## Semantic Rules

- `openHost` is only valid in `upstream roles` (the grammar's `RoleName` rule); using it under
  `downstream roles` is a syntax error, not a semantic diagnostic.
- Like any upstream role, it does not change how `exposes` is checked: each exposed name must
  still be a real entity or aggregate in the upstream context (`unknown-exposed-type`).
- Multiple upstream roles may combine, e.g. `openHost, publishedLanguage` — see
  [published language](published-language.md), which frequently accompanies an open host.

## Example

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    exposes Plan
  }
}
```

## See also

- [Upstream-downstream](upstream-downstream.md)
- [Published language](published-language.md)
- [Context map](context-map.md)
