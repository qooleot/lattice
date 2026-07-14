# tpl-7 / tpl-2 — stop inferring domain truth from structural shape

Date: 2026-07-14
Status: approved, ready for planning

## Problem

`matchTemplates` ([lattice/src/engine/templates.ts](../../../lattice/src/engine/templates.ts)) auto-adopts two
invariants that assert domain facts nobody stated, both at prior 0.9, both derived from structural
shape rather than from a modeler declaration.

### Bug 1 — tpl-7's no-refs branch invents a singleton claim

```ts
const actives = r.states.filter(s => s.tags?.includes('active')).map(s => s.name);
if (actives.length > 0) {
  if (refs.length === 0)
    adopt.push(mk(`tpl-7-${o.name}`, `SingleActive_${o.name}`,
      { kind: 'cardinality', aggregate: o.name, where: { ... }, atMost: 1 }));
  else
    for (const f of refs)
      seeds.push(mk(`tpl-7-${o.name}-${f.name}`, `UniquePer_${f.name}`, { kind: 'unique', ... }, 0.4));
}
```

The catalog (`docs/plan.md` §10.2, row 7) defines template #7 as:

| # | Template | Auto-proposed when… | Schema |
|---|---|---|---|
| 7 | Single-active (uniqueness) | an `@active` state on **a child collection** | `unique while active by (parent, key)` |

The trigger is *a child collection* — an aggregate that **has** a parent ref — and the schema is the
per-parent `unique` form. That is the `refs.length > 0` branch.

The `refs.length === 0` branch has **no basis in the catalog**. It fires precisely when template #7's
trigger condition *fails*, and emits a different invariant of a different kind (`cardinality`, not
`unique`) asserting something strictly stronger: `emit/prose.ts` renders it as
"At most 1 Biller where Biller is in state Active may exist" — a platform-wide claim.

Observed consequence: in a multi-tenant bill-payment domain this auto-adopts `SingleActive_Biller`
and `SingleActive_Payer`, negating multi-tenancy. `Biller` and `Payer` triggered it only because they
happen to carry no ref fields.

### Bug 2 — tpl-2 ignores the documented `@signed` escape hatch

`docs/language/tags.md` documents `@signed` as suppressing the non-negative rule on a `Money` field
that can legitimately go negative. `implied.ts` honors it:

```ts
if (f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed'))
```

`templates.ts` does not:

```ts
for (const f of o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money'))
```

So `@signed` silently fails to suppress anything in the elicitation path, and tpl-2 auto-adopts
`NonNegative_<Agg>_<field>` at 0.9 on a field the modeler explicitly marked as legitimately negative.
The two derivations of the same rule disagree. tpl-2 also drifted from its catalog trigger
(`a @balance field`) to fire on *any* `Money`-typed field.

## Why this matters more than a wrong default

Adopted invariants are not inert — they become **solver assumptions**. `planner.ts`:

```ts
export const adoptedConstraints = (s: SessionState): Candidate[] =>
  s.candidates.filter(c => c.status === 'adopted').map(c => c.inv.candidate);
```

That value is passed as the `adopted` argument into every `solve(...)` call. Once
`SingleActive_Biller` is adopted, any witness containing two active Billers is UNSAT, so the
elicitation loop becomes structurally incapable of generating the question that would expose the
error. **The false invariant seals off the only channel through which it could be refuted**, and
silently constrains every unrelated question asked afterward.

The error directions are severely asymmetric:

- **Drop and be wrong:** a genuine singleton isn't auto-proposed. A human authors it, or elicitation
  or LLM domain seeding finds it. Cost: one convenience.
- **Keep and be wrong:** the witness space is poisoned, multi-tenancy is negated in the emitted spec,
  and the loop cannot self-correct.

## Chesterton's fence — why the branch existed

Slice-1 Task 12's interface contract names it explicitly:

