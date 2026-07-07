# Conformist

A DDD pattern where the **downstream** context adopts the upstream's model as-is, with no
translation layer at the boundary. It is cheaper than an [anticorruption layer](anticorruption.md)
when the upstream's model is well-designed and stable enough to live with directly, or when the
downstream has no leverage to demand otherwise.

In Lattice, `conformist` is one of the [upstream-downstream](upstream-downstream.md) role
keywords, listed under `downstream roles`.

## Syntax

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  /// Subscriptions conforms to Catalog's Plan shape directly.
  Catalog upstream of Subscriptions {
    downstream roles conformist
    exposes Plan
  }
}
```

## Semantic Rules

- `conformist` is only valid in `downstream roles`; it never appears under `upstream roles`
  (grammar-enforced, not a diagnostic).
- The role is descriptive, not structural: `exposes` checking (`unknown-exposed-type`) and
  qualified-ref coverage (`uncovered-cross-context-ref`) apply the same whether the downstream
  conforms or translates.
- Contrast with [anticorruption](anticorruption.md): a downstream chooses one or the other, never
  both, for a given relationship.

## Example

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    downstream roles conformist
    exposes Plan
  }
}
```

## See also

- [Anticorruption layer](anticorruption.md)
- [Upstream-downstream](upstream-downstream.md)
- [Context map](context-map.md)
