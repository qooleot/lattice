# Nested Types Expressiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an aggregate-owned child carry `ref` and value-typed fields, and make every money rule
(non-negativity, conservation, sums) see through a value type and into a child — so a double-entry
ledger can keep both the balance law and referential integrity, with multi-currency money.

**Architecture:** Two axes. (1) *Children are owners*: nine modules define a top-level-only owner
list; the ones that should see children gain them, and `candidateToQuint` learns to quantify over an
owner's child map instead of a top-level var. (2) *See through values*: money-rule derivation expands
a field into its solver-visible numeric paths, so `total : Amount` yields `total.amount` wherever
`total : Money` yields `total`. The `.lat` grammar, parser, and printer are already nesting-blind and
need **no changes**.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Langium (grammar — untouched),
Alloy + Quint/Apalache as solver backends.

**Design doc:** `docs/superpowers/specs/2026-07-16-nested-types-expressiveness-design.md`

## Global Constraints

- **Run tests with `npm test`** (vitest) and types with `npm run typecheck`, from `lattice/`.
- **Imports use `.js` specifiers** even for `.ts` sources (ESM/NodeNext) — `from '../ast/domain.js'`.
- **`OWNED_BOUND = 3`** (`src/engine/owned.ts:4`) — the fixed cap on live children per collection.
- **`SOLVER_INT_PRIMS = ['Int', 'Money', 'Date', 'Duration']`** (`src/ast/grammar.ts:158`) — the
  solver-representable prims. `Text`/`Id` are dropped from both encodings.
- **The docs are executable.** `test/docs-blocks.test.ts` parses every ` ```lat ` block under
  `docs/language/` through `loadLatText` → `validateModel` and asserts `ok`. Doc examples and code
  must land in the same commit.
- **`validateModel` stays free of money-sign diagnostics.** `undecidedMoneySigns` is a separate,
  elicitation-only gate; `test/ast/validate-sign.test.ts` pins this in both directions. Never move a
  sign check onto the load path.
- **The candidate grammar (`src/ast/invariant.ts`) is closed.** Only Task 12 changes it, and that is
  a deliberate versioned act with a back-compat normalizer.
- **Emitter API shapes** (verified — do not guess these):
  - `astToAlloy(m, q): string` where `q: AlloyQuery = { kind: 'distinguish' | 'probe-forbid' |
    'probe-permit'; hi: Candidate; hj?; exclusions: SalientFact[][]; adopted?; scope: number;
    varyUnreferenced? }`. **There is no `'invariant-check'` kind, and `scope` is required.**
  - `astToQuint(m, q): QuintEmission` where `QuintEmission = { source: string; invariantName: string;
    varTypes: Record<string, string> }` — **the emitted text is `.source`, not the return value** —
    and `q: QuintQuery` requires `maxSteps: number` (not `scope`).
  - `astToCode(model, invariants)` takes **two** arguments.
  - `loadLatText(text): { ok: true; model; invariants; warnings } | { ok: false; diagnostics }`.
  - `candidateToPred` (alloy) is **module-private**; assert through `astToAlloy` instead of
    exporting it.
- **Never widen `owners` blindly.** Each of the nine sites is changed only where the design says so.
  `pathToQuint`/`initValue` must NOT resolve a child as a *ref hop target* — Task 1 is what makes
  that safe.

---

### Task 1: Reject any `ref` whose target is a nested child

Closes a latent bug that exists today: a top-level aggregate may `ref` a nested child, validate
clean, and emit Quint drawing from an undeclared `<CHILD>_IDS` pool. Children are inlined records
with no id pool (`quint.ts:102` draws `oneOf(<TARGET>_IDS)`; `quint.ts:407` declares that pool only
per top-level owner). This must land **first**: it is what makes Task 6's `ownerDef` change safe.

**The trap:** an owned collection *is* `List<ref Child>` (`domain.ts:58-61`), and `checkType`
recurses into `list.of` (`validate.ts:170`). A naive rule would reject the owned-collection
declaration itself. The rule must permit `List<ref Child>` **on the child's own owning aggregate**
and reject every other ref to a child.

**Files:**
- Modify: `lattice/src/ast/validate.ts` (add helper + call from `checkFields`, near `:158-186`)
- Test: `lattice/test/ast/validate-nested.test.ts`

**Interfaces:**
- Produces: diagnostic code `ref-target-nested-child`. No exported symbols change.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('nested entities', …)` block in
`lattice/test/ast/validate-nested.test.ts`:

```ts
  it('accepts the owned-collection declaration itself (List<ref Child> on the owning aggregate)', () => {
    // Guards the trap: an owned collection IS a ref to a child, and must stay legal.
    expect(validateModel(inv(goodChild)).map(d => d.code)).not.toContain('ref-target-nested-child');
  });

  it('rejects a top-level aggregate ref-ing a nested child (ref-target-nested-child)', () => {
    // Latent bug at 2db1539: this validated clean and emitted Quint drawing from an
    // undeclared INVOICELINE_IDS pool. Children are inlined records with no id pool.
    const m = inv(goodChild);
    m.aggregates.push({ kind: 'aggregate', name: 'Audit', fields: [
      { name: 'auditId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'line', type: { kind: 'ref', target: 'InvoiceLine' } }] });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('rejects a child ref-ing a sibling child (child->child)', () => {
    const m = inv([...goodChild, { name: 'att', type: { kind: 'ref', target: 'Attachment' } }]);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Attachment',
      fields: [{ name: 'attId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('rejects an aggregate ref-ing its OWN child outside a List', () => {
    const m = inv(goodChild);
    m.aggregates[0]!.fields.push({ name: 'first', type: { kind: 'ref', target: 'InvoiceLine' } });
    expect(validateModel(m).map(d => d.code)).toContain('ref-target-nested-child');
  });

  it('still accepts a ref to a top-level entity', () => {
    const m = inv(goodChild);
    m.entities.push({ kind: 'entity', name: 'Customer',
      fields: [{ name: 'cid', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'customer', type: { kind: 'ref', target: 'Customer' } });
    expect(validateModel(m).map(d => d.code)).not.toContain('ref-target-nested-child');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/ast/validate-nested.test.ts`
Expected: FAIL — the three "rejects" tests fail (`ref-target-nested-child` never appears; note the
child→child and own-child cases currently report `nested-entity-flat` / nothing instead). The two
"accepts" tests pass vacuously.

- [ ] **Step 3: Implement**

In `lattice/src/ast/validate.ts`, after the `const values = new Set(...)` line (~`:155`), add:

```ts
  /**
   * child entity name -> the aggregate that owns it. A nested child is inlined into its owner in
   * BOTH solver encodings (quint.ts's `f: int -> {…}` record; alloy.ts's child sig with `owner: one
   * <Parent>`), so it has no id and no `<TARGET>_IDS` pool to draw a ref from (quint.ts:407 declares
   * pools per TOP-LEVEL owner only). A ref naming one therefore emits invalid Quint — this rule is
   * the encoding being honest, and it matches the DDD notion the child encodes: an owned child has
   * no identity outside its owner, so nothing may reference it.
   */
  const childOwner = new Map<string, string>();
  for (const a of m.aggregates) for (const e of a.entities ?? []) childOwner.set(e.name, a.name);

  /**
   * `ownerAgg` is the aggregate whose body this field is declared in, or null (top-level entity,
   * event, value). The ONE legal ref-to-a-child is the owned-collection declaration itself —
   * `List<ref Child>` on the child's own owning aggregate (design §3.2, ownedCollectionChild) —
   * which checkType would otherwise walk into via its `list` recursion.
   */
  const checkRefTarget = (t: TypeRef, at: string, ownerAgg: string | null) => {
    if (t.kind === 'list') {
      // The ONE legal ref-to-a-child is the owned-collection declaration: `List<ref Child>` declared
      // DIRECTLY on the child's own owning aggregate (design §3.2 — ownedCollectionChild only ever
      // inspects an aggregate's OWN fields, and requires `of.kind === 'ref'`, so neither a deeper
      // list nor a child's own list is one). Recursing with ownerAgg: null is what keeps the
      // exception from re-firing at depth — `List<List<ref Child>>` is not an owned collection.
      if (ownerAgg !== null && t.of.kind === 'ref' && childOwner.get(t.of.target) === ownerAgg) return;
      checkRefTarget(t.of, at, null);
      return;
    }
    if (t.kind !== 'ref') return;
    const target = t.target;   // capture before isQualifiedRef narrows t: its predicate type equals
                               // this branch's narrowed type exactly, so the false branch is `never`
    if (isQualifiedRef(t)) return;
    const owner = childOwner.get(target);
    if (owner)
      out.push({ code: 'ref-target-nested-child', at,
        message: `ref target ${t.target} is an entity owned by aggregate ${owner} — an owned child has no identity to reference (both solver encodings inline it into its owner, with no id pool to draw from). Reference ${owner} instead, or promote ${t.target} to a top-level entity.` });
  };
```

`isQualifiedRef` is already imported at `validate.ts:3`? **Check** — if the import line reads
`import { ownedCollectionChild } from './domain.js';`, extend it to
`import { isQualifiedRef, ownedCollectionChild } from './domain.js';`.

Then thread `ownerAgg` through `checkFields`. Change its signature and body:

```ts
  const checkFields = (fs: Field[], owner: string, needKey: boolean, ownerAgg: string | null = null) => {
    fs.forEach(f => { checkType(f.type, `${owner}.${f.name}`); checkReservedField(f, `${owner}.${f.name}`);
      checkRefTarget(f.type, `${owner}.${f.name}`, ownerAgg);
```

(leave the rest of `checkFields` untouched), and update its call sites:

- `m.entities.forEach(e => checkFields(e.fields, e.name, true));` — unchanged (`ownerAgg` defaults null).
- `checkFields(a.fields, a.name, true);` → `checkFields(a.fields, a.name, true, a.name);`
- `checkFields(child.fields, `${a.name}.${child.name}`, true);` →
  `checkFields(child.fields, `${a.name}.${child.name}`, true, null);` — **`null`, not `a.name`.** The
  owned-collection exception is a property of a *position* (declared directly on the owning
  aggregate), not of a type: `ownedCollectionChild` only ever inspects an aggregate's OWN fields, so
  a child's field position is never eligible for it. Passing `a.name` here would let a child's
  `List<ref Sibling>` claim the exception — masked today only by `nested-entity-flat`, which Task 2
  relaxes.

Also cover events and values, which do not go through `checkFields`:

- in the events loop (`validate.ts:211`), add `checkRefTarget(f.type, `${e.name}.${f.name}`, null);`
- in the `m.values.forEach` loop (`validate.ts:189`), add `checkRefTarget(f.type, `${v.name}.${f.name}`, null);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/ast/validate-nested.test.ts && npm test && npm run typecheck`
Expected: PASS. Full suite green — if `specs/` or a doc block trips the new rule, that is a **real
find**: report it rather than weakening the rule.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/validate.ts lattice/test/ast/validate-nested.test.ts
git commit -m "fix(ast): reject any ref targeting an aggregate-owned child

A nested child is inlined into its owner in both encodings and has no
<CHILD>_IDS pool (quint.ts:407 declares pools per top-level owner only), so a
ref naming one emitted Quint drawing from an undeclared pool. Verified this
validated clean at 2db1539.

The owned-collection declaration itself (List<ref Child> on the owning
aggregate) stays legal — checkType recurses into list.of, so the rule has to
distinguish it explicitly."
```

---

### Task 2: Nested children carry `ref` and value-typed fields

Narrows `nested-entity-flat` from `ref | list | value` to **`list` only**. Structure only — the
emitters follow in Tasks 3–4. The grammar, `fromLangium`'s `mapType`, and `code.ts`'s `typeStr` are
already nesting-blind, so **no surface work**.

**Files:**
- Modify: `lattice/src/ast/validate.ts:219-221`
- Test: `lattice/test/ast/validate-nested.test.ts`

**Interfaces:**
- Consumes: Task 1's `ref-target-nested-child` (a child's ref must target a top-level owner).
- Produces: `nested-entity-flat` now fires only on a `list`-typed child field.

- [ ] **Step 1: Write the failing tests**

**Replace** these two existing tests in `lattice/test/ast/validate-nested.test.ts` (they pin the old
behaviour and are now wrong):

```ts
  it('rejects ref/list fields inside children (nested-entity-flat)', () => { … });
  it('rejects a value-typed field inside a nested child (nested-entity-flat, design §5.2)', () => { … });
