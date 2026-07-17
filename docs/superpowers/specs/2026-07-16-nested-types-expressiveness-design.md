# Slice B2 — Nested types: refs and values inside children, money that carries currency

**Status:** design, awaiting implementation plan
**Date:** 2026-07-16
**Origin:** the BillPayments double-entry ledger elicitation — the "language expressiveness" slice
that `2026-07-15-optional-fields-design.md` was cut from

## Problem

A double-entry ledger (`Bill` owning `LineItem`; `JournalTransaction` owning `Posting`;
`LedgerAccount` as a chart of accounts; multi-currency) cannot be modelled correctly. Four findings,
all verified against the code at commit `2db1539` rather than inferred.

### 1. Ownership and referential integrity are mutually exclusive

`validate.ts:220` rejects `ref`, `list`, and `value` fields on an aggregate-owned child. A `Posting`
is inherently *owned* by its `JournalTransaction` and inherently *points at* a `LedgerAccount`. The
language forbids both at once:

- Keep `Posting` an owned child → the account link degrades to a bare `accountId : Id`, and
  `refsResolve` ("every posting hits a real account") is silently lost.
- Promote `Posting` to a top-level aggregate → `sumOverCollection` requires an owned collection
  (`invariant.ts:38-43`), so `netAmount == sum(postings, amount)` — the defining law of double-entry
  bookkeeping — becomes inexpressible.

No modelling choice keeps both. This is not niche: "an owned child that references a shared lookup
entity" is every line-item-with-a-product-ref, every posting-with-an-account-ref, every
order-line-with-a-sku-ref.

### 2. `@unsigned` is required but inert — on a value's Money sub-field *and on a child's*

The brief reported the value half. **Verified by running, there are two disagreements, not one**, and
the second needs no value type at all:

```
Money on the AGGREGATE (untagged):  demands: [Txn]      derives: [nonNegativeTxnFee]   ✓
Money on a CHILD      (untagged):  demands: [Posting]  derives: []                    ✗ inert
```

So `Posting.amount : Money @unsigned` — a plain `Money`, no value type involved — is inert **today**.
The ledger's core non-negativity is already broken independent of multi-currency, and
`test/ast/validate-sign.test.ts:38-43` is a **passing test that pins the demand side only**
("covers nested entities inside an aggregate" asserts `at === 'Posting'`). This raises the stakes on
Decision 4: the child-subject Quint encoding is not just needed for the *new* value-typed case, it is
what makes an existing, already-demanded tag mean anything.

Two owner lists disagree, and one of them is wrong:

- `validate.ts:318-320` — `undecidedMoneySigns` builds owners as
  `[...m.entities, ...m.values, ...m.aggregates.flatMap(...)]`. It **includes values**, so `init`
  hard-rejects a `value Amount { amount : Money }` whose sub-field carries no sign tag.
- `implied.ts:72` — `impliedInvariants` builds owners as `[...m.aggregates, ...m.entities]`. It
  **excludes values**, so `nonNegativeMoneyFields` never runs on a value's sub-field.

`init` forces a decision the engine then ignores. `@unsigned` asserts a rule that is never enforced;
`@signed` suppresses a rule that was never going to exist. Worse, the decision is made **once per
value declaration, not per use site**, so a single `value Amount` used for both `Bill.total` (must be
non-negative) and `LedgerAccount.balance` (must go negative) cannot express both even in principle.

### 3. The conservation template cannot see through a value

`templates.ts:26-30` reads `@balance`/`@total` off `o.fields` directly and emits single-segment paths
(`parts: balances.map(b => [b.name])`); its owner list (`templates.ts:7`) excludes values. The moment
money becomes value-typed to carry currency, `conserve amountPaid + amountDue == total` stops firing
— silently. The model looks richer and quietly checks less.

### 4. The combined effect: multi-currency is unmodelable

The idiomatic DDD encoding of money is a value object pairing amount and currency. Here that encoding
is **illegal** on nested entities (1) and **rule-disabling** where it is legal (2, 3). The only
workaround is a parallel `currency : Currency` field beside each `Money`, with nothing binding the
pair. A user eliciting a real multi-currency ledger today has to be talked out of the correct model.

## The unifying diagnosis

These are one bug with four faces: **the derivation and encoding layers treat a nested child, and a
value-typed field, as opaque.**

