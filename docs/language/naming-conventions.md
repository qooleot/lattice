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
| module | PascalCase | `BillingEngine` |
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

## Candidate invariant names are normalized, not warned

The warning above governs `.lat` text, which a human wrote. Candidate invariant names this codebase
generates itself arrive by two roads, and neither passes through the parser, so no
`naming-convention` warning could ever fire on them.

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

Those two roads are the whole of the folding: it covers candidate invariant names, not every name
the codebase mints. Auto-derived transition guards are the standing exception — `cli.ts` mints
`guard_<transition>_<shape>` at a single point and keeps it verbatim, so the underscore form is what
lands in the ledger and what `explain --name` answers to. Nothing is lost by leaving it alone: a
guard is never printed as a standalone `invariant` block — it renders only through its transition's
`requires` — so it never reaches the parser either, and no `naming-convention` warning can fire on
it.

Where folding does apply, the split is about authorship, not construct kind or which module does the
folding. In `.lat` the identifier is the author's and the convention stays advisory — rewriting
their file would overstep. A candidate name or a template-matched name is machine-authored with
nothing referencing it yet, and camelCase is a pure function of the words, so there is no judgment
to defer to anyone and no reason to spend a round-trip asking.

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
(kept in lockstep with the grammar by a sync test): `aggregate`, `anticorruption`, `builtin`, `by`, `conformist`, `conserve`, `const`, `contains`, `context`, `contextMap`, `count`, `creates`, `downstream`, `emits`, `entity`, `enum`, `event`, `exposes`, `fairness`, `from`, `in`, `invariant`, `key`, `leads`, `lifecycle`, `List`, `Map`, `module`, `monotonic`, `now`, `of`, `on`, `openHost`, `Optional`, `partnership`, `performs`, `present`, `publishedLanguage`, `read-only`, `ref`, `refs`, `requires`, `resolve`, `roles`, `service`, `sharedKernel`, `state`, `states`, `sum`, `terminal`, `ticksPerDay`, `to`, `transition`, `type`, `under`, `unique`, `upstream`, `value`, `when`, `where`, `while`, `with`.

## Primitive type names are reserved for the type namespace

The built-in primitive type names — `Int`, `Text`, `Date`, `Duration`, `Money`, `Id` — cannot name
an enum, value, entity, or aggregate. That is `reserved-prim-name`, a hard error that fails the
load. It is narrower than the reserved-word rule above, and it fails for a different reason.

The grammar has no primitive production at all: `Id` and a declared `Invoice` parse through the very
same `NamedType: name=ID` rule, and the split happens after parsing, where a name matching a
primitive wins. So a bare `Id` in a type position *always* means the primitive, and a declaration
called `Id` can never be reached by its own name.

For a value or an enum that is fatal, because a bare name is their only spelling. Both fields below
print the identical type expression `Id` — one meaning the primitive, one meaning the value — with
nothing to tell them apart on the way back in, so the file no longer means what the model said:

```
aggregate Subscription {
  subscriptionId : Id key     // the primitive
  legacyId       : Id const   // the value — re-parses as the primitive, silently
}
```

Entities and aggregates are reserved for a softer reason. They have a second spelling, `ref Id`,
which is unambiguous and is what the printer always emits — so a prim-named entity does survive a
round-trip. But the bare form is still silently hijacked: writing `foo : Id` meaning your entity
`Id` gets you the primitive with no diagnostic. The rule covers them to keep that trap out of the
language, and to keep one rule rather than one per construct.

A reserved word, by contrast, cannot lex as an identifier at all, so the printer would emit
unparseable text; a primitive name lexes fine and re-parses as the *wrong type*. Because this
collision lives in the surface syntax rather than the lexer, it is scoped to names a type
expression can resolve to. Events and services are not in that namespace — no type expression
resolves to one — so `event Id { ... }` is unambiguous and stays legal, as does a field named
`Money`.

## Semantic Rules

- Every identifier must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, else `invalid-name`.
- Every identifier is checked against the reserved-word set, regardless of case; a match is
  `reserved-word` (hard error).
- Enum/value/entity/aggregate names (including aggregate-nested entities) are additionally checked
  against the primitive type names; a match is `reserved-prim-name` (hard error). Events, services,
  contexts, and fields are exempt — none is reachable from a type position.
- Case-convention mismatches per the table above are `naming-convention` (warning); the same
  identifier can be both correctly-cased and reserved-word-clean, or neither, independently.
- A field literally named `state` gets its own dedicated diagnostic, `reserved-field-name`, ahead
  of the generic reserved-word check — `state` is meaningful in this position (it would collide
  with lifecycle-state path accessors like `standing.state`).

## See also

- [Doc comments](doc-comments.md)
- [Tags](tags.md)
- [Context](context.md)