```

with:

```ts
  it('accepts a ref to a top-level entity inside a child', () => {
    // The ledger case: Posting is OWNED by its transaction and POINTS AT a chart-of-accounts entry.
    const m = inv([...goodChild, { name: 'account', type: { kind: 'ref', target: 'Account' } }]);
    m.entities.push({ kind: 'entity', name: 'Account',
      fields: [{ name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m)).toEqual([]);
  });

  it('accepts a value-typed field inside a child', () => {
    const m = inv([...goodChild, { name: 'period', type: { kind: 'value', value: 'Period' } }]);
    m.values.push({ kind: 'value', name: 'Period', fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }] });
    expect(validateModel(m)).toEqual([]);
  });

  it('still rejects a List field inside a child (nested-entity-flat)', () => {
    // Out of this slice: quint has no list encoding (fieldQType returns null), so two-level
    // collections need nested bounded maps + an OWNED_BOUND^2 blowup + a bitwidth revisit.
    const m = inv([...goodChild, { name: 'taxes', type: { kind: 'list', of: { kind: 'ref', target: 'Account' } } }]);
    m.entities.push({ kind: 'entity', name: 'Account',
      fields: [{ name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('nested-entity-flat');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/ast/validate-nested.test.ts`
Expected: FAIL — the two "accepts" tests report `nested-entity-flat`. The List test passes already.

- [ ] **Step 3: Implement**

In `lattice/src/ast/validate.ts`, replace the check at `:220-221`:

```ts
        if (f.type.kind === 'ref' || f.type.kind === 'list' || f.type.kind === 'value')
          out.push({ code: 'nested-entity-flat', message: `nested entity ${a.name}.${child.name}.${f.name}: children carry prim/enum fields only in v1 (design §5.2)`, at: `${a.name}.${child.name}.${f.name}` });
```

with:

```ts
        // `ref` and value-typed child fields are structurally legal as of this slice — List is the
        // one remaining rejection below. A child's ref must name a TOP-LEVEL owner —
        // checkRefTarget's ref-target-nested-child (already in this file) enforces that.
        //
        // Honest gap as of this commit: alloy.ts's emitChildSigs does not yet emit a child's ref or
        // value fields — it silently drops them (its loop only branches on enum and int prim). The
        // arms mirroring emitOwnerSig land in Task 3. Quint needs no change here: fieldQType and
        // initValue are already generic over ref/value and recurse into an owned child exactly as
        // they do for a top-level owner.
        //
        // `List` stays rejected: quint has no list encoding at all (fieldQType returns null), so a
        // collection inside a collection needs nested bounded maps, an OWNED_BOUND^2 state blowup,
        // and a revisit of the bitwidth policy that already rises to 7 for a single-level sum
        // (alloy.ts:385-391). That is its own slice — see the design doc's "Not in this slice".
        if (f.type.kind === 'list')
          out.push({ code: 'nested-entity-flat', message: `nested entity ${a.name}.${child.name}.${f.name}: a child cannot own a collection — List inside an aggregate-owned child is not yet encodable (quint has no list encoding; see design B2 "Not in this slice")`, at: `${a.name}.${child.name}.${f.name}` });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/ast/validate-nested.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/validate.ts lattice/test/ast/validate-nested.test.ts
git commit -m "feat(ast): allow ref and value-typed fields on an aggregate-owned child

nested-entity-flat narrows to List-only. Evidence: a double-entry ledger's
Posting is inherently owned by its JournalTransaction AND inherently points at
a LedgerAccount; the old rule forced giving up one, losing either refsResolve
or sumOverCollection's balance law.

Structure only — emitters follow. Grammar/parser/printer already handled both."
```

---

### Task 3: Alloy emits a child's `ref` and value fields

`emitChildSigs` (`alloy.ts:75-90`) silently drops both kinds today. Add the two arms mirroring
`emitOwnerSig` (`alloy.ts:40-58`), which already flattens `period : Period` to `period_start,
period_end`. Alloy emits sigs for top-level entities (`alloy.ts:360`), so a child ref's target always
has a sig.

**Files:**
- Modify: `lattice/src/emit/alloy.ts:75-90`
- Modify: `lattice/src/ast/validate.ts` — **delete the now-false "Honest gap" paragraph** (see below)
- Test: `lattice/test/emit/alloy.test.ts`

**Interfaces:**
- Consumes: Task 2 (child ref/value fields validate).
- Produces: child sigs containing `<ref>: one <Target>` and `<field>_<sub>: one Int|<Enum>`.

**Delete the stale comment this task falsifies.** Task 2 left a deliberately honest paragraph in
`validate.ts`'s child-field loop stating that `emitChildSigs` "does not yet emit a child's ref or
value fields — it silently drops them ... the arms mirroring emitOwnerSig land in the next commit of
this slice." **This task is that commit**, so the paragraph becomes false the moment it lands. Delete
it, keeping the surrounding `List`-rejection rationale and the `ref-target-nested-child` sentence,
both of which stay true. This is called out explicitly because nothing mechanical links `alloy.ts` to
`validate.ts` — a comment in one file describing the other's internals drifts unless a checklist
catches it, which is exactly how the false comment shipped in the first place.

- [ ] **Step 1: Write the failing test**

Append to `lattice/test/emit/alloy.test.ts` (match the file's existing import/helper style; it
imports `astToAlloy` from `../../src/emit/alloy.js`):

```ts
describe('child sigs carry refs and value fields (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [{ name: 'Currency', values: ['usd', 'eur'] }],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'currency', type: { kind: 'enum', enum: 'Currency' } }] }],
    entities: [{ kind: 'entity', name: 'Account', fields: [
      { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'code', type: { kind: 'prim', prim: 'Int' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'account', type: { kind: 'ref', target: 'Account' } },
        { name: 'amount', type: { kind: 'value', value: 'Amount' } }] }] }],
    events: [], services: [],
  };
  const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
    hi: { kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] } });

  it('emits a child ref as `one <Target>`', () => {
    expect(src).toMatch(/sig Posting \{[^}]*account: one Account/s);
  });
  it('flattens a child value field to underscore-joined relations', () => {
    expect(src).toMatch(/sig Posting \{[^}]*amount_amount: one Int/s);
    expect(src).toMatch(/sig Posting \{[^}]*amount_currency: one Currency/s);
  });
  it('keeps the by-construction owner relation', () => {
    expect(src).toMatch(/sig Posting \{\s*owner: one Txn/s);
  });
  it('declares a sig for the ref target', () => {
    expect(src).toMatch(/sig Account \{/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/emit/alloy.test.ts -t 'child sigs carry'`
Expected: FAIL — `account`, `amount_amount`, `amount_currency` are absent from `sig Posting`.

- [ ] **Step 3: Implement**

In `lattice/src/emit/alloy.ts`, replace the child-field loop body inside `emitChildSigs` (`:81-86`):

```ts
    for (const cf of child.fields) {
      if (cf.key) continue;
      if (cf.type.kind === 'enum') fields.push(`  ${cf.name}: one ${cf.type.enum}`);
      else if (cf.type.kind === 'prim' && isIntPrim(cf.type.prim)) fields.push(`  ${cf.name}: one Int`);
      // Text/Id dropped — atom identity suffices, same convention as emitOwnerSig
    }
```

with:

```ts
    for (const cf of child.fields) {
      if (cf.key) continue;
      // Mirrors emitOwnerSig (:40-58) arm for arm. `one` throughout, never `lone`: validateModel's
      // optional-owned-child rejects an optional child field, so there is no multiplicity to vary.
      if (cf.type.kind === 'ref') {
        if (isQualifiedRef(cf.type)) continue;   // cross-context — the target sig is never declared here
        fields.push(`  ${cf.name}: one ${cf.type.target}`);
      }
      else if (cf.type.kind === 'enum') fields.push(`  ${cf.name}: one ${cf.type.enum}`);
      else if (cf.type.kind === 'prim' && isIntPrim(cf.type.prim)) fields.push(`  ${cf.name}: one Int`);
      else if (cf.type.kind === 'value') fields.push(...valueSubRelations(m, cf, 'one'));
      // Text/Id dropped — atom identity suffices, same convention as emitOwnerSig
    }
```

`emitChildSigs` currently takes only `(a: AggregateDef)`. Change its signature to
`function emitChildSigs(m: DomainModel, a: AggregateDef): string[]` and update its call site at
`alloy.ts:361` to `emitChildSigs(m, a)`.

**Also widen `ownerByName` (`alloy.ts:6`) to include nested children** — it is a *tenth* top-level-only
owner list the design's "nine modules" missed, and `alloyFieldPath` resolves through it. Task 12
renders a child's sum field with `alloyFieldPath(m, c.child, 'l', …)`; without this it silently
fails to resolve `Posting`, falls back to a dotted join, and emits `l.amount.amount` — a relation no
sig declares. Same safety argument as `ownerDef` in Task 5 (`ref-target-nested-child` means a child
is never a ref hop):

```ts
const ownerByName = (m: DomainModel, name: string): AggregateDef | EntityDef | undefined =>
  [...m.entities, ...m.aggregates, ...m.aggregates.flatMap(a => a.entities ?? [])].find(o => o.name === name);
```

`Field`, `isQualifiedRef`, `AggregateDef`, and `EntityDef` are **already imported** in `alloy.ts:1-2`
— no import changes needed.

Add the shared helper above `emitOwnerSig`, and **use it from `emitOwnerSig` too** so the two cannot
drift (replace `emitOwnerSig`'s inline value branch at `:47-58` with
`else if (f.type.kind === 'value') fields.push(...valueSubRelations(m, f, mult));`):

```ts
/**
 * Value fields (design §3.5) flatten to underscore-joined sig relations — `period: Period{start,end}`
 * becomes `period_start: one Int, period_end: one Int` — never a nested sig, because values have no
 * identity for Alloy to quantify over. Shared by emitOwnerSig and emitChildSigs so the owner and
 * child encodings cannot drift; `mult` is the owner's multiplicity (`one`/`lone`), and sub-fields
 * always take `one` (a value's sub-field cannot be optional — validate.ts's optional-value).
 */
function valueSubRelations(m: DomainModel, f: Field, mult: string): string[] {
  if (f.type.kind !== 'value') return [];
  const vdef = m.values.find(v => v.name === f.type.value);
  const out: string[] = [];
  for (const sub of vdef?.fields ?? []) {
    if (sub.type.kind === 'enum') out.push(`  ${f.name}_${sub.name}: ${mult} ${sub.type.enum}`);
    else if (sub.type.kind === 'prim' && isIntPrim(sub.type.prim)) out.push(`  ${f.name}_${sub.name}: ${mult} Int`);
    // Text/Id sub-fields dropped, same convention as top-level fields
  }
  return out;
}
```

Ensure `Field` is imported in `alloy.ts` from `../ast/domain.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/emit/alloy.test.ts && npm test && npm run typecheck`
Expected: PASS. `emitOwnerSig`'s existing value tests must stay green — that is the point of sharing
the helper.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/emit/alloy.ts lattice/test/emit/alloy.test.ts
git commit -m "feat(emit): Alloy child sigs carry ref and value fields

emitChildSigs silently dropped both. Adds the two arms mirroring emitOwnerSig,
and extracts valueSubRelations so the owner and child value encodings cannot
drift. Alloy already emits sigs for top-level entities (:360), so a child ref's
target always has a sig to point at."
```

---

### Task 4: Witness normalization covers a child's value keys

`witness.ts:4`'s `owners` omits nested children, so `remapEntity`'s `e.type` lookup fails for a child
and its flattened `amount_amount` key passes through un-normalized. The rest of the engine
(`evaluate.ts`'s `resolveValue`, `salient.ts`, validated `Candidate` paths) speaks dotted paths.

**Files:**
- Modify: `lattice/src/engine/witness.ts:4`
- Test: `lattice/test/engine/witness.test.ts`

**Interfaces:**
- Produces: a child `CaseEntity`'s `amount_amount` key normalizes to `amount.amount`.

- [ ] **Step 1: Write the failing test**

Append to `lattice/test/engine/witness.test.ts` (match its existing import style):

```ts
describe('child value keys normalize (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], services: [], events: [], entities: [],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'value', value: 'Amount' } }] }] }],
  };

  it('renames a CHILD entity\'s flattened value key to a dotted path', () => {
    const cs = { entities: [{ type: 'Posting', id: 'p1', fields: { amount_amount: 5, owner: 't1' } }] };
    const out = remapValueKeys(m, cs);
    expect(out.entities[0]!.fields['amount.amount']).toBe(5);
    expect(out.entities[0]!.fields['amount_amount']).toBeUndefined();
  });

  it('renames ONLY the value-prefixed key, leaving the child\'s other keys untouched', () => {
    // Asserts the whole object, not one key: `expect(fields['owner']).toBe('t1')` alone passes even
    // with the widening reverted, because a missed `e.type` lookup returns the entity unchanged —
    // so `owner` survives either way and the test proves nothing.
    const cs = { entities: [{ type: 'Posting', id: 'p1', fields: { amount_amount: 5, owner: 't1' } }] };
    expect(remapValueKeys(m, cs).entities[0]!.fields).toEqual({ 'amount.amount': 5, owner: 't1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/engine/witness.test.ts -t 'child value keys'`
Expected: FAIL — `amount.amount` is `undefined`; `amount_amount` is still `5` (the `owners` lookup
misses `Posting`, so `remapEntity` returns `e` unchanged).

- [ ] **Step 3: Implement**

In `lattice/src/engine/witness.ts`, replace line 4:

```ts
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];
```

with:

```ts
// Nested children included deliberately, unlike the same-named helper elsewhere: a witness names a
// child by its own entity name (`type: 'Posting'`), exactly as evaluate.ts:148 resolves children for
// sumOverCollection, so remapEntity's `e.type` lookup must find it or the child's flattened
// `<field>_<sub>` keys pass through un-normalized while every other entity's are dotted.
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] =>
  [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/engine/witness.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/engine/witness.ts lattice/test/engine/witness.test.ts
git commit -m "fix(engine): normalize a nested child's value keys in witnesses

witness.ts's owners omitted nested children, so remapEntity's e.type lookup
missed a child and left its flattened amount_amount key un-normalized while
every other entity's became dotted."
```

---

### Task 5: `ownerDef` and `pathToQuint` resolve a nested child

Makes a child nameable as a candidate *subject*. Safe **only because of Task 1**: `ownerDef` is also
what `resolveFieldPath` rebinds to on a ref hop (`grammar.ts:40-41`), so admitting children would
otherwise let a path hop *into* a child no encoding can address. With no ref able to target a child,
a child is reachable as a subject but never as a hop.

**Files:**
- Modify: `lattice/src/ast/grammar.ts:7-9` (`ownerDef`)
- Modify: `lattice/src/emit/quint.ts:135-153` (`pathToQuint`'s owner lookup)
- Test: `lattice/test/ast/grammar.test.ts`

**Interfaces:**
- Consumes: Task 1's `ref-target-nested-child`.
- Produces: `ownerDef(m, 'Posting')` returns the child's `EntityDef`; `validateCandidate` accepts
  `aggregate: 'Posting'` instead of reporting `unknown-aggregate`.

- [ ] **Step 1: Write the failing test**

Append to `lattice/test/ast/grammar.test.ts`:

```ts
describe('a nested child is a nameable candidate subject (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], values: [], events: [], services: [],
    entities: [{ kind: 'entity', name: 'Account', fields: [
      { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'account', type: { kind: 'ref', target: 'Account' } },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
  };

  it('accepts a candidate whose aggregate names a child', () => {
    expect(validateCandidate({ kind: 'statePredicate', aggregate: 'Posting',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] },
              right: { kind: 'int', value: 0 } } }, m)).toEqual([]);
  });

  it('resolves a path on a child', () => {
    expect(resolveFieldPath(m, 'Posting', ['amount'])?.name).toBe('amount');
  });

  it('still reports unknown-aggregate for a name that is nothing', () => {
    expect(validateCandidate({ kind: 'refsResolve', aggregate: 'Nope', fields: ['x'] }, m)
      .map(d => d.code)).toContain('unknown-aggregate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/ast/grammar.test.ts -t 'nameable candidate subject'`
Expected: FAIL with `unknown-aggregate` for `Posting` (grammar.ts:150-151).

- [ ] **Step 3: Implement**

In `lattice/src/ast/grammar.ts`, replace `ownerDef` (`:7-9`):

```ts
function ownerDef(m: DomainModel, name: string): Owner | undefined {
  return m.aggregates.find(a => a.name === name) ?? m.entities.find(e => e.name === name);
}
```

with:

```ts
/**
 * Resolve an owner by name, INCLUDING aggregate-owned children (slice B2) — a child is a nameable
 * candidate SUBJECT (`{aggregate: 'Posting'}`), which is how refsResolve and non-negativity reach a
 * child's fields at all.
 *
 * Admitting children here is safe only because validateModel's `ref-target-nested-child` makes a
 * child unreachable as a ref TARGET: resolveFieldPath rebinds `def = ownerDef(m, target)` on a ref
 * hop (:40-41), so if a ref could name a child, a path could hop INTO one — and neither encoding can
 * address a child from outside its owner (quint inlines it with no id pool; alloy's child sig is
 * reachable only via `owner`). A child is a subject, never a hop.
 */
function ownerDef(m: DomainModel, name: string): Owner | undefined {
  return m.aggregates.find(a => a.name === name)
    ?? m.entities.find(e => e.name === name)
    ?? m.aggregates.flatMap(a => a.entities ?? []).find(e => e.name === name);
}
```

In `lattice/src/emit/quint.ts`, `pathToQuint` (`:135-153`) looks its owner up with
`owners(m).find(o => o.name === owner)!` — a non-null assertion that **crashes** for a child. Replace
that single line:

```ts
    const def = owners(m).find(o => o.name === owner)!;
```

with:

```ts
    // Children included: a candidate subject may be a nested child (slice B2), whose fields this
    // walks exactly as an owner's. The ref-hop rebind below can never land on a child —
    // validateModel's ref-target-nested-child makes a child unnameable as a ref target.
    const def = [...owners(m), ...m.aggregates.flatMap(a => a.entities ?? [])].find(o => o.name === owner)!;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/ast/grammar.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/grammar.ts lattice/src/emit/quint.ts lattice/test/ast/grammar.test.ts
git commit -m "feat(ast,emit): resolve a nested child as a nameable candidate subject

ownerDef and pathToQuint's owner lookup now find aggregate-owned children, so a
candidate may name one as its subject. Safe only because ref-target-nested-child
(previous commit) makes a child unreachable as a ref TARGET — ownerDef is also
resolveFieldPath's ref-hop rebind, so a child is a subject, never a hop."
```

---

### Task 6: `candidateToQuint` quantifies over a child map

**The load-bearing task.** `routeCandidate` sends any arithmetic predicate to Quint
(`grammar.ts:351-355`), and `candidateToQuint` binds `varName(c.aggregate)` (`quint.ts:285`) — a var
declared only for top-level owners (`quint.ts:387`). Without this, every child-subject arithmetic
rule emits Quint naming a var that does not exist. This is what makes Task 7's `@unsigned` on a child
mean anything, including the plain-`Money` case that is **inert today**.

**Files:**
- Modify: `lattice/src/emit/quint.ts` (fix `refHopsIn`; add `ownersAndChildren` + `childContext`
  helpers; branch in `candidateToQuint`)
- Test: `lattice/test/emit/quint-emission-valid.test.ts`

**Interfaces:**
- Consumes: Task 5 (`pathToQuint` resolves a child).
- Produces: `childContext(m, name): { owner: AggregateDef; collection: string; child: EntityDef } | null`,
  exported for Task 7's reuse.

**FIRST — fix the second crash site, or everything below throws.** Task 5 fixed `pathToQuint`'s
owner lookup but **`refHopsIn` (`quint.ts:177`) has the identical
`owners(m).find(o => o.name === owner)!` non-null assertion**, and `predToQuint`'s `cmp` case calls
it. Every child-subject `statePredicate` this task emits routes through `predToQuint` → `cmp` →
`refHopsIn(m, path, 'c', 'Posting')` → `undefined!.fields` → **TypeError**. It throws even on a
single-segment path like `amount >= 0`, which is exactly what Task 7 derives — so this is not an
edge case, it is the main path.

Task 5's fix inlined the widened lookup, and this task needs the same list again. Extract it once
rather than writing it a third time:

```ts
/**
 * Owners a candidate SUBJECT or path may name, including aggregate-owned children (slice B2).
 * Distinct from `owners(m)` above, which drives var and `<TARGET>_IDS` pool declaration and must
 * stay top-level-only — a child has neither. Safe because validateModel's `ref-target-nested-child`
 * makes a child unreachable as a ref TARGET, so the ref-hop rebinds in pathToQuint/refHopsIn can
 * never land on one: a child is a subject, never a hop.
 */
const ownersAndChildren = (m: DomainModel): (AggregateDef | EntityDef)[] =>
  [...owners(m), ...m.aggregates.flatMap(a => a.entities ?? [])];
```

Use it in **both** `pathToQuint` (replacing Task 5's inlined form) and `refHopsIn`. Leave
`owners(m)` itself untouched.

- [ ] **Step 1: Write the failing test**

Append to `lattice/test/emit/quint-emission-valid.test.ts`:

```ts
describe('child-subject candidates quantify over the child map (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], values: [], events: [], services: [], entities: [],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
  };
  const nonNeg: Candidate = { kind: 'statePredicate', aggregate: 'Posting',
    body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] },
            right: { kind: 'int', value: 0 } } };

  it('does not bind a var for the child (postings does not exist)', () => {
    const src = candidateToQuint(m, nonNeg, 'P');
    expect(src).not.toMatch(/\bpostings\b/);
  });

  it('walks the owner\'s collection map, gated on the live count', () => {
    const src = candidateToQuint(m, nonNeg, 'P');
    expect(src).toContain('txns.keys().forall');
    expect(src).toContain('legsCount');
    expect(src).toContain('.legs.get(i).amount');
  });

  it('names only vars the module declares', () => {
    // The regression that motivates this task: an undeclared var is invalid Quint.
    const mod = astToQuint(m, { kind: 'probe-permit', exclusions: [], maxSteps: 1, hi: nonNeg }).source;
    const declared = new Set([...mod.matchAll(/var (\w+):/g)].map(x => x[1]!));
    declared.add('now');
    for (const used of new Set([...mod.matchAll(/^\s*val \w+ = (\w+)\.keys\(\)/gm)].map(x => x[1]!)))
      expect([...declared], `val body names undeclared var ${used}`).toContain(used);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/emit/quint-emission-valid.test.ts -t 'child-subject candidates'`
Expected: FAIL — the emission contains `postings.keys().forall`, a var the module never declares.

- [ ] **Step 3: Implement**

In `lattice/src/emit/quint.ts`, add above `candidateToQuint`:

```ts
/**
 * The owning aggregate + collection field for a candidate subject that names an aggregate-owned
 * child, or null for an ordinary top-level subject (slice B2).
 *
 * A child has no top-level Quint var: it is inlined into its owner as `<coll>: int -> {…}` plus a
 * `<coll>Count: int` companion (design §6.1, astToQuint's owned-collection branch). So a
 * child-subject candidate cannot bind `varName(c.aggregate)` — that names a var the module never
 * declares, which is invalid Quint. It must instead quantify over the owner's map.
 */
export function childContext(m: DomainModel, name: string):
    { owner: AggregateDef; collection: string; child: EntityDef } | null {
  for (const a of m.aggregates)
    for (const f of a.fields) {
      const child = ownedCollectionChild(a, f);
      if (child?.name === name) return { owner: a, collection: f.name, child };
    }
  return null;
}

/**
 * Wrap a predicate rendered over a child slot in the owner+slot quantification. Mirrors
 * sumOverCollection's bounded fold (:317): walk every slot up to OWNED_BOUND, ignore slots at or
 * above the live count. `foldl` with `and` rather than `.forall` because `range(...)` is a list and
 * foldl is the shape the rest of this emitter already uses over it.
 *
 * `render` takes the slot accessor as its `self` and INLINES it, exactly as sumOverCollection reads
 * a slot. An earlier draft bound the slot as a block val (`{ val c = o.legs.get(i) … }`) and passed
 * `self='c'` — which emits `c.amount >= 0` and makes the `.legs.get(i).amount` assertion below
 * unsatisfiable. The two contradicted each other; the accessor form is the one that matches both the
 * test and the existing sum encoding.
 */
function overChildren(
  ctx: { owner: AggregateDef; collection: string }, name: string, render: (self: string) => string,
): string {
  const ov = varName(ctx.owner.name);
  const slot = `range(0, ${OWNED_BOUND}).foldl(true, (acc, i) => acc and (i >= o.${ctx.collection}Count or ${render(`o.${ctx.collection}.get(i)`)}))`;
  return `val ${name} = ${ov}.keys().forall(k => { val o = ${ov}.get(k) not(o.exists) or ${slot} })`;
}
```

Import `AggregateDef`, `EntityDef`, and `ownedCollectionChild` in `quint.ts` from `../ast/domain.js`
if not already present.

Then, in `candidateToQuint`, immediately after the `guard` throw and **before**
`const v = varName(c.aggregate);`, insert:

```ts
  const kid = childContext(m, c.aggregate);
  if (kid) {
    // Only the two kinds a child subject is ever derived with today (Task 7's refsResolve is
    // alloy-routed and never reaches here). Anything else is a real gap, not a silent skip.
    if (c.kind === 'statePredicate') {
      return overChildren(kid, name, self => {
        const guard = c.where ? `${predToQuint(m, c.where, self, c.aggregate)} implies ` : '';
        return `(${guard}${predToQuint(m, c.body, self, c.aggregate)})`;
      });
    }
    if (c.kind === 'conservation') {
      return overChildren(kid, name, self =>
        `(${c.parts.map(p => pathToQuint(m, p, self, c.aggregate)).join(' + ')} == ${pathToQuint(m, c.total, self, c.aggregate)})`);
    }
    throw new Error(`candidateToQuint: ${c.kind} on the aggregate-owned child ${c.aggregate} has no child-map encoding — only statePredicate and conservation are derived with a child subject (slice B2)`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/emit/quint-emission-valid.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/emit/quint.ts lattice/test/emit/quint-emission-valid.test.ts
git commit -m "feat(emit): Quint encoding for a child-subject candidate

routeCandidate sends any arithmetic predicate to Quint, and candidateToQuint
bound varName(c.aggregate) — a var declared only for top-level owners. Every
child-subject arithmetic rule therefore named a var the module never declares.

Quantifies over the owner's child map instead, reusing sumOverCollection's
bounded-fold shape. This is what lets a child's @unsigned mean anything."
```

---

### Task 7: Money sign is derived per money path — through values and into children

Fixes finding 2, **both halves**. `undecidedMoneySigns` demands a sign decision for a value's Money
sub-field (`validate.ts:319`) *and* for a child's (`validate.ts:320`); `impliedInvariants`
(`implied.ts:72`) honours neither. Verified: `Money on a CHILD (untagged) → demands: [Posting],
derives: []`. Sign is driven off the **use site**, so one `value Amount` can be non-negative at
`Bill.total` and signed at `LedgerAccount.balance`.

**Files:**
- Modify: `lattice/src/engine/implied.ts:60-86`
- Test: `lattice/test/engine/implied.test.ts`

**Interfaces:**
- Consumes: Task 6's child-map encoding (a derived child rule must emit valid Quint).
- Produces: `moneyPaths(m, o): Path[]` — every non-negative-eligible money path on an owner.

- [ ] **Step 1: Write the failing tests**

Append to `lattice/test/engine/implied.test.ts`:

```ts
describe('money sign is a use-site decision (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };

  it('THE case: one value, two use sites, opposite signs', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [amount], events: [], services: [],
      entities: [{ kind: 'entity', name: 'LedgerAccount', fields: [
        { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'balance', type: { kind: 'value', value: 'Amount' }, tags: ['signed'] }] }],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['unsigned'] }] }],
    };
    const names = impliedInvariants(m).map(i => i.name);
    expect(names).toContain('nonNegativeBillTotalAmount');          // @unsigned use site
    expect(names.filter(n => n.startsWith('nonNegativeLedgerAccount'))).toEqual([]);  // @signed
  });

  it('derives through a value to the Money sub-field only, not the Text one', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [amount], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' } }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativeBillTotalAmount')!.candidate;
    expect(c).toEqual({ kind: 'statePredicate', aggregate: 'Bill',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['total', 'amount'] },
              right: { kind: 'int', value: 0 } } });
  });

  it('derives a CHILD\'s plain Money non-negativity — the half the brief missed, inert today', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
        { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
        entities: [{ kind: 'entity', name: 'Posting', fields: [
          { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativePostingAmount')!.candidate;
    expect(c).toEqual({ kind: 'statePredicate', aggregate: 'Posting',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] },
              right: { kind: 'int', value: 0 } } });
  });

  it('a derived child rule emits valid Quint (the Task 6 regression)', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
        { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
        entities: [{ kind: 'entity', name: 'Posting', fields: [
          { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativePostingAmount')!.candidate;
    expect(candidateToQuint(m, c, 'P')).toContain('legsCount');
    expect(candidateToQuint(m, c, 'P')).not.toMatch(/\bpostings\b/);
  });

  it('@signed still opts a plain Money field out', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'A', fields: [
        { name: 'aId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'bal', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
    };
    expect(impliedInvariants(m).map(i => i.name)).not.toContain('nonNegativeABal');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/engine/implied.test.ts -t 'use-site decision'`
Expected: FAIL — every `nonNegative…` name is absent for value-typed and child fields (`find(...)`
returns `undefined` → TypeError on `.candidate`). The `@signed` test passes already.

- [ ] **Step 3: Implement**

In `lattice/src/engine/implied.ts`, replace `nonNegativeMoneyFields` and `nonNegativeBody`
(`:59-64`):

```ts
/** Money ⇒ non-negative, opted out of by @signed (spec P9). */
const nonNegativeMoneyFields = (o: AggregateDef | EntityDef): Field[] =>
  o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed'));

const nonNegativeBody = (field: string): Predicate =>
  ({ kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [field] }, right: { kind: 'int', value: 0 } });
```

with:

```ts
/**
 * Every non-negative-eligible money path on an owner (spec P9, slice B2). A path is `[f]` for a
 * plain `Money` field and `[f, sub]` for each `Money` sub-field of a value-typed field — so
 * `total : Amount` yields `total.amount` wherever `total : Money` yields `total`.
 *
 * **Sign is read off the USE SITE, never the value declaration.** A `value Amount` is used at
 * `Bill.total` (must be non-negative) and `LedgerAccount.balance` (must go negative); one tag on the
 * declaration could not express both even in principle. Hence only the OWNER field's tags are read
 * below; a sub-field's own tags are not consulted.
 *
 * CAVEAT — a sign tag written INSIDE a value declaration is currently silent, not rejected: no
 * `value-money-sign-inert` diagnostic exists yet (Task 9 adds it), and validateModel passes such a
 * model. `value Amount { amount : Money @signed }` therefore still yields `total.amount` here and is
 * derived non-negative — the tag reads as an opt-out but does nothing. **Task 9 must delete this
 * caveat**, exactly as Task 3 deleted Task 2's.
 */
export function moneyPaths(m: DomainModel, o: AggregateDef | EntityDef): Path[] {
  const out: Path[] = [];
  for (const f of o.fields) {
    if (f.tags?.includes('signed')) continue;             // opted out at the use site
    if (f.type.kind === 'prim' && f.type.prim === 'Money') { out.push([f.name]); continue; }
    if (f.type.kind !== 'value') continue;
    const vdef = m.values.find(v => v.name === (f.type as { kind: 'value'; value: string }).value);
    for (const sub of vdef?.fields ?? [])
      if (sub.type.kind === 'prim' && sub.type.prim === 'Money') out.push([f.name, sub.name]);
  }
  return out;
}

const nonNegativeBody = (path: Path): Predicate =>
  ({ kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path }, right: { kind: 'int', value: 0 } });
```

Import `Path` from `../ast/invariant.js` (it is already imported alongside `Predicate`/`Term`).

Then replace the owner list and the non-negative loop in `impliedInvariants` (`:72-81`):

```ts
  const owners: (AggregateDef | EntityDef)[] = [...m.aggregates, ...m.entities];
  for (const o of owners) {
    for (const f of nonNegativeMoneyFields(o))
      out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`,
        { kind: 'statePredicate', aggregate: o.name,
          body: f.optional
            ? { kind: 'implies', left: { kind: 'present', path: [f.name] }, right: nonNegativeBody(f.name) }
            : nonNegativeBody(f.name) }));
```

with:

```ts
  // Children included (slice B2): validate.ts:320's undecidedMoneySigns already DEMANDS a sign
  // decision for a child's Money field, while this list excluded children — so the tag was demanded
  // and ignored. candidateToQuint's childContext branch gives the derived rule a real encoding.
  const owners: (AggregateDef | EntityDef)[] =
    [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];
  for (const o of owners) {
    for (const p of moneyPaths(m, o)) {
      const f = o.fields.find(x => x.name === p[0])!;
      out.push(mk(`nonNegative${cap(o.name)}${p.map(cap).join('')}`,
        { kind: 'statePredicate', aggregate: o.name,
          // An absent amount is not a negative one. The assertion form would make every optional
          // Money mandatory and defeat optionality, so the guard form is forced, not chosen.
          // Only a top-level field can be optional (optional-value forbids an optional value
          // sub-field; optional-owned-child forbids an optional child field), so the guard reads
          // the head segment.
          body: f.optional
            ? { kind: 'implies', left: { kind: 'present', path: [f.name] }, right: nonNegativeBody(p) }
            : nonNegativeBody(p) }));
    }
```

**Leave the `refsResolve` and `terminal` blocks that follow untouched** — Task 8 handles `refsResolve`
for children, and `terminal` reads `o.kind === 'aggregate' ? o.machine : undefined`, which is
correctly `undefined` for a child.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/engine/implied.test.ts && npm test && npm run typecheck`
Expected: PASS. `test/engine/implied-optional.test.ts` must stay green — the optional guard form is
preserved.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/engine/implied.ts lattice/test/engine/implied.test.ts
git commit -m "fix(engine): derive money non-negativity per path — through values, into children

undecidedMoneySigns DEMANDED a sign decision for a value's Money sub-field and
for a child's; impliedInvariants honoured neither. Verified: Money on a child,
untagged -> demands [Posting], derives []. The tag was demanded and ignored.

Sign is now read off the USE SITE, so one `value Amount` can be @unsigned at
Bill.total and @signed at LedgerAccount.balance — impossible with one tag on
the declaration."
```

---

### Task 8: `refsResolve` fires on a nested child

Recovers "every posting hits a real account". The judge needs no change: `subjects()` filters
`e.type === c.aggregate`, and witness children carry `type = child.name` (exactly how
`evaluate.ts:148` resolves them for `sumOverCollection`). Alloy's vacuous `pred X { }` stays correct
— the child's ref is `one Target`, total by construction.

**Files:**
- Modify: `lattice/src/engine/implied.ts` (the `sameContextRefFields` block)
- Test: `lattice/test/engine/implied.test.ts`, `lattice/test/engine/evaluate.test.ts`

**Interfaces:**
- Consumes: Task 5 (`validateCandidate` accepts a child subject), Task 7 (children in `owners`).
- Produces: `refsResolve` candidates named `refsResolve<Child>`.

- [ ] **Step 1: Write the failing tests**

Append to `lattice/test/engine/implied.test.ts`:

```ts
describe('refsResolve on an owned child (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], values: [], events: [], services: [],
    entities: [{ kind: 'entity', name: 'Account', fields: [
      { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'account', type: { kind: 'ref', target: 'Account' } }] }] }],
  };

  it('derives refsResolve with the CHILD as its own subject', () => {
    expect(impliedInvariants(m).find(i => i.name === 'refsResolvePosting')!.candidate)
      .toEqual({ kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] });
  });
});
```

Append to `lattice/test/engine/evaluate.test.ts`:

```ts
describe('refsResolve judges a child (slice B2)', () => {
  const c: Candidate = { kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] };

  it('forbids a posting pointing at no account', () => {
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: {} },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', account: 'ghost' } }] })).toBe('forbid');
  });

  it('permits a posting pointing at a real account', () => {
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: {} },
      { type: 'Account', id: 'a1', fields: {} },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', account: 'a1' } }] })).toBe('permit');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/engine/implied.test.ts -t 'refsResolve on an owned child'`
Expected: FAIL — `refsResolvePosting` absent (TypeError on `.candidate`). The `evaluate` tests
**already pass**: the judge needed no change, which is exactly the design's claim — run them to
confirm that rather than assume it.

- [ ] **Step 3: Implement**

No code change is needed beyond Task 7's owner-list widening — children are now in `owners`, and the
existing `sameContextRefFields` block derives `refsResolve` per owner. **Verify this by running Step
2 after Task 7.** If `refsResolvePosting` is already derived, this task's implementation is a no-op
and the tests are the deliverable (they pin behaviour that would otherwise regress silently).

If it is absent, the cause is the `!isQualifiedRef(f.type) && !f.optional` filter at `implied.ts:83`
— confirm the child's ref field is unqualified and non-optional, and fix the owner list rather than
special-casing children.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/engine/implied.test.ts test/engine/evaluate.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lattice/test/engine/implied.test.ts lattice/test/engine/evaluate.test.ts
git commit -m "test(engine): pin refsResolve firing on an aggregate-owned child

'Every posting hits a real account' — the rule the old nested-entity-flat rule
forced modellers to give up to keep the balance law. The judge needed no change:
subjects() filters on e.type and witness children already carry their own type,
exactly as evaluate.ts:148 resolves them for sumOverCollection."
```

---

### Task 9: `value-money-sign-inert` + use-site sign sites

Completes finding 2's *demand* side to match Task 7's *derivation* side. `undecidedMoneySigns` stops
asking the value declaration and starts asking each use site; a sign tag inside a value declaration
becomes an error, so there is exactly one place sign is written.

**Files:**
- Modify: `lattice/src/ast/validate.ts:188-208` (value loop), `:316-338` (`undecidedMoneySigns`)
- Test: `lattice/test/ast/validate-sign.test.ts`

**Interfaces:**
- Consumes: Task 7's `moneyPaths` (import it, do not re-derive the expansion).
- Produces: diagnostic `value-money-sign-inert`.

**Delete the caveat this task falsifies.** Task 7 left an honest CAVEAT paragraph in `moneyPaths`'
docstring (`implied.ts`) saying no `value-money-sign-inert` diagnostic exists and a sign tag inside a
value declaration is silently inert. **This task is what makes that false.** Delete the caveat, keep
the use-site rule above it. Called out explicitly because nothing mechanically links `validate.ts` to
`implied.ts` — the same drift that shipped a false comment in Task 2 and was only caught by review.

- [ ] **Step 1: Write the failing tests**

Append to `lattice/test/ast/validate-sign.test.ts`:

```ts
describe('sign is a use-site decision (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  const withValue = (tags?: string[]): DomainModel => ({
    context: 'L', enums: [], values: [amount], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, ...(tags ? { tags } : {}) }] }],
  });

  it('demands a sign at the USE SITE of a value with a Money sub-field', () => {
    const d = undecidedMoneySigns(withValue());
    expect(d.map(x => x.code)).toEqual(['money-sign-undecided']);
    expect(d[0]!.at).toBe('Bill');           // the use site, NOT 'Amount'
    expect(d[0]!.message).toContain('total');
  });

  it('is satisfied by a tag on the use-site field', () => {
    expect(undecidedMoneySigns(withValue(['unsigned']))).toEqual([]);
  });

  it('no longer demands a sign on the value DECLARATION itself', () => {
    expect(undecidedMoneySigns(withValue(['unsigned'])).map(x => x.at)).not.toContain('Amount');
  });

  it('rejects a sign tag inside a value declaration (value-money-sign-inert)', () => {
    const m = withValue(['unsigned']);
    m.values[0]!.fields[0]!.tags = ['signed'];
    const d = validateModel(m);
    expect(d.map(x => x.code)).toContain('value-money-sign-inert');
    expect(d.find(x => x.code === 'value-money-sign-inert')!.at).toBe('Amount.amount');
  });

  it('still keeps money-sign checks OFF the load path', () => {
    expect(validateModel(withValue()).map(d => d.code)).not.toContain('money-sign-undecided');
    expect(validateModel(withValue())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/ast/validate-sign.test.ts -t 'use-site decision'`
Expected: FAIL — the demand is reported `at: 'Amount'` not `'Bill'`; `value-money-sign-inert` never
appears.

- [ ] **Step 3: Implement**

In `lattice/src/ast/validate.ts`, inside the `m.values.forEach` loop (after the `value-flat` check),
add:

```ts
      // Sign is a USE-SITE decision (slice B2): the same `value Amount` is @unsigned at Bill.total
      // and @signed at LedgerAccount.balance, so a tag here could not express both even in
      // principle — and implied.ts's moneyPaths reads the use site, so a tag here would be inert.
      if (f.tags?.includes('signed') || f.tags?.includes('unsigned'))
        out.push({ code: 'value-money-sign-inert', at: `${v.name}.${f.name}`,
          message: `value ${v.name}.${f.name} carries @signed/@unsigned, but money sign is decided where the value is USED, not where it is declared — the same value type may be non-negative at one field and signed at another. Tag the field typed '${v.name}' instead.` });
```

Then replace `undecidedMoneySigns`'s owner list and money-field selection (`:316-338`). Replace:

```ts
  const owners: { name: string; fields: Field[] }[] = [
    ...m.entities, ...m.values,
    ...m.aggregates.flatMap(a => [a as { name: string; fields: Field[] }, ...(a.entities ?? [])]),
  ];
  for (const o of owners) {
    const moneyFields = o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money');
```

with:

```ts
  // Values are NOT owners here (slice B2): sign is decided at each USE SITE. m.values was in this
  // list while implied.ts's owner list excluded it, so init demanded a decision the engine then
  // ignored — the two lists disagreed and this one was wrong.
  const owners: { name: string; fields: Field[] }[] = [
    ...m.entities,
    ...m.aggregates.flatMap(a => [a as { name: string; fields: Field[] }, ...(a.entities ?? [])]),
  ];
  // A sign site is any field that IS money or CARRIES money: a `Money` prim, or a value type with at
  // least one `Money` sub-field. Mirrors implied.ts's moneyPaths, which derives from the same shape.
  const carriesMoney = (f: Field): boolean => {
    if (f.type.kind === 'prim') return f.type.prim === 'Money';
    if (f.type.kind !== 'value') return false;
    const vdef = m.values.find(v => v.name === (f.type as { kind: 'value'; value: string }).value);
    return (vdef?.fields ?? []).some(s => s.type.kind === 'prim' && s.type.prim === 'Money');
  };
  for (const o of owners) {
    const moneyFields = o.fields.filter(carriesMoney);
```

The rest of the function (contradictory/undecided partitioning and messages) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/ast/validate-sign.test.ts && npm test && npm run typecheck`
Expected: PASS. The existing "covers nested entities inside an aggregate" test (`:38-43`) must stay
green — its demand was always correct; Task 7 supplied the missing derivation.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/validate.ts lattice/test/ast/validate-sign.test.ts
git commit -m "fix(ast): money sign is decided at the use site, not the value declaration

undecidedMoneySigns included m.values while implied.ts's owner list excluded it:
init demanded a sign decision the engine then ignored. Drops values as owners,
adds value-typed use sites, and rejects a sign tag inside a value declaration
(value-money-sign-inert) so there is exactly one place sign is written.

A single `value Amount` can now be @unsigned at Bill.total and @signed at
LedgerAccount.balance — impossible with one tag per declaration."
```

---

### Task 10: Values nest inside values

`fieldQType` already recurses (`quint.ts:57`), so Quint needs nothing. Blocked only by `value-flat`,
Alloy's one-level flattening, and `resolveFieldPath`'s one-hop cap. Also fixes a latent bug:
`alloyFieldPath` special-cases a value at segment 0 only, so `plan.period.start` (ref hop then value
hop) emits an undeclared relation.

**Files:**
- Modify: `lattice/src/ast/validate.ts:203-204` (`value-flat`)
- Modify: `lattice/src/ast/grammar.ts:43-49` (`resolveFieldPath`'s value hop)
- Modify: `lattice/src/emit/alloy.ts` (`valueSubRelations` recursion, `alloyFieldPath` rewrite)
- Test: `lattice/test/ast/validate-values.test.ts`, `lattice/test/emit/alloy.test.ts`

**Interfaces:**
- Consumes: Task 3's `valueSubRelations(m, f, mult)`.
- Produces: `value-flat` fires only on `ref`/`list` sub-fields.

- [ ] **Step 1: Write the failing tests**

Append to `lattice/test/ast/validate-values.test.ts`:

```ts
describe('values nest (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount',
    fields: [{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }] };
  const taxed: ValueDef = { kind: 'value', name: 'TaxedAmount', fields: [
    { name: 'net', type: { kind: 'value', value: 'Amount' } },
    { name: 'tax', type: { kind: 'value', value: 'Amount' } }] };

  it('accepts a value-typed sub-field', () => {
    expect(validateModel(model([amount, taxed]))).toEqual([]);
  });

  it('still rejects a ref sub-field (value-flat)', () => {
    const bad: ValueDef = { kind: 'value', name: 'Bad',
      fields: [{ name: 'r', type: { kind: 'ref', target: 'Amount' } }] };
    expect(validateModel(model([amount, bad])).map(d => d.code)).toContain('value-flat');
  });

  it('still rejects a List sub-field (value-flat)', () => {
    const bad: ValueDef = { kind: 'value', name: 'Bad',
      fields: [{ name: 'l', type: { kind: 'list', of: { kind: 'prim', prim: 'Money' } } }] };
    expect(validateModel(model([amount, bad])).map(d => d.code)).toContain('value-flat');
  });

  it('reports unresolved-value for an undeclared nested value', () => {
    const bad: ValueDef = { kind: 'value', name: 'Bad',
      fields: [{ name: 'n', type: { kind: 'value', value: 'Nope' } }] };
    expect(validateModel(model([bad])).map(d => d.code)).toContain('unresolved-value');
  });
});
```

Append to `lattice/test/emit/alloy.test.ts`:

```ts
describe('nested value flattening and path rendering (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], events: [], services: [], entities: [],
    values: [
      { kind: 'value', name: 'Amount', fields: [{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }] },
      { kind: 'value', name: 'TaxedAmount', fields: [
        { name: 'net', type: { kind: 'value', value: 'Amount' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'line', type: { kind: 'value', value: 'TaxedAmount' } }] }],
  };

  it('flattens a nested value recursively', () => {
    const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
      hi: { kind: 'statePredicate', aggregate: 'Bill',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['line', 'net', 'amount'] },
                right: { kind: 'int', value: 0 } } } });
    expect(src).toMatch(/sig Bill \{[^}]*line_net_amount: one Int/s);
  });

  it('renders a deep value path as the flattened relation, not a dotted join', () => {
    const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
      hi: { kind: 'statePredicate', aggregate: 'Bill',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['line', 'net', 'amount'] },
                right: { kind: 'int', value: 0 } } } });
    expect(src).toContain('.line_net_amount');
    expect(src).not.toContain('.line.net.amount');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/ast/validate-values.test.ts test/emit/alloy.test.ts -t 'nest'`
Expected: FAIL — `value-flat` on the nested value; `line_net_amount` absent.

- [ ] **Step 3: Implement**

**(a)** In `lattice/src/ast/validate.ts`, replace the `value-flat` check (`:203-204`):

```ts
      if (f.type.kind !== 'prim' && f.type.kind !== 'enum')
        out.push({ code: 'value-flat', message: `value ${v.name}.${f.name}: value fields carry prim/enum types only in v1`, at: `${v.name}.${f.name}` });
