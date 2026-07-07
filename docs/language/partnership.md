# Partnership

A DDD pattern for two contexts with a mutual dependency: neither is strictly upstream or
downstream of the other, so the teams succeed or fail together and must coordinate planning and
releases rather than one side dictating to the other. Unlike
[upstream-downstream](upstream-downstream.md), a partnership carries no roles and no
upstream/downstream direction.

In Lattice, `partnership` is a symmetric [context map](context-map.md) relationship kind,
declared with `partnership with`.

## Syntax

```lat
contextMap Acme {
  contains Billing
  contains Ordering

  /// Billing and Ordering release together; changes are coordinated.
  Billing partnership with Ordering {
    exposes Invoice
  }
}
```

## Semantic Rules

- Both sides must be declared contexts (`unknown-relationship-endpoint`); a context cannot
  partner with itself (`self-relationship`).
- `exposes` is optional and, unlike `upstream-downstream`, bidirectional: a name is valid if it
  is declared as an entity or aggregate in *either* side of the partnership
  (`unknown-exposed-type` otherwise checks both).
- A qualified `ref` to either partner's exposed type is covered from either direction
  (`uncovered-cross-context-ref` otherwise) — the relationship has no upstream/downstream
  asymmetry to enforce.
- No `upstream roles` / `downstream roles` clauses exist for `partnership` — the grammar simply
  has no slot for them, so this is a parse error rather than a diagnostic.

## Example

```lat
contextMap Acme {
  contains Billing
  contains Ordering

  Billing partnership with Ordering { }
}
```

## See also

- [Shared kernel](shared-kernel.md)
- [Upstream-downstream](upstream-downstream.md)
- [Context map](context-map.md)
