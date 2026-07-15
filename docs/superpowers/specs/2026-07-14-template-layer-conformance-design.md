# Slice A — Template-layer conformance

**Status:** design, awaiting implementation plan
**Date:** 2026-07-14
**Origin:** the BillPayments ledger elicitation (see "Evidence" below)

## Problem

`plan.md` §10.2 specifies the template layer as: match → materialize → **render a concrete
reachable violation** → the writer **accepts / edits / declines** → decline is **recorded in the
ledger with a reason** ("a *declined* invariant ≠ an *absent* one; auditable").

`matchTemplates` instead adopts every match silently. Adopted candidates are fed into every solver
call (`planner.ts:93`), so a false one distorts every question the elicitation loop subsequently
asks; and `astToCode` prints any adopted candidate that `isImplied` does not recognize
(`code.ts:125`), so a false one is also emitted into `spec.lat` as an explicit rule.

The `@signed` bug (fixed in 22f6c29) was a symptom. `templates.ts` derived Money non-negativity
independently of `implied.ts` and ignored `@signed`, so `balance : Money @signed` was adopted as
`balance >= 0` — enforced against every witness, and printed three lines under the tag it ignored.
The emitted file reloaded clean, because it genuinely was not implied. The round-trip that should
have caught the contradiction laundered it.

That fix removed one duplicated derivation. Three remain, and the divergence from §10.2 is wider
than non-negativity.

## Evidence

From the one real committed session (`.lattice-session-subscriptions`) and the BillPayments
elicitation:

- **18 of 30 renames** in the real session are a human hand-fixing template names to camelCase:
  `TotalDue_At_Most_Parts → totalDueAtMostParts`, `NoOrphan_Subscription → refsResolveSubscription`.
  Every spec this tool has ever emitted warns on reload. This is the most-hit annoyance on record.
  The last rename is notable: the user aligned a template name onto `implied.ts`'s derived name —
  the same convergence this design makes structural.
- **Zero template matches have ever been declined on domain grounds.** All four `declined` entries
  in that session are refactor bookkeeping: `Plan` was extracted to the `Catalog` context
  (`specs/subscriptions/spec.lat:23` → `ref Catalog.Plan`), so its rules left the session. The
  apparent "23% rejection rate" is an artifact; the real rate is 0%.
- **The prose worked.** Every problem found in the BillPayments elicitation — the `@signed` bug, a
  `@terminal` tag contradicting its own transition, the overpayment interaction — was caught by
  Phase 0b, a prose instruction in the skill. Not by a mechanism.
- **But the escape hatch is late.** `reconcile.ts:107` writes a `declined` record via the
  `--force-remove` hand-edit ceremony. It works; it requires hand-editing `spec.lat` after the
  fact.
- **Templates misfire on shape.** `Biller` (states `onboarding/active/suspended/offboarded`, no ref
  fields) tripped template #7 into `count where inState(standing,{active}) <= 1` — at most one
  active biller on the entire platform — because it happened to lack a ref field. The only escape
  available was withholding an honest `@active` tag, leaving the model deformed with no record of
  why. **This specific misfire was fixed on main by `9bc1ed5` while this design was being written**,
  by deleting the no-refs arm rather than by making it escapable. The evidence still stands for the
  general claim — shape-matching cannot see domain truth, and a template that fires on a coincidence
  needs somewhere to be rejected — but the motivating instance is gone, which weakens the case for
  the mechanism and is part of why the review stays advisory.

These cut both ways, and the design follows them rather than the initial instinct: the review
mechanism is **advisory**, because prose has caught everything so far and the hard gate is
supported by exactly one session; but the **naming** fix is load-bearing, because it is the thing
users actually pay for, repeatedly.

## Decisions

### 1. Reconciliation is case-by-case; `plan.md` is amended to match

§10.2 predates the engine. Reality has out-learned it in places and drifted badly in others.
Neither "conform the code" nor "document reality" is right. Each divergence is decided on merit and
`plan.md` is updated, so exactly one source of truth survives.

| # | Divergence | Resolution | Rationale |
|---|---|---|---|
| 1 | Non-negative trigger: Money-typed (code) vs `@balance` (plan) | **Code's survives in the language; `init` additionally demands an explicit decision** (§2) | Plan's `@balance` trigger is dropped outright. The remaining disagreement is resolved by layer, not by picking a winner: `loadLatText` keeps Money-typed defaulting, while `init` refuses to accept the default silently — because the right default differs between the billing and ledger layers, so no static rule is right everywhere |
| 2 | Conservation: `parts == @total` (code) vs `sum(buckets) == initial(sum(buckets))` (plan) | **Both** — different templates, not rivals | Code's proved `Payment`'s clawback fields missing; plan's catches money leaking between buckets and needs no `@total`. Plan's needs `initial(...)`, which the closed grammar cannot express → recorded as deferred |
| 3 | `@balance` means "conservation part" (code) vs "money bucket" (plan) | **Code's meaning**; `plan.md` amended | It is the one in use, in docs, and in shipped specs |
| 4 | Invented tags `@total`, `@monotonic` | **Legitimize in `plan.md`** | `@total` powers the conservation that works; `@monotonic` is the only route to a monotonic rule (not elicitable) |
| 5 | `@signed` | **Keep**, and add `@unsigned` (§2) | It is how "may go negative" is said, and it still drives `implied.ts` |

