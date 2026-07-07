# Context map

A `contextMap` is the single authored index of a workspace: it lists the bounded contexts
(each a `.lat` [context](README.md)) and the CML-style strategic relationships between them
— [upstream-downstream](upstream-downstream.md), [partnership](partnership.md), and
[shared kernel](shared-kernel.md). It lives at `specs/context-map.lat` and is parsed by the
same grammar as any other `.lat` file (`LatFile: LatContext | ContextMapDecl`).

## Syntax

```lat
/// Acme billing: catalog-driven subscriptions.
contextMap AcmeBilling {
  contains Subscriptions
  contains Catalog from "catalog"

  /// Subscriptions consumes plan definitions from the catalog.
  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    downstream roles anticorruption
    exposes Plan
  }
}
```

Each `contains` entry names a member context; `from "<path>"` gives the workspace-relative
directory holding its `spec.lat`. The path is optional — when omitted it defaults to the
decapitalized context name (`Subscriptions` → `subscriptions`), so `contains Subscriptions`
above resolves to `subscriptions/spec.lat`.

## Semantic Rules

- Every context name must be a valid identifier and not a reserved word (`invalid-name`,
  `reserved-word`).
- No two `contains` entries may declare the same context name (`duplicate-context`).
- A relationship cannot name the same context on both sides (`self-relationship`).
- Every relationship endpoint must be a declared context (`unknown-relationship-endpoint`).
- At the workspace level (checked by the `docs` command, not by parsing alone): each
  `contains` path must resolve to a `spec.lat` whose own `context` name matches the declared
  name (`context-name-mismatch`); each `exposes` entry must name a real entity or aggregate in
  the exposing context (`unknown-exposed-type`); and every qualified cross-context `ref` in a
  member spec must be covered by a declared relationship (`uncovered-cross-context-ref`).

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

- [Upstream-downstream](upstream-downstream.md)
- [Partnership](partnership.md)
- [Shared kernel](shared-kernel.md)
- [README](README.md)
