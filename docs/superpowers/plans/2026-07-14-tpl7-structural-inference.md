# tpl-7 / tpl-2 Structural-Inference Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `matchTemplates` from auto-adopting domain claims inferred from structural shape — delete tpl-7's no-refs `SingleActive_<Agg>` branch, make tpl-2 honor the documented `@signed` escape hatch, and give the Money-non-negative rule one definition instead of two.

**Architecture:** Three changes to `lattice/src/engine/`. tpl-2's `@signed` bug exists because the Money-non-negative rule is written twice (`templates.ts` and `implied.ts`) and drifted; Task 1 extracts the shared source of truth and fixes the bug through it. Task 2 deletes tpl-7's no-refs arm, leaving the catalog-defined `refs.length > 0` arm untouched. Task 3 reconciles golden trace C, which currently pins the buggy behavior.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, Alloy/Apalache solvers via `vendor/`.

**Design:** `docs/superpowers/specs/2026-07-14-tpl7-structural-inference-design.md`

## Global Constraints

- **Working directory is `lattice/`.** All paths below are relative to it unless prefixed with `docs/`.
- **First-time setup:** run `bash scripts/ensure-ready.sh` before the first test run. This worktree may have no `node_modules`; `npx vitest` fails with `Cannot find package 'vitest'` until it is run. It also sweeps orphaned solver JVMs.
- **ESM import specifiers must end in `.js`** even for TypeScript sources (e.g. `from '../ast/domain.js'`).
- **No new dependencies.**
- **Do not touch the `refs.length > 0` arm of tpl-7.** It is the catalog-defined template and must keep seeding `UniquePer_<ref>` at prior 0.4.
- **Never edit a golden trace to make it pass.** A golden diff must be justified as removal of a false claim, and Task 3 gates that explicitly.

## Measured blast radius (established before planning — do not re-derive)

`matchTemplates` tpl-7 output per fixture, measured on the current tree:

| Model | tpl-7 adopt | tpl-7 seeds |
|---|---|---|
| `fixtures/domains/revrec.json` | `SingleActive_AccountingPeriod` | — |
| `fixtures/domains/trace-a.json` | — | `UniquePer_customer`, `UniquePer_plan` |
| `fixtures/domains/trace-b.json` | — | `UniquePer_invoice` |
| `revrecModel` (`test/fixtures.ts:325`) | `SingleActive_AccountingPeriod` | — |
| `traceAModel`, `traceBModel` | — | `UniquePer_*` |

**Golden traces A and B are unaffected** — they exercise the refs arm only. **Golden trace C is affected**: `golden/trace-c.test.ts:49` asserts `'tpl-7-AccountingPeriod'` is adopted.

`@signed` appears in **zero** specs (`specs/*/spec.lat`) and **zero** fixtures. The only `@signed` coverage is `test/engine/implied.test.ts:31` and parser tests. **The tpl-2 fix therefore changes no existing test's outcome** — it needs new coverage to be observable at all.

---

### Task 1: Give the Money-non-negative rule one definition, and fix tpl-2's `@signed` bug

`implied.ts:68` honors `@signed`; `templates.ts:34` does not. Same rule, two copies, drifted. Extract the two pieces that drifted (the field predicate and the body shape) into `implied.ts` next to `valueLawInstances`, which `templates.ts` already imports from — this is the established house pattern for a derivation shared between these two files.

Keeping both call sites' loop structure intact preserves output ordering. (All `impliedInvariants` consumers — `cli.ts:82`, `cli.ts:566`, `cli.ts:850`, `reconcile.ts:50` — are order-insensitive, but preserving order keeps this task's diff to the rule itself.)

**Files:**
- Modify: `src/engine/implied.ts` (add exports; rewrite the nonNegative arm of `impliedInvariants` at lines 67-71)
- Modify: `src/engine/templates.ts:34-37` (tpl-2 loop)
- Test: `test/engine/templates.test.ts`

**Interfaces:**
- Consumes: `Field` from `../ast/domain.js`, `Predicate` from `../ast/invariant.js` (both already imported by at least one of the two files).
- Produces:
  - `isUnsignedMoney(f: Field): boolean` — exported from `src/engine/implied.ts`
  - `nonNegativeBody(field: string): Predicate` — exported from `src/engine/implied.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/engine/templates.test.ts`, immediately after the existing `'#2 non-negative for every Money field'` test (line 32-33):