Out of scope, recorded in `plan.md` as **deferred rather than absent**: templates #4 (idempotency),
#5 (reservation-released), #6 (cross-aggregate coupling), #10 (no-skip), #12 (saga net-zero). They
require `@reservation`, `@idempotencyKey`, and `external`, none of which exist.

### 2. A `Money` field's sign is elicited, not defaulted

The engine does not guess a sign. Three parts, and the split is the point:

**The model carries the decision.** The sign is a tag, so it is visible in `spec.lat` and
round-trips. "Decided: non-negative" must be distinguishable from "never considered", so a positive
marker is required:

- `@signed` — decided: may go negative. Suppresses the rule (unchanged).
- `@unsigned` — decided: must not. **Inert to the language**; identical to untagged as far as
  `implied.ts` is concerned.
- untagged — non-negative by default. Legal in hand-written `.lat`. **Rejected at `init`.**

`@unsigned` changing no rule is a genuine wart, and the direct cost of the next decision.

**The engine refuses to guess — at `init` only.** `init` rejects a model whose `Money` fields carry
no sign decision, as an `ill-formed-model` diagnostic listing them grouped by owner. `loadLatText`
keeps today's default. This targets the actual failure — an LLM authoring a JSON model without
considering sign — without taxing the language: all ~33 doc examples across 16 pages (parsed by CI
via `docs-blocks.test.ts`) and `derived-invariants.md`'s three families are untouched.

**The skill clusters; the engine never does.** `init` reports undecided fields grouped by owner and
stops. The skill asks per *cluster* — a skill-side judgment with no engine counterpart. In
BillPayments: `Bill`'s `total`/`amountPaid`/`amountDue` is one question; the three account balances
plus `JournalTransaction.netAmount` is one question **spanning four different aggregates** (so a
cluster is not an aggregate). ~2 questions instead of 12 hand-placed tags. Each answer lands in the
structure ledger with its reasoning.

The engine never infers a cluster, because inference is guessing.

