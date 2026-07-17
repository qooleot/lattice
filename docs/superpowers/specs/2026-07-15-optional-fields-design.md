# Slice B1 — Optional fields

**Status:** design, awaiting implementation plan
**Date:** 2026-07-15
**Origin:** the BillPayments ledger elicitation; scope cut from the larger "language expressiveness"
slice (see "Not in this slice")

## Problem

`FieldDecl` has no optionality marker (`lat.langium:70`): every field is required. A model therefore
cannot say a fact is sometimes absent, and the workarounds are worse than the gap.

The load-bearing case is `Payment`:

```
paymentMethod : ref PaymentMethod        // required
lifecycle intent { requiresPaymentMethod @initial, … }
```

The model asserts every `Payment` has a payment method. Its own state machine says a `Payment`
*begins* without one — the initial state is named `requiresPaymentMethod`. Because `refsResolve` is
auto-derived for every owner with a same-context ref, the engine enforces "this ref always
resolves", so **the model forbids its own initial state from being honest**.

It fails silently, and asymmetrically: `refsResolve` is a **no-op in Alloy** — `alloy.ts:149` emits
`pred name { }` with the comment "refs are total in Alloy sigs by construction — vacuously true". The
contradiction only bites on Quint-routed queries. A rule auto-adopted on every ref-bearing aggregate
is enforced by one engine and ignored by the other, today, before any change here.

## Evidence, and a correction to it

The slice was originally pitched on `JournalTransaction.reversesTxnId` — a reversal points at the
transaction it reverses; an original points at nothing. That evidence is **weak, and was checked
rather than assumed**: `Id` is dropped from both encodings (`quint.ts:43` returns `null` for
non-int prims; `alloy.ts:43` only pushes `isIntPrim`), and an `Id`-terminated path is
`unrepresentable-path` in any invariant. `reversesTxnId : Id?` would change nothing enforceable.

`Payment.paymentMethod` is the real case: an encoded `ref` (Quint sees `str`), genuinely absent in a
*named* state, with a real auto-adopted rule forcing it to exist. The slice is worth doing; the
reason is not the one originally given.

## Decisions

### 1. Surface: `field : Type?`, any type

`?` binds to the type, before `key` / `const` / tags.

- **`key` fields may not be optional** — `optional-key`. Identity is not absent.
- **`List<T>?` is rejected** — `optional-list`. An absent list and an empty list are the same fact;
  `List<T>` already means "zero or more". Admitting both invites a distinction nobody can act on.
- **`Text?` / `Id?` are legal but structural-only.** They are excluded from derived invariants and
  unusable in any invariant path — because `Text`/`Id` already are. Documented exactly like
  cross-context refs, which `field-types.md:81` already calls "structural only: accepted by the
  grammar and by per-file validation, but … excluded from derived invariants, cannot appear in any
  invariant path."

Rejecting `Id?` because Quint drops `Id` was considered and refused: it lets the *encoding* dictate
the *language*, which is the complaint that motivated this whole slice one level down. The type
system stays uniform; the docs state where optionality is inert.

### 2. Absence is elicited, never guessed

The codebase already has an absence rule — **"unknown facts don't convict"** — implemented
consistently in the TS judge (`evaluate.ts:45`: `if (l === undefined || r === undefined) return
true`) and mirrored in Quint (`quint.ts:171`: `allExist implies cmp` for ref-hops). Extending it
unchanged to optional fields would make absence *satisfy* rules, which is the wrong default half the
time — and invisibly so:

```lat
approvedAmount : Money?                                        // absent until approved

invariant approvalWithinPayment { approvedAmount <= amount }
invariant succeededWasApproved  { state progress in {succeeded} => approvedAmount > 0 }
```

Under vacuous truth the first rule is **right** (it should not fire on an unapproved refund) and the
second is **silently wrong** (a succeeded-but-unapproved refund passes the rule that exists to forbid
it). The two are indistinguishable in the spec text. That is the passing-but-vacuous failure mode —
the same shape that let a `@signed` regression guard survive a rename while asserting nothing —
promoted from a test defect to a language feature.

So:

- **Gate.** Validation rejects an invariant whose path **ends at** an optional field without saying
  what absence means: `absence-undecided`. Same shape as `money-sign-undecided`.
- **Elicit.** The engine draws a witness with the field absent and asks permit/forbid. **Permit** ⇒
  it writes the guard form (`where present(f)`). **Forbid** ⇒ it writes the assertion form
  (`present(f) && …`). The user judges a concrete case; the engine writes the syntax; the verdict
  lands in the ledger with the witness that produced it.
- **Hand-authored `.lat`** gets the diagnostic and writes `present(f)` itself — there is no loop to
  ask in. Same split as `@signed`: the language keeps a rule, the elicitation path refuses to inherit
  it silently.

`present(f)` is new predicate surface, but it is what the **engine writes**, not what the author
types. Auto-inserting it was considered and is impossible: the two rules above need *opposite*
insertions (guard vs assertion), and only a domain expert knows which. That is the definition of a
judgment.

**The gate reaches the END of a path, not the middle of it.** `absence-undecided` fires when a path's
*terminal* field is optional. A path that reads **through** an optional ref and ends at a required
field — `paymentMethod.fee > 0`, where `paymentMethod : ref PayMethod?` and `fee : Money` — does not
fire, and permits when the ref is absent. Verified, not assumed: `validateCandidate` returns `[]` and
`evaluateCandidate` returns `permit` on that shape today.