- Nine modules independently define the same top-level-only owner list — `emit/quint.ts:36`,
  `engine/implied.ts:44`, `engine/implied.ts:72`, `engine/templates.ts:7`, `engine/witness.ts:4`,
  `parse/diff.ts:20`, `parse/fromLangium.ts:206`, `ast/grammar.ts:7-9` (`ownerDef`), and
  `emit/alloy.ts:325` (`extraComparisonPaths`' `byName`). **Every one omits nested children.**
- Every tag-reading site matches `f.type.kind === 'prim'`, so a value wrapper hides the field it
  wraps.

The fix has two axes, and each finding is one axis applied at one site:

- **Axis 1 — children are owners.** Include nested children where that is correct, and give a
  child-subject candidate a Quint encoding (see Decision 4) where it is not yet possible at all.
- **Axis 2 — see through values.** Expand a field into its solver-visible numeric paths, so
  `total : Amount` yields `total.amount` wherever `total : Money` yields `total`.

## Evidence, and corrections to it

The findings are accurate. Five things discovered while verifying them change the plan.

**The grammar, parser, and printer are already nesting-blind.** `lat.langium:60-61` uses one
`EntityDecl` production in both top-level and nested position; `fromLangium.ts:39-47`'s `mapType` and
`code.ts:7-10`'s `typeStr` are total over `TypeRef` with no nesting-aware branch. `ref X` inside a
child already parses, round-trips, and prints today. **The restriction is one `if` at
`validate.ts:220`.** No surface work is needed.

**Alloy already emits sigs for top-level entities** (`alloy.ts:360`), so a child ref to any top-level
target has a sig to point at. The Alloy blocker is only `emitChildSigs` (`alloy.ts:75-90`) having no
`ref` or `value` arm — six lines mirroring `emitOwnerSig` (`alloy.ts:40-58`), which already flattens
`period : Period` to `period_start, period_end`.

**Quint needs almost nothing.** `fieldQType` (`quint.ts:38-64`) already types a ref as `str` and
already recurses into value sub-fields, so a value-typed child field — and a value inside a value —
emit correctly today. `initValue` (`quint.ts:88-124`) likewise recurses and is already called from
the child-slot loop (`quint.ts:272`).

**Correction to the original brief's suggested shortcut.** The brief proposed allowing a child's
`ref` field structurally "so `refsResolve` can fire on it" while continuing to reject paths through
it, as a strictly smaller change. **That does not work.** `refsResolve` is derived per top-level
owner (`implied.ts:82-86`), its judge iterates `subjects()` filtered by `c.aggregate`
(`evaluate.ts:93`) which never yields children, and `validateCandidate` rejects a child subject with
`unknown-aggregate` (`grammar.ts:150-151`). Allowing the field alone buys a **silently unchecked
ref** — the exact failure the finding exists to escape. Decision 2 covers what recovering it costs.

**A hard constraint the brief guessed at correctly — and it is wider than the brief thought.**
`initValue` draws a same-context ref from `oneOf(<TARGET>_IDS)` (`quint.ts:102`), and that pool is
declared only per top-level owner (`quint.ts:407`, inside `for (const o of owners(m))`). Children are
inlined map records with no id and no pool, so **a nested child is not an addressable ref target at
all** — regardless of where the ref lives.

The brief framed this as "child→child". It is not: `validate.ts:152-153` puts nested children in the
`owners` set that `checkType` validates ref targets against, so **a top-level aggregate may already
`ref` a nested child today, and it emits invalid Quint.** Verified by running, not read:

```
context L {
  aggregate Bill  { billId : Id key   lines : List<LineItem>
                    entity LineItem { lineId : Id key   qty : Int } }
  aggregate Audit { auditId : Id key  n : Int   line : ref LineItem }
}
→ MODEL VALIDATES OK? true
→ pools DECLARED: [ BILL_IDS, AUDIT_IDS ]
→ pools USED    : [ LINEITEM_IDS, BILL_IDS, AUDIT_IDS ]
→ UNDEFINED     : [ LINEITEM_IDS ]        # invalid Quint, at 2db1539, today
```

So the rule generalizes (Decision 1): **any** ref whose target is a nested child is rejected, whoever
holds it. Child→child falls out as a special case, and an existing latent bug closes with it.

**Good news on finding 3.** Alloy does not encode `conservation` at all — `routeCandidate`
(`grammar.ts:351`) sends it to Quint and `candidateToPred` throws on the Alloy path
(`alloy.ts:233`). Quint's `pathToQuint` (`quint.ts:135-153`) already renders a value hop as
`x.total.amount`, and `evaluate.ts:13-16`'s `resolveValue` already has a dotted-key fast path. So
conservation-through-a-value is a `templates.ts` change plus a tag-resolution rule; the emitters need
nothing.

## Decisions

### 1. Nested children carry `ref` and `value` fields

`nested-entity-flat` narrows from `ref | list | value` to **`list` only** (see "Not in this slice").

- **Any** ref whose target is a nested child is rejected — new `ref-target-nested-child`, on every
  owner (top-level or child), for the `<TARGET>_IDS` pool reason above. A child's ref must therefore
  target a top-level aggregate/entity, which is what the ledger needs (`Posting.account : ref
  LedgerAccount`). This closes the latent invalid-Quint bug demonstrated above as well as the
  child→child case. It is an encoding constraint being honest about itself rather than a language
  opinion, and the diagnostic should say so — a nested child has no identity to reference, which is
  also true of the DDD notion it encodes.
- `emitChildSigs` (`alloy.ts:75-90`) gains a `ref` arm (`one <Target>`, skipping qualified refs, per
  `emitOwnerSig:40-44`) and a `value` arm flattening to `<field>_<sub>: one Int|<Enum>`, mirroring
  `emitOwnerSig:47-58`.
- Quint: **no change**.
- `witness.ts:4` includes nested children, so a child's `amount_amount` normalizes to the dotted
  `amount.amount` like every other value key. Without this, `remapEntity` fails its `e.type` lookup
  and silently passes the flattened key through.
- `optional-owned-child` (`validate.ts:232-233`) is **unchanged**. Its rationale is about
  multiplicity, not field kind, and still holds.

### 2. `refsResolve` fires on a child

`implied.ts` derives the candidate with the **child as its own subject** —
`{ kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] }`.

- The judge then works unchanged: `subjects()` filters `e.type === 'Posting'`, and witness children
  already carry `type = child.name` (`evaluate.ts:148` resolves them exactly this way for
  `sumOverCollection`).
- `validateCandidate`'s `ownerDef` (`grammar.ts:7-9`) must resolve a nested child as a nameable
  subject. **This is safe only because of Decision 1's `ref-target-nested-child`**: `ownerDef` is
  also what `resolveFieldPath` rebinds to on a ref hop (`grammar.ts:40-41`), so admitting children
  would otherwise let a path hop *into* a child that no encoding can address. With no ref able to
  target a child, a child is reachable as a *subject* but never as a *hop* — which is exactly the
  asymmetry the encodings have.
- Alloy's vacuous `pred X { }` (`alloy.ts:215`) stays correct for the reason it is correct today: the
  child's ref is `one Target`, total by construction. `refsResolve` stays Alloy-routed and
  unelicitable (`cli.ts:75`); its real semantics remain the TS judge's.

### 3. Money sign is decided at the use site

A **sign site** is any field that is a `Money` prim *or* a value with ≥1 `Money` sub-field. The tag
lives on the use-site field, never on the value declaration.

- `undecidedMoneySigns` drops `...m.values` and gains value-typed sign sites. It **already covers
  children** (`validate.ts:320`) — the gap is entirely on the `implied.ts` side, which must gain both
  children and value sub-fields to stop the demand being inert.
- New `value-money-sign-inert`: a `Money` sub-field **inside a `value` declaration** carrying
  `@signed`/`@unsigned` is rejected. There is then exactly one place sign is written and no
  precedence to reason about. Non-breaking: `specs/` contains no `value` declarations at all
  (verified by grep).
- `nonNegativeMoneyFields` (`implied.ts:60-61`) returns `Path`s rather than `Field`s — `[f]` for a
  `Money` prim, `[f, sub]` per `Money` sub-field of a value — gated on the **use site's** tag.
  `nonNegativeBody(field: string)` (`implied.ts:63`) widens to `nonNegativeBody(path: Path)`.

This is what makes the motivating case expressible: one `value Amount`, two use sites, opposite signs.

```lat
aggregate Bill          { total   : Amount @unsigned }   // derives total.amount >= 0
entity    LedgerAccount { balance : Amount @signed   }   // derives nothing
```

### 4. A child-subject candidate gets a Quint encoding

**This decision exists because the design was wrong without it, and the error was the same one the
slice is fixing.** `routeCandidate` (`grammar.ts:351-355`) sends **any arithmetic** predicate to
Quint, and `candidateToQuint` binds `varName(c.aggregate)` (`quint.ts:285`) — a var declared only for
top-level owners (`quint.ts:387`). So Decision 3's `Posting.amount : Amount @unsigned` derives
`amount.amount >= 0`, which is arithmetic, which routes to Quint, which binds a var that does not
exist. The only safe alternative would be to skip it — **reproducing finding 2's inertness one level
down, in the fix for finding 2.**

So: when `c.aggregate` names a nested child, `candidateToQuint` quantifies over the owner's child map
instead of a top-level var:

```
x.postings.keys().forall(i => i < x.postingsCount implies <pred over x.postings.get(i)>)
```

This is the fold shape `sumOverCollection` already emits (`quint.ts:317`) — a known pattern, not new
machinery. It makes `statePredicate` and `conservation` work on children too, so the "conservation is
top-level-only" limit disappears rather than being documented.

### 5. Values nest inside values

`value-flat` (`validate.ts:203`) narrows to reject `ref` and `list` only; a value-typed sub-field
becomes legal.

- Quint: **no change** — `fieldQType` already recurses (`quint.ts:57`).
- Alloy: `emitOwnerSig`'s and `emitChildSigs`' value arms recurse, joining with `_` at each level
  (`net_amount`, `net_currency`).
- `resolveFieldPath`'s value-hop case (`grammar.ts:43-49`) drops its `i + 2 === path.length` cap and
  walks value hops to arbitrary depth.
- `alloyFieldPath` (`alloy.ts:109-114`) is rewritten to walk the path resolving each hop's kind,
  rather than special-casing a value at segment 0 only. **This also fixes a latent bug**: today a
  path like `plan.period.start` (ref hop then value hop) passes `checkPath` and emits `a.plan.period.start`,
  a relation Alloy has no declaration for. See "Latent bugs".

Without this, `value TaxedAmount { net : Amount, tax : Amount }` stays illegal and must be
hand-flattened to `netAmount, netCurrency, taxAmount, taxCurrency` — with nothing binding each amount
to its currency. That is finding 4 verbatim, one level down, and Quint is already ready for it.

### 6. `@balance`/`@total` resolve through a value

A `@balance`/`@total` tag on a value-typed field resolves to that value's **single**
solver-numeric sub-field, yielding a two-segment path.

- Zero or ≥2 numeric sub-fields is **ambiguous** → new `ambiguous-numeric-tag` at init. Loud, not
  guessed. (`value Amount { amount : Money, currency : Currency }` has exactly one; `value
  TaxedAmount { net : Amount, tax : Amount }` has two and must be tagged on a sub-path instead.)
- `templates.ts:7`'s owner list gains children (safe once Decision 4 lands).

### 7. `sumOverCollection.field` widens from `string` to `Path`

The versioned change to the closed candidate grammar (`invariant.ts:38-43`), needed for
`sum(postings, amount.amount)` once `Posting.amount` is value-typed.

- Alloy renders `l.amount_amount` (`alloy.ts:231`), Quint `.get(i).amount.amount` (`quint.ts:317`).
  Note `quint.ts:354` emits a **second** copy of the same fold for the classify path (`mSum`) and
  must be widened in step, or a `Path` field silently renders as `[object Object]` there.
- `evaluate.ts:149` switches from `k.fields[c.field]` to `resolveValue(s, k, c.field)`, which works
  via the dotted fast-path once Decision 1 normalizes child witnesses.
- `grammar.ts:307-320` resolves `field` against the child's fields, accepts 1–2 segments (2nd = value
  sub-field), and keeps the `SOLVER_INT_PRIMS` gate on the terminal field.
