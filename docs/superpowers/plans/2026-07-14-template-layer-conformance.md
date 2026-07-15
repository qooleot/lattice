# Template-Layer Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the template layer tell the truth — one derivation per rule, camelCase names, an elicited (never guessed) Money sign, and a decline path that records *why*.

**Architecture:** `implied.ts` becomes the single source of truth for the four structure-implied families (non-negativity, refs-resolve, terminal, value laws); `matchTemplates` adopts its output verbatim instead of re-deriving it, and keeps only the four genuinely template-y rules. A new `init`-only diagnostic refuses to accept a `Money` field whose sign was never decided — `loadLatText` is deliberately untouched. A new `decline` command writes the `declined` ledger record that already exists in the schema.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, Langium, Alloy + Quint solvers.

**Design:** `docs/superpowers/specs/2026-07-14-template-layer-conformance-design.md` (rebased onto main `cb01d6a`).

## Global Constraints

- **Never pipe vitest through `tail`/`head` when reading its exit code.** The pipeline returns `tail`'s status: vitest exits 1 while `echo $?` prints 0. Redirect to a file and grep it.
- **The full suite has no known-green baseline on this machine.** Two back-to-back runs on 2026-07-14 failed 3 tests each — *different ones both times*, all passing in isolation (`trace-b`'s p50 latency budget; `cli-classify.integration` at 81s against a 120s timeout; `roundtrip`'s 200 unseeded fast-check iterations). **Gate per-file**, and run `bash lattice/scripts/cleanup-solvers.sh` first. Argue any failure by whether the change can *reach* the test, never by the suite's verdict.
- **All commands run from `lattice/`** unless stated. The repo root is the worktree at `.claude/worktrees/bill-payment-ledger-spec-edffdc`.
- **`loadLatText` behavior must not change.** `Money ⇒ non-negative unless @signed` stays the language default. Any change that makes a `.lat` file or a ```lat doc block stop parsing is a defect — `test/docs-blocks.test.ts` parses every block in `docs/language/`.
- Imports use `.js` extensions (ESM). Follow the existing comment style: state constraints the code can't show, not narration.
- Commit after every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lattice/src/engine/implied.ts` | **Single source of truth** for the four structure-implied families. `nonNegativeMoneyFields` **and** `nonNegativeBody` revert to private. | 1 |
| `lattice/src/engine/templates.ts` | Only conservation / monotonic / uniquePer-seed / deadline. Delegates the rest; folds its own names via `toCamelName`. | 1, 2 |
| `lattice/src/ast/naming.ts` | **Reused, not modified** — `toCamelName` already exists (`3438724`). | 2 |
| `lattice/src/ast/validate.ts` | Gains `undecidedMoneySigns` — **exported, and NOT called by `validateModel`**. | 3 |
| `lattice/src/engine/session.ts` | `CandidateStatus` gains `'declined'`. | 4 |
| `lattice/src/cli.ts` | `init` calls the sign check; new `decline` command. | 3, 4 |
| `lattice/test/engine/templates.test.ts` | Delegation + naming guards. | 1, 2 |
| `lattice/test/ast/validate-sign.test.ts` | **New** — sign diagnostic, incl. that `validateModel` does *not* emit it. | 3 |
| `lattice/test/cli-decline.test.ts` | **New** — decline command. | 4 |
| `docs/plan.md`, `docs/language/tags.md` | §10.2 amendments; `@unsigned`. | 5 |
| `.claude/skills/elicit-spec/SKILL.md` | Cluster sign question. | 6 |

---

### Task 1: `templates.ts` delegates the structure-implied families to `implied.ts`

**Why:** `matchTemplates` and `impliedInvariants` already produce **identical candidate shapes** for these four families (verified: zero difference in both directions). They differ only in `id`, `name`, and `prior`. `impliedInvariants` never reaches the solver — `planner.ts:93`'s `adoptedConstraints` reads only `s.candidates` — so the sole purpose of the duplicate derivation is to feed a different consumer. Deriving twice is what let `templates.ts` ignore `@signed` while `implied.ts` honoured it.

**Files:**
- Modify: `lattice/src/engine/templates.ts`
- Modify: `lattice/src/engine/implied.ts`
- Modify: `lattice/test/engine/templates.test.ts`
- Modify: `lattice/golden/trace-c.test.ts:52`, `lattice/test/cli-strengthen.test.ts:344`, `lattice/test/cli-strengthen.integration.test.ts:82`, `lattice/test/pipeline-from-scratch.test.ts:90`, `lattice/test/golden-trace-d.test.ts:22-23`

**Interfaces:**
- Consumes: `impliedInvariants(m: DomainModel): CandidateInvariant[]` from `./implied.js`.
- Produces: `matchTemplates(m)` returns `{ adopt, seeds }` where `adopt` contains `impliedInvariants(m)` verbatim (ids `implied-*`, `prior: 1`) plus template-owned candidates (ids `tpl-*`, `prior: 0.9`).

- [ ] **Step 1: Write the failing test**

Add to `lattice/test/engine/templates.test.ts`, after the `revrecMini` describe block:

```ts
describe('matchTemplates — structure-implied families are delegated, not re-derived', () => {
  const { adopt } = matchTemplates(revrecMini);
  const implied = impliedInvariants(revrecMini);

  it('adopts every implied invariant verbatim (same id, name, and candidate)', () => {
    for (const i of implied) {
      const found = adopt.find(a => a.id === i.id);
      expect(found, `implied ${i.name} not adopted`).toBeDefined();
      expect(found!.name).toBe(i.name);
      expect(found!.candidate).toEqual(i.candidate);
    }
  });

  it('derives no non-negative / refsResolve / terminal / value-law candidate of its own', () => {
    const impliedIds = new Set(implied.map(i => i.id));
    const ownDerived = adopt.filter(a => !impliedIds.has(a.id));
    expect(ownDerived.every(a => a.id.startsWith('tpl-')), 'template-owned ids must be tpl-*').toBe(true);
    // Obligation's conservation + monotonic are the whole template-owned set. No cardinality:
    // 9bc1ed5 dropped tpl-7's no-refs arm, so a refless @active aggregate (AccountingPeriod)
    // adopts nothing. Verified against main at cb01d6a — do not "correct" this to include
    // cardinality without re-running matchTemplates first.
    expect(ownDerived.map(a => a.candidate.kind).sort())
      .toEqual(['conservation', 'monotonic']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/templates.test.ts -t "delegated"`
