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
| machine region | camelCase | `lifecycle` |
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

    machine {
      region settlement { states { open @initial, closed @terminal } }
      transition close { region settlement; from open to closed }
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

## Reserved words are a hard error

Separately, a fixed set of `.lat` keywords can never be used as an identifier, regardless of case
— attempting to, e.g., name a field `count` or an enum value `state` is `reserved-word`, a hard
diagnostic that fails the load (`loadLatText` returns `ok: false`). This is stricter than
`naming-convention`: keywords collide with the grammar itself, so a name reusing one isn't just
poor style — the printer could not even re-emit it as valid syntax. See
[`RESERVED_WORDS`](../../lattice/src/ast/reserved.ts) for the complete, hand-maintained list
(kept in lockstep with the grammar by a sync test): `aggregate`, `anticorruption`, `by`,
`conformist`, `conserve`, `contains`, `context`, `contextMap`, `count`, `downstream`, `entity`,
`enum`, `event`, `exposes`, `fairness`, `from`, `in`, `invariant`, `key`, `leads`, `List`,
`machine`, `monotonic`, `now`, `of`, `on`, `openHost`, `partnership`, `publishedLanguage`, `ref`,
`refs`, `region`, `resolve`, `roles`, `sharedKernel`, `state`, `states`, `terminal`, `ticksPerDay`,
`to`, `transition`, `under`, `unique`, `upstream`, `when`, `where`, `while`, `with`.

## Semantic Rules

- Every identifier must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, else `invalid-name`.
- Every identifier is checked against the reserved-word set, regardless of case; a match is
  `reserved-word` (hard error).
- Case-convention mismatches per the table above are `naming-convention` (warning); the same
  identifier can be both correctly-cased and reserved-word-clean, or neither, independently.
- A field literally named `state` gets its own dedicated diagnostic, `reserved-field-name`, ahead
  of the generic reserved-word check — `state` is meaningful in this position (it would collide
  with machine-state path accessors like `lifecycle.state`).

## See also

- [Doc comments](doc-comments.md)
- [Tags](tags.md)
- [Context](context.md)
