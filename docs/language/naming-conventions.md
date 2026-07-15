# Naming conventions

`.lat` has one identifier rule enforced everywhere (letters, digits, underscore, not starting with
a digit — `invalid-name` if violated) and a case *convention* layered on top, per construct kind
(spec P8). The convention is advisory: violating it is a warning, not a rejection.

## The convention table

| Construct | Case | Example |
|---|---|---|
| context | PascalCase | `Billing` |
| enum | PascalCase | `BillingPeriod` |
| enum value | camelCase | `monthly` |
| entity / aggregate / event | PascalCase | `Invoice` |
| field | camelCase | `licenseFee` |
| lifecycle block | camelCase | `standing` |
| state | camelCase | `pastDue` |
| transition | camelCase | `cancelFromTrial` |
| invariant | camelCase | `nonNegativeTotal` |
| contextMap / contains entry | PascalCase | `AcmeBilling` |

```lat
context Billing {
  enum BillingPeriod { monthly, annual }

  aggregate Invoice {
    invoiceId : Id key
    total     : Money

    lifecycle settlement {
      states { open @initial, closed @terminal }
      transition close { from open to closed }
    }

    invariant nonNegativeTotal { total >= 0 }
  }
}
```

## Warning, not error

Every row in the table above is enforced as the `naming-convention` diagnostic — **warning-level**:
`loadLatText` still returns `ok: true`, with the violation listed in `warnings`. A context named
`billing` (lowercase) or a field named `LicenseFee` (PascalCase) loads and works; the warning just
flags the style deviation. This is deliberate: case style is a readability convention the team can
choose to enforce strictly (e.g. in review) without it blocking the parser or the solvers.

## Machine-authored names are normalized, not warned

The warning above governs `.lat` text, which a human wrote. Names this codebase generates itself
arrive by different roads, and neither one passes through the parser, so no `naming-convention`
warning could ever fire on them.

One road is `engine propose`: it reads candidate invariants as JSON. Left unchecked, a name like
`TotalDue_At_Most_Parts` reaches the ledger, gets adopted, and can then only be corrected through
apply's `--rename` confirmation ceremony. So `propose` folds candidate names onto the convention on
the way in ([`toCamelName`](../../lattice/src/ast/naming.ts)), reporting each change under
`normalized`:

```
$ engine propose --session s --candidates round1.json
{ "registered": 4,
  "normalized": [{ "id": "r1-discounts", "from": "TotalDue_At_Most_Parts", "to": "totalDueAtMostParts" }] }
```

The other road is template matching: `matchTemplates` builds invariant names such as
`Conservation_Invoice` or `Monotonic_Invoice_paidTotal` while matching a domain model against the
template catalog, and folds them the same way at its own return, before either `adopt` or `seeds`
is seen outside the module.

The split is about authorship, not construct kind or which module does the folding. In `.lat` the
identifier is the author's and the convention stays advisory — rewriting their file would overstep.
A candidate name or a template-matched name is machine-authored with nothing referencing it yet,
and camelCase is a pure function of the words, so there is no judgment to defer to anyone and no
reason to spend a round-trip asking.

Two candidates in one batch folding onto the same name is the one case that *is* judgment — an
ambiguity no normalizer can settle — and `propose` refuses the batch with `name-collision`. The
check is within-batch only: a later round legitimately re-proposes an earlier name under a new id
to restate the same rule more precisely.

## Reserved words are a hard error

Separately, a fixed set of `.lat` keywords can never be used as an identifier, regardless of case
— attempting to, e.g., name a field `count` or an enum value `state` is `reserved-word`, a hard
diagnostic that fails the load (`loadLatText` returns `ok: false`). This is stricter than
`naming-convention`: keywords collide with the grammar itself, so a name reusing one isn't just
poor style — the printer could not even re-emit it as valid syntax. See
[`RESERVED_WORDS`](../../lattice/src/ast/reserved.ts) for the complete, hand-maintained list
(kept in lockstep with the grammar by a sync test): `aggregate`, `anticorruption`, `by`, `conformist`, `conserve`, `const`, `contains`, `context`, `contextMap`, `count`, `creates`, `downstream`, `emits`, `entity`, `enum`, `event`, `exposes`, `fairness`, `from`, `in`, `invariant`, `key`, `leads`, `lifecycle`, `List`, `monotonic`, `now`, `of`, `on`, `openHost`, `partnership`, `performs`, `publishedLanguage`, `read-only`, `ref`, `refs`, `requires`, `resolve`, `roles`, `service`, `sharedKernel`, `state`, `states`, `sum`, `terminal`, `ticksPerDay`, `to`, `transition`, `under`, `unique`, `upstream`, `value`, `when`, `where`, `while`, `with`.

## Semantic Rules

- Every identifier must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, else `invalid-name`.
- Every identifier is checked against the reserved-word set, regardless of case; a match is
  `reserved-word` (hard error).
- Case-convention mismatches per the table above are `naming-convention` (warning); the same
  identifier can be both correctly-cased and reserved-word-clean, or neither, independently.
- A field literally named `state` gets its own dedicated diagnostic, `reserved-field-name`, ahead
  of the generic reserved-word check — `state` is meaningful in this position (it would collide
  with lifecycle-state path accessors like `standing.state`).

## See also

- [Doc comments](doc-comments.md)
- [Tags](tags.md)
- [Context](context.md)