Expected: FAIL — `adopt.find(a => a.id === 'implied-nonNegativeObligationRecognized')` is `undefined`, because `templates.ts` currently emits `tpl-2-Obligation-recognized`.

- [ ] **Step 3: Delegate in `templates.ts`**

Replace the import on line 1-4 of `lattice/src/engine/templates.ts`:

```ts
import type { AggregateDef, DomainModel, EntityDef } from '../ast/domain.js';
import { isQualifiedRef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import { impliedInvariants } from './implied.js';
```

(All four of main's current imports from `./implied.js` — `nonNegativeBody`, `nonNegativeMoneyFields`, `valueLawInstances` — plus the `Field` type become unused here once the three blocks below are deleted.)

Replace the opening of `matchTemplates` — the `adopt`/`seeds` declarations and the `valueLawInstances` loop — with:

```ts
export function matchTemplates(m: DomainModel): { adopt: CandidateInvariant[]; seeds: CandidateInvariant[] } {
  // The structure-implied families (non-negativity, refs-resolve, terminal, value laws) are NOT
  // derived here. implied.ts is their single source of truth and its output is adopted verbatim:
  // adoption is what puts a rule in front of the solver (planner.ts's adoptedConstraints reads
  // s.candidates; impliedInvariants never reaches a solver on its own), so a second derivation
  // here bought nothing but the opportunity to disagree — which it took, ignoring @signed while
  // implied.ts honoured it. Only rules with no implied.ts counterpart are matched below.
  const adopt: CandidateInvariant[] = [...impliedInvariants(m)];
  const seeds: CandidateInvariant[] = [];
```

Delete these three blocks from the `for (const o of owners(m))` loop:
- `// #2 non-negative for Money fields` (and its `for` loop)
- `// #9 no-orphan for owners with refs` (and its `if`)
- `// #3 terminal` (and its `for` loop, inside the `for (const r of machine?.regions ?? [])` loop)

Keep `const refs = ...` — `#7` still uses it.

- [ ] **Step 4: Revert `nonNegativeMoneyFields` AND `nonNegativeBody` to private in `implied.ts`**

Both were exported so `templates.ts` could share them (`4c1bd33`/`eec5b3e`). Delegation orphans both — `impliedInvariants` becomes their only consumer. In `lattice/src/engine/implied.ts`, drop `export` from each, and replace the long shared-derivation doc comment above `nonNegativeMoneyFields` with:

```ts
/** Money ⇒ non-negative, opted out of by @signed (spec P9). */
```

The drift warning that comment carries is obsolete: with `templates.ts` delegating, there is exactly one derivation and nothing left to drift. Sharing a helper was the right fix while there were two callers; deleting the second caller is strictly better.

Remove the now-unused `Field` import from `templates.ts` if tsc flags it (it was only reachable via `nonNegativeMoneyFields`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/engine/templates.test.ts`
Expected: PASS for the new block. Three pre-existing tests in that file pin the old naming and will FAIL — update each:

```ts
  // was: expect(adopt.filter(a => a.name.startsWith('NonNegative')).length).toBe(3)
  it('#2 non-negative is delegated to implied.ts (camelCase, implied- ids)', () =>
    expect(adopt.filter(a => a.name.startsWith('nonNegative')).length).toBe(3));
```

In the `#2 non-negativity honours @signed` describe block, rename the two expectations:
`'NonNegative_Account_balance'` → `'nonNegativeAccountBalance'`, `'NonNegative_Account_lifetimeFees'` → `'nonNegativeAccountLifetimeFees'`. Keep both — they still pin @signed suppression, now through the delegation.

**Leave the two tpl-7 tests alone** (`#7 adopts NO cardinality for a refless @active aggregate`, and `#7 adopts no SingleActive_* … multi-tenant shape`). They assert an absence, which delegation does not touch, and they are `9bc1ed5`'s regression guard against re-inferring singletons from shape.

Update that block's header comment too: it currently explains that both callers "now share `nonNegativeMoneyFields`". After this task they do not share it — there is one caller. The comment should say the tests pin that delegation keeps `matchTemplates` and `implied.ts` in agreement by construction.

- [ ] **Step 6: Migrate the five test files that hard-code names/ids**

`lattice/golden/trace-c.test.ts:52` — `tpl-3-*` and `tpl-9-*` become `implied-*`; `tpl-1`/`tpl-8` stay:

```ts
    for (const id of ['tpl-1-Obligation', 'tpl-8-Obligation-recognized',
                      'implied-terminalAccountingPeriodLifecycleClosed', 'implied-refsResolveRevenueEntry'])
```

**Do NOT add `tpl-7-AccountingPeriod` to that list.** It is *intentionally absent* — the comment directly above it (lines 47-51) explains that `9bc1ed5` stopped #7 inferring a platform-wide singleton from a refless aggregate. Re-adding it would resurrect the behavior that comment exists to prevent. Leave those five lines exactly as they are.

`lattice/test/cli-strengthen.test.ts:344` and `lattice/test/cli-strengthen.integration.test.ts:82` — replace the four `NonNegative_Invoice_*` names with `nonNegativeInvoiceAmountPaid`, `nonNegativeInvoiceLicenseFeeAmount`, `nonNegativeInvoiceTotalDue`, `nonNegativeInvoiceUsageAmount` (keep surrounding entries such as `paidExact` unchanged, and keep the arrays' existing sort order expectations).

`lattice/test/pipeline-from-scratch.test.ts:90` — `'NonNegative_Order_balance'` → `'nonNegativeOrderBalance'`.

`lattice/test/golden-trace-d.test.ts:22-23` — `'NonNegative_Invoice_totalDue'` → `'nonNegativeInvoiceTotalDue'`; `'ValueLaw_Invoice_period_wellOrdered'` → `'valPeriodInvoicePeriodWellOrdered'`.

Comments in those files referencing the old names (e.g. `cli-strengthen.test.ts:339`, `:378`, `pipeline-from-scratch.test.ts:220`) must be updated too — a comment naming a symbol that no longer exists is a defect.

- [ ] **Step 7: Verify the affected files pass**

```bash
bash scripts/cleanup-solvers.sh
npx vitest run test/engine/templates.test.ts test/engine/implied.test.ts test/pipeline-from-scratch.test.ts test/golden-trace-d.test.ts > /tmp/t1.log 2>&1; echo "exit=$?"
grep -E "Tests |FAIL" /tmp/t1.log
```
Expected: `exit=0`, all pass.

Then the slow real-solver ones, **one at a time**:
```bash
npx vitest run golden/trace-c.test.ts > /tmp/t1c.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t1c.log
npx vitest run test/cli-strengthen.test.ts > /tmp/t1s.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t1s.log
```
Expected: `exit=0` each. If `cli-strengthen.integration.test.ts` times out, re-run it alone after `cleanup-solvers.sh` — it takes ~269s of real quint and is a known load-sensitive test, not a regression.

- [ ] **Step 8: Commit**

```bash
git add lattice/src/engine/templates.ts lattice/src/engine/implied.ts lattice/test/engine/templates.test.ts lattice/golden/trace-c.test.ts lattice/test/cli-strengthen.test.ts lattice/test/cli-strengthen.integration.test.ts lattice/test/pipeline-from-scratch.test.ts lattice/test/golden-trace-d.test.ts
git commit -m "refactor(engine): templates delegates the structure-implied families to implied.ts

The two modules produced identical candidate shapes for non-negativity,
refs-resolve, terminal and value laws — differing only in id, name and prior.
impliedInvariants never reaches a solver (planner.ts reads only s.candidates),
so the duplicate derivation existed solely to feed a different consumer, and
its only observable effect was the chance to disagree: templates.ts ignored
@signed while implied.ts honoured it (22f6c29).

Adopting impliedInvariants verbatim deletes the duplication rather than
sharing more of it, and camelCases those names for free — which is the rename
the real subscriptions session performed by hand."
```

---

### Task 2: camelCase the template-owned names

**Why:** 18 of 30 renames in the one real committed session are a human hand-fixing template names (`TotalDue_At_Most_Parts → totalDueAtMostParts`). Every spec this tool has emitted warns on reload. Task 1 fixed the delegated families; these remain.

**Use main's normalizer, don't write another.** `3438724` landed `toCamelName` (`lattice/src/ast/naming.ts`) and applies it in `propose` at the boundary where the agent authors a name (`cli.ts:439`), on the reasoning that a machine-authored name should be *folded*, not warned about — while hand-written `.lat` keeps the convention advisory, "because rewriting their file would overstep" (`docs/language/naming-conventions.md`). **Template names are machine-authored by exactly the same argument**, so this task folds them at the `matchTemplates` boundary rather than hand-writing camelCase literals. One normalizer, two authorship boundaries.

**Also fixes a latent collision that main's own design calls out.** `propose` refuses a batch with `name-collision` when two rules fold onto one name — "a real ambiguity no normalizer can settle". Templates bypass that path and have exactly this bug: `UniquePer_${f.name}` keys off the ref *field* only, so the BillPayments model produced **three distinct seeds all named `UniquePer_biller`** (on `Bill`, `SettlementBatch`, `Fee`) — folding to three identical `uniquePerBiller`. Including the owner fixes it at the source.

**Note `SingleActive_*` is gone** (`9bc1ed5` dropped tpl-7's no-refs arm), so there is no `singleActive` rename to make.

**Files:**
- Modify: `lattice/src/engine/templates.ts`
- Modify: `lattice/test/engine/templates.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: adopted/seeded names `conservation<Owner>`, `monotonic<Owner><Field>`, `uniquePer<Owner><Field>`, `deadlineBound<Owner>` — every template-owned name folded through `toCamelName`. Ids are unchanged (`tpl-*`). There is no `singleActive<Owner>`: `9bc1ed5` removed the arm that produced it.

- [ ] **Step 1: Write the failing test**

Add to `lattice/test/engine/templates.test.ts`. Add `astToCode` and `loadLatText` imports at the top:

```ts
import { astToCode } from '../../src/emit/code.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
```

Then:

```ts
// 18 of 30 renames in the real subscriptions session were a human hand-fixing these names to
// camelCase, and every emitted spec warned on reload. These two guards pin both halves: the
// ledger-visible name (which `apply` reconciles by, printed or not) and the emitted file.
describe('matchTemplates — invariant names follow the camelCase convention (spec P8)', () => {
  const CAMEL = /^[a-z][A-Za-z0-9]*$/;

  // revrecMini is NOT usable for the emit guard: its region `Lifecycle`, states `Open`/`Closed` and
  // enum values `Recognition`/`Correction` are PascalCase and produce 5 naming warnings of their
  // own. This model is convention-clean everywhere EXCEPT what matchTemplates names, so a warning
  // here can only be an invariant name.
  const cleanModel: DomainModel = {
    context: 'Billing', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Biller', fields: [{ name: 'billerId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'biller', type: { kind: 'ref', target: 'Biller' } },
      { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'amountDue', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
      machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
        { name: 'draft' }, { name: 'issued', tags: ['active'] }, { name: 'void', tags: ['terminal'] }] }],
        transitions: [] } }],
    events: [], services: []
  };

  it('every adopted and seeded name is camelCase', () => {
    const { adopt, seeds } = matchTemplates(revrecMini);
    expect([...adopt, ...seeds].filter(a => !CAMEL.test(a.name)).map(a => a.name)).toEqual([]);
  });

  it('an emitted spec reloads with zero naming-convention warnings', async () => {
    const { adopt } = matchTemplates(cleanModel);
    const r = await loadLatText(astToCode(cleanModel, adopt));
    expect(r.ok).toBe(true);
    expect(r.warnings.filter(w => w.code === 'naming-convention')).toEqual([]);
  });

  it('uniquePer seeds are distinct per owner (not just per ref field)', () => {
    // two aggregates with a same-named ref field and an @active state must not collide
    const m: DomainModel = {
      context: 'Coll', ticksPerDay: 24, enums: [], values: [],
      entities: [{ kind: 'entity', name: 'Biller', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
      aggregates: (['Bill', 'Fee'] as const).map(n => ({
        kind: 'aggregate' as const, name: n,
        fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
                 { name: 'biller', type: { kind: 'ref' as const, target: 'Biller' } }],
        machine: { regions: [{ name: 'standing', initial: 'open', states: [{ name: 'open', tags: ['active' as const] }] }], transitions: [] }
      })),
      events: [], services: []
    };
    const names = matchTemplates(m).seeds.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/templates.test.ts -t "camelCase"`
Expected: FAIL — names include `Conservation_Obligation`, `Monotonic_Obligation_recognized`, `SingleActive_AccountingPeriod`; and the two seeds collide on `UniquePer_biller`.

- [ ] **Step 3: Fix the collision at its source**

In `lattice/src/engine/templates.ts`, the tpl-7 seed name must carry the owner. Change:

```ts
          seeds.push(mk(`tpl-7-${o.name}-${f.name}`, `UniquePer_${o.name}_${f.name}`,
```

(The id already carried the owner; only the name did not. Ids stay exactly as they are — they are ledger provenance keys, and `trace-c.test.ts:52` pins them.)

- [ ] **Step 4: Fold every template name through the shared normalizer**

Import it in `templates.ts`:

```ts
import { toCamelName } from '../ast/naming.js';
```

Then fold at the single boundary — the `return` of `matchTemplates`:

```ts
  // Fold names onto the convention here, at the boundary where THIS module authors them, exactly
  // as cli.ts's `propose` does for agent-authored names (docs/language/naming-conventions.md): a
  // machine-authored name is normalized, a hand-written one only warned. Folding at the return
  // keeps the literals above readable as `NonNegative_${o.name}_${f.name}` while nothing outside
  // ever sees the un-folded form.
  const fold = (i: CandidateInvariant): CandidateInvariant => ({ ...i, name: toCamelName(i.name) });
  return { adopt: adopt.map(fold), seeds: seeds.map(fold) };
```

Note the delegated candidates from Task 1 arrive already camelCase (`implied.ts` builds them that way), and `toCamelName` is idempotent on a name with no underscores — so folding them again is a no-op, not a double-fold.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/engine/templates.test.ts`
Expected: PASS (all, including the Task 1 delegation tests).

- [ ] **Step 6: Verify no other test pins the old names**

```bash
grep -rnE "Conservation_\{|UniquePer_\{|Monotonic_\{|DeadlineBound_\{|NonNegative_\{|NoOrphan_\{|Terminal_\{|ValueLaw_\{" lattice/src
grep -rnE "'(Conservation|UniquePer|Monotonic|DeadlineBound|NonNegative|NoOrphan|Terminal|ValueLaw)_" lattice/test lattice/golden
```
Expected from the first: only the `templates.ts` literals that Step 4 folds at the boundary (they are meant to survive in source). Expected from the second: **no output** — any hit is a test still pinning a pre-fold name.

Note `'SingleActive_Biller'` legitimately remains in `templates.test.ts` as an **absence** assertion (`9bc1ed5`'s guard: `expect(...).not.toContain('SingleActive_Biller')`). Leave it — it pins that the name is never produced.

- [ ] **Step 7: Commit**

```bash
git add lattice/src/engine/templates.ts lattice/test/engine/templates.test.ts
git commit -m "fix(engine): camelCase template invariant names, disambiguate uniquePer seeds

Every spec this tool emitted warned on reload: template names violated the
project's own P8 convention. 18 of the 30 renames in the one real committed
session are a human fixing this by hand.

uniquePer also collided: the name keyed off the ref FIELD only, so the
BillPayments model produced three distinct seeds all named UniquePer_biller
(Bill, SettlementBatch, Fee). The owner now disambiguates.

Ids are unchanged — they are ledger provenance keys."
```

---

### Task 3: `@unsigned` + the `init`-only sign diagnostic

**Why:** the right default differs by layer — `Bill`'s amounts are non-negative, the ledger's balances are not — so no static rule is right everywhere. The engine stops guessing. **The gate is `init`-only**: `loadLatText` calls `validateModel` (`fromLangium.ts:348`), so the check must NOT live inside `validateModel`, or it would fire on every hand-written `.lat` and all ~33 doc examples.

`@unsigned` is inert to the language by design — it changes no rule, and exists solely so `init` can distinguish "decided: non-negative" from "never considered".

**Files:**
- Modify: `lattice/src/ast/validate.ts`
- Modify: `lattice/src/cli.ts:414`
- Create: `lattice/test/ast/validate-sign.test.ts`
- Modify: fixture models reaching `init` (see Step 6)

**Interfaces:**
- Produces: `undecidedMoneySigns(m: DomainModel): Diagnostic[]` exported from `../ast/validate.js`. Returns one diagnostic per owner (not per field), code `money-sign-undecided`, `at` = the owner name. **Not called by `validateModel`.**

- [ ] **Step 1: Write the failing test**

Create `lattice/test/ast/validate-sign.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateModel, undecidedMoneySigns } from '../../src/ast/validate.js';
import type { DomainModel, Field } from '../../src/ast/domain.js';

const model = (fields: Field[]): DomainModel => ({
  context: 'Ledger', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Account',
    fields: [{ name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true }, ...fields] }],
  events: [], services: []
});
const money = (name: string, tags?: string[]): Field =>
  ({ name, type: { kind: 'prim', prim: 'Money' }, ...(tags ? { tags } : {}) });

describe('undecidedMoneySigns', () => {
  it('flags a Money field with no sign decision', () => {
    const d = undecidedMoneySigns(model([money('balance')]));
    expect(d.map(x => x.code)).toEqual(['money-sign-undecided']);
    expect(d[0]!.message).toContain('balance');
    expect(d[0]!.at).toBe('Account');
  });

  it('accepts @signed and @unsigned', () => {
    expect(undecidedMoneySigns(model([money('balance', ['signed']), money('fees', ['unsigned'])]))).toEqual([]);
  });

  it('reports one diagnostic per owner, naming every undecided field', () => {
    const d = undecidedMoneySigns(model([money('balance'), money('fees')]));
    expect(d.length).toBe(1);
    expect(d[0]!.message).toContain('balance');
    expect(d[0]!.message).toContain('fees');
  });

  it('ignores non-Money fields', () => {
    const m = model([{ name: 'seats', type: { kind: 'prim', prim: 'Int' } }]);
    expect(undecidedMoneySigns(m)).toEqual([]);
  });

  it('covers nested entities inside an aggregate', () => {
    const m = model([]);
    m.aggregates[0]!.entities = [{ kind: 'entity', name: 'Posting',
      fields: [{ name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true }, money('amount')] }];
    expect(undecidedMoneySigns(m).map(d => d.at)).toEqual(['Posting']);
  });

  // THE load path must not change: this is the whole reason the check is separate.
  it('validateModel does NOT emit it — the language keeps its default', () => {
    expect(validateModel(model([money('balance')])).map(d => d.code)).not.toContain('money-sign-undecided');
    expect(validateModel(model([money('balance')]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ast/validate-sign.test.ts`
Expected: FAIL — `undecidedMoneySigns is not a function` / import error.

- [ ] **Step 3: Implement `undecidedMoneySigns`**

Append to `lattice/src/ast/validate.ts` (outside `validateModel` — do **not** call it from there):

```ts
/**
 * Money fields whose sign was never decided (spec: Slice A design §2). Deliberately NOT part of
 * validateModel: loadLatText calls that (fromLangium.ts), and the language keeps its
 * Money ⇒ non-negative default for hand-written .lat and every doc example. This gate is for the
 * elicitation path only, where the model is machine-authored and an unconsidered default silently
 * becomes an adopted rule that constrains every witness the solver draws.
 *
 * One diagnostic per owner, naming every undecided field — the caller elicits per cluster, so a
 * per-field list is what it needs to ask one question instead of N.
 */
export function undecidedMoneySigns(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const owners: { name: string; fields: Field[] }[] = [
    ...m.entities, ...m.values,
    ...m.aggregates.flatMap(a => [a as { name: string; fields: Field[] }, ...(a.entities ?? [])]),
  ];
  for (const o of owners) {
    const undecided = o.fields
      .filter(f => f.type.kind === 'prim' && f.type.prim === 'Money'
        && !f.tags?.includes('signed') && !f.tags?.includes('unsigned'))
      .map(f => f.name);
    if (undecided.length)
      out.push({ code: 'money-sign-undecided', at: o.name,
        message: `${o.name}: Money field(s) ${undecided.join(', ')} have no sign decision — tag each @signed (may go negative) or @unsigned (may not). The engine will not guess.` });
  }
  return out;
}
```

Ensure `Field` is imported as a type in `validate.ts` (it may already be).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ast/validate-sign.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Wire it into `init` only**

In `lattice/src/cli.ts`, change the import on line 5:

```ts
import { validateModel, undecidedMoneySigns } from './ast/validate.js';
```

And in `case 'init':` replace line 414's `const diags = validateModel(m as DomainModel);` with:

```ts
        // undecidedMoneySigns is init-only on purpose: loadLatText keeps the language's
        // Money ⇒ non-negative default (see validate.ts). Adding it to validateModel would
        // reject every hand-written .lat and doc example.
        const diags = [...validateModel(m as DomainModel), ...undecidedMoneySigns(m as DomainModel)];
```

- [ ] **Step 6: Migrate every fixture model that reaches `init`**

Find them:
```bash
grep -rln "'Money'" lattice/test lattice/fixtures lattice/golden
```

For each model passed to `init` (or to `matchTemplates`), tag every `Money` field. Use `@unsigned` for billing-style amounts (totals, fees, paid/due) and `@signed` only where the value legitimately goes negative. Example — `lattice/test/fixtures.ts`:

```ts
{ name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total', 'unsigned'] },
```

Tags are a list; `@unsigned` coexists with `@total`/`@balance`. Fixtures used **only** for `loadLatText`/printer round-trip tests do **not** need tagging — the load path is unchanged. If a fixture is used for both, tag it.

- [ ] **Step 7: Verify**

```bash
bash scripts/cleanup-solvers.sh
npx vitest run test/ast/ test/engine/ test/cli.test.ts test/pipeline-from-scratch.test.ts > /tmp/t3.log 2>&1; echo "exit=$?"
grep -E "Tests |FAIL" /tmp/t3.log
```
Expected: `exit=0`. A `money-sign-undecided` failure names the fixture to tag — that is the gate working, not a defect.

Then each golden trace alone:
```bash
for t in golden/trace-a.test.ts golden/trace-b.test.ts golden/trace-c.test.ts test/golden-trace-d.test.ts; do
  npx vitest run "$t" > "/tmp/$(basename $t).log" 2>&1; echo "$t exit=$?"
done
```
Expected: `exit=0` each. `trace-b` asserts a p50 solver latency ≤ 10s — if it fails on latency alone, re-run it on an idle machine before treating it as a regression.

- [ ] **Step 8: Verify the load path really did not change**

```bash
npx vitest run test/docs-blocks.test.ts test/parse/ > /tmp/t3docs.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t3docs.log
```
Expected: `exit=0` with **no fixture changes needed** — this is the proof that the ~33 doc examples are untouched. If a doc block fails, the check leaked into `validateModel`; fix that rather than editing the docs.

- [ ] **Step 9: Commit**

```bash
git add lattice/src/ast/validate.ts lattice/src/cli.ts lattice/test/ast/validate-sign.test.ts lattice/test/fixtures.ts
git commit -m "feat(engine): init refuses to guess a Money field's sign

The right default differs by layer — a Bill's amounts are non-negative, a
ledger account's balance is not — so no static rule is right everywhere. init
now rejects a model whose Money fields carry no explicit decision, listing
them grouped by owner so the caller can elicit per cluster rather than per
field.

Gate is init-only by construction: loadLatText calls validateModel, so
undecidedMoneySigns is deliberately separate. The language keeps its
Money ⇒ non-negative default and every doc example is untouched.

@unsigned is inert to the language on purpose — it exists so init can tell
'decided: non-negative' from 'never considered'."
```

---

### Task 4: `decline --id --reason`

**Why:** §10.2 requires a declined invariant to be recorded, not merely absent. The record already exists (`session.ts:27`); the only writer is `reconcile.ts:107`'s post-hoc `--force-remove` ceremony.

The motivating example (`singleActiveBiller`) is **gone** — `9bc1ed5` fixed that misfire at the trigger, which is the better fix. A live one from the same elicitation: `monotonicPaymentAmountReturned`, adopted from a `@monotonic` tag on `Payment.amountReturned`, asserting the returned total never decreases. That is true *only* if a won dispute can never reverse a bank return — a question nobody answered. If it can, the rule is false, and `monotonic` is **template-adopted only** (`propose`/`regenerate` reject it as `not-elicitable`), so there is no way to argue with it in the loop. The escape today is to delete the `@monotonic` tag: the model then silently stops claiming something true-ish, and the reason it was removed lives nowhere. That is the same deformation, one tag over.

**Refused once a verdict exists:** witnesses were drawn from a space that rule shaped; retracting it later does not un-ask those questions. The late path stays `apply --force-remove`.

**Files:**
- Modify: `lattice/src/engine/session.ts:9`
- Modify: `lattice/src/cli.ts`
- Create: `lattice/test/cli-decline.test.ts`

**Interfaces:**
- Consumes: `loadState`, `saveState`, `appendLedger`, `readLedger` from `./engine/session.js`.
- Produces: CLI `decline --session <dir> --id <candidateId> --reason <text>` → `{ ok: true, declined: <name> }`, or `{ error: 'unknown-candidate' | 'not-adopted' | 'verdicts-exist', … }`.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/cli-decline.test.ts`. Model it on the existing `test/cli.test.ts` (read it first for the `run`/tmpdir helper style and copy that pattern exactly):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { readLedger, loadState } from '../src/engine/session.js';

const MODEL = {
  context: 'D', ticksPerDay: 24, enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{ kind: 'aggregate', name: 'Acct', fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'bal', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] }] }]
};

describe('decline', () => {
  let dir: string, modelPath: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decline-'));
    modelPath = join(dir, 'm.json');
    writeFileSync(modelPath, JSON.stringify(MODEL));
    await main(['init', '--session', dir, '--model', modelPath]);
  });

  it('declines an adopted candidate and records the reason', async () => {
    const r: any = await main(['decline', '--session', dir,
      '--id', 'implied-nonNegativeAcctBal', '--reason', 'balances may go negative']);
    expect(r).toEqual({ ok: true, declined: 'nonNegativeAcctBal' });

    const entry = readLedger(dir).find(e => e.kind === 'declined') as any;
    expect(entry.invariant.name).toBe('nonNegativeAcctBal');
    expect(entry.reason).toBe('balances may go negative');
  });

  it('drops the rule from the adopted set so the solver stops seeing it', async () => {
    await main(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x']);
    const s = loadState(dir);
    expect(s.candidates.find(c => c.inv.id === 'implied-nonNegativeAcctBal')!.status).toBe('declined');
    expect(s.candidates.filter(c => c.status === 'adopted').map(c => c.inv.id))
      .not.toContain('implied-nonNegativeAcctBal');
  });

  it('rejects an unknown id', async () => {
    const r: any = await main(['decline', '--session', dir, '--id', 'nope', '--reason', 'x']);
    expect(r.error).toBe('unknown-candidate');
  });

  it('requires --id and --reason', async () => {
    expect((await main(['decline', '--session', dir, '--reason', 'x']) as any).error).toBe('missing-arg');
    expect((await main(['decline', '--session', dir, '--id', 'x']) as any).error).toBe('missing-arg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli-decline.test.ts`
Expected: FAIL — unknown command `decline`.

- [ ] **Step 3: Add the `'declined'` status**

`lattice/src/engine/session.ts:13` — note `'refuted'` is **not** in this union: `1560ac6` removed it as dead. Do not re-add it.

```ts
export type CandidateStatus = 'active' | 'pruned' | 'merged' | 'adopted' | 'parked' | 'declined';
```

- [ ] **Step 4: Add the `decline` command**

In `lattice/src/cli.ts`, add to the `parseArgs` options object (line ~340): `reason: { type: 'string' }`. (`id` — check whether an `id` option already exists; if not, add `id: { type: 'string' }`.)

Add to the arg-validation switch, beside `case 'structure':`:

```ts
      case 'decline':
        if (!values.id) return { error: 'missing-arg', arg: 'id' };
        if (!values.reason) return { error: 'missing-arg', arg: 'reason' };
        break;
```

Add the command case, beside `case 'structure':` in the main switch:

```ts
      case 'decline': {
        // The early half of §10.2's accept/decline: same ledger record reconcile.ts writes for a
        // hand-removal, reachable at the moment the reviewer notices rather than only after
        // hand-editing spec.lat. Refused once a verdict exists — witnesses were drawn from a space
        // this rule shaped, so retracting it cannot un-ask the questions already answered. The late
        // path stays `apply --force-remove`, which reconciles properly.
        if (readLedger(dir).some(e => e.kind === 'verdict'))
          return { error: 'verdicts-exist',
            hint: 'decline is only legal before the first verdict; hand-edit spec.lat and use `apply --force-remove`' };
        const tracked = s.candidates.find(c => c.inv.id === values.id);
        if (!tracked) return { error: 'unknown-candidate', id: values.id };
        if (tracked.status !== 'adopted') return { error: 'not-adopted', id: values.id, status: tracked.status };
        tracked.status = 'declined';
        appendLedger(dir, { kind: 'declined', at: now(), invariant: tracked.inv, reason: values.reason! });
        return done({ ok: true, declined: tracked.inv.name });
      }
```

Check how `done(...)` is used by neighbouring cases (it saves state) and match that; if `done` is not in scope for this case, call `saveState(dir, s)` before returning.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cli-decline.test.ts`
Expected: PASS (4).

- [ ] **Step 6: Add the verdict-gating test**

Rather than driving a real solver, append a verdict entry directly:

```ts
  it('is refused once a verdict exists', async () => {
    appendLedger(dir, { kind: 'verdict', at: new Date().toISOString(), witnessId: 'w1',
      witness: {} as any, salient: [], judge: 'permit', question: 'q' });
    const r: any = await main(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x']);
    expect(r.error).toBe('verdicts-exist');
  });
```

Add `appendLedger` to the import. Run: `npx vitest run test/cli-decline.test.ts` → PASS (5).

- [ ] **Step 7: Verify nothing else reads `status` exhaustively**

```bash
grep -rn "status === 'adopted'\|status !== 'adopted'\|CandidateStatus" lattice/src
```
Check each hit still behaves correctly now that `'declined'` exists — a declined candidate must be excluded from `adoptedConstraints` (`planner.ts:94` filters `=== 'adopted'`, so it is) and from `emit`'s adopted list (`cli.ts:537`, same filter). Report anything that switches exhaustively on `CandidateStatus` and would now miss a case.

```bash
bash scripts/cleanup-solvers.sh
npx vitest run test/cli-decline.test.ts test/cli.test.ts test/engine/ > /tmp/t4.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t4.log
```
Expected: `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add lattice/src/engine/session.ts lattice/src/cli.ts lattice/test/cli-decline.test.ts
git commit -m "feat(cli): decline --id --reason, the early half of plan.md §10.2

A declined invariant is not an absent one. The ledger record already existed
(session.ts) but its only writer was reconcile.ts's post-hoc --force-remove
ceremony, so rejecting a bad template match meant deforming the model instead
— dropping the @monotonic tag that produced a rule you doubt, which silently
stops the model claiming something true-ish and leaves the reason nowhere.
That matters most for monotonic, which is template-adopted only: propose and
regenerate refuse it, so the elicitation loop can never argue with it.

Refused once a verdict exists — witnesses were drawn from a space the rule
shaped, so a late retraction cannot un-ask the questions already answered.
That path stays apply --force-remove, which reconciles properly."
```

---

### Task 5: Amend `plan.md` §10.2 and document `@unsigned`

**Why:** the slice's governing rule is case-by-case reconciliation with `plan.md` amended, so exactly one source of truth survives. Leaving §10.2 stale would re-create the drift this slice exists to remove.

**Files:**
- Modify: `docs/plan.md` (§10.1 and §10.2, lines ~518-544)
- Modify: `docs/language/tags.md`

- [ ] **Step 1: Amend §10.1's tag list**

Current text lists `@active`, `@terminal`, `@balance`, `@reservation`, `@idempotencyKey`, plus `external`. Replace the tag list with the tags that actually exist and are read by the engine — `@active`, `@terminal`, `@initial`, `@balance`, `@total`, `@monotonic`, `@signed`, `@unsigned` — and mark `@reservation`, `@idempotencyKey` and `external` as **not yet implemented** (they gate templates #4/#5, deferred below). Note that `@balance` means "a part for the conservation rule", not "a money bucket".

- [ ] **Step 2: Amend the §10.2 catalog table**

- **Row 1 (Money conservation):** change the trigger to `≥2 @balance fields + a @total field` and the schema to `conserve <parts> == <total>`. Add a new row for the original time-based rule (`sum(buckets) == initial(sum(buckets))`, trigger `≥2 @balance, no @total`) marked **deferred — requires `initial(...)`, which the closed candidate grammar (§6.1) cannot express**.
- **Row 2 (Non-negative balance):** change the trigger from "a `@balance` field" to "a `Money` field not tagged `@signed`", and note that `init` additionally rejects a `Money` field carrying neither `@signed` nor `@unsigned` — the sign is elicited, because the right default differs between the billing and ledger layers.
- **Rows 4, 5, 6, 10, 12:** mark **deferred**, each naming the missing ingredient (`@idempotencyKey` + `external`; `@reservation`; cross-aggregate invariant paths; reachability encoding; saga/compensation modelling). A deferred template is recorded, not absent.
- **Row 7:** leave the row's trigger and schema **as written** — `9bc1ed5` deleted tpl-7's no-refs arm, so the code now does what the row already said (`@active` on a child collection → the per-parent `unique` seed). This divergence closed itself while the design was being written; do not "fix" the row to describe the old behavior. Add only that it seeds at prior 0.4 rather than adopting.
- **Rows 3, 8, 9, 11:** implemented. Note that 2/3/9 and value laws are derived by `implied.ts` and adopted by `matchTemplates`, not derived twice.

§16 already says SingleActive/DeadlineBound are seeds rather than free adoptions (`988c807`) — leave it alone.

- [ ] **Step 3: Amend §10.2's application-model paragraph**

It currently claims the writer accepts/edits/declines each candidate against a rendered concrete violation. State what is true: matches are **auto-adopted**, and a reviewer declines via `decline --id --reason` before the first verdict (or `apply --force-remove` after). Rendering each match as a concrete reachable violation is **not implemented** — record it as deferred rather than deleting it.

- [ ] **Step 4: Document `@unsigned` in `docs/language/tags.md`**

Add a row to the tag table:

| `@unsigned` | field | Records that this `Money` field's sign was **decided**: it may not go negative. Inert to the language — the non-negative rule already applies by default. It exists so `engine init` can tell a decided field from an unconsidered one; `init` rejects a `Money` field carrying neither `@signed` nor `@unsigned`. |

Update the surrounding prose: "The six tags" becomes seven, and the field/state tag split gains `@unsigned` on the field side. Add a Semantic Rules bullet:

- `@unsigned` is never required by `loadLatText` — a bare `Money` field is legal and non-negative by default. Only `engine init` requires an explicit decision, because a machine-authored model must not inherit a default nobody considered.

Do **not** change `docs/language/derived-invariants.md` — the three families are unchanged on the load path.

- [ ] **Step 5: Verify the doc examples still parse**

```bash
cd lattice && npx vitest run test/docs-blocks.test.ts > /tmp/t5.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t5.log
```
Expected: `exit=0`. If `tags.md`'s example gained an `@unsigned` field, it must still parse.

- [ ] **Step 6: Commit**

```bash
git add docs/plan.md docs/language/tags.md
git commit -m "docs(plan): reconcile §10.2 with the engine, record deferrals as deferred

§10.2 predates the engine. Reality out-learned it in places (parts == @total
conservation caught a missing field during the BillPayments elicitation; the
plan's time-based rule would not have) and drifted badly in others (the
non-negative trigger). Each divergence decided on merit, per the slice design.

The 5 unimplemented templates and the unrendered concrete-violation step are
now recorded as deferred rather than silently absent — a deferred template is
not the same as an absent one, which is §10.2's own principle applied to
itself."
```

---

### Task 6: Teach the skill to elicit the sign per cluster

**Why:** `init` now reports undecided `Money` fields grouped by owner. The skill turns that into ~2 questions instead of 12 tags. The engine never clusters — inference is guessing.

**Files:**
- Modify: `.claude/skills/elicit-spec/SKILL.md` (Phase 0 section)

- [ ] **Step 1: Add the sign-elicitation step to Phase 0**

Add as a sixth numbered step in the "five more structure steps" list (and change "five more structure steps" to "six more structure steps" in the sentence introducing it):

```markdown
6. **Money sign elicitation**: `init` rejects any `Money` field carrying neither `@signed` (may go
   negative) nor `@unsigned` (may not), listing them grouped by owner — the engine will not guess,
   because the honest default differs by layer: a Bill's amounts are non-negative, a ledger
   account's balance is not. Ask per CLUSTER, not per field: one question can cover every money
   field on an aggregate, and one can span several aggregates that share a layer (all three account
   types plus the journal are one question). But say what you are batching and let them refuse the
   batch — NAME the fields the question covers ("this covers `total`, `amountPaid` and `amountDue`
   on `Bill`") and always offer "not all of these — let me split them". Clustering is a convenience
   you offer, never an assumption you make; a wrong cluster silently mis-signs a field the user
   never saw. Record each answer as structure Q&A.
```

- [ ] **Step 2: Update Phase 0b's template-audit paragraph**

The paragraph beginning "When stable: `engine init --model <file>`" says to present auto-adopted invariants for objection but offers no way to act on one. Add, after the "lead with the ones you suspect are wrong" sentence:

```markdown
When one IS wrong, decline it — `engine decline --id <id> --reason <why>` — do not deform the model
to dodge it. Deleting an honest `@monotonic` tag so a rule you doubt cannot fire leaves the model
quietly not-claiming something, and the reason nowhere. A decline is recorded and auditable; a
missing tag is not. This matters most for `monotonic`, which is template-adopted only — `propose`
and `regenerate` refuse it — so the loop can never argue with it. `decline` is only legal before
the first verdict, so this is the moment.
```

- [ ] **Step 3: Replace the stale `SingleActive_Biller` example**

`SKILL.md:97` uses `SingleActive_Biller` to illustrate "never present a template as a bare name" — but `9bc1ed5` deleted the arm that produced it, so the skill now teaches with a name the engine cannot emit, and its worked example ("at most one Biller may be active at any time — a second one is illegal") describes a rule that no longer exists. Swap in a template that does: `conservationBill` — "a bill's `amountPaid` and `amountDue` must add up to its `total`, exactly, at every moment — a bill showing 40 paid and 40 due on a 100 total is illegal". Same lesson (name → forbidden concrete case, in the user's nouns), a rule the engine actually adopts.

- [ ] **Step 4: Verify the skill's claims match the code**

```bash
grep -n "decline\|money-sign-undecided\|@unsigned" .claude/skills/elicit-spec/SKILL.md
cd lattice && grep -n "'decline'" src/cli.ts && grep -n "money-sign-undecided" src/ast/validate.ts
```
Expected: every command and diagnostic the skill names exists. The skill is instructions to a model that cannot verify them at runtime — a stale claim there is a silent failure.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/elicit-spec/SKILL.md
git commit -m "docs(elicit-spec): elicit the Money sign per cluster, decline instead of deforming

init now refuses to guess a Money field's sign. The skill turns that refusal
into ~2 questions instead of 12 tags by asking per cluster — but names the
fields it batches and offers to split them, because a wrong cluster silently
mis-signs a field the user never saw.

Also: when a template match is wrong, decline it. The previous guidance said
to present matches for objection but gave no way to act on one, so the only
move was deforming the model to dodge the match."
```

---

## Final verification

- [ ] **Per-file gate** (there is no green full-suite baseline — see Global Constraints):

```bash
cd lattice && bash scripts/cleanup-solvers.sh
npx vitest run test/ast/ test/engine/ test/parse/ test/cli.test.ts test/cli-decline.test.ts test/docs-blocks.test.ts > /tmp/fast.log 2>&1; echo "fast exit=$?"; grep -E "Tests |FAIL" /tmp/fast.log
```
Expected: `exit=0`.

- [ ] **Real-solver files, one at a time** (each after `cleanup-solvers.sh`):

```bash
for t in golden/trace-a.test.ts golden/trace-b.test.ts golden/trace-c.test.ts \
         test/golden-trace-d.test.ts test/pipeline-from-scratch.test.ts \
         test/cli-strengthen.test.ts test/cli-strengthen.integration.test.ts \
         test/cli-classify.integration.test.ts test/engine/classify.integration.test.ts; do
  bash scripts/cleanup-solvers.sh >/dev/null 2>&1
  npx vitest run "$t" > "/tmp/$(basename $t).log" 2>&1
  echo "$t exit=$?"
done
```
Expected: `exit=0` each. For any failure: re-run that file alone on an idle machine, then argue causation from whether this slice's changes can reach it. `trace-b` (p50 latency ≤ 10s), `cli-classify.integration` (81s/120s timeout), `cli-strengthen.integration` (~269s of real quint), and `roundtrip` (200 unseeded fast-check runs) are all known load-sensitive and are **not** regressions when they pass in isolation.

- [ ] **Prove the headline claim end-to-end** — an emitted spec reloads clean:

```bash
cd lattice && cat > /tmp/sign-check.json <<'EOF'
{"context":"Check","enums":[],"values":[],"entities":[],"events":[],"services":[],
 "aggregates":[{"kind":"aggregate","name":"Account","fields":[
   {"name":"accountId","type":{"kind":"prim","prim":"Id"},"key":true},
   {"name":"balance","type":{"kind":"prim","prim":"Money"},"tags":["signed"]},
   {"name":"lifetimeFees","type":{"kind":"prim","prim":"Money"},"tags":["unsigned"]}]}]}
EOF
rm -rf /tmp/sc-sess /tmp/sc-out
npx tsx src/cli.ts init --session /tmp/sc-sess --model /tmp/sign-check.json
npx tsx src/cli.ts emit --session /tmp/sc-sess --out /tmp/sc-out >/dev/null
cat /tmp/sc-out/spec.lat
```
Expected: no `invariant` block at all — `balance` is `@signed` so no rule fires, and `lifetimeFees`'s rule is implied and therefore never printed (spec §3.4). Before this slice, an untagged `Money @signed` field emitted `invariant NonNegative_Account_balance { balance >= 0 }` directly beneath the tag it contradicted.

- [ ] **Confirm the init gate refuses an undecided model:**

```bash
cd lattice && python3 - <<'EOF'
import json
m = json.load(open('/tmp/sign-check.json'))
for f in m['aggregates'][0]['fields']:
    f.pop('tags', None)
json.dump(m, open('/tmp/sign-undecided.json','w'))
EOF
rm -rf /tmp/sc-sess2
npx tsx src/cli.ts init --session /tmp/sc-sess2 --model /tmp/sign-undecided.json
rm -rf /tmp/sc-sess /tmp/sc-sess2 /tmp/sc-out /tmp/sign-check.json /tmp/sign-undecided.json
```
Expected: `{"error":"ill-formed-model","diagnostics":[{"code":"money-sign-undecided","at":"Account","message":"Account: Money field(s) balance, lifetimeFees have no sign decision — …"}]}`

- [ ] **Merge to `main`** (it is checked out at `/Users/taras/projects/spec-core`; the branch has been fast-forwarding cleanly):

```bash
cd /Users/taras/projects/spec-core && git status --short && git merge --ff-only claude/bill-payment-ledger-spec-edffdc && git log --oneline -8
```
Confirm `main` is clean before merging. Do not push unless asked.
