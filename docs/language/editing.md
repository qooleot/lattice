# Editing

`.lat` is git-facing and hand-editable: an engineer edits `specs/<name>/spec.lat` directly, and
`engine apply` (or its watcher wrapper, `engine sync`) parses it, reconciles the change against
every prior judgment in the ledger, and re-renders every [projection](projections.md). This page
covers that apply/sync loop, the rename ceremony, forced removals, and how a brand-new context
bootstraps.

## The apply/sync loop

```lat
context Billing {
  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    invariant nonNegativeTotal { total >= 0 }
  }
}
```

`engine apply --lat specs/billing/spec.lat --session .lattice-session-billing` runs the pipeline
once: parse → map + validate → diff against the session's stored model → reconcile renames and
invariant changes against the ledger → write. Every step is atomic — any refusal at any step means
**nothing is written**; the session and files are left byte-identical to before the attempt.
`--dry-run` reports the full diff and reconciliation verdicts without writing anything.

`engine sync --lat specs/billing/spec.lat --session .lattice-session-billing` is a thin
debounced-watcher wrapper over the identical `apply` routine: it re-runs on every save, keeps
watching through failures, and prints each outcome — useful for an editor-attached workflow where
you want continuous feedback instead of invoking `apply` by hand after each change.

Both commands refuse outright if the session shows a mid-flight elicitation in progress (an open
`propose`/`verdict` question loop): finish or abandon that session first.

## Rename ceremony

Renaming a field, state, transition, enum value, or invariant is detected as a delete+add pair of
the same kind. If the old name is **not** referenced anywhere in the ledger (no witness, no
provenance text names it), the rename applies silently, no ceremony needed. If it **is**
referenced, `apply` refuses and prints the exact re-run:

```
--rename Subscription.accruedUnits=usedUnits
```

Re-running with that flag confirms the rename: the model's references are rewritten, and a
`rename` ledger entry is appended (append-only — historical entries are never rewritten). Witness
replay resolves old names through the accumulated mapping, so chained renames compose correctly
across multiple `apply` runs. `--rename` accepts multiple flags in one invocation for multiple
simultaneous renames.

## `--force-remove`

Deleting an explicit invariant block, removing `@terminal` from a state, adding `@signed` to a
`Money` field, or deleting a `ref` field all count as removing an invariant (see
[derived invariants](derived-invariants.md) for why the tag edits count too). If the invariant
being removed has ledger history, `apply` refuses unless the removal is confirmed with
`--force-remove <invariantName>` — which appends a `declined` ledger entry recording the explicit
overrule. Without a matching `--force-remove`, the whole apply is refused; nothing is written.
The declined entry's reason is settable with `--reason '<why>'` alongside `--force-remove`; without
it, the entry falls back to the fixed text `hand-removed via --force-remove`.

## Refusals name the witness and the verdict

An invariant add or edit is replayed against every `verdict` entry in the ledger before it is
accepted. A refusal always names the concrete witness and verdict it conflicts with, never a bare
"invariant conflicts with history":

```
this edit permits the state in w5, judged forbid on 2026-07-05 — re-judge with the domain expert
or revert
```

or, for the opposite direction (a *permit*-judged witness newly forbidden by the edit):

```
invariant oneDraftPerSubscription forbids the state in w2, judged permit on 2026-06-30 — re-judge
with the domain expert or revert
```

Both name the exact witness id, the verdict it was judged under, and the judgment date — the
refusal is always actionable: re-judge with a domain expert, or revert the edit.

## Fresh-session bootstrap

Applying a `.lat` file against a session directory that does not yet exist is treated as a brand
new, hand-authored context: there is no prior model to diff against and no verdicts to contradict,
so **every** invariant in the file — explicit and derived — adopts immediately, with provenance
`hand-authored <date>`. This is how a new context enters the system: write the `.lat` file by hand
first, then `apply` it once with no `--session` history to reconcile against.

## Semantic Rules

- `apply`/`sync` never partially write: a refusal at any pipeline step leaves the session and spec
  files untouched.
- A rename is proposed only for a delete+add pair of the *same construct kind* (e.g. a field
  deleted and a field added, not a field deleted and a transition added).
- An unreferenced-by-the-ledger delete+add pair never needs `--rename` — it just applies as a
  plain removal-and-addition.
- `--force-remove` is invariant-scoped (by name), not construct-scoped: it names the invariant
  whose removal is being forced, which may be an explicit block or a derived rule's name.
- A session showing `phase !== 'converged'` or non-empty pending witnesses blocks `apply`/`sync`
  until the elicitation session is finished or abandoned.

## See also

- [Projections](projections.md)
- [Derived invariants](derived-invariants.md)
- [Invariant](invariant.md)