```

with:

```ts
      // Values nest (slice B2): quint's fieldQType already recurses (quint.ts:57) and alloy's
      // valueSubRelations now does too. `ref` stays out — a value is keyless and compared by
      // structure, so a reference from inside one has no identity to belong to; `list` stays out for
      // the same reason it does on a child (no quint list encoding).
      if (f.type.kind === 'ref' || f.type.kind === 'list')
        out.push({ code: 'value-flat', message: `value ${v.name}.${f.name}: a value's fields are prim, enum, or another value — not ${f.type.kind} (a value is keyless and structural; it has no identity for a reference to belong to)`, at: `${v.name}.${f.name}` });
```

**(b)** In `lattice/src/ast/grammar.ts`, replace `resolveFieldPath`'s value-hop branch (`:43-49`):

```ts
    } else if (f.type.kind === 'value') {
      const vdef = m.values.find(x => x.name === (f.type as { kind: 'value'; value: string }).value);
      const sub = vdef?.fields.find(x => x.name === path[i + 1]);
      return i + 2 === path.length ? (sub ?? null) : null;
    } else def = undefined;
```

with:

```ts
    } else if (f.type.kind === 'value') {
      // Value hops to arbitrary depth (slice B2): values may nest, so walk sub-field by sub-field
      // rather than capping at one hop. A `list` intermediate still falls through to `def =
      // undefined` below and dies as unknown-path.
      let vdef = m.values.find(x => x.name === (f.type as { kind: 'value'; value: string }).value);
      for (let j = i + 1; j < path.length; j++) {
        const sub: Field | undefined = vdef?.fields.find(x => x.name === path[j]);
        if (!sub) return null;
        if (j === path.length - 1) return sub;
        if (sub.type.kind !== 'value') return null;
        vdef = m.values.find(x => x.name === (sub.type as { kind: 'value'; value: string }).value);
      }
      return null;
    } else def = undefined;