- **Back-compat:** stored candidates carry `field: string`. Normalize-on-read, following the
  `stripRefsResolveFields` precedent (`implied.ts:117-124`). The type accepts `string | Path`; every
  reader sees a `Path`.

## Not in this slice

One limit stays, and it is recorded as **not yet implemented, with its cost and the shape of its
fix** — not as a decision.

### `List` inside a nested child

```lat
entity LineItem {
  lineId : Id key
  amount : Amount
  taxes  : List<TaxLine>      // rejected: nested-entity-flat
}
```

A bill line carrying a VAT component *and* a city-tax component is ordinary. The workarounds are the
familiar two: `vatAmount`/`cityTaxAmount` columns turn the set of tax types into schema (adding a tax
becomes a schema change); promoting `TaxLine` to top-level makes `lineTotal == sum(taxes, amount)`
inexpressible because `sumOverCollection` needs an owned collection. **That is finding 1 verbatim,
one level down.**

It is out of scope for cost, not principle. Alloy is easy — sigs are flat, so `TaxLine { owner: one
LineItem }` needs no new idea. **Quint is the blocker**: `fieldQType` returns `null` for lists
(`quint.ts:63`), so two-level collections need nested bounded maps, an `OWNED_BOUND²` state blowup,
and a revisit of the bitwidth policy that already had to rise to 7 for a single-level sum
(`alloy.ts:385-391`). That is its own slice with its own solver-fidelity risk, and bundling it here
would put the ledger behind it.