```ts
  it('#2 skips @signed Money fields — matches implied.ts and docs/language/tags.md', () => {
    const signedModel: DomainModel = {
      context: 'Ledger', ticksPerDay: 24, enums: [], values: [], aggregates: [],
      entities: [{ kind: 'entity', name: 'Account', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'cleared', type: { kind: 'prim', prim: 'Money' } },
        { name: 'adjustment', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
      events: [], services: []
    };
    const names = matchTemplates(signedModel).adopt.map(a => a.name);
    expect(names).toContain('NonNegative_Account_cleared');
    expect(names).not.toContain('NonNegative_Account_adjustment');
  });
```

Note: `revrecMini`'s existing `'#2 non-negative for every Money field'` assertion of `3` stays correct — none of its Money fields carry `@signed`.

- [ ] **Step 2: Run the test to verify it fails**

If this is the first run in this worktree, run setup first:

```bash
bash scripts/ensure-ready.sh
```

Then:

```bash
npx vitest run test/engine/templates.test.ts -t '@signed'
```

Expected: FAIL — `expected [ ... ] not to contain 'NonNegative_Account_adjustment'`. This is the bug: tpl-2 adopts the rule on a field explicitly marked as legitimately negative.

- [ ] **Step 3: Add the shared derivation to `implied.ts`**

Add `Field` to the existing type import on line 1:

```ts
import type { AggregateDef, DomainModel, EntityDef, Field, ValueDef } from '../ast/domain.js';
```

Then add these exports directly above `impliedInvariants` (i.e. above its doc comment at line 58):

```ts
/**
 * The Money-non-negative rule's single source of truth — `docs/language/derived-invariants.md`:
 * an untagged `Money` field is non-negative; `@signed` opts out (a running balance, a refund
 * adjustment). Shared by impliedInvariants (below — parse-time dedup, never printed) and
 * templates.ts's tpl-2 (enforcement + template provenance). These two derived the rule separately
 * once and drifted: tpl-2 ignored @signed, silently adopting the rule on fields the modeler had
 * explicitly excluded. Keep them reading from here so they cannot diverge again.
 */
export const isUnsignedMoney = (f: Field): boolean =>
  f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed');

export const nonNegativeBody = (field: string): Predicate =>
  ({ kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [field] }, right: { kind: 'int', value: 0 } });
```

- [ ] **Step 4: Route `impliedInvariants` through it**

Replace lines 67-71 of `src/engine/implied.ts`:

```ts
    for (const f of o.fields)
      if (f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed'))
        out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`, { kind: 'statePredicate', aggregate: o.name,
          body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [f.name] },
            right: { kind: 'int', value: 0 } } }));
```

with:

```ts
    for (const f of o.fields)
      if (isUnsignedMoney(f))
        out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`,
          { kind: 'statePredicate', aggregate: o.name, body: nonNegativeBody(f.name) }));
```

- [ ] **Step 5: Route tpl-2 through it, fixing the bug**

In `src/engine/templates.ts`, add the two helpers to the existing `implied.js` import on line 4:

```ts
import { isUnsignedMoney, nonNegativeBody, valueLawInstances } from './implied.js';
```

Replace lines 34-37:

```ts
    // #2 non-negative for Money fields
    for (const f of o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money'))
      adopt.push(mk(`tpl-2-${o.name}-${f.name}`, `NonNegative_${o.name}_${f.name}`,
        { kind: 'statePredicate', aggregate: o.name,
          body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [f.name] }, right: { kind: 'int', value: 0 } } }));
```

with:

```ts
    // #2 non-negative for Money fields — @signed opts out (isUnsignedMoney is the shared rule)
    for (const f of o.fields.filter(isUnsignedMoney))
      adopt.push(mk(`tpl-2-${o.name}-${f.name}`, `NonNegative_${o.name}_${f.name}`,
        { kind: 'statePredicate', aggregate: o.name, body: nonNegativeBody(f.name) }));
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/engine/templates.test.ts test/engine/implied.test.ts
npx tsc --noEmit
```

Expected: PASS, all tests in both files. `tsc` clean. The pre-existing `'#2 non-negative for every Money field'` (expects 3) and `'suppresses nonNegative for @signed Money fields'` must both still pass — they pin the two call sites against the shared rule.

- [ ] **Step 7: Commit**