```

**(c)** In `lattice/src/emit/alloy.ts`, make `valueSubRelations` recurse — replace its sub-field loop:

```ts
  for (const sub of vdef?.fields ?? []) {
    if (sub.type.kind === 'enum') out.push(`  ${f.name}_${sub.name}: ${mult} ${sub.type.enum}`);
    else if (sub.type.kind === 'prim' && isIntPrim(sub.type.prim)) out.push(`  ${f.name}_${sub.name}: ${mult} Int`);
    // Text/Id sub-fields dropped, same convention as top-level fields
  }
```

with:

```ts
  for (const sub of vdef?.fields ?? []) {
    if (sub.type.kind === 'enum') out.push(`  ${f.name}_${sub.name}: ${mult} ${sub.type.enum}`);
    else if (sub.type.kind === 'prim' && isIntPrim(sub.type.prim)) out.push(`  ${f.name}_${sub.name}: ${mult} Int`);
    // Nested value (slice B2): flatten recursively, joining each level with `_` — matches
    // alloyFieldPath's renderer and quint's already-recursive fieldQType.
    else if (sub.type.kind === 'value')
      out.push(...valueSubRelations(m, { ...sub, name: `${f.name}_${sub.name}` }, mult));
    // Text/Id sub-fields dropped, same convention as top-level fields
  }