That is deliberate, and it is the existing rule rather than a new one. Every ref-hop in this language
already resolves vacuously when its target is absent: `evaluate.ts:19-21` returns `undefined` for an
unresolvable hop and `:45` permits on it, and `quint.ts:171` emits `allExist implies cmp` so Apalache
cannot read through a never-created record. An optional ref that is absent is the same fact as a ref
pointing at nothing, so it gets the same answer. Gating hops would mean a *second* absence rule for
exactly the case the first one already covers.

**Known cost, and it is real:** the language has two absence rules — explicit at a path's end, vacuous
through its hops — and a reader of `paymentMethod.fee > 0` cannot see that it can never fail. The docs
must say so where that reader will look (`invariant.md`), not only here. Unifying the two would change
the semantics of every ref-crossing invariant already written and needs its own slice with a
migration. Recorded, not fixed.

### 3. Derived invariants take the guard form — forced, not chosen

The engine writes derived rules; there is no author to ask. For every derived family the guard form
is the only meaningful reading, so no question is asked and none is skipped:

- `nonNegative` on an optional `Money` ⇒ `present(f) => f >= 0`. An absent amount is not a negative
  one. The assertion form would make every optional `Money` mandatory and defeat optionality.
- `refsResolve` on an optional ref ⇒ **absent is not an orphan**. This is the fix for
  `Payment.paymentMethod`.

### 4. Encoding

| Engine | Optional field | `present(f)` |
|---|---|---|
| **Alloy** | `one X` → `lone X` (`alloy.ts:40-43`) — native multiplicity | `some f` |
| **Quint** | companion flag `${f}Present: bool` — no Option type; `fieldQType` maps fields to plain `int`/`str` | `x.fPresent` |
| **evaluate.ts** | already `undefined` for a missing fact | `!== undefined` |

Required refs stay `one` in Alloy, so `refsResolve` remains vacuous there — unchanged by this slice.

The Quint companion flag is the pattern the codebase already uses twice: `exists: bool` for instance
existence (`quint.ts:123-127`) and `${collection}Count: int` for owned collections (`quint.ts:264`).

**`evaluate.ts` needs no semantic change** — an absent optional field *is* `undefined`, which it
already handles. It needs `present()` support only.

## Testing

The guard that pins the motivating bug, end-to-end:

> **A `Payment` in `requiresPaymentMethod` with no payment method is a legal instance.** Today the
> auto-derived `refsResolve` forbids it. This must hold on the Quint path specifically — the Alloy
> path never enforced it, so an Alloy-only test would pass before the fix and prove nothing.

Also:

- `optional-key` and `optional-list` are rejected; `Text?`/`Id?` load and print but are excluded from
  derived invariants and rejected in invariant paths.
- An invariant crossing an optional field without `present()` is `absence-undecided`; with either
  form it loads.
- Round-trip: `Type?` survives parse ∘ print (`test/parse/roundtrip.test.ts` generates arbitrary
  specs — its generator must learn optionality, or it will never exercise this).
- The elicited witness: absence-permit yields the guard form, absence-forbid the assertion form, and
  each verdict carries its witness in the ledger.
- `tsc --noEmit` must exit 0. This is a standing gate, not a nicety: Slice A shipped a branch that
  passed every test and failed compilation for five tasks, because no plan step ran it.

**Verification constraint:** the full suite has no known-green baseline on this machine — the failure
set shifts run to run and every failure passes in isolation. Gate per-file after
`bash lattice/scripts/cleanup-solvers.sh`, from `lattice/`. Never pipe vitest or tsc through
`tail`/`head` when reading an exit code — the pipeline returns the pipe's status.

## Risks

1. **21 files switch on `type.kind`.** A new field property is not a new `TypeRef` arm (optionality
   sits beside `key`/`const`, not inside the type union), which keeps the blast radius smaller — but
   every emitter, the printer, diff/rename, and codegen must decide what optional means for them.
2. **`roundtrip.test.ts` runs 200 unseeded fast-check iterations.** Once its generator emits optional
   fields it will explore parse ∘ print for them randomly — good coverage, but a failure arrives with
   no reproducible seed. Expect an intermittent, hard-to-reproduce failure to mean a real
   counterexample.
3. **Two absence rules coexist** (decision 2). A future reader will ask why ref-hops are vacuous and
   optional fields are not. The answer is migration cost, and it should be written down where they
   will look.
4. **The gate lands on existing specs.** Any invariant already crossing a field that becomes optional
   starts failing validation. That is the gate working, but it is a migration.

## Not in this slice

- **Polymorphic/union refs** — `LedgerAccount.owner` pointing at one of three party types. This and
  optionality were originally pitched together; they are *competing* answers to that one question
  (three optional refs + "exactly one set" vs one union ref), not complements. Union refs have their
  own evidence and need their own slice.
- **Refs inside owned children** (`nested-entity-flat`) — a `Posting` leg cannot hold `ref
  LedgerAccount`, forcing a double-entry ledger to choose between proving its legs balance and
  proving each leg points at a real account. Smaller than it first appeared: the owned-collection
  machinery already exists and is solver-encoded (`quint.ts:264` folds over it;
  `alloy.ts:158` carries it as an adopted constraint), contrary to `entity.md`'s claim that
  list-typed fields are dropped before solving. That doc claim is stale and should be corrected
  whenever that slice runs.
- **Unifying the two absence rules** (decision 2's cost).