```bash
git add src/engine/implied.ts src/engine/templates.ts test/engine/templates.test.ts
git commit -m "fix(lattice): tpl-2 honors @signed — one shared Money-non-negative derivation

implied.ts honored the documented @signed escape hatch; templates.ts's tpl-2
did not, auto-adopting NonNegative_* at prior 0.9 on fields the modeler
explicitly marked as legitimately negative. Same rule, two copies, drifted.

Extract isUnsignedMoney + nonNegativeBody into implied.ts alongside
valueLawInstances (the established pattern for a derivation these two files
share) and route both call sites through them.

No fixture or spec uses @signed, so no existing trace shifts."
```

---

### Task 2: Delete tpl-7's no-refs branch

The catalog (`docs/plan.md` §10.2 row 7) defines template #7 as `@active` on **a child collection** → `unique while active by (parent, key)`. The `refs.length === 0` arm fires precisely when that trigger *fails* and emits a different kind (`cardinality`) asserting a platform-wide singleton. Delete it. A refless `@active` aggregate produces nothing from #7.

**Files:**
- Modify: `src/engine/templates.ts:56-66`
- Test: `test/engine/templates.test.ts:36-37`

**Interfaces:**
- Consumes: nothing new.
- Produces: `matchTemplates` no longer emits any `tpl-7-<Agg>` id into `adopt`. The `tpl-7-<Agg>-<field>` seed ids in `seeds` are unchanged.

- [ ] **Step 1: Rewrite the test that pins the bug**

In `test/engine/templates.test.ts`, replace the existing test at lines 36-37:

```ts
  it('#7 cardinality single-active when the tagged aggregate has no refs', () =>
    expect(adopt.some(a => a.candidate.kind === 'cardinality' && a.candidate.aggregate === 'AccountingPeriod' && (a.candidate as any).atMost === 1)).toBe(true));
```

with:

```ts
  // Catalog (docs/plan.md §10.2 row 7) defines #7 as `@active` on a CHILD COLLECTION -> the
  // per-parent `unique` form. The old no-refs arm fired when that trigger FAILED, asserting a
  // platform-wide singleton from a shape coincidence. "No refs" was a discriminator fitted to
  // revrecMini's AccountingPeriod, never a singleton signal. See the 2026-07-14 design doc.
  it('#7 adopts NO cardinality for a refless @active aggregate', () =>
    expect(adopt.some(a => a.candidate.kind === 'cardinality')).toBe(false));

  it('#7 adopts no SingleActive_* for a refless @active aggregate in a multi-tenant shape', () => {
    const billerModel: DomainModel = {
      context: 'BillPayments', ticksPerDay: 24, enums: [], values: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Biller', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'name', type: { kind: 'prim', prim: 'Text' } }],
        machine: { regions: [{ name: 'Lifecycle', initial: 'Active', states: [
          { name: 'Active', tags: ['active'] }, { name: 'Retired', tags: ['terminal'] }] }], transitions: [] } }],
      events: [], services: []
    };
    const r = matchTemplates(billerModel);
    expect(r.adopt.map(a => a.name)).not.toContain('SingleActive_Biller');
    expect(r.adopt.some(a => a.candidate.kind === 'cardinality')).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/engine/templates.test.ts -t '#7'
```

Expected: both new tests FAIL (`expected true to be false`), because the no-refs arm still adopts a `cardinality`. The existing `'#7-unique seeds fire for @active aggregates WITH refs (trace A model)'` must still PASS — it pins the arm being preserved.

- [ ] **Step 3: Delete the branch**

In `src/engine/templates.ts`, replace lines 56-66:

```ts
      // #7 single-active
      const actives = r.states.filter(s => s.tags?.includes('active')).map(s => s.name);
      if (actives.length > 0) {
        if (refs.length === 0)
          adopt.push(mk(`tpl-7-${o.name}`, `SingleActive_${o.name}`,
            { kind: 'cardinality', aggregate: o.name, where: { kind: 'inState', owner: 'self', region: r.name, states: actives }, atMost: 1 }));
        else
          for (const f of refs)
            seeds.push(mk(`tpl-7-${o.name}-${f.name}`, `UniquePer_${f.name}`,
              { kind: 'unique', aggregate: o.name, whileStates: { region: r.name, states: actives }, by: [[f.name]] }, 0.4));
      }
```

with:

```ts
      // #7 single-active (uniqueness) — catalog §10.2 row 7: an @active state on a CHILD
      // COLLECTION seeds `unique while active by (parent)`. Deliberately silent for a refless
      // aggregate: singleton-ness is a claim about how many instances EXIST and is not recoverable
      // from field shape, so it is elicited or authored (`count where … <= 1`), never inferred.
      const actives = r.states.filter(s => s.tags?.includes('active')).map(s => s.name);
      if (actives.length > 0)
        for (const f of refs)
          seeds.push(mk(`tpl-7-${o.name}-${f.name}`, `UniquePer_${f.name}`,
            { kind: 'unique', aggregate: o.name, whileStates: { region: r.name, states: actives }, by: [[f.name]] }, 0.4));
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/engine/templates.test.ts
npx tsc --noEmit
```

Expected: PASS, every test in the file — including `'#7-unique seeds fire for @active aggregates WITH refs (trace A model)'`.

If `tsc` reports `refs` or `actives` as unused, do **not** delete them: `refs` is still read by tpl-9 (`templates.ts:46`) and `actives` by the tpl-11 grace shell below. An unused-variable error here means the edit removed too much — re-read the diff.

- [ ] **Step 5: Commit**

```bash
git add src/engine/templates.ts test/engine/templates.test.ts
git commit -m "fix(lattice): drop tpl-7's no-refs branch — stop inferring singletons from shape

The catalog (plan.md §10.2 row 7) defines #7 as the per-parent \`unique\` form
on a child collection. The refs.length===0 arm fired precisely when that
trigger failed, emitting a platform-wide \`cardinality … atMost 1\` at prior
0.9 — auto-adopting SingleActive_Biller / SingleActive_Payer and negating
multi-tenancy in any domain whose aggregates happen to carry no refs.

Traced to slice-1 Task 12, where it was fitted to revrecMini's AccountingPeriod
'single-open' case. With one positive example, 'has no refs' and 'is an
accounting period' are indistinguishable hypotheses; the author picked the
mechanically checkable one. It detects incompleteness, not singletons — the
moment AccountingPeriod gains an entity ref, the refs arm gives the correct
per-entity answer.

Adopted invariants become solver assumptions (planner.ts:93), so the false
claim made its own refuting witness UNSAT — sealing off its correction channel.

Singleton-ness stays available via LLM domain seeding (plan.md §9 source 5),
elicitation, or authoring \`count where … <= 1\` (lat.langium:115)."
```

---

### Task 3: Reconcile golden trace C

`golden/trace-c.test.ts:49` asserts `'tpl-7-AccountingPeriod'` among the adopted ids — a kill-criterion trace that pins the deleted behavior. **This task is a measurement, not a predetermined edit.** Removing an adopted invariant removes a solver assumption (`planner.ts:93` feeds `adoptedConstraints` into every `solve(...)`), which *loosens* the witness space. The trace's `judgments <= 8` budget may move. Find out what actually happens before deciding what to change.

**Files:**
- Modify: `golden/trace-c.test.ts:49`
- Possibly modify: `golden/trace-c.test.ts:87` (the judgment budget) — **only** with the justification required in Step 4.

**Interfaces:**
- Consumes: `matchTemplates` behavior from Task 2.
- Produces: a green golden trace C with a justified diff.

- [ ] **Step 1: Run trace C and observe the actual failure**

```bash
npx vitest run golden/trace-c.test.ts 2>&1 | tail -30
```

Expected: FAIL at line 49 — `expected [ … ] to contain 'tpl-7-AccountingPeriod'`.

If the whole `describe` is **skipped**, Alloy is missing: run `bash scripts/ensure-ready.sh` and confirm it reports `"alloyJar": true`. A skipped trace C is not a passing trace C — do not proceed on a skip.

- [ ] **Step 2: Remove the stale id from the expectation**

Replace line 49:

```ts
    for (const id of ['tpl-1-Obligation', 'tpl-8-Obligation-recognized', 'tpl-3-AccountingPeriod-Closed', 'tpl-7-AccountingPeriod', 'tpl-9-RevenueEntry'])
```

with:

```ts
    // tpl-7-AccountingPeriod intentionally absent: #7 no longer infers a platform-wide singleton
    // from a refless aggregate (2026-07-14 design). "At most one Open period" is real domain
    // knowledge and belongs to LLM domain seeding (plan.md §9 source 5) or an authored
    // `count where … <= 1` — not to a shape-matching template. The other four still come free.
    for (const id of ['tpl-1-Obligation', 'tpl-8-Obligation-recognized', 'tpl-3-AccountingPeriod-Closed', 'tpl-9-RevenueEntry'])
```