**This wording is deliberate.** `entity.md:84` ("until there's evidence to go further") and
`value.md:73` ("still deliberately closed pending evidence") call these limits considered decisions.
The evidence arrived — this slice is it — and the docs had no mechanism to notice. The replacement
text states the blocking cost and the fix shape, so the next person with a tax-breakdown spec has
something to push against instead of a wall that claims to be a decision.

## Doc changes

**The docs are executable, and that sequences the work.** `test/docs-blocks.test.ts` parses every
` ```lat ` block under `docs/language/` through `loadLatText` → `validateModel` and asserts `ok`. So a
doc example showing a child `ref` **fails until `validate.ts` changes** — docs and code must land in
the same commit, and every example below is a real test rather than prose. This is a guard the repo
already has; the plan should lean on it rather than add a parallel one.

The three docs the brief names are not merely out of date after this slice — **two are wrong
today**, which is worth fixing regardless of the code:

- **`entity.md:82-84`** says children reject "`ref` and `List`" and **never mentions `value`**, though
  `validate.ts:220` rejects value-typed child fields too. Rewrite for Decision 1 (ref legal,
  top-level targets only; value legal; `List` the sole remaining rejection, with its cost).
- **`entity.md:91-93`** claims "candidate paths that reach into a collection are rejected". There is
  no such check — `checkPath`'s guard is gated on `f.type.kind === 'prim'` (`grammar.ts:159-172`), so
  a single-segment path at a list field yields **zero** diagnostics. The rejection is emergent, from
  `resolveFieldPath` falling through to `def = undefined` (`grammar.ts:50`), and only for
  multi-segment paths. Restate accurately; the fix is listed under "Latent bugs".
- **`value.md:73-80`** — drop the nested-entity limit (Decision 1) and the one-flat-hop limit
  (Decision 5); document use-site money sign (Decision 3).
- **`field-types.md`** carries no "pending evidence" claim, but line 40 says `List<T>` holds "any of
  the above, including nested lists" — which the child rule contradicts. Note where lists may
  actually appear, and document `value-money-sign-inert` alongside the existing "structural only"
  sections (`:89`, `:105`), whose vocabulary this slice reuses.
- **`tags.md`** — `@signed`/`@unsigned` are use-site tags; `@balance`/`@total` resolve through a
  value to its single numeric sub-field.
- **`derived-invariants.md`** — non-negativity derives per money path (including through a value),
  and `refsResolve` now covers owned children.

### Latent bugs found while verifying, fixed only where this slice already touches the code

- **A ref may target a nested child**, which emits Quint drawing from an undeclared `<CHILD>_IDS`
  pool (demonstrated under "Evidence"). **Fixed here** — Decision 1's `ref-target-nested-child`.
- **`alloyFieldPath` handles a value hop at segment 0 only** (`alloy.ts:109-114`), so `plan.period.start`
  emits an undeclared relation. **Fixed here** — Decision 5 rewrites this function anyway.
- **Quint's `conservation` and `sumOverCollection`'s `total` lack the ref-hop existence gate** their
  siblings have (`quint.ts:291-292`, `:319` call `pathToQuint` bare, while `cmp`/`present`/`unique`
  gate on `refHopsIn(...).exists`). Apalache can read a never-created record's placeholder and
  convict where `evaluate.ts:138`'s judge permits. **Not fixed here** — own change, own tests.
- **`checkPath` does not reject a single-segment path at a list field** (`grammar.ts:159-172`; the
  guard is gated on `f.type.kind === 'prim'`), contradicting `entity.md:92`'s claim that
  collection-reaching paths are rejected. **Not fixed here.**

### Also unchanged

- `optional-owned-child` — rationale is about multiplicity, not field kind.
- `refsResolve` staying unelicitable and Alloy-routed (`cli.ts:75`).
- Refs *targeting* a nested child stay impossible (Decision 1) — children have no identity in either
  encoding. This is a real expressiveness limit, but unlike `List`-in-child it is not a cost
  question: giving children addressable identity would make them entities, which is what promoting
  them to top-level already means.

## Tests

Each maps to a finding or a decision. All are new unless noted.

**Structure (`test/ast/validate-nested.test.ts` — has existing cases to invert):**
- an owned child with `ref` to a top-level aggregate/entity validates clean (inverts the existing
  "rejects ref/list fields inside children")
- an owned child with a value-typed field validates clean (inverts the existing "rejects a
  value-typed field inside a nested child")
- child→child ref reports `ref-target-nested-child`
- **a top-level aggregate ref'ing a nested child reports `ref-target-nested-child`** — the latent
  invalid-Quint bug, which validates clean today
- `List` inside a child still reports `nested-entity-flat`

**Money sign (`test/ast/validate-sign.test.ts`, `test/engine/implied*.test.ts`):**
- **the load-bearing one:** one `value Amount`, two use sites, opposite signs — `Bill.total : Amount
  @unsigned` derives `total.amount >= 0`; `LedgerAccount.balance : Amount @signed` derives nothing
- an untagged value-typed money field reports `money-sign-undecided` at the **use site**
- `@signed` on a `value`'s own Money sub-field reports `value-money-sign-inert`
- a child's **plain `Money`** `@unsigned` field derives non-negativity **and emits valid Quint** — the
  half of finding 2 the brief missed; inert today with a passing test pinning only the demand
- a child's **value-typed** `@unsigned` field derives non-negativity and emits valid Quint (the
  Decision 4 regression — the test that would have caught the design error)
- `validate-sign.test.ts:38-43` ("covers nested entities…") is **extended, not replaced**: the demand
  it pins is correct; what was missing is the derivation

**Values (`test/ast/validate-values.test.ts`):**
- value-in-value validates clean; `ref`/`list` in a value still reports `value-flat`

**Emission (`test/emit/alloy.test.ts`, `test/emit/quint-emission-valid.test.ts`):**
- Alloy: child `ref` → `one Target`; child value → `amount_amount, amount_currency`; nested value →
  `net_amount`
- Quint: child value record; child-subject candidate → the `postingsCount` fold, not a bare
  `varName`
- `plan.period.start` emits a declared Alloy relation (the `alloyFieldPath` latent bug)

**Rules through a value:**
- `refsResolve` derived for a child ref, and the judge forbids a dangling one
- conservation with `@total` on a value-typed field emits a two-segment path and fires
- `ambiguous-numeric-tag` on a value with two numeric sub-fields
- `sumOverCollection` over `amount.amount`; a stored `field: string` candidate still resolves

**End-to-end:** a ledger `.lat` (`Bill`/`LineItem`, `JournalTransaction`/`Posting`,
`LedgerAccount`, multi-currency `Amount`) round-trips through the printer and solves — the spec that
motivated the slice, kept as the regression.

## Risks

- **Decision 4 is the schedule risk.** Child-subject Quint encoding is the largest piece and the one
  with real solver-fidelity exposure (the judge and Quint must agree on a child the judge reaches via
  `x.fields['owner'] === e.id` and Quint reaches via a map index). It needs an integration test
  against a real solver, not just an emission-shape test.
- **Decision 7 touches persisted data.** The `string | Path` normalizer must be covered by a test
  reading a pre-change candidate, or adopted ledger candidates silently stop resolving.
- **`OWNED_BOUND` × value sub-fields multiplies Alloy's Int pressure.** The bitwidth policy already
  rises to 7 for a single-level sum (`alloy.ts:385-391`); a value-typed sum field does not add
  summands, so this is believed safe — **but it is believed, not measured.** Worth a check against a
  real Alloy run before the plan closes.
