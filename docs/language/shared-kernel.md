# Shared kernel

A DDD pattern where two contexts genuinely share a slice of the model — not a copy, the same
model — and agree that slice may only be changed by mutual consent, since either side's
unilateral edit breaks the other. It is the tightest-coupling strategic relationship, chosen
deliberately when duplicating or fully separating the shared slice would cost more than the
coordination overhead.

In Lattice, `sharedKernel` is a symmetric [context map](context-map.md) relationship kind,
declared with `sharedKernel with` — syntactically identical in shape to
[partnership](partnership.md), distinguished only by the DDD intent the keyword names.

## Syntax

```lat
contextMap Acme {
  contains Billing
  contains Ordering

  /// Billing and Ordering share the Money value shape; change it together.
  Billing sharedKernel with Ordering {
    exposes Invoice
  }
}
```

## Semantic Rules

- Both sides must be declared contexts (`unknown-relationship-endpoint`); a context cannot share
  a kernel with itself (`self-relationship`).
- `exposes` is optional and bidirectional, exactly as for `partnership`: a name is valid if
  declared as an entity or aggregate in either side (`unknown-exposed-type` otherwise).
- A qualified `ref` to either side's exposed type is covered from either direction
  (`uncovered-cross-context-ref` otherwise).
- No `upstream roles` / `downstream roles` clauses exist for `sharedKernel` — there is no
  upstream/downstream direction to annotate.

## Example

```lat
contextMap Acme {
  contains Billing
  contains Ordering

  Billing sharedKernel with Ordering { }
}
```

## See also

- [Partnership](partnership.md)
- [Upstream-downstream](upstream-downstream.md)
- [Context map](context-map.md)
