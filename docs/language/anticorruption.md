# Anticorruption layer

A DDD pattern where the **downstream** context builds a translation layer that shields its own
model from the upstream's — converting the upstream's shapes into the downstream's own concepts
at the boundary, rather than letting foreign modeling decisions leak into its domain. It costs
extra mapping code, but keeps the downstream model coherent even when the upstream isn't
well-behaved.

In Lattice, `anticorruption` is one of the [upstream-downstream](upstream-downstream.md) role
keywords, listed under `downstream roles`.

## Syntax

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  /// Subscriptions translates Catalog's Plan shape at its own boundary.
  Catalog upstream of Subscriptions {
    downstream roles anticorruption
    exposes Plan
  }
}
```

## Semantic Rules

- `anticorruption` is only valid in `downstream roles`; using it under `upstream roles` is a
  syntax error — the grammar's `upstream roles` clause accepts only `openHost`/`publishedLanguage`
  (`UpstreamRoleName`), a separate rule from the `downstream roles` clause's vocabulary.
- The role itself does not relax `exposes` checking — the downstream still may only reference
  types the relationship exposes (`unknown-exposed-type`, `uncovered-cross-context-ref`); the
  translation the pattern describes is a modeling discipline in the downstream's own spec, not a
  structural exemption.
- Contrast with [conformist](conformist.md): a downstream chooses one or the other, never both,
  for a given relationship.

## Example

```lat
contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    downstream roles anticorruption
    exposes Plan
  }
}
```

## See also

- [Conformist](conformist.md)
- [Upstream-downstream](upstream-downstream.md)
- [Context map](context-map.md)