```

**(d)** Replace `alloyFieldPath` (`:101-114`) — this fixes the latent bug:

```ts
/**
 * Value-aware field path rendering (design §3.5): a path hopping through a value-typed field
 * flattens with `_` for that hop, matching the `<field>_<subfield>` sig relations valueSubRelations
 * emits; every other hop (ref hops, the leading var) joins with `.`.
 *
 * Walks the path resolving each hop's kind rather than special-casing a value at segment 0. The old
 * version checked only `p[0]`, so a value reached THROUGH a ref (`plan.period.start` — legal per
 * resolveFieldPath, reachable on the alloy route via a `unique` by-path or an enum-eq
 * statePredicate) rendered `a.plan.period.start`, a relation no sig declares.
 */
function alloyFieldPath(m: DomainModel, ownerName: string, v: string, p: Path): string {
  let def: AggregateDef | EntityDef | undefined = ownerByName(m, ownerName);
  const segs: string[] = [v];
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const f: Field | undefined = def?.fields.find(x => x.name === seg);
    if (f?.type.kind === 'value') {
      // Consume every remaining value hop into one underscore-joined relation name.
      let vdef = m.values.find(x => x.name === (f.type as { kind: 'value'; value: string }).value);
      let name = seg;
      let j = i + 1;
      for (; j < p.length; j++) {
        const sub: Field | undefined = vdef?.fields.find(x => x.name === p[j]);
        name = `${name}_${p[j]}`;
        if (sub?.type.kind !== 'value') { j++; break; }
        vdef = m.values.find(x => x.name === (sub.type as { kind: 'value'; value: string }).value);
      }
      segs.push(name);
      def = undefined;
      i = j - 1;
      continue;
    }
    segs.push(seg);
    def = f?.type.kind === 'ref' ? ownerByName(m, f.type.target) : undefined;
  }
  return segs.join('.');
}
```

Ensure `AggregateDef`, `EntityDef`, and `Field` are imported in `alloy.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run && npm run typecheck`
Expected: PASS — full suite, since `alloyFieldPath` is on many paths.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/validate.ts lattice/src/ast/grammar.ts lattice/src/emit/alloy.ts \
        lattice/test/ast/validate-values.test.ts lattice/test/emit/alloy.test.ts
git commit -m "feat: values nest inside values; fix alloyFieldPath's deep value hops

value-flat narrows to ref/list. Quint needed nothing (fieldQType already
recursed); alloy's valueSubRelations and resolveFieldPath's one-hop cap were the
blockers. Without this, `value TaxedAmount { net : Amount, tax : Amount }` must
be hand-flattened with nothing binding each amount to its currency — the
multi-currency complaint, one level down.

Also fixes a latent bug: alloyFieldPath special-cased a value at segment 0 only,
so plan.period.start rendered a relation no sig declares."
```