**The skill must hedge the batch.** A cluster question names the fields it covers ("this covers
`total`, `amountPaid`, `amountDue` on `Bill`") and always offers a **"not all of these — let me
split them"** option. Batching is a convenience offered, never an assumption made.

### 3. `templates.ts` delegates to `implied.ts` — the duplication is deleted, not shared

`templates.ts` #2/#3/#9 and `implied.ts`'s families are **already the same candidate shapes**;
they differ only in `id`, `name`, and `prior`. `impliedInvariants` is never fed to the solver
(`planner.ts:93` reads only `s.candidates`), so the sole reason `templates.ts` re-derives them is
to reach a different consumer — not because the rules differ.

> `matchTemplates` adopts what `impliedInvariants` returns. It stops deriving them.

Ownership, with no overlap left to drift:

- **`implied.ts`** owns the structure-implied families: non-negativity, refs-resolve, terminal,
  value laws.
- **`templates.ts`** owns the genuinely template-y ones: conservation (#1), monotonic (#8),
  single-active (#7), deadline (#11). These have no `implied.ts` counterpart.

This is a deletion, and it fixes naming for free on those families: adopting `nonNegativeBillTotal`
and `refsResolveBill` rather than `NonNegative_Bill_total` and `NoOrphan_Bill` — exactly the rename
the real session performed by hand. It also removes a duplication not previously noted: value laws
are named `ValueLaw_Subscription_period_wellOrdered` by one module and
`valPeriodSubscriptionPeriodWellOrdered` by the other, for a shape they already share via
`valueLawInstances`. The four template-owned names are camelCased to match
(`Conservation_Bill → conservationBill`, and so on).

The `@signed` fix's shared-helper approach (`nonNegativeMoneyFields`) is superseded for those
families: with one derivation there is nothing to share.

Delegating also moves those candidates from `prior: 0.9` to `implied.ts`'s `prior: 1`. This is
inert — `adoptedConstraints` ignores `prior`, and priors only order *hypotheses*, which adopted
candidates are not — but it changes the ledger record, so the implementation plan should expect it
rather than treat it as a regression.

### 4. Decline is advisory, and only legal before the first verdict

`decline --id <id> --reason <text>` flips an adopted candidate and writes the
`{kind:'declined', invariant, reason}` record `session.ts:27` already defines — the same record
`--force-remove` writes, reachable at the moment the problem is noticed.

`init` still adopts. Nothing forces review. This follows the evidence: prose caught every problem
so far, the escape hatch already exists, and zero template matches have ever been declined on
domain grounds. A hard gate would rework all four golden traces to front-load a decision the record
says is almost always "fine".

**Decline is refused once a verdict exists.** Witnesses drawn under a rule were drawn from a space
that rule shaped; retracting it later does not un-ask those questions. Two paths, separated by cost,
both writing the same auditable record:

- **Early** (post-`init`, pre-first-verdict): `decline`.
- **Late** (verdicts exist): hand-edit + `apply --force-remove`, which already reconciles properly.

This preserves §10.2's "a declined invariant ≠ an absent one" at both ends without pretending a late
decline is cheap.

What this buys concretely: `Biller` keeps its honest `@active` tag, and `singleActiveBiller` is
declined with a reason — instead of the tag being withheld and the model silently deformed.

## Testing

The guard that matters most pins the item users actually pay for:

> **An emitted spec reloads with zero `naming-convention` warnings** — `loadLatText(emit(session))`
> → `warnings: []`. End-to-end, silently false for every spec this tool has produced, and not
> satisfiable by a partial fix.

Also:

- `init` rejects a model with untagged `Money`, diagnostic grouped by owner; accepts when tagged.
- `decline` flips status, writes the ledger record, and drops the rule from `adoptedConstraints`.
- `decline` is refused once a verdict exists.
- `matchTemplates`' adoptions for the delegated families are exactly `impliedInvariants`' output
  (id, name, shape). The `@signed` drift guard becomes structural, but is kept as a regression
  anchor.

**Verification cannot rely on the full suite.** It has no known-green baseline on this machine: two
back-to-back runs on 2026-07-14 failed 3 tests each, *different ones both times*, every one passing
in isolation (`trace-b`'s p50 latency budget, `cli-classify.integration` at 81s against a 120s
timeout, `roundtrip`'s 200 unseeded fast-check iterations). The gate is per-file after
`cleanup-solvers.sh`, and any failure is argued by whether the change can reach the test — not by
the suite's verdict.

## Migration

| Surface | Work |
|---|---|
| 5 test files (`trace-c.test.ts:47`, `cli-strengthen` ×2, `pipeline-from-scratch`, `golden-trace-d`) | Update asserted names/ids: delegated families move to `implied-*`, template-owned keep `tpl-*` with camelCase names |
| 18 fixture files + 4 golden trace models | Add explicit sign tags (only models reaching `init`) |
| `docs/language/tags.md` | Document `@unsigned`; the tag table gains a seventh |
| `plan.md` §10.2 | The five amendments; conservation split in two; the 5 unimplemented marked deferred |
| `derived-invariants.md`, ~33 doc examples | **unchanged** — the payoff of gating at `init` |

Existing sessions are unaffected: they carry their own adopted names plus `rename` entries, and
`renames.ts` already reconciles.

## Risks

1. **`@unsigned` is inert to the language** — a tag that changes no rule, existing only so `init`
   can tell "decided" from "never considered". The price of the `init`-only gate.
2. **The `init` gate lands on every fixture that inits a `Money` model.** Miss one and the suite
   goes red — loud, not silent, which is the right direction.
3. **Advisory review may prove too weak.** It rests on Phase 0b, which is ~6 commits old and has a
   one-session track record. If a false template reaches an emitted spec, revisit the hard gate. The
   evidence today does not support paying for it.
4. ~~**Template misfire is not addressed, only made escapable.**~~ **Resolved on main before this
   slice started** — `9bc1ed5` drops tpl-7's no-refs arm entirely, on the same reasoning this design
   reached from the other side: singleton-ness is a claim about how many instances *exist* and is
   not recoverable from field shape. `SingleActive_Biller` can no longer be produced, and §10.2
   row 7 ("an `@active` state on a child collection") now describes the code. The escape hatch
   (decline) is still worth building — shape-matching will misfire again elsewhere — but the
   specific misfire that motivated it is gone at the trigger, which is the better fix.

## Not in this slice

- **Slice B — language expressiveness**: optional fields, union/polymorphic refs, owned collections
  holding refs. `plan.md` is silent on all three. This is what reshaped the BillPayments ontology
  (three parties → three account types) and what forces a double-entry ledger to choose between
  "the legs balance" and "every leg points at a real account".
- **Slice C — interaction effects**: `Conservation_Bill` + `NonNegative_Bill_amountDue` together
  forbid overpayment; neither says so alone. No per-rule review can catch it. Depends on this
  slice, since declining is what you would *do* about a bad interaction.
- **Chore**: `roundtrip.test.ts:60` runs 200 unseeded fast-check iterations and intermittently finds
  a real parse∘print counterexample with no recorded seed to reproduce from.