- [ ] **Step 3: Re-run trace C and record the judgment count**

```bash
npx vitest run golden/trace-c.test.ts 2>&1 | tail -30
```

Two possible outcomes — do not assume which:

- **PASS** → the loosened witness space did not change the trace. Go to Step 5.
- **FAIL on `expect(judgments).toBeLessThanOrEqual(8)`** → removing the constraint widened the space and the loop now needs more judgments. Go to Step 4.

Any *other* failure (`survivor` undefined, `openDecisions !== 1`, an unexpected `q.type`) is **not** an expected consequence of this change. Stop and report it rather than adjusting the test.

- [ ] **Step 4: If and only if the budget was exceeded — measure, then decide**

Add a temporary `console.log(judgments)` after the loop and re-run to get the real number. Then report to the reviewer with:

1. the old count (from `git stash` + run, or the committed baseline) and the new count;
2. whether the extra questions are *legitimate* — i.e. the loop now asks about states that the false `SingleActive_AccountingPeriod` had previously made unreachable. **This is the expected and correct direction:** the bug was suppressing real questions, and getting them back is the fix working. It also means the trace's original 8 was measured under a false assumption.
3. a recommendation: raise the budget to the measured value, or treat it as a genuine regression.

**Do not silently raise the number.** `docs/superpowers/specs/2026-07-03-lattice-elicitation-slice-1-design.md` §2.4 ("Cross-cutting budgets and kill criteria") pre-registers it: convergence needing "> 8 judgments total for the residual on trace C" is a kill criterion, set at 2× the expected 4. Moving it is a project-level decision that needs a human. Remove the temporary `console.log` before committing.

- [ ] **Step 5: Run the full suite**

```bash
npx vitest run 2>&1 | tail -25
```

Expected: PASS. Golden traces A and B were measured unaffected (they exercise only the refs arm). Pay attention to `test/cli.test.ts`, `test/dod.test.ts`, `test/pipeline-from-scratch.test.ts`, and `test/golden-trace-d.test.ts` — all assert `NonNegative_*` names, all of which survive because no fixture uses `@signed`.

If a solver test fails with a timeout or JVM error rather than an assertion, re-run `bash scripts/ensure-ready.sh` (it sweeps orphaned solver JVMs) and retry once before treating it as a real failure — trace B's latency budget is load-sensitive.

- [ ] **Step 6: Commit**

```bash
git add golden/trace-c.test.ts
git commit -m "test(lattice): golden trace C — AccountingPeriod is not a free singleton

trace-c pinned tpl-7-AccountingPeriod as part of the 'comes free' moment. That
claim was the bug: a platform-wide 'at most one Open period' inferred from
AccountingPeriod happening to carry no ref fields. The other four template
adoptions still come free; the period invariant is now domain knowledge to be
seeded or authored, not inferred from shape."
```

---

## Self-Review

**Spec coverage:**

| Design section | Task |
|---|---|
| 1. tpl-7 — delete the no-refs branch | Task 2 |
| 2. tpl-2 — honor `@signed` | Task 1 |
| 3. Share the derivation | Task 1 (Steps 3-5) |
| 4. Tests — invert `templates.test.ts:36` | Task 2 Step 1 |
| 4. Tests — refless `@active` regression (Biller) | Task 2 Step 1 |
| 4. Tests — `@signed` in the template path | Task 1 Step 1 |
| 4. Tests — trace-A `UniquePer` seeds keep passing | Task 2 Steps 2, 4 |
| Risk — golden traces | Task 3 (all steps) |
| Risk — `prior` inert | N/A: documented in design; no code change |
| Success criteria 1-4 | Tasks 1-2 |
| Success criterion 5 (suite green, diffs justified) | Task 3 Steps 4-5 |

**Type consistency:** `isUnsignedMoney(f: Field): boolean` and `nonNegativeBody(field: string): Predicate` are defined in Task 1 Step 3 and used under those exact names in Steps 4-5. `Field` is added to `implied.ts`'s import in Step 3; `templates.ts` already imports `Field` (line 1) and `Predicate` is already imported by `implied.ts` (line 3).

**Placeholders:** none — every code step carries the literal before/after text.

**Out of scope (per design):** `@singleton` tag; `retract`/`refute` command and the dead `'refuted'` status; persisting `seeds`.
