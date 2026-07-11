# Inference Slice — Plan 3: Abstract-Evolution Modeling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@balance`/`@monotonic` data fields a sound over-approximate evolution step (monotone-up while non-terminal) in the *classifier's* emission only, add a per-conjunct structural gate that assigns tier `sound` (enum/region-only) vs `abstract` (data-touching), move honesty caveats onto abstract-tier `violated` findings, and retire the pre-Plan-3 provisional caveat.

**Architecture:** A flag `QuintQuery.abstractEvolution` gates new `evolve_<owner>_<field>` monotone-up actions inside `astToQuint`; only `astToQuintClassify` sets it, so goldens/elicitation/method-guard emit byte-identically. A new `conjunctsOf`/`fieldsIn` structural gate (pure AST walkers) drives per-conjunct tier assignment in the classifier; abstract-tier holds are trustworthy (over-approximation errs toward false alarms), so caveats move to abstract-tier `violated`.

**Tech Stack:** TypeScript (strict, ESM, `.js` specifiers), Vitest, Quint 0.26.0 / Apalache 0.47.2.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run`. **Real solvers, no simulated validation** — each verdict shift asserted in a test must come from a real `quint verify`.
- After a fresh checkout: `npx langium generate` + `npm install`.
- **Goldens A–D are byte-identical** — the whole point of the `abstractEvolution` flag is that unflagged callers (goldens, elicitation `cli.ts:44`, `method-guard.ts`) emit exactly as before. A Task-1 test asserts the evolve actions are ABSENT without the flag.
- **Load note (this session):** the machine is currently slow from heavy solver use; `golden/trace-b.test.ts`'s *median-latency* assertion is a known load-induced flake (design honest-ceiling; ledger note). Task verification should confirm `tsc` clean + the task's own tests green + **no NEW correctness failures**; a lone `golden-trace-b` *latency* failure is environmental, not a regression — report it but do not treat it as blocking, and do not "fix" it by weakening budgets.
- Never `git add -A`. `evaluate.ts` untouched (abstract-evolution is emission-only, design §2.1); generation `differential.test.ts` untouched.
- Design of record: `docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md` §6 (abstract-evolution), §6.3 (direction-of-error), §6.4 (structural gate), §10 (honest ceiling).

## Landed foundation (verified 2026-07-10)

- `astToQuint(m, q: QuintQuery)` (`src/emit/quint.ts:297-402`): per-owner loop builds `actions[]`; enum-mutator pattern at `:363-366` is the template; `frame(changed)` at `:304`; `INT_POOL='Set(0,24,72,100)'` at `:24` (all non-negative — reusable as the monotone delta pool); `action step = any { <names> }` at `:396`.
- `astToQuintClassify` (`src/emit/quint-classify.ts:34-37`) builds its machine by calling `astToQuint(m, {kind:'probe-permit', hi:cq.invariant, exclusions:[], maxSteps:cq.maxSteps})` and string-slicing through the `step` line — so new actions gated into `astToQuint` arrive in the classifier's `head` for free once the flag is set on that one call.
- `astToMethodGuardQuery` (`src/emit/method-guard.ts:114`) also slices `astToQuint` — it must stay UNFLAGGED (method⊨guard is a `--max-steps 0` pure entailment, unrelated to accrual).
- `Field.tags?: string[]` (`src/ast/domain.ts:12-17`); reader idiom `f.tags?.includes('balance')` (`src/engine/templates.ts:27-28,40` reads `'balance'`/`'total'`/`'monotonic'`). Terminal states via `StateDef.tags?.includes('terminal')`.
- Predicate/Term/Candidate shapes (`src/ast/invariant.ts:6-42`); recursion templates `collectCmps`/`collectInStateRegions` (`src/engine/salient.ts:12-34,42-50`).
- `classifyInvariant` (`src/engine/classify.ts`): `tier:'sound'` hardcoded (`:10`); provisional `HONEST_CEILING_CAVEAT` (`:17-25`) on entailed/independent; three return branches (`:41-44`). Ledger `classified` already types `tier:'sound'|'abstract'` + `caveat?` + `conjunct?` (`session.ts:29-32`). CLI ledger writers (`cli.ts:174-176,514-516`) pass `tier`/`caveat` through tier-agnostically.
- Per-invariant classify call sites: `classifyAdopted` (`cli.ts:112-123`), `classifyOnApply` (`cli.ts:165-179`) — one whole `Candidate` per invariant today; per-conjunct threading + `conjunct` index goes here.
- Committed tags: `Invoice.amountPaid @balance`; `licenseFeeAmount/usageAmount/totalDue @total`; `accruedUnits/retryCount/paidInvoiceCount/maxRetries/seats` **untagged** (`specs/subscriptions/spec.lat`).

## ⚠️ DESIGN FORK — resolved here, needs human sign-off at plan review (refines design §6.4)

Design §6.4 said annotation-less counters default to **evolving**. But committed evolving-counters (`accruedUnits`, `retryCount`) and config fields (`maxRetries`, `seats`) are indistinguishable (all untagged `Int`), and defaulting to evolving would let `maxRetries` drift and spuriously violate `retryCapWhilePastDue { latestInvoice.retryCount <= maxRetries }`. **Resolution taken in this plan: evolution is OPT-IN by annotation** —

- `@balance` → **monotone-up** (arbitrary non-negative increase while non-terminal).
- `@monotonic` → **monotone-up** (same; the tag already exists).
- `@total` and **untagged** → **frozen** (current behavior; `@total`'s "set-once until finalized" needs effects we don't model, so frozen is the honest floor).

This is more conservative than §6.4 (default-frozen, not default-evolving) — it never fabricates evolution the author didn't annotate, avoids config-field false alarms, and still delivers the headline `amountPaid`-accrual flip. **If the human prefers §6.4's default-evolving (or a `@static` opt-out instead), only Task 1's field-selection predicate changes.** Confirm at review; update design §6.4 to match whichever is chosen.

---

## Task 1: `abstractEvolution` flag + monotone-up evolve actions (classifier-only, golden-safe)

**Files:**
- Modify: `lattice/src/emit/quint.ts` (add `QuintQuery.abstractEvolution`; emit gated `evolve_*` actions), `lattice/src/emit/quint-classify.ts` (set the flag on its `base` call)
- Test: `lattice/test/emit/quint.test.ts`, `lattice/test/emit/quint-classify.integration.test.ts`

**Interfaces:**
- Produces: `QuintQuery.abstractEvolution?: boolean`. When set, `astToQuint` emits, for each owner field tagged `balance` or `monotonic` with a numeric type (`isIntPrim`), an action `evolve_<Owner>_<field>` that non-deterministically increases the field by a non-negative delta **only while the owner is non-terminal**, added to `step`. Unset (default) → no such actions (byte-identical to today).

- [ ] **Step 1: Golden-safety + shape unit tests (write first)**

Add to `lattice/test/emit/quint.test.ts`:

```ts
it('emits NO evolve_ actions without the abstractEvolution flag (golden-safety)', () => {
  const em = astToQuint(subscriptionsModel, { kind: 'probe-permit', hi: paidImpliesExactConjunct, exclusions: [], maxSteps: 5 });
  expect(em.source).not.toContain('action evolve_');
});
it('emits a monotone-up evolve action for @balance fields only when flagged', () => {
  const em = astToQuint(subscriptionsModel, { kind: 'probe-permit', hi: paidImpliesExactConjunct, exclusions: [], maxSteps: 5, abstractEvolution: true });
  expect(em.source).toContain('action evolve_Invoice_amountPaid');        // @balance -> monotone-up
  expect(em.source).toMatch(/amountPaid.*\+ /);                            // increase, not set
  expect(em.source).not.toContain('action evolve_Invoice_totalDue');      // @total -> frozen (no action)
  expect(em.source).not.toContain('action evolve_Subscription_maxRetries'); // untagged -> frozen
  expect(em.source).toContain('evolve_Invoice_amountPaid');               // wired into `step = any {...}`
});
```

- [ ] **Step 2: Run — FAIL** (`abstractEvolution` not in the type; no evolve actions). `cd lattice && npx vitest run test/emit/quint.test.ts`

- [ ] **Step 3: Implement.** In `src/emit/quint.ts`: add `abstractEvolution?: boolean` to the `QuintQuery` interface (`:7-19`). In the per-owner loop, immediately after the enum-mutator block (`:363-366`), add:

```ts
if (q.abstractEvolution) {
  const machine = (o as AggregateDef).machine;
  // non-terminal guard: the drawn id is not in any region's @terminal state (frozen once terminal).
  const termConj = (machine?.regions ?? []).flatMap(r =>
    r.states.filter(s => s.tags?.includes('terminal'))
      .map(s => `${v}.get(id).${r.name}_state != "${s.name}"`));
  const nonTerminal = termConj.length ? `(${termConj.join(' and ')})` : 'true';
  for (const f of o.fields.filter(f => f.type.kind === 'prim' && isIntPrim((f.type as any).prim)
        && (f.tags?.includes('balance') || f.tags?.includes('monotonic')))) {
    actions.push(`action evolve_${o.name}_${f.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet dv = oneOf(${INT_POOL}) all { ${nonTerminal}, ${v}' = ${v}.set(id, ${v}.get(id).with("${f.name}", ${v}.get(id).${f.name} + dv)), ${frame([v]).join(', ')} } }`);
  }
}
```

(`isIntPrim` and `INT_POOL` are already exported from `quint.ts` — Plan 2 Task 5 exported them. `StateDef.tags` carries `'terminal'`.) In `src/emit/quint-classify.ts:34`, add `abstractEvolution: true` to the `base` query.

- [ ] **Step 4: Run unit — PASS.**

- [ ] **Step 5: Real-quint integration — the accrual flip.** Add to `lattice/test/emit/quint-classify.integration.test.ts`: emit the `amountPaid <= totalDue` conjunct (add fixture `amountPaidAtMostTotalConjunct` = `statePredicate` Invoice `amountPaid <= totalDue`) through `astToQuintClassify` consecution and confirm via real `runQuintVerify` that with abstract accrual it is **violable** (`violated:true`) — accrual drives `amountPaid` past `totalDue` — whereas the same invariant under the *unflagged* frozen machine holds. (This is design §6.3's worked flip; it's what makes abstract-evolution meaningful.)

- [ ] **Step 6: Full check + commit.** `cd lattice && npx tsc --noEmit && npx vitest run` (heed the load note: a lone golden-trace-b latency failure is environmental). Commit `lattice/src/emit/quint.ts`, `lattice/src/emit/quint-classify.ts`, the two test files, `test/fixtures.ts` (new conjunct fixture); message `feat(emit): abstract-evolution monotone-up steps for @balance/@monotonic (classifier-only, flag-gated)`.

---

## Task 2: Structural-gate helpers — `conjunctsOf` + `fieldsIn` (pure functions)

**Files:**
- Create: `lattice/src/engine/tier.ts`
- Test: `lattice/test/engine/tier.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // Split a statePredicate whose body is a top-level `and` into one Candidate per conjunct
  // (index-tagged); other Candidate kinds (and non-and bodies) pass through as a single [c].
  export function conjunctsOf(c: Candidate): { candidate: Candidate; conjunct?: string }[];
  // Which data-field paths + region names a predicate references (recursion mirrors salient.ts).
  export function fieldsIn(p: Predicate): { paths: Path[]; regions: Set<string> };
  // Tier for one (already-split) conjunct against the model's field tags:
  //   pure region/inState facts, no data paths            -> 'sound'
  //   references any data field (balance/total/monotonic/untagged numeric/etc.) -> 'abstract'
  export function conjunctTier(m: DomainModel, c: Candidate): 'sound' | 'abstract';
  ```

- [ ] **Step 1: Unit tests first** (`tier.test.ts`): `conjunctsOf` splits `neverOverpaidAndPaidExact`-shaped `and` body into 2 (with `conjunct:'0'`/`'1'`), passes a non-`and` statePredicate through as `[{candidate:c}]`, passes a `unique`/`terminal` candidate through unchanged. `fieldsIn` returns the region for an `inState`-only predicate (empty paths) and the field paths for a `cmp`. `conjunctTier`: an `inState`-only conjunct → `'sound'`; a conjunct referencing `amountPaid`/`totalDue` → `'abstract'`; a `terminal` candidate (region-only) → `'sound'`.

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement** `src/engine/tier.ts`. `fieldsIn` mirrors `collectCmps`/`collectInStateRegions` recursion (`salient.ts:12-34,42-50`): walk `and`/`or` args, `not.arg`, `implies` both sides; `cmp` → collect `field`-term paths from `left`/`right` (walk `plus`); `inState` → add `region`. `conjunctsOf`: for `statePredicate` with `body.kind==='and'`, return `body.args.map((a,i) => ({candidate:{...c, body:a}, conjunct:String(i)}))`; else `[{candidate:c}]`. `conjunctTier`: derive the candidate's testable predicate (statePredicate `body` (+`where`); other kinds → their natural facts — `terminal`/`unique`/`cardinality` are region/structural → `'sound'` unless they reference a data field); `fieldsIn` → if `paths.length===0` → `'sound'`, else `'abstract'`. (Data-vs-config distinction is not needed for the TIER — any data path ⇒ abstract; whether it *evolves* is Task 1's emission concern.)

- [ ] **Step 4: Run — PASS. Step 5: tsc + commit** (`tier.ts`, `tier.test.ts`); message `feat(engine): per-conjunct structural gate (conjunctsOf/fieldsIn/conjunctTier)`.

---

## Task 3: Wire tier + per-conjunct classification + move caveats to abstract violations

**Files:**
- Modify: `lattice/src/engine/classify.ts` (tier from gate; caveat policy; widen `Classification.tier`), `lattice/src/cli.ts` (`classifyAdopted`/`classifyOnApply` per-conjunct loop + `conjunct` in ledger)
- Test: `lattice/test/engine/classify.test.ts`, `lattice/test/engine/classify.integration.test.ts`

**Interfaces:**
- `Classification.tier` widens to `'sound' | 'abstract'`. `classifyInvariant` takes the tier for the (conjunct) candidate (computed by the caller via `conjunctTier`, or computed inside from the candidate). **Caveat policy (design §6.3):** remove `HONEST_CEILING_CAVEAT`; attach a caveat ONLY to **`violated`** findings whose tier is `abstract` — text: `"abstract-evolution over-approximation: the accrual model permits this; the real (unmodeled) update rule may rule it out — add a guard or confirm intended"`. Abstract-tier `entailed`/`independent` are trustworthy (holds survive arbitrary accrual) → no caveat. `sound`-tier → no caveat.
- `classifyAdopted`/`classifyOnApply`: for each adopted invariant, `conjunctsOf(candidate)` → classify each conjunct, tag the `classified` ledger entry with its `conjunct` index and `tier`.

- [ ] **Step 1: Update unit tests** (`classify.test.ts`) for the new policy: an `abstract`-tier `violated` result carries the over-approximation caveat; a `sound`-tier or any `entailed`/`independent` result has NO caveat; assert `tier` is threaded through. (The three existing branch tests change: drop the `HONEST_CEILING_CAVEAT` assertions; add tier + abstract-violated-caveat assertions.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `classify.ts`: widen `tier` to `'sound'|'abstract'`; accept/compute the conjunct's tier (via `conjunctTier(m, inv.candidate)`); set `caveat` only on `violated && tier==='abstract'`; delete `HONEST_CEILING_CAVEAT`. In `cli.ts` `classifyAdopted`/`classifyOnApply`: replace the one-candidate-per-invariant call with a `conjunctsOf` loop, classifying each conjunct and appending a `classified` entry per conjunct (with `conjunct` index + `tier`). Keep the `skipped`/quint-expressible filtering intact.

- [ ] **Step 4: Run unit — PASS.**

- [ ] **Step 5: Real-quint worked classification** (`classify.integration.test.ts`): on `subscriptionsModel`, classify `neverOverpaidAndPaidExact` (whole invariant, via the per-conjunct path) → its `paid ⇒ exact` conjunct classifies **entailed** (`sound`/guard-forced, no caveat) and its `amountPaid <= totalDue` conjunct classifies **violated** with **tier `abstract`** + the over-approximation caveat (accrual drives overpayment). This is the §6.3 headline, end-to-end, real quint.

- [ ] **Step 6: Update design §6.4** to the opt-in-by-annotation resolution (per the fork sign-off) and note the provisional pre-Plan-3 caveat (§10) is now retired/superseded by the structural gate. **Step 7: tsc + full suite + commit** (`classify.ts`, `cli.ts`, both test files, design doc); message `feat(engine): per-conjunct tier gate + abstract-evolution caveats; retire provisional caveat`.

---

## Final whole-branch review (after Task 3)

Run an integrated review over Plan 3's diff (base = pre-Task-1, head = last Task-3 commit): confirm goldens byte-identical (the flag seam held), the tier gate is per-conjunct and correct, the caveat direction flipped correctly (abstract-violated only), and the design-§6.4 fork resolution is reflected in code + doc. Carry Plan 2b's still-open follow-up tickets forward.

## Self-Review

**Spec coverage:** Task 1 = §6.2 abstract steps (opt-in `@balance`/`@monotonic` monotone-up; `@total`/untagged frozen — the §6.4 fork resolution); Task 2 = §6.4 structural gate (per-conjunct); Task 3 = §6.3 caveat direction (abstract-violated) + retires the provisional caveat + per-conjunct ledger tagging.

**Placeholder scan:** Task 1 carries the full evolve-action code; Tasks 2–3 carry interfaces + recursion templates + concrete seams (the salient.ts mirrors, the classify.ts branch edits) — grounded in the landed code, no "TBD"/"handle edges". The one open decision (the §6.4 fork) is explicitly flagged for human sign-off, not silently assumed.

**Type consistency:** `abstractEvolution` (QuintQuery), `conjunctsOf`/`fieldsIn`/`conjunctTier` (tier.ts), widened `Classification.tier` (`'sound'|'abstract'`, matching the ledger's existing union), caveat-on-abstract-violated — consistent across producers/consumers. Golden-safety rests on unflagged callers being unchanged (verified: only `astToQuintClassify` sets the flag).