---

### Task 11: `@balance`/`@total` resolve through a value

Fixes finding 3. Alloy does not encode `conservation` at all (`routeCandidate` sends it to Quint;
`candidateToPred` throws on the Alloy path), and Quint's `pathToQuint` already renders `x.total.amount`
— so this is `templates.ts` plus a resolution rule. Zero or ≥2 numeric sub-fields is ambiguous and
reported loudly rather than guessed.

**Files:**
- Modify: `lattice/src/engine/templates.ts:7,26-30`
- Modify: `lattice/src/ast/validate.ts` (add `ambiguous-numeric-tag`)
- Test: `lattice/test/engine/templates.test.ts`, `lattice/test/ast/validate.test.ts`

**Interfaces:**
- Consumes: Task 6 (a child-subject conservation emits valid Quint).
- Produces: `numericTagPath(m, f): Path | null` exported from `templates.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `lattice/test/engine/templates.test.ts`:

```ts
describe('conservation sees through a value (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  const m: DomainModel = {
    context: 'L', enums: [], values: [amount], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'paid', type: { kind: 'value', value: 'Amount' }, tags: ['balance', 'unsigned'] },
      { name: 'due', type: { kind: 'value', value: 'Amount' }, tags: ['balance', 'unsigned'] },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['total', 'unsigned'] }] }],
  };

  it('emits two-segment paths through the value', () => {
    const c = matchTemplates(m).adopt.find(i => i.candidate.kind === 'conservation')!.candidate;
    expect(c).toEqual({ kind: 'conservation', aggregate: 'Bill',
      parts: [['paid', 'amount'], ['due', 'amount']], total: ['total', 'amount'] });
  });

  it('still emits single-segment paths for plain Money', () => {
    const flat: DomainModel = { ...m, values: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'paid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'due', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] }] };
    const c = matchTemplates(flat).adopt.find(i => i.candidate.kind === 'conservation')!.candidate;
    expect(c).toEqual({ kind: 'conservation', aggregate: 'Bill',
      parts: [['paid'], ['due']], total: ['total'] });
  });
});
```

Append to `lattice/test/ast/validate.test.ts`:

```ts
describe('ambiguous numeric tag (slice B2)', () => {
  it('rejects @total on a value with two numeric sub-fields', () => {
    const m: DomainModel = {
      context: 'L', enums: [], entities: [], events: [], services: [],
      values: [{ kind: 'value', name: 'Pair', fields: [
        { name: 'a', type: { kind: 'prim', prim: 'Money' } },
        { name: 'b', type: { kind: 'prim', prim: 'Money' } }] }],
      aggregates: [{ kind: 'aggregate', name: 'X', fields: [
        { name: 'xId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 't', type: { kind: 'value', value: 'Pair' }, tags: ['total'] }] }],
    };
    expect(validateModel(m).map(d => d.code)).toContain('ambiguous-numeric-tag');
  });

  it('rejects @balance on a value with no numeric sub-field', () => {
    const m: DomainModel = {
      context: 'L', enums: [], entities: [], events: [], services: [],
      values: [{ kind: 'value', name: 'Tag', fields: [
        { name: 'label', type: { kind: 'prim', prim: 'Text' } }] }],
      aggregates: [{ kind: 'aggregate', name: 'X', fields: [
        { name: 'xId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'b', type: { kind: 'value', value: 'Tag' }, tags: ['balance'] }] }],
    };
    expect(validateModel(m).map(d => d.code)).toContain('ambiguous-numeric-tag');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/engine/templates.test.ts test/ast/validate.test.ts -t 'value'`
Expected: FAIL — conservation is absent entirely for the value-typed model (the tags are invisible);
`ambiguous-numeric-tag` never appears.

- [ ] **Step 3: Implement**

**(a)** In `lattice/src/engine/templates.ts`, add above `matchTemplates`:

```ts
/**
 * The numeric path a `@balance`/`@total` tag on `f` names (slice B2): `[f]` for a numeric prim, or
 * `[f, sub]` for the single solver-numeric sub-field of a value-typed field — so `total : Amount`
 * conserves as `total.amount` wherever `total : Money` conserves as `total`.
 *
 * Null when the tag names nothing summable (no numeric sub-field) or is ambiguous (two or more).
 * validateModel's `ambiguous-numeric-tag` reports that case at load; this returns null so the
 * template stays silent rather than guessing which sub-field was meant.
 */
export function numericTagPath(m: DomainModel, f: Field): Path | null {
  const NUM = ['Int', 'Money', 'Date', 'Duration'];
  if (f.type.kind === 'prim') return NUM.includes(f.type.prim) ? [f.name] : null;
  if (f.type.kind !== 'value') return null;
  const vdef = m.values.find(v => v.name === (f.type as { kind: 'value'; value: string }).value);
  const nums = (vdef?.fields ?? []).filter(s => s.type.kind === 'prim' && NUM.includes(s.type.prim));
  return nums.length === 1 ? [f.name, nums[0]!.name] : null;
}
```

Import `Field`, `Path` as needed.

**(b)** Replace the conservation block (`templates.ts:25-30`):

```ts
    // #1 conservation: >=2 @balance + a @total
    const balances = o.fields.filter(f => f.tags?.includes('balance'));
    const total = o.fields.find(f => f.tags?.includes('total'));
    if (balances.length >= 2 && total)
      adopt.push(mk(`tpl-1-${o.name}`, `Conservation_${o.name}`,
        { kind: 'conservation', aggregate: o.name, parts: balances.map(b => [b.name]), total: [total.name] }));
```

with:

```ts
    // #1 conservation: >=2 @balance + a @total. Paths resolve THROUGH a value type (slice B2) —
    // before this, tagging a value-typed money field silently stopped conservation firing.
    const balances = o.fields.filter(f => f.tags?.includes('balance'))
      .map(f => numericTagPath(m, f)).filter((p): p is Path => p !== null);
    const totalField = o.fields.find(f => f.tags?.includes('total'));
    const total = totalField ? numericTagPath(m, totalField) : null;
    if (balances.length >= 2 && total)
      adopt.push(mk(`tpl-1-${o.name}`, `Conservation_${o.name}`,
        { kind: 'conservation', aggregate: o.name, parts: balances, total }));
```

**(c)** Widen `templates.ts:7`'s `owners` to include children (safe now that Task 6 gives a
child-subject conservation a real encoding):

```ts
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] =>
  [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];
```

**(d)** In `lattice/src/ast/validate.ts`, inside `checkFields`'s `fs.forEach`, add:

```ts
      // A @balance/@total tag must name exactly one summable number. On a value-typed field that
      // means exactly one solver-numeric sub-field; zero or several is ambiguous, and templates.ts's
      // numericTagPath returns null there — so without this the tag would be accepted and do
      // nothing, which is the inertness this slice exists to remove.
      if ((f.tags?.includes('balance') || f.tags?.includes('total')) && f.type.kind === 'value') {
        const vdef = m.values.find(v => v.name === (f.type as { kind: 'value'; value: string }).value);
        const nums = (vdef?.fields ?? []).filter(s => s.type.kind === 'prim'
          && ['Int', 'Money', 'Date', 'Duration'].includes(s.type.prim));
        if (nums.length !== 1)
          out.push({ code: 'ambiguous-numeric-tag', at: `${owner}.${f.name}`,
            message: `${owner}.${f.name} is tagged @${f.tags?.includes('total') ? 'total' : 'balance'} but its value type ${vdef?.name ?? '?'} has ${nums.length} numeric sub-fields (${nums.map(n => n.name).join(', ') || 'none'}) — the tag must name exactly one summable number. Tag a field whose value type has a single numeric sub-field.` });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/engine/templates.ts lattice/src/ast/validate.ts \
        lattice/test/engine/templates.test.ts lattice/test/ast/validate.test.ts
git commit -m "fix(engine,ast): @balance/@total resolve through a value type

templates.ts read tags off o.fields and emitted single-segment paths, so the
moment money became value-typed to carry currency, conservation stopped firing —
silently. Paths now resolve to a value's single numeric sub-field, and a tag
naming zero or several reports ambiguous-numeric-tag rather than being guessed.

Emitters needed nothing: alloy doesn't encode conservation, and quint's
pathToQuint already rendered x.total.amount."
```

---

### Task 12: `sumOverCollection.field` widens to a `Path`

The versioned change to the closed candidate grammar, needed for `sum(postings, amount.amount)` once
`Posting.amount` is value-typed. **There are two copies of the fold** — `quint.ts:317`
(`candidateToQuint`) and `quint.ts:354` (the classify path's `mSum`) — and both must be widened, or a
`Path` renders as `[object Object]` in the second.

**Files:**
- Modify: `lattice/src/ast/invariant.ts:38-43`
- Modify: `lattice/src/emit/quint.ts:317,354`, `lattice/src/emit/alloy.ts:231`
- Modify: `lattice/src/engine/evaluate.ts:149`
- Modify: `lattice/src/ast/grammar.ts:307-320`
- Test: `lattice/test/ast/grammar-sum.test.ts`

**Interfaces:**
- Consumes: Task 4 (child witness keys are dotted, so `resolveValue` finds `amount.amount`).
- Produces: `sumFieldPath(c): Path` — the normalize-on-read accessor. Every reader uses it.

- [ ] **Step 1: Write the failing tests**

Append to `lattice/test/ast/grammar-sum.test.ts`:

```ts
describe('sumOverCollection over a value sub-field (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], entities: [], events: [], services: [],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'net', type: { kind: 'value', value: 'Amount' } },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'value', value: 'Amount' } }] }] }],
  };
  const c: Candidate = { kind: 'sumOverCollection', aggregate: 'Txn', collection: 'legs',
    child: 'Posting', field: ['amount', 'amount'], op: 'eq', total: ['net', 'amount'] };

  it('validates a two-segment sum field', () => {
    expect(validateCandidate(c, m)).toEqual([]);
  });

  it('rejects a sum field ending at a non-numeric sub-field', () => {
    expect(validateCandidate({ ...c, field: ['amount', 'currency'] } as Candidate, m)
      .map(d => d.code)).toContain('ill-typed');
  });

  it('normalizes a legacy `field: string` candidate on read (back-compat)', () => {
    const legacy = { kind: 'sumOverCollection', aggregate: 'Txn', collection: 'legs',
      child: 'Posting', field: 'amount', op: 'eq', total: ['net', 'amount'] } as unknown as Candidate;
    expect(sumFieldPath(legacy as any)).toEqual(['amount']);
  });

  it('emits the dotted accessor in quint and the underscore relation in alloy', () => {
    expect(candidateToQuint(m, c, 'S')).toContain('.get(i).amount.amount');
    // candidateToPred is module-private — assert through astToAlloy, which renders `hi` as `pred Hi`.
    const alloySrc = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4, hi: c });
    expect(alloySrc).toContain('l.amount_amount');
    expect(alloySrc).not.toContain('l.amount.amount');
  });

  it('the judge sums a child\'s value sub-field via the dotted witness key', () => {
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: { 'net.amount': 7 } },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', 'amount.amount': 3 } },
      { type: 'Posting', id: 'p2', fields: { owner: 't1', 'amount.amount': 4 } }] })).toBe('permit');
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: { 'net.amount': 9 } },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', 'amount.amount': 3 } }] })).toBe('forbid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/ast/grammar-sum.test.ts -t 'value sub-field'`
Expected: FAIL — `tsc` rejects `field: ['amount','amount']` (it is typed `string`); `sumFieldPath`
does not exist.

- [ ] **Step 3: Implement**

**(a)** In `lattice/src/ast/invariant.ts`, replace the `sumOverCollection` arm (`:38-43`):

```ts
  | { kind: 'sumOverCollection'; aggregate: string;
      collection: string;                 // owned List field name on the aggregate
      child: string;                      // the nested entity's name (== ownedCollectionChild(...).name)
      field: string;                      // numeric field on the child
      op: 'eq' | 'le' | 'ge';
      total: Path }                       // single-segment numeric path on the aggregate
```

with:

```ts
  | { kind: 'sumOverCollection'; aggregate: string;
      collection: string;                 // owned List field name on the aggregate
      child: string;                      // the nested entity's name (== ownedCollectionChild(...).name)
      // Numeric path on the child: `['amount']` for a prim, `['amount','amount']` through a value
      // type (slice B2). `string` is the LEGACY form — candidates stored before the widening carry
      // it. Read it through sumFieldPath, never directly.
      field: string | Path;
      op: 'eq' | 'le' | 'ge';
      total: Path }                       // numeric path on the aggregate (may hop through a value)
```

And add, at the end of the file:

```ts
/**
 * The sum field as a Path, normalizing the legacy `field: string` form (slice B2). Candidates
 * adopted/stored before `field` widened carry a bare string; every reader goes through this so a
 * stored ledger candidate keeps resolving. Same precedent as implied.ts's stripRefsResolveFields.
 */
export const sumFieldPath = (c: Candidate & { kind: 'sumOverCollection' }): Path =>
  typeof c.field === 'string' ? [c.field] : c.field;
```

**(b)** In `lattice/src/emit/quint.ts`, replace the fold at `:317`:

```ts
    const fold = `range(0, ${OWNED_BOUND}).foldl(0, (acc, i) => if (i < x.${c.collection}Count) acc + x.${c.collection}.get(i).${c.field} else acc)`;
```

with:

```ts
    // Dotted accessor: quint embeds a value as a nested record (fieldQType), so a value sub-field
    // reads `.get(i).amount.amount`.
    const fold = `range(0, ${OWNED_BOUND}).foldl(0, (acc, i) => if (i < x.${c.collection}Count) acc + x.${c.collection}.get(i).${sumFieldPath(c).join('.')} else acc)`;
```

And at `:354`, the classify path's second copy — replace `${mSum[2]}` with a normalized join. Read
the surrounding code and apply the same `.join('.')` treatment to whatever `mSum[2]` holds; if it is
a regex capture over a rendered string it may already be dotted, in which case **add a test proving
it** rather than changing it.

**(c)** In `lattice/src/emit/alloy.ts`, replace `:231`'s `l.${c.field}`:

```ts
      return `pred ${name} { all x: ${c.aggregate} | ${alloyFieldPath(m, c.aggregate, 'x', c.total)} ${ops[c.op]} (sum l: { l: ${c.child} | l.owner = x } | l.${c.field}) }`;
```

with:

```ts
      // Underscore relation: alloy flattens a value into `<field>_<sub>` sig relations
      // (valueSubRelations), so a value sub-field reads `l.amount_amount`.
      return `pred ${name} { all x: ${c.aggregate} | ${alloyFieldPath(m, c.aggregate, 'x', c.total)} ${ops[c.op]} (sum l: { l: ${c.child} | l.owner = x } | ${alloyFieldPath(m, c.child, 'l', sumFieldPath(c))}) }`;
```

**(d)** In `lattice/src/engine/evaluate.ts`, replace `:149`:

```ts
        const vals = kids.map(k => k.fields[c.field]);
```

with:

```ts
        // resolveValue, not a raw key read: a value sub-field arrives as the dotted `amount.amount`
        // (witness.ts's remapValueKeys, which covers children as of slice B2).
        const vals = kids.map(k => resolveValue(s, k, sumFieldPath(c)));
```

**(e)** In `lattice/src/ast/grammar.ts`, replace the sum-field type gate (`:318-320`):

```ts
      const cf = child.fields.find(x => x.name === c.field);
      if (!cf || cf.key || cf.type.kind !== 'prim' || !SOLVER_INT_PRIMS.includes(cf.type.prim))
        out.push({ code: 'ill-typed', message: `sum field ${c.child}.${c.field} must be a numeric (Int/Money/Date/Duration) non-key field`, at: 'field' });
```

with:

```ts
      // resolveFieldPath resolves a child subject as of slice B2 (ownerDef includes children), so a
      // two-segment `['amount','amount']` walks the value hop exactly as any other path does.
      const fp = sumFieldPath(c);
      const cf = resolveFieldPath(m, c.child, fp);
      if (!cf || cf.key || cf.type.kind !== 'prim' || !SOLVER_INT_PRIMS.includes(cf.type.prim))
        out.push({ code: 'ill-typed', message: `sum field ${c.child}.${fp.join('.')} must be a numeric (Int/Money/Date/Duration) non-key field`, at: 'field' });
```

Import `sumFieldPath` in each of the four files from `../ast/invariant.js` (or `./invariant.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run && npm run typecheck`
Expected: PASS. `tsc` will flag every remaining raw `c.field` read — fix each by routing through
`sumFieldPath`. That type error is the feature.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/invariant.ts lattice/src/emit/quint.ts lattice/src/emit/alloy.ts \
        lattice/src/engine/evaluate.ts lattice/src/ast/grammar.ts lattice/test/ast/grammar-sum.test.ts
git commit -m "feat(ast): sumOverCollection.field widens from string to Path

A versioned change to the closed candidate grammar, needed for
sum(postings, amount.amount) once Posting.amount is value-typed to carry
currency. Legacy `field: string` candidates normalize on read via sumFieldPath,
the same precedent as stripRefsResolveFields.

Both copies of the fold widened — candidateToQuint's and the classify path's."
```

---

### Task 13: Documentation

The docs are executable (`test/docs-blocks.test.ts` validates every ` ```lat ` block), so this is a
test change as much as a prose change. **Two pages are wrong today**, independent of this slice.

**Files:**
- Modify: `docs/language/entity.md:82-93`, `docs/language/value.md:73-80`,
  `docs/language/field-types.md:40`, `docs/language/tags.md`, `docs/language/derived-invariants.md`
- Test: `lattice/test/docs-blocks.test.ts` (existing — must stay green)

- [ ] **Step 1: Fix `entity.md`'s "Nested in an aggregate"**

Replace the bullet at `:82-84`. It says children reject "`ref` and `List`" and **never mentions
`value`**, though `validate.ts:220` rejected value-typed child fields too — so it is wrong today.

```markdown
- Nested entities carry prim, enum, `ref`, and value-typed fields. A child's `ref` must name a
  **top-level** aggregate or entity: an owned child has no identity to reference, so a `ref` naming
  one reports `ref-target-nested-child` (both solver encodings inline a child into its owner, with
  no id pool to draw from). Reference the owning aggregate instead, or promote the child to a
  top-level entity.
- A `List` field inside a child reports `nested-entity-flat` — a child cannot own a collection.
  This is **not yet implemented rather than deliberate**: Alloy would encode it directly (its child
  sigs are flat), but Quint has no list encoding at all, so two-level collections need nested
  bounded maps, an `OWNED_BOUND²` state blowup, and a revisit of the bitwidth policy that already
  rises to 7 for a single-level sum. If you have a spec that needs it — a bill line with a per-line
  tax breakdown is the usual one — that is the evidence, and the cost above is what it has to buy.
```

Replace `:91-93`, which claims a check that does not exist:

```markdown
- Owned collections round-trip through the printer, but list-typed fields are dropped before solving
  (quint/alloy). A multi-segment candidate path *through* a collection fails to resolve and reports
  `unknown-path`. A single-segment path *at* a list field is not currently rejected — it resolves
  and then contributes nothing, which is a gap rather than a design.
```

- [ ] **Step 2: Fix `value.md`**

**Exact stale claims found by Task 10's review — these are NORMATIVE text contradicting shipped code:**
- **`value.md:39-40`** — "**Flat.** Value fields are prim or enum types only in v1 — no `ref`, no
  `List<T>`, and no value-typed field nested inside another value. A field of any other kind reports
  `value-flat`." **This is the exact rule Task 10 deleted.** `value-flat` now fires only on
  `ref`/`list`.
- **`value.md:78-80`** — "A value-typed candidate path is one flat hop (`period.start`) … deeper
  paths through a value aren't part of the v1 candidate surface." Task 10 uncapped it.
- **`field-types.md:36`** — "Structural, keyless, and flat (prim/enum fields only)".
- **`value-cycle` is undocumented anywhere in `docs/`.** Document it: a value is a structural type
  flattened into its fields, so a cycle has no finite flattening and is rejected at load.
- **`unowned-nested-entity`, `ref-target-nested-child`, `value-money-sign-inert`, and
  `derived-name-collision` are also undocumented** — all four are new diagnostics from this slice.

Note `test/docs-blocks.test.ts` CANNOT catch any of these: they are prose, not ` ```lat ` blocks.

Replace the "Remaining limits" block at `:73-80`:

```markdown
A value-typed field is legal anywhere a prim is: on an aggregate, on a top-level entity, on an
aggregate-owned child, and **inside another value**. Alloy flattens each level with `_`
(`line_net_amount`); Quint nests records to match.

**Money sign is decided at the use site.** A `value Amount { amount : Money, currency : Currency }`
is non-negative at `Bill.total` and signed at `LedgerAccount.balance` — one tag on the declaration
could not express both, so `@signed`/`@unsigned` go on the field *typed* with the value. A sign tag
inside a value declaration reports `value-money-sign-inert`.

**Remaining limit:** a value's fields are prim, enum, or another value — never `ref` or `List`
(`value-flat`). A value is keyless and compared by structure, so it has no identity for a reference
to belong to.
```

Add to the "Solver encoding" section:

```markdown
A `@balance`/`@total` tag on a value-typed field resolves to that value's single solver-numeric
sub-field, so `total : Amount @total` conserves as `total.amount`. A value with zero or several
numeric sub-fields is ambiguous and reports `ambiguous-numeric-tag` — the tag must name exactly one
summable number.
```

- [ ] **Step 2b: Fix `invariant-forms.md` and one false code comment (from Task 12's review)**

- **`invariant-forms.md:178-200`** documents only `sum(<collection>, <field>)` with a single-name
  example. Task 12 widened the `.lat` surface to `field=PathExpr`, so `sum(postings, amount.amount)`
  — the entire motivating case — is now legal and **undocumented**. The doc's executable block still
  passes `docs-blocks.test.ts` because it is single-segment, so the suite cannot catch this.
- **`fromLangium.ts:186-187`** (a code comment, not a doc): it justifies mapping a single-segment sum
  field back to the legacy `string` by claiming always-Path "would break candidate identity in
  reconcile's `rehydrateIds` and `isImplied`". **Both mechanisms are wrong** — `rehydrateIds`
  (`reconcile.ts:36`) matches by NAME, and `impliedInvariants` never emits a `sumOverCollection`, so
  `isImplied` is vacuously false for this kind. The DECISION is right and the conclusion is right;
  the cited mechanism is not. The real one is `diff.ts:171`'s `changedInvariants` (via
  `canonicalSet`), proven to fire. Correct the comment to name it — a comment that misdirects the
  next reader to two dead ends is the same defect class this slice keeps hitting.

- [ ] **Step 3: Fix `field-types.md`, `tags.md`, `derived-invariants.md`**

- `field-types.md:40` says `List<T>` holds "any of the above, including nested lists" — contradicted
  by `nested-entity-flat` and `value-flat`. State where lists may actually appear: on an aggregate or
  top-level entity, ranging over a nested child (an owned collection) or a prim/enum. Not inside a
  child, not inside a value.
- `field-types.md` — document `ref-target-nested-child` beside the existing "structural only"
  sections (`:89`, `:105`), whose vocabulary this reuses.
- `tags.md` — `@signed`/`@unsigned` are **use-site** tags and may sit on a value-typed field;
  `@balance`/`@total` resolve through a value to its single numeric sub-field.
- `derived-invariants.md` — non-negativity derives **per money path**, including `total.amount`
  through a value and a child's own money fields; `refsResolve` now covers owned children.

- [ ] **Step 4: Run the docs test**

Run: `cd lattice && npx vitest run test/docs-blocks.test.ts && npm test`
Expected: PASS. Every ` ```lat ` block must be a complete, parseable, valid file — add a `context`
wrapper to any new example.

- [ ] **Step 5: Commit**

```bash
git add docs/language/
git commit -m "docs(language): nested types — refs/values in children, use-site money sign

Two corrections that were wrong before this slice: entity.md said children
reject 'ref and List' and never mentioned value (validate.ts rejected it too),
and it claimed collection-reaching candidate paths are rejected when no such
check exists.

List-in-child is documented as not-yet-implemented with its blocking cost and
the shape of its fix, rather than as a decision 'pending evidence' — that
framing is what let the ledger evidence arrive and change nothing."
```

---

### Task 14: End-to-end ledger spec

The spec that motivated the slice, kept as the regression. Exercises every decision at once against
**real solvers**, which is where the judge/Quint divergence risk in Task 6 actually shows up.

**Files:**
- Create: `lattice/test/fixtures/ledger.lat`
- Create: `lattice/test/ledger-e2e.test.ts`

**Interfaces:**
- Consumes: every prior task.

- [ ] **Step 1: Write the fixture**

Create `lattice/test/fixtures/ledger.lat`:

```lat
/// Double-entry bill-payment ledger: the spec that motivated slice B2.
context Ledger {
  enum Currency { usd, eur }

  /// Money that carries its currency — the DDD value-object encoding.
  value Amount {
    amount   : Money
    currency : Currency
  }

  entity LedgerAccount {
    accountId : Id key
    code      : Int
    balance   : Amount @signed
  }

  aggregate Bill {
    billId     : Id key
    total      : Amount @total @unsigned
    amountPaid : Amount @balance @unsigned
    amountDue  : Amount @balance @unsigned
    lines      : List<LineItem>

    entity LineItem {
      lineId : Id key
      amount : Amount @unsigned
    }
  }

  aggregate JournalTransaction {
    txnId     : Id key
    netAmount : Amount @signed
    postings  : List<Posting>

    entity Posting {
      postingId : Id key
      account   : ref LedgerAccount
      amount    : Amount @signed
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `lattice/test/ledger-e2e.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLatText } from '../src/parse/fromLangium.js';
import { astToCode } from '../src/emit/code.js';
import { astToAlloy } from '../src/emit/alloy.js';
import { candidateToQuint } from '../src/emit/quint.js';
import { impliedInvariants } from '../src/engine/implied.js';
import { matchTemplates } from '../src/engine/templates.js';
import { undecidedMoneySigns } from '../src/ast/validate.js';
import { validateCandidate } from '../src/ast/grammar.js';
import type { Candidate } from '../src/ast/invariant.js';

const src = readFileSync(join(import.meta.dirname, 'fixtures/ledger.lat'), 'utf8');

describe('the double-entry ledger that motivated slice B2', () => {
  const r = loadLatText(src);
  if (!r.ok) throw new Error(`fixture does not load:\n${JSON.stringify(r.diagnostics, null, 2)}`);
  const { model, invariants } = r;

  it('validates', () => {
    expect(r.ok).toBe(true);
  });

  it('has no undecided money signs', () => {
    expect(undecidedMoneySigns(model)).toEqual([]);
  });

  it('round-trips through the printer', () => {
    // astToCode takes (model, invariants) — two args.
    const printed = astToCode(model, invariants);
    const again = loadLatText(printed);
    expect(again.ok).toBe(true);
    expect(astToCode((again as Extract<typeof again, { ok: true }>).model,
                     (again as Extract<typeof again, { ok: true }>).invariants)).toBe(printed);
  });

  it('KEEPS REFERENTIAL INTEGRITY: a posting must hit a real account', () => {
    // Finding 1, first horn: this was the rule you gave up to keep the balance law.
    expect(impliedInvariants(model).map(i => i.name)).toContain('refsResolvePosting');
  });

  it('KEEPS THE BALANCE LAW: conservation fires through the value type', () => {
    // Findings 3+4: tagging value-typed money used to silently stop this firing.
    const c = matchTemplates(model).adopt
      .find(i => i.candidate.kind === 'conservation' && (i.candidate as any).aggregate === 'Bill')!;
    expect(c.candidate).toEqual({ kind: 'conservation', aggregate: 'Bill',
      parts: [['amountPaid', 'amount'], ['amountDue', 'amount']], total: ['total', 'amount'] });
  });

  it('DERIVES NON-NEGATIVITY PER USE SITE: one value, opposite signs', () => {
    // Finding 2: @unsigned asserted a rule that was never enforced.
    const names = impliedInvariants(model).map(i => i.name);
    expect(names).toContain('nonNegativeBillTotalAmount');       // @unsigned use site
    expect(names).toContain('nonNegativeLineItemAmountAmount');  // @unsigned on a CHILD
    expect(names).not.toContain('nonNegativePostingAmountAmount');        // @signed child
    expect(names).not.toContain('nonNegativeLedgerAccountBalanceAmount'); // @signed entity
  });

  it('KEEPS THE OTHER HORN: netAmount == sum(postings, amount) is expressible', () => {
    // Finding 1's second horn. Promoting Posting to top-level to get real refs used to make this
    // candidate inexpressible (sumOverCollection requires an OWNED collection) — so no model could
    // hold both this and refsResolvePosting above. Both now validate against the same spec.
    const sum: Candidate = { kind: 'sumOverCollection', aggregate: 'JournalTransaction',
      collection: 'postings', child: 'Posting', field: ['amount', 'amount'], op: 'eq',
      total: ['netAmount', 'amount'] };
    expect(validateCandidate(sum, model)).toEqual([]);
  });

  it('emits valid Quint and Alloy for the ledger\'s balance law', () => {
    const sum: Candidate = { kind: 'sumOverCollection', aggregate: 'JournalTransaction',
      collection: 'postings', child: 'Posting', field: ['amount', 'amount'], op: 'eq',
      total: ['netAmount', 'amount'] };
    expect(candidateToQuint(model, sum, 'S')).toContain('.get(i).amount.amount');
    expect(astToAlloy(model, { kind: 'probe-permit', exclusions: [], scope: 4, hi: sum }))
      .toContain('l.amount_amount');
  });
});
```

- [ ] **Step 3: Run and iterate**

Run: `cd lattice && npx vitest run test/ledger-e2e.test.ts`
Expected: PASS. If a derived name differs, **read the actual name from the failure and fix the test**
— do not weaken the assertion to `toContain('nonNegative')`, which would pass while proving nothing.

- [ ] **Step 4: Add the real-solver check**

Run the fidelity harness against the fixture to confirm the Task 6 child-map encoding agrees with the
TS judge on a real solver, and that Alloy's Int bitwidth holds with value-typed sum fields (the
design's one *believed, not measured* risk):

Run: `cd lattice && npm run fidelity 2>&1 | tail -30`
Expected: no divergence rows for the ledger. **If Alloy overflows**, raise `intW` in `alloy.ts:391`
and record the measured bound in the design doc's Risks section.

- [ ] **Step 5: Commit**

```bash
git add lattice/test/fixtures/ledger.lat lattice/test/ledger-e2e.test.ts
git commit -m "test: end-to-end double-entry ledger — the spec that motivated slice B2

Pins all four findings closed at once: Posting is an owned child that keeps BOTH
refsResolve (a posting hits a real account) and sumOverCollection's balance law;
conservation fires through a value-typed money field; and one `value Amount` is
@unsigned at Bill.total while @signed at LedgerAccount.balance."
```

---

## Self-Review

**Spec coverage.** Design Decision 1 → Tasks 1–4; Decision 2 → Tasks 5, 8; Decision 3 → Tasks 7, 9;
Decision 4 → Task 6; Decision 5 → Task 10; Decision 6 → Task 11; Decision 7 → Task 12; doc changes →
Task 13; the ledger regression and the measured-bitwidth risk → Task 14. The design's "Latent bugs"
section maps as stated: `ref`-targets-a-child → Task 1, `alloyFieldPath` → Task 10, and the two
explicitly *not* fixed here (Quint's missing ref-hop existence gate on `conservation`/`total`;
`checkPath` accepting a single-segment list path) are recorded in Task 13's `entity.md` rewrite as
known gaps rather than silently dropped.

**Ordering.** Task 1 must precede Task 5 (it is what makes admitting children to `ownerDef` safe).
Task 6 must precede Tasks 7 and 11 (a child-subject rule needs an encoding before it is derived).
Task 4 must precede Task 12 (the judge reads dotted child keys). Task 3 must precede Task 10 (which
adds recursion to the helper Task 3 extracts).

**API verification.** Every symbol this plan calls was checked against the source with `grep -rn
"export (function|const) <name>"` rather than recalled. That caught five errors that would each have
wasted an implementation cycle, and they are why the Global Constraints list the exact shapes:

- `AlloyQuery.kind` has no `'invariant-check'` member and `scope` is required — the draft used a
  nonexistent kind in three tasks.
- `astToQuint` returns `QuintEmission`, not a string; the text is `.source`.
- `astToCode` takes `(model, invariants)` — two arguments, not one.
- `candidateToPred` is module-private; Task 12 asserts through `astToAlloy` instead.
- `ownerByName` (`alloy.ts:6`) is a **tenth** top-level-only owner list the design's "nine modules"
  missed. `alloyFieldPath` resolves through it, so Task 12's child sum field would have silently
  rendered `l.amount.amount`. Widened in Task 3.

**Type consistency.** `moneyPaths` (Task 7) and `carriesMoney` (Task 9) derive from the same shape by
construction; `numericTagPath` (Task 11) is the tag-side analogue and is deliberately separate
because it demands *exactly one* numeric sub-field where `moneyPaths` takes *all* money sub-fields.
`sumFieldPath` (Task 12) is the single accessor for `field`; the `string | Path` union makes `tsc`
find every remaining raw read.

**Known soft spot.** Task 12(b)'s second fold (`quint.ts:354`, the classify path's `mSum`) is the one
step whose exact edit I could not pin down from reading — it is a regex capture over a rendered
string, so the implementer must read it and either widen it or prove it already dotted with a test.
It is called out in the step rather than glossed.

---

### Task 15: Reject an unowned nested entity

**Added mid-slice, sequenced immediately after Task 6** (numbered 15 only to keep Tasks 7–14's
brief numbering stable). Surfaced by Task 6's review; the user approved adding it to this slice.

A nested entity declared with **no `List<ref Child>` field owning it** passes `validateModel` with
**zero diagnostics** today, yet is unreachable in every encoding: Quint gives it no var and no record
field (it is only ever reached via its owner's collection map), Alloy's `emitChildSigs` only emits a
sig for a child reached through an owned collection, and Task 1's `ref-target-nested-child` forbids
anything referencing it. It is a dead declaration the language accepts silently — the same "silent
acceptance of something the encodings cannot represent" bug this whole slice exists to remove.

Task 6 made `childContext` throw on one, so the failure is at least loud. This makes it a diagnostic
at `init`, where every other structural error is reported.

**Blast radius: measured, not assumed.** Every `.lat` in `specs/` and every ` ```lat ` block in
`docs/language/` was parsed and checked: **47 models, 0 orphan nested entities.** No real spec or doc
example trips this.

**Files:**
- Modify: `lattice/src/ast/validate.ts` (in the `m.aggregates.forEach` child loop)
- Test: `lattice/test/ast/validate-nested.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: diagnostic code `unowned-nested-entity`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('nested entities', …)` block in
`lattice/test/ast/validate-nested.test.ts`. The helpers `inv(childFields, listOf?)` and `goodChild`
are defined at the top of that file — read them first.

```ts
  it('rejects a nested entity that no owned collection owns (unowned-nested-entity)', () => {
    // Unreachable in every encoding: quint gives a child no var and no record field (it exists only
    // inside its owner's collection map), and ref-target-nested-child forbids referencing it. It
    // validated clean with ZERO diagnostics before this rule.
    const m = inv(goodChild);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Orphan',
      fields: [{ name: 'oid', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('unowned-nested-entity');
  });

  it('names the orphan and its declaring aggregate', () => {
    const m = inv(goodChild);
    m.aggregates[0]!.entities!.push({ kind: 'entity', name: 'Orphan',
      fields: [{ name: 'oid', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    const d = validateModel(m).find(x => x.code === 'unowned-nested-entity')!;
    expect(d.at).toBe('Invoice.Orphan');
    expect(d.message).toContain('Orphan');
    expect(d.message).toContain('Invoice');
  });

  it('does not fire on a properly owned child', () => {
    expect(validateModel(inv(goodChild)).map(d => d.code)).not.toContain('unowned-nested-entity');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lattice && npx vitest run test/ast/validate-nested.test.ts`
Expected: FAIL — the two "rejects"/"names" tests; `unowned-nested-entity` never appears. The third
passes vacuously.

- [ ] **Step 3: Implement**

In `lattice/src/ast/validate.ts`, inside `m.aggregates.forEach(a => { … })`'s `for (const child of
a.entities ?? [])` loop, after the existing `checkFields(child.fields, …)` call, add:

```ts
      // A child is reachable ONLY through an owned collection: quint inlines it into its owner as
      // `<coll>: int -> {…}` (no var, no id pool of its own — see emit/quint.ts's owners/pools), and
      // alloy emits its sig only for a child an owned collection ranges over. Nothing may reference
      // one either (checkRefTarget's ref-target-nested-child). So a child no `List<...>` field owns
      // is unreachable in every encoding — a dead declaration. Reported here rather than left to
      // childContext's emission-time throw, so it lands at init with every other structural error.
      if (!a.fields.some(f => ownedCollectionChild(a, f)?.name === child.name))
        out.push({ code: 'unowned-nested-entity', at: `${a.name}.${child.name}`,
          // Do NOT synthesize a field name for the suggestion. Naive `+ 's'` pluralization produces
          // `boxs`, `companys`, `classs`, `childs` — an authoritative-sounding wrong suggestion — and
          // an invented name could collide with an existing field. Name the TYPE, not the field.
          message: `nested entity ${a.name}.${child.name} is not owned by any collection — give ${a.name} a 'List<${child.name}>' field, or declare ${child.name} at context level. A nested entity is reachable only through its owner's owned collection, so nothing can read or constrain this one.` });
```

`ownedCollectionChild` is already imported at the top of `validate.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lattice && npx vitest run test/ast/validate-nested.test.ts test/ast/validate.test.ts test/parse/fromLangium.test.ts test/docs-blocks.test.ts && npm run typecheck`
Expected: PASS. `docs-blocks` is the one that would catch a doc example tripping the new rule — it
was measured clean beforehand, so a failure there is a real find, not an expected chore.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/validate.ts lattice/test/ast/validate-nested.test.ts
git commit -m "feat(ast): reject a nested entity no owned collection owns

An orphan nested entity passed validateModel with zero diagnostics while being
unreachable in every encoding — quint gives a child no var and no record field,
alloy emits its sig only via an owned collection, and ref-target-nested-child
forbids referencing it. A dead declaration the language accepted silently.

Task 6 made childContext throw on one at emission; this reports it at init,
where every other structural error lands. Measured before landing: 47 parsed
models across specs/ and docs/language/, 0 orphans."
```
