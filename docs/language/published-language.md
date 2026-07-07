# Published language

A DDD pattern where an upstream context publishes a well-documented, shared interchange model
for its data — a model both sides commit to as the contract, rather than each downstream
inferring the shape from the upstream's internals. It typically pairs with
[open host](open-host.md): the service is the mechanism, the published language is the
documented shape flowing over it.

In Lattice, `publishedLanguage` is one of the [upstream-downstream](upstream-downstream.md) role
keywords, listed under `upstream roles`. The `exposes` list on the relationship is the
published language in practice: the named types are the upstream's committed, documented
interchange shapes.

## Syntax

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  /// Plan is Catalog's published language for downstream consumers.
  Catalog upstream of Subscriptions {
    upstream roles publishedLanguage
    exposes Plan
  }
}
```

## Semantic Rules

- `publishedLanguage` is only valid in `upstream roles`; it never appears under
  `downstream roles` (grammar-enforced, not a diagnostic).
- Each type in `exposes` must be declared as an entity or aggregate in the upstream context
  (`unknown-exposed-type`) — the published language is exactly this checked list, not free text.
- A downstream referencing an exposed type with a qualified `ref Catalog.Plan` field is only
  legal when the relationship's `exposes` covers it (`uncovered-cross-context-ref` otherwise).

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

- [Open host](open-host.md)
- [Upstream-downstream](upstream-downstream.md)
- [Context map](context-map.md)