> Adopt = verified-shape, no question needed (#1 conservation, #2 non-negative, #3 terminal,
> **#7-cardinality single-open**, #8 monotonic, #9 no-orphan).

The branch was built for one case: `AccountingPeriod` — "at most one **Open** accounting period" — a
real, canonical accounting invariant. The plan's own name for it is "single-**open**," not
"single-active."

The fixture it was written against (`revrecMini`) contains exactly two `@active`-bearing shapes:
`AccountingPeriod` (Open/Closed, no refs) and `RevenueEntry` (a ref to `Obligation`). The author
needed one bit to route the period case to `cardinality` and the child-collection case to `unique by
(parent)`. `refs.length === 0` splits those two aggregates perfectly.

**"No refs" was therefore never intended as a singleton signal — it is a fixture-fitting
discriminator.** With a training set of one positive example, "has no refs" and "is an accounting
period" are indistinguishable hypotheses; the author picked the mechanically checkable one. `Biller`
and `Payer` are not overlooked edge cases — they are the first real test of a rule that had never
been tested.

Two further observations confirm the fence is misplaced:

1. **Singleton-ness is not a structural property.** Structure describes what an instance *is*
   (fields, states, refs); singleton-ness is a claim about how many instances *exist*. `Biller`,
   `Product`, and `AccountingPeriod` are structurally identical — refless aggregates with an
   `@active` state — with true cardinalities of many, many, and maybe-one. No refinement of a shape
   predicate separates them, because the information was never in the shape. Contrast the templates
   that work: `@terminal` → terminal, `@monotonic` → monotonic, `ref` → resolves, `@balance` +
   `@total` → conservation. Each restates a declaration the modeler made, or what a construct
   definitionally means. The tag or type *carries* the claim. Singleton-ness has no carrier.
2. **The branch degrades as the model matures.** Even for `AccountingPeriod`, the global claim is
   wrong in any real ledger — you want at most one Open period *per legal entity*. The moment
   `AccountingPeriod` gains an `entity` ref, the refs branch fires and produces the correct
   per-entity `unique` form. The no-refs branch fires hardest when the model is least developed. It
   does not detect singletons; it detects incompleteness.

### How the change still serves the original goal

`docs/plan.md` §9 lists six candidate sources. **1. Template Catalog (+ tags)** pattern-matches
"the model's *structure and tags*." **5. LLM domain seeding** — "the model already knows canonical
Stripe/billing invariants; it proposes them from prior art and re-renders each in prose for
confirmation."

"At most one open accounting period" is canonical domain knowledge — it belongs to source 5. It was
routed through source 1, which can only see shape, and to make it fit, someone had to invent a
shape-proxy for a fact that has no shape. **The branch is the symptom of a fact filed under the wrong
source.**

After the drop, `AccountingPeriod` still gets its invariant, by three routes that are all better than
today: LLM domain seeding proposes it with a prose confirmation (source 5, as designed); or a human
authors `count where inState(Lifecycle, {Open}) <= 1`, which the grammar fully supports
(`lat.langium:115`, `docs/language/invariant-forms.md` §4); or elicitation derives it. Each route ends
in a human judging the claim, which is the premise of the tool.

**We lose the invariant's automatic arrival, not the invariant.** In exchange, `Biller` stops being
declared a singleton by a rule that was never about singletons.

## Design

### 1. tpl-7 — delete the no-refs branch

Remove the `refs.length === 0` arm. Keep the `refs.length > 0` arm unchanged, restoring the catalog's
definition: `@active` on a child collection seeds `UniquePer_<ref>` at prior 0.4. A refless `@active`
aggregate produces nothing from template #7.

### 2. tpl-2 — honor `@signed`

Add the `@signed` exclusion so the template path matches `implied.ts` and the documented behavior.

### 3. Share the derivation (root cause of bug 2)

tpl-2 and `implied.ts` drifted because the same rule is written twice. Extract the Money-non-negative
predicate into a single shared helper both call, the way `valueLawInstances` is already shared
between `templates.ts` and `implied.ts`. This is the root cause, not a drive-by refactor: without it,
the fix is one edit away from regressing.

### 4. Tests

- `templates.test.ts:36` (`'#7 cardinality single-active when the tagged aggregate has no refs'`)
  asserts the wrong behavior. Invert it: `AccountingPeriod` gets **no** cardinality candidate.
- New regression test: a refless `@active` aggregate in a multi-tenant shape (the `Biller` case)
  adopts no `SingleActive_*`.
- New test: a `@signed` `Money` field produces no `NonNegative_*` in the **template** path.
- Existing test `'#7-unique seeds fire for @active aggregates WITH refs (trace A model)'` must keep
  passing unchanged — it pins the branch being preserved.

### Out of scope

- **`@singleton` tag** — YAGNI. `cardinality` is already authorable; this is convenience, not
  capability. If a real model wants it, it gets its own design pass. Note it would be a
  *declaration*, not a structural signal — consistent with the two-layer design where tags classify.
- **`retract` / `refute` command** — a retraction path already exists (`emit` → edit `.lat` →
  `apply --force-remove`). The real gap is that `plan.md:542` requires "Decline → recorded in the
  ledger with a reason (a *declined* invariant ≠ an *absent* one; auditable)" and the round-trip
  captures no reason. Separately: `'refuted'` is declared in `CandidateStatus` but never assigned
  anywhere in `lattice/src/` — hand-editing it works only by accident (the status is neither
  `'adopted'` nor `'active'`, so every filter ignores it). Both belong in their own design.
- **Seeds are never persisted** — `cli.ts:417` pushes only `adopt` into `s.candidates`; `seeds` is
  echoed in `init`'s JSON and dropped, re-entering only if the LLM voluntarily calls `propose`. This
  is a real gap (it is the mirror image of tpl-7: a claim discarded with no record, vs. a claim
  asserted with no judgment). It is excluded here because it is a *design* question — the skill tells
  the agent to "fold the engine's returned seeds with your own domain knowledge," so seeds may be
  deliberately advisory rather than candidates to mechanically register. Resolving it also shifts
  golden traces, which `implied.ts:61` explicitly warns against. Coupling it to two unambiguous
  correctness bugs would bury them in a debatable redesign.

## Risks

- **Golden traces.** These edits change `matchTemplates` output, so any golden trace containing a
  `SingleActive_*` or a `@signed` `NonNegative_*` will shift. Expected and correct — those traces
  encode the bug. Each shift must be reviewed individually and confirmed to be a removal of a false
  claim, not collateral damage.
- **`prior` is inert.** `prior` gates nothing — it is used only for pair ordering (`planner.ts:133`)
  and merge tie-breaks (`planner.ts:140`). The 0.9 on adopted candidates never gates adoption. This
  design does not change that; noted so nobody expects prior tuning to be a fix.
- **Unverified reproduction.** The `.lattice-session-bill-payment-ledger` session was not present in
  this worktree, so the `SingleActive_Biller` trace was not reproduced directly. The diagnosis rests
  on reading `templates.ts`, `prose.ts`, and `planner.ts`, which is sufficient to establish the
  mechanism, but the specific session's JSON was not inspected.

## Success criteria

1. A refless aggregate with an `@active` state adopts no `SingleActive_*` invariant.
2. An aggregate with refs and an `@active` state still seeds `UniquePer_<ref>` at prior 0.4.
3. A `@signed` `Money` field yields no `NonNegative_*` from either `templates.ts` or `implied.ts`.
4. The Money-non-negative rule has exactly one definition in the codebase.
5. Full suite green; every golden-trace diff reviewed and justified as false-claim removal.
