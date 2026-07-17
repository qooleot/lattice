# Optionality Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 verified findings from the Slice A/B1 code review — finish the Quint half of optionality, repair generated-code `present()`, restore gate symmetry (templates, money-sign tags, decline, refsResolve), close the named test-coverage gaps, and reconcile the docs — plus two verified elicitation-loop defects reported by other agents (Phase 6): declined rulings must block re-adoption, and adoption provenance must be anchored per candidate.

**Architecture:** All engine work is in `lattice/src` (TypeScript, ESM, vitest). Three encodings must agree on absence: the TS judge (`evaluate.ts`: absent = `undefined`, cmp permits unknowns, `present()` reads absence as a fact), Alloy (`lone` relations; hop gates already landed), and Quint (a `${f}Present: bool` companion beside each optional field; hop gates and witness decoding are what this plan completes). Findings are fixed in the user-chosen sequence: Quint unit (1, 2, 6) → missing-case bugs (3, 5) → gate symmetry (4, 7, 8) → tests (9 + gaps) → docs (10 + stale claims).

**Tech Stack:** TypeScript, vitest, Langium (parser is generated — run `npm run langium:generate` once per fresh worktree), Quint/Apalache via the `quint` npm binary (available), Alloy via `vendor/alloy.jar` (integration tests guard with `describe.skipIf(!existsSync(ALLOY_JAR))`).

**Rebase note (2026-07-17):** this plan was re-verified after rebasing onto `b7a879f` (Slice B2: nested types — refs/values inside owned children, use-site money sign; +6090/−220). Every task's target survives; quoted code was re-checked byte-for-byte where a task performs an exact replacement (the quint unique arm, `refHopsIn`, `multiSegmentPaths`, `canonicalSet`, `adoptGuard`, the `hasVerdicts` block). Line numbers shifted — key anchors now: `refHopsIn` quint.ts:187, refsResolve optional filter implied.ts:118, `optional-owned-child` validate.ts:355, `undecidedMoneySigns` validate.ts:447, `writeProjections` cli.ts:79, `adoptGuard` cli.ts:213, `hasVerdicts` cli.ts:530, `canonicalSet` reconcile.ts:49. Relocate by quoted code, and prefer B2's new shared helpers where they exist (`moneyFieldPaths` in domain.ts, `sumFieldPath` in invariant.ts).

## Global Constraints

- Working directory for all commands: `lattice/` (the package root; `npx vitest run <file>` paths below are relative to it).
- Every code task follows TDD: failing test first, then the minimal fix, then green, then commit.
- Task order within Phase 1 and Phase 3 is load-bearing: Task 2 (adapter strip) must land before Task 6 (refsResolve re-inclusion) — without the strip, the judge convicts placeholder ids of absent optional refs. Task 12 consumes Task 8's `declinedShapes` helper and must follow it.
- Doc code examples are CI-checked (`test/docs-blocks.test.ts` runs `loadLatText` on every ```lat block) — run it after any doc edit.
- Commit after every task; message style follows the repo's `fix(scope): sentence` convention.
- **Non-goals** (reviewed and deliberately excluded): the `apply`-path money-sign gate (explicitly-argued design decision — raise with the user separately, do not change); a rename bridge for pre-slice `classified` ledger entries (low impact, converges after one re-classify); absence gates for `cardinality.where`/`leadsTo` (documented open decision in invariant.md); reuse/efficiency refactors beyond the `refHopGates` consolidation Task 1 performs.
- **Deferred to a design slice, not this plan** (verified real, but each needs an "open question" grouping concept the session state does not have — a mechanical patch would guess the design): per-session `alternativeAttempts`/`regenAttempts`/`probesAsked` counters starving every question after the first (session.ts:22-24, hypothesis.ts:27-31, planner.ts:158); `pruneOnVerdict` annihilating unrelated candidates proposed in one flat batch; cross-kind conjunctions being inexpressible (an `and` Predicate cannot hold a `sumOverCollection`). Write a kickoff doc (repo pattern: docs/superpowers/specs/*-kickoff-prompt.md) instead of patching.
- Slice B2's carried-findings triage (`.superpowers/sdd/carried-findings.md` in the B2 worktree; not committed to this tree) lists ten open items. #5 (Quint conservation/sum lack hop gates) is absorbed into Task 1 Step 4b — it is the same gate family Task 1 owns. The other nine stay with that triage; they are not this plan's mandate.
- Agent 1's proposed new `'retired'` ledger kind is deliberately NOT added: `apply --force-remove` already appends `{kind: 'declined', invariant, reason}` (reconcile.ts:107) and `decline --id --reason` writes the same kind — the defect is that adoption paths never CONSULT it (Task 12), not that the record is missing. A third removal kind would split one meaning across two spellings.

---

## Phase 1 — Finish Quint optionality (findings 1, 2, 6)

### Task 1: Quint hop gates include the optional hop's `Present` flag

`refHopsIn` (src/emit/quint.ts:164) returns hop-target expressions and every caller appends `.exists` — so an optional ref hop is gated only on its *target record's* existence, never on the hop field's own `${f}Present` companion. An absent optional ref still holds a drawn id from the target pool (`initValue`, quint.ts:94-102), so when that id points at a created record, Apalache reads through a hop the state says is absent — diverging from both the TS judge and Alloy. Fix by replacing `refHopsIn` with `refHopGates`, which returns complete **gate atoms** (the `Present` flag for an optional hop, plus `.exists` for every hop target); all five gate sites (quint cmp/present/unique, method-guard cmp/present) then share one derivation and cannot drift.

**Files:**
- Modify: `src/emit/quint.ts` (refHopsIn:164-184, refHopsInTerm:185-192, predToQuint cmp:203-206 and present:221-224, unique arm:307-309)
- Modify: `src/emit/method-guard.ts` (import:4, refHopsInTermParam:37, cmp:53-56, present:63-68)
- Test: `test/emit/quint-optional-hop.test.ts` (new), `test/emit/quint-optional.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `pathToQuint`, `varName`, `owners` (unchanged, src/emit/quint.ts).
- Produces: `export function refHopGates(m: DomainModel, path: Path, self: string, ownerName: string): string[]` — replaces `refHopsIn` (which is deleted). Returns ready-to-conjoin boolean atoms, e.g. for path `['method','fee']` from self `x` where `method: ref Method?`: `['x.methodPresent', 'methods.get(x.method).exists']`. Required hops contribute only the `.exists` atom, so existing emitted strings for required hops are unchanged.

- [ ] **Step 1: Write the failing unit test**

Create `test/emit/quint-optional-hop.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { astToQuint, predToQuint, refHopGates } from '../../src/emit/quint.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate, Predicate } from '../../src/ast/invariant.js';

// Finding: an absent optional ref still holds a drawn id (initValue draws from METHOD_IDS
// regardless of the Present flag), so gating a hop on the TARGET's `.exists` alone lets Apalache
// read through a hop the state says is absent. Every gate must conjoin the hop's own flag.
const m: DomainModel = {
  context: 'HopGate', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [
    { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'fee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'tag', type: { kind: 'prim', prim: 'Int' }, optional: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true }],
    machine: { regions: [{ name: 'intent', initial: 'pending', states: [
      { name: 'pending', tags: ['active'] }] }], transitions: [] } }],
  events: [], services: []
};

describe('refHopGates — optional hop contributes its Present flag', () => {
  it('returns flag + exists for an optional hop, exists only for a required one', () => {
    expect(refHopGates(m, ['method', 'fee'], 'x', 'Payment'))
      .toEqual(['x.methodPresent', 'methods.get(x.method).exists']);
  });

  it('cmp through an optional hop is gated on the flag (implies polarity)', () => {
    const p: Predicate = { kind: 'cmp', op: 'gt',
      left: { kind: 'field', owner: 'self', path: ['method', 'fee'] },
      right: { kind: 'int', value: 0 } };
    expect(predToQuint(m, p, 'x', 'Payment'))
      .toBe('((x.methodPresent and methods.get(x.method).exists) implies (methods.get(x.method).fee > 0))');
  });

  it('present() through an optional hop conjoins the flag (fact polarity)', () => {
    const p: Predicate = { kind: 'present', path: ['method', 'tag'] };
    expect(predToQuint(m, p, 'x', 'Payment'))
      .toBe('((x.methodPresent and methods.get(x.method).exists) and methods.get(x.method).tagPresent)');
  });

  it('unique collision through an optional hop conjoins both rows\' flags', () => {
    const c: Candidate = { kind: 'unique', aggregate: 'Payment',
      whileStates: { region: 'intent', states: ['pending'] }, by: [['method', 'fee']] };
    const em = astToQuint(m, { kind: 'probe-forbid', hi: c, exclusions: [], maxSteps: 0 });
    expect(em.source).toContain('payments.get(k1).methodPresent');
    expect(em.source).toContain('payments.get(k2).methodPresent');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/emit/quint-optional-hop.test.ts`
Expected: FAIL — `refHopGates` is not exported (and the emitted strings lack `methodPresent`).

- [ ] **Step 3: Implement refHopGates and update the five gate sites**

In `src/emit/quint.ts`, replace `refHopsIn` (keep its doc comment, extend it with the flag rationale) and delete the `.exists`-appending in callers:

```typescript
export function refHopGates(m: DomainModel, path: Path, self: string, ownerName: string): string[] {
  const gates: string[] = [];
  let expr = self, owner = ownerName;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const stateMatch = seg.match(/^(\w+)\.state$/);
    if (stateMatch && i === path.length - 1) break;
    const def = owners(m).find(o => o.name === owner)!;
    const f = def.fields.find(x => x.name === seg)!;
    expr = `${expr}.${seg}`;
    if (i < path.length - 1 && f.type.kind === 'ref') {
      // An OPTIONAL hop is absent when its own companion flag is false — the drawn id is
      // placeholder data (initValue draws it regardless), so the flag gates before the target's
      // existence does. The flag lives beside the ref field, hence pre-get-wrap `${expr}Present`.
      if (f.optional) gates.push(`${expr}Present`);
      owner = f.type.target;
      expr = `${varName(owner)}.get(${expr})`;
      gates.push(`${expr}.exists`);
    }
  }
  return gates;
}
```

Rename `refHopsInTerm` → `refHopGatesInTerm` (body: `case 'field': return refHopGates(...)`). Update the three quint.ts sites:

```typescript
// cmp arm (was :203-206):
      const gates = [...refHopGatesInTerm(m, p.left, self, ownerName), ...refHopGatesInTerm(m, p.right, self, ownerName)];
      if (gates.length === 0) return cmp;
      return `((${[...new Set(gates)].join(' and ')}) implies ${cmp})`;
// present arm (was :221-224):
      const gates = refHopGates(m, p.path, self, ownerName);
      if (gates.length === 0) return flag;
      return `((${[...new Set(gates)].join(' and ')}) and ${flag})`;
// unique arm (was :307-309):
    const gates = [...new Set(c.by.flatMap(p => [...refHopGates(m, p, rec('k1'), c.aggregate), ...refHopGates(m, p, rec('k2'), c.aggregate)]))];
    const collides = [`${rec('k1')}.exists`, `${rec('k2')}.exists`, inS('k1'), inS('k2'), ...gates, ...eqs].join(' and ');
```

In `src/emit/method-guard.ts`: import `refHopGates` instead of `refHopsIn`; `refHopsInTermParam` returns `refHopGates(...)` for the field case; in both the cmp arm (:53-56) and present arm (:65-68) replace `.map(h => `${h}.exists`)` with the plain atoms: `[...new Set(gates)].join(' and ')`.

- [ ] **Step 4: Run the new test and the existing quint/method-guard unit tests**

Run: `npx vitest run test/emit/quint-optional-hop.test.ts test/emit/quint-optional.test.ts test/emit/quint-emission-valid.test.ts`
Expected: PASS. (Required-hop strings are unchanged — `refHopGates` emits the same `.exists` atom the old code appended.)

- [ ] **Step 4b: Gate Quint's conservation and sumOverCollection arms too (carried finding #5 from Slice B2)**

The B2 branch's own review carried this sibling gap forward unfixed: `conservation` (quint.ts:386-389) and `sumOverCollection`'s total read (quint.ts:408+) call `pathToQuint` bare — no hop gate at all, so a part/total path that crosses a ref lets Apalache read a never-created (or, post-B2, absent-optional) record's placeholder and convict where the judge permits. Task 1 owns the gate helper, so close it here rather than leave a fourth polarity site ungated. In the conservation arm:

```typescript
  if (c.kind === 'conservation') {
    const parts = c.parts.map(p => pathToQuint(m, p, 'x', c.aggregate)).join(' + ');
    // Same permit polarity as the cmp arm: an ungrounded read is unknown, and unknown facts
    // don't convict — gate the equation, not the quantifier.
    const gates = [...new Set([...c.parts, c.total].flatMap(p => refHopGates(m, p, 'x', c.aggregate)))];
    const eq = `${parts} == ${pathToQuint(m, c.total, 'x', c.aggregate)}`;
    const body = gates.length ? `(${gates.join(' and ')}) implies (${eq})` : eq;
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${body}) })`;
  }
```

Apply the same wrap to the sumOverCollection arm's total-vs-fold comparison (gates from `refHopGates(m, c.total, 'x', c.aggregate)` — the summed child field never crosses a ref hop). Unit test in `test/emit/quint-optional-hop.test.ts`: a conservation candidate whose total path is `['method', 'fee']` (through the optional ref) must emit `x.methodPresent` and the `implies` wrap; one with own-field paths must emit unchanged.

Run: `npx vitest run test/emit/quint-optional-hop.test.ts test/emit/quint-emission-valid.test.ts` — expected: PASS.

- [ ] **Step 5: Add the real-Quint integration test (spurious counterexample dies)**

Append to `test/emit/quint-optional.integration.test.ts`:

```typescript
  // Flags are drawn once at init and never written, so `not(present(method))` as an adopted
  // constraint pins methodPresent=false in every reachable state. Pre-fix, present(method.tag)
  // still evaluated exists∧tagPresent through the placeholder id — Apalache could "violate" Hi
  // with a state whose own flag says the hop is absent. The gate must make that unsat.
  const optHop: DomainModel = {
    context: 'OptHop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'tag', type: { kind: 'prim', prim: 'Int' }, optional: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true }],
      machine: { regions: [{ name: 'intent', initial: 'pending', states: [{ name: 'pending' }] }], transitions: [] } }],
    events: [], services: []
  };
  const methodAbsent: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'not', arg: { kind: 'present', path: ['method'] } } };
  const noTagThroughAbsentMethod: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'not', arg: { kind: 'present', path: ['method', 'tag'] } } };

  it('present() through a flag-false optional hop is FALSE even when the placeholder id resolves', async () => {
    const em = astToQuint(optHop, { kind: 'probe-forbid', hi: noTagThroughAbsentMethod,
      exclusions: [], maxSteps: 2, adopted: [methodAbsent] });
    expect(em.source).toContain('x.methodPresent');   // the new gate atom
    const r = await runQuintVerify(em, { invariant: em.invariantName, maxSteps: 2 });
    expect(r.violated, 'a flag-false hop manufactured a spurious witness').toBe(false);
  }, 180_000);
```

Run: `npx vitest run test/emit/quint-optional.integration.test.ts`
Expected: PASS (all four tests; the pre-existing two prove required-hop behavior is intact).

- [ ] **Step 6: Commit**

```bash
git add src/emit/quint.ts src/emit/method-guard.ts test/emit/quint-optional-hop.test.ts test/emit/quint-optional.integration.test.ts
git commit -m "fix(quint): gate ref-hops on the optional hop's own Present flag, not just target existence"
```

### Task 2: Quint witness decoder interprets `Present` flags

`stateToEntities` (src/solvers/quint-adapter.ts:79-128) copies every record field into `CaseEntity.fields`, including `${f}Present` flags and the placeholder value of a flag-false field. The judge defines absence as a *missing key* (`evaluate.ts` present arm: `!== undefined`), so every Quint witness with an absent optional field is judged as if the field were present with placeholder data. Strip flags in the decoder: a flag-false base field is deleted; flag keys never reach `fields`.

**Files:**
- Modify: `src/solvers/quint-adapter.ts:88-124` (the per-record loop in `stateToEntities`)
- Test: `test/solvers/quint-adapter.test.ts` (extend — follow the file's existing pattern for driving the parser), `test/emit/quint-optional.integration.test.ts:51` (fix a now-wrong assertion)

**Interfaces:**
- Consumes: nothing new. The flag-detection rule needs no model access: no `.lat` prim maps to a Quint `bool` (prims → `int`, enums/refs → `str`), so a boolean-valued key ending in `Present` whose base key exists in the same record can only be the emitted companion.
- Produces: `CaseEntity.fields` for a flag-false optional field contains neither the base key nor the flag key; for a flag-true field it contains the base key only.

- [ ] **Step 1: Write the failing test**

Add to `test/solvers/quint-adapter.test.ts`, following the existing `parseITF` describe blocks (e.g. 'materializes owned-collection children from ITF', line 70):

```typescript
describe('quint adapter strips Present companion flags', () => {
  it('flag-false drops the placeholder value; flag-true drops only the flag', () => {
    const itf = { states: [{
      payments: { '#map': [['p1', {
        exists: true, bal: { '#bigint': '24' }, balPresent: false,
        tip: { '#bigint': '7' }, tipPresent: true,
        intent_state: 'pending',
      }]] },
    }] };
    const w = parseITF(itf, { payments: 'Payment' });
    const p = w.entities.find(e => e.type === 'Payment')!;
    expect('bal' in p.fields, 'flag-false: placeholder must not become a fact').toBe(false);
    expect('balPresent' in p.fields).toBe(false);
    expect(p.fields['tip']).toBe(7);
    expect('tipPresent' in p.fields).toBe(false);
    expect(p.fields['intent.state']).toBe('pending');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/solvers/quint-adapter.test.ts`
Expected: FAIL — `bal`, `balPresent`, `tipPresent` all present in fields.

- [ ] **Step 3: Implement the strip**

In `stateToEntities`, immediately after `if (rec.exists === false) continue;` (line 89), insert:

```typescript
      // `${f}Present` companions (quint.ts presentInitValue): interpret and strip them HERE so the
      // judge sees absence as a missing key — evaluate.ts's present() and cmp both define absence
      // as `undefined`, and a flag-false field's value is placeholder data, not a fact. A boolean
      // is decisive: no .lat prim encodes to bool (prims→int, enums/refs→str), so a bool key
      // ending in 'Present' whose base key exists can only be the companion.
      const presentFlags = new Set<string>();
      const absentBases = new Set<string>();
      for (const [fk, fv] of Object.entries(rec)) {
        if (fk.endsWith('Present') && typeof fv === 'boolean' && fk.slice(0, -'Present'.length) in (rec as any)) {
          presentFlags.add(fk);
          if (fv === false) absentBases.add(fk.slice(0, -'Present'.length));
        }
      }
```

Then add as the first line inside the field loop (after `if (fk === 'exists') continue;`):

```typescript
        if (presentFlags.has(fk) || absentBases.has(fk)) continue;
```

- [ ] **Step 4: Fix the stale integration assertion and run**

`test/emit/quint-optional.integration.test.ts:51` asserts `p!.fields['paymentMethodPresent']).toBe(false)` — post-strip, absence is a missing key. Replace lines 50-51's flag assertion with:

```typescript
    expect(p!.fields['intent.state']).toBe('requiresPaymentMethod');
    expect('paymentMethod' in p!.fields, 'absent optional ref must be a MISSING key for the judge').toBe(false);
    expect('paymentMethodPresent' in p!.fields).toBe(false);
```

Run: `npx vitest run test/solvers/quint-adapter.test.ts test/emit/quint-optional.integration.test.ts test/engine/evaluate-present.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solvers/quint-adapter.ts test/solvers/quint-adapter.test.ts test/emit/quint-optional.integration.test.ts
git commit -m "fix(quint-adapter): strip Present companions so the judge reads absence as a missing key"
```

### Task 3: Reserve the `${f}Present` companion namespace

A model with optional `foo` plus a user field literally named `fooPresent` validates cleanly but emits a duplicate Quint record label (`foo: int, fooPresent: bool, fooPresent: int`) that fails at solve time, far from the declaration (reproduced during review). Reject it at validation.

**Files:**
- Modify: `src/ast/validate.ts` (checkFields, :176-184)
- Test: `test/ast/validate-optional.test.ts` (extend)

**Interfaces:**
- Produces: new diagnostic code `present-name-collision`, fired from `validateModel` (so both `init` and `loadLatText` reject it).

- [ ] **Step 1: Write the failing test**

Add to `test/ast/validate-optional.test.ts` (reuse the file's model-building style):

```typescript
  it('rejects a field named <f>Present beside an optional f (the Quint companion label)', () => {
    const m = modelWith([
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'foo', type: { kind: 'prim', prim: 'Int' }, optional: true },
      { name: 'fooPresent', type: { kind: 'prim', prim: 'Int' } },
    ]);
    const diags = validateModel(m);
    expect(diags.some(d => d.code === 'present-name-collision')).toBe(true);
  });

  it('fooPresent beside a REQUIRED foo stays legal — no companion is emitted', () => {
    const m = modelWith([
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'foo', type: { kind: 'prim', prim: 'Int' } },
      { name: 'fooPresent', type: { kind: 'prim', prim: 'Int' } },
    ]);
    expect(validateModel(m).some(d => d.code === 'present-name-collision')).toBe(false);
  });
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npx vitest run test/ast/validate-optional.test.ts`
Expected: FAIL on the first new test only.

- [ ] **Step 3: Implement**

In `checkFields` (validate.ts:176), inside the `fs.forEach(f => { ... })` alongside the optional-key/list/value checks, add:

```typescript
      if (f.optional && fs.some(g => g.name === `${f.name}Present`))
        out.push({ code: 'present-name-collision',
          message: `${owner}.${f.name}Present collides with the solver companion flag of optional field ${owner}.${f.name} — the Quint encoding emits '${f.name}Present' beside every optional field; rename one of them`,
          at: `${owner}.${f.name}Present` });
```

- [ ] **Step 4: Run and verify**

Run: `npx vitest run test/ast/validate-optional.test.ts test/parse/fromLangium.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ast/validate.ts test/ast/validate-optional.test.ts
git commit -m "fix(validate): reserve the <f>Present companion name beside an optional field"
```

## Phase 2 — Missing-case bugs (findings 3, 5)

### Task 4: Generated-code `present()` — flatten registration and null-safe, NULL-aware rendering

Two bugs in generated invariant checks: (a) `multiSegmentPaths`' `walkPred` (src/generate/render/commands.ts:23-38) has no `present` case, so a present-only ref hop is never registered with `flattenForChecks` and the check reads the raw FK column; (b) `predToTs`'s present arm (src/generate/invariantCheck.ts:26) renders `row.a.b !== undefined`, which throws on an absent ref and — because SQLite encodes absence as `NULL`, not `undefined` — answers *true* for a NULL column even in the single-segment case. Note: main's ad41b47 already added the `present` case to `refReachPaths` in render/tests.ts:175 — that renderer is covered; commands.ts and invariantCheck.ts are not.

**Files:**
- Modify: `src/generate/render/commands.ts:30-38`, `src/generate/invariantCheck.ts:26`
- Test: `src/generate/invariantCheck.test.ts` (extend), `src/generate/generate.test.ts` (extend; fixtures in `src/generate/fixtures.ts`)

**Interfaces:**
- Produces: present renders as `` `${rowVar}.${p.path.join('?.')} != null` `` — `?.` is undefined/null-safe on the hop, `!= null` (loose) treats both SQL `NULL` and a missing key as absent.

- [ ] **Step 1: Write the failing tests**

In `src/generate/invariantCheck.test.ts`:

```typescript
  it('present() is NULL-aware and hop-safe in generated TS', () => {
    const single = predToTs({ kind: 'present', path: ['approvedAmount'] }, 'row');
    expect(single).toBe('row.approvedAmount != null');
    // eslint-disable-next-line no-new-func
    const f = new Function('row', `return ${single};`);
    expect(f({ approvedAmount: null })).toBe(false);   // SQL NULL is absence
    expect(f({ approvedAmount: 0 })).toBe(true);       // falsy zero is a fact

    const hop = predToTs({ kind: 'present', path: ['method', 'fee'] }, 'row');
    expect(hop).toBe('row.method?.fee != null');
    const g = new Function('row', `return ${hop};`);
    expect(g({ method: undefined })).toBe(false);      // absent ref: no throw, answer is false
    expect(g({ method: { fee: 3 } })).toBe(true);
  });
```

In `src/generate/generate.test.ts` (crib a plan from `src/generate/fixtures.ts`; give one aggregate an invariant whose ONLY multi-segment path is inside `present()`):

```typescript
  it('a present()-only ref hop still triggers flattenForChecks', () => {
    // build/extend a fixture plan whose invariant body is {kind:'present', path:['method','fee']}
    const src = renderCommands(planWithPresentOnlyHop);
    expect(src).toContain('flattenForChecks');
  });
```

- [ ] **Step 2: Run to verify both fail**

Run: `npx vitest run src/generate/invariantCheck.test.ts src/generate/generate.test.ts`
Expected: FAIL — present renders `!== undefined` with plain dots; no `flattenForChecks` emitted.

- [ ] **Step 3: Implement**

`src/generate/invariantCheck.ts:26`:

```typescript
    // `?.` survives an absent/NULL ref hop (the exact case present() answers); `!= null` reads
    // SQLite's NULL — not just undefined — as absence, while 0/'' stay facts.
    case 'present': return `${rowVar}.${p.path.join('?.')} != null`;
```

`src/generate/render/commands.ts` walkPred (after the `inState` case):

```typescript
      case 'present': if (p.path.length > 1) paths.push([...p.path]); break;
```

- [ ] **Step 4: Run and verify**

Run: `npx vitest run src/generate/`
Expected: PASS (all generate suites).

- [ ] **Step 5: Commit**

```bash
git add src/generate/invariantCheck.ts src/generate/render/commands.ts src/generate/invariantCheck.test.ts src/generate/generate.test.ts
git commit -m "fix(generate): present() flattens its ref hop and reads SQL NULL as absence"
```

### Task 5: Templates stop authoring rules the absence gates forbid

`matchTemplates` (src/engine/templates.ts) derives monotonic (#8), conservation (#1), unique seeds (#7), and deadline seeds (#11) without filtering optional fields — but `validateCandidate` rejects the same shapes a human proposes (`absence-undecided`: monotonic field, conservation parts/total, unique by-path ends). `init` (src/cli.ts:452-457) adopts template output with no `validateCandidate` pass, so the engine enforces rules its own grammar calls undecided. Fix at the source (filter optional fields out of template matching) and add the belt (init validates everything matchTemplates returns).

**Files:**
- Modify: `src/engine/templates.ts` (lines 22, 26-28, 33, 49-50, 69-78), `src/cli.ts` (init case, after :452)
- Test: `test/engine/templates.test.ts` (extend), `test/cli.test.ts` (extend)

**Interfaces:**
- Produces: new init error `{ error: 'template-out-of-grammar', diagnostics }` — internal-invariant breach, should be unreachable once the filters land.

- [ ] **Step 1: Write the failing tests**

In `test/engine/templates.test.ts` (reuse its model helpers):

```typescript
  it('does not adopt monotonic over an optional @monotonic field (absence-undecided shape)', () => {
    const m = modelWithField({ name: 'approvedAt', type: { kind: 'prim', prim: 'Date' }, optional: true, tags: ['monotonic'] });
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'monotonic')).toBe(false);
  });

  it('skips conservation entirely when any @balance/@total field is optional', () => {
    const m = modelWithFields([
      { name: 'a', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'unsigned'] },
      { name: 'b', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['balance', 'unsigned'] },
      { name: 't', type: { kind: 'prim', prim: 'Money' }, tags: ['total', 'unsigned'] }]);
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'conservation')).toBe(false);
  });

  it('unique seeds never key on an optional ref (by-path would be rejected at propose)', () => {
    const m = modelWithOptionalRefAndActiveState();   // optional same-context ref + an @active state
    const { seeds } = matchTemplates(m);
    expect(seeds.some(s => s.candidate.kind === 'unique')).toBe(false);
  });

  it('every template-authored candidate passes validateCandidate', () => {
    for (const m of allTemplateFixtureModels) {      // every model this test file already builds
      const { adopt, seeds } = matchTemplates(m);
      for (const i of [...adopt, ...seeds])
        expect(validateCandidate(i.candidate, m), i.id).toEqual([]);
    }
  });
```

In `test/cli.test.ts`, an init-level belt test: monkey-model is impossible to build once filters land, so assert the belt exists by shape — init a valid model and confirm no `template-out-of-grammar`; the belt's real value is failing loudly on future template/gate drift.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/engine/templates.test.ts`
Expected: the first three FAIL (candidates are currently derived).

- [ ] **Step 3: Implement the filters**

In `src/engine/templates.ts`:

```typescript
    // line 22 — unique seeds (#7) key on the ref; an optional by-path end is absence-undecided:
    const refs = o.fields.filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type) && !f.optional);

    // lines 26-28 — a conservation law over a maybe-absent part is a DIFFERENT law; skip whole rule:
    const balances = o.fields.filter(f => f.tags?.includes('balance'));
    const total = o.fields.find(f => f.tags?.includes('total'));
    if (balances.length >= 2 && total && ![...balances, total].some(f => f.optional))

    // line 33 — monotonic over an optional path is absence-undecided (grammar.ts:296):
    for (const f of o.fields.filter(f => f.tags?.includes('monotonic') && !f.optional))

    // line 49 — deadline seed reads duration/date paths in a bare cmp; stay conservative:
    const duration = o.fields.find(f => f.type.kind === 'prim' && f.type.prim === 'Duration' && !f.optional);
```

In `findDatePath` (:69-78): add `&& !f.optional` / `&& !x.optional` to the `direct`, ref-hop, and target-date lookups.

In `src/cli.ts` init (after `const { adopt, seeds } = matchTemplates(...)` at :452), add the belt:

```typescript
        // Belt for the filters in templates.ts: the template layer must never author a candidate
        // the grammar rejects from a human. Unreachable if templates.ts and grammar.ts agree —
        // which is exactly the drift this catches.
        const templateDiags = [...adopt, ...seeds].flatMap(i =>
          validateCandidate(i.candidate, m as DomainModel).map(d => ({ ...d, candidate: i.id })));
        if (templateDiags.length) return { error: 'template-out-of-grammar', diagnostics: templateDiags };
```

- [ ] **Step 4: Run the templates suite plus the pipeline tests**

Run: `npx vitest run test/engine/templates.test.ts test/cli.test.ts test/pipeline-from-scratch.test.ts test/golden-trace-d.test.ts`
Expected: PASS. If the belt fires in any existing fixture, a template/gate disagreement slipped the filters — fix templates.ts, never the belt.

- [ ] **Step 5: Commit**

```bash
git add src/engine/templates.ts src/cli.ts test/engine/templates.test.ts test/cli.test.ts
git commit -m "fix(templates): never author candidates the absence gates reject; init validates template output"
```

## Phase 3 — Gate symmetry (findings 4, 7, 8)

### Task 6: refsResolve keeps optional refs — absent skips, dangling convicts

`impliedInvariants` (src/engine/implied.ts:82) excludes optional refs from `refsResolve` entirely, so a *present-but-dangling* optional ref is convicted by nothing (refsResolve is Alloy-vacuous and Quint-unemitted; the TS judge was the sole enforcement and is never asked). The judge's refsResolve arm already skips absent values (`evaluate.ts`: `typeof v === 'string' && !ids.has(v)`), so re-including the field gives guard semantics for free. **Depends on Task 2** — before the adapter strip, an absent optional ref's placeholder id would reach the judge and convict spuriously.

**Files:**
- Modify: `src/engine/implied.ts:82-84`, `docs/language/derived-invariants.md` (the refsResolve row this slice changed)
- Test: `test/engine/implied-optional.test.ts` (extend), `test/emit/quint-optional.test.ts:102-124` (rewrite — it asserts the old exclusion)

**Interfaces:**
- Produces: `refsResolve.fields` once again lists every same-context ref, optional or not.

- [ ] **Step 1: Write the failing tests**

In `test/engine/implied-optional.test.ts`:

```typescript
  it('refsResolve names optional refs — absence is skipped by the judge, dangling convicts', () => {
    const m = paymentWithOptionalMethodModel();   // reuse the file's existing model
    const refs = impliedInvariants(m).find(i => i.candidate.kind === 'refsResolve');
    expect(refs, 'an all-optional-ref owner still derives refsResolve').toBeDefined();
    expect((refs!.candidate as any).fields).toContain('paymentMethod');

    const absent = { entities: [{ type: 'Payment', id: 'p1', fields: { 'intent.state': 'requiresPaymentMethod' } }] };
    expect(evaluateCandidate(refs!.candidate, absent)).toBe('permit');   // absent ≠ orphan

    const dangling = { entities: [{ type: 'Payment', id: 'p1', fields: { paymentMethod: 'pm-404' } }] };
    expect(evaluateCandidate(refs!.candidate, dangling)).toBe('forbid'); // present must resolve
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/engine/implied-optional.test.ts`
Expected: FAIL — no refsResolve derived for the all-optional-ref owner.

- [ ] **Step 3: Implement**

In `src/engine/implied.ts` remove the `!f.optional` conjunct and rewrite the comment:

```typescript
    // Optional refs stay IN refsResolve: the judge's arm skips an absent value (evaluate.ts's
    // `typeof v === 'string'` guard), so absence is never an orphan — but a PRESENT optional ref
    // that dangles is one, and this rule is its only enforcement (Alloy-vacuous, Quint-unemitted).
    // Safe only because quint-adapter strips flag-false placeholders before the judge sees them.
    const sameContextRefFields = o.fields
      .filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type))
      .map(f => f.name);
```

- [ ] **Step 4: Rewrite the stale test block and doc line**

`test/emit/quint-optional.test.ts:102-124` (`impliedInvariants derives no refsResolve for an all-optional-ref owner`): invert it — refsResolve IS derived and names the optional ref; the initial state stays legal because the judge skips absence (assert `evaluateCandidate(refs.candidate, methodlessState) === 'permit'`). Keep the describe-comment honest about where the legality now lives.

In `docs/language/derived-invariants.md`, find the refsResolve entry (this slice rewrote it to say optional refs are excluded) and replace with: optional refs are included; an absent optional ref is not an orphan (the judge skips it), a present one must resolve.

Run: `npx vitest run test/engine/implied-optional.test.ts test/emit/quint-optional.test.ts test/emit/quint-optional.integration.test.ts test/docs-blocks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/implied.ts test/engine/implied-optional.test.ts test/emit/quint-optional.test.ts docs/language/derived-invariants.md
git commit -m "fix(implied): refsResolve keeps optional refs — absent skips, present-but-dangling convicts"
```

### Task 7: `money-sign-contradictory` moves to validateModel

A hand-written `bal : Money @signed @unsigned` loads through `loadLatText` with zero diagnostics and silently drops the non-negative rule (implied.ts filters only on `!@signed`). Undecidedness is legitimately init-only (the language has a default); *contradiction* is ill-formedness on any path. Split the two: contradictory joins `validateModel`, undecided stays init-only.

**Files:**
- Modify: `src/ast/validate.ts` (undecidedMoneySigns :303-330, validateModel), `src/cli.ts` (no change needed — verify), `docs/language/tags.md` (the "at `init`" wording)
- Test: `test/ast/validate-sign.test.ts` (extend), `test/parse/fromLangium.test.ts` (extend)

**Interfaces:**
- Produces: `export function contradictoryMoneySigns(m: DomainModel): Diagnostic[]`; `validateModel` includes its output; `undecidedMoneySigns` no longer reports contradictions (only `money-sign-undecided`).

- [ ] **Step 1: Write the failing tests**

In `test/parse/fromLangium.test.ts` (follow its loadLatText test style):

```typescript
  it('a field tagged both @signed and @unsigned fails to LOAD — contradiction is ill-formed on any path', () => {
    const r = loadLatText(`context D {\n  aggregate Acct {\n    id : Id key\n    bal : Money @signed @unsigned\n  }\n}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some(d => d.code === 'money-sign-contradictory')).toBe(true);
  });
```

In `test/ast/validate-sign.test.ts`: assert `validateModel` reports `money-sign-contradictory` for the both-tagged field, and that `undecidedMoneySigns` on the same model reports NEITHER code (contradiction is no longer its job; a both-tagged field is not undecided).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/parse/fromLangium.test.ts test/ast/validate-sign.test.ts`
Expected: the new tests FAIL (loads clean today).

- [ ] **Step 3: Implement**

Slice B2 rewrote `undecidedMoneySigns` (now validate.ts:447): values are no longer owners (sign is decided at each USE site), and "is a money field" is `carriesMoney` via the shared `moneyFieldPaths` helper (domain.ts) — a `Money` prim or a value type carrying one. Preserve BOTH properties in the split: `contradictoryMoneySigns` must use the same owners list and the same `carriesMoney` predicate, so a use-site contradiction on a value-typed field (`total : Amount @signed @unsigned`) is caught identically to a prim one. Add that value-carrying case to the Step 1 tests alongside the `Money` prim case.

In `src/ast/validate.ts`: extract the owners enumeration + contradictory loop from `undecidedMoneySigns` into:

```typescript
/** @signed+@unsigned on one field contradicts itself regardless of authoring path — unlike
 *  undecidedness (init-only; the language has a Money⇒non-negative default), a contradiction is
 *  never a legal default, so it belongs with the other tag rules in validateModel. */
export function contradictoryMoneySigns(m: DomainModel): Diagnostic[] { /* moved loop */ }
```

`undecidedMoneySigns` keeps only the undecided loop (still excluding both-tagged fields from "undecided", as today). At the end of `validateModel` (before `return out;` at :300), add `out.push(...contradictoryMoneySigns(m));`. Verify `cli.ts:449` needs no change (`validateModel` now carries contradictory; `undecidedMoneySigns` adds undecided).

- [ ] **Step 4: Run the sign, parse, and doc-example suites**

Run: `npx vitest run test/ast/validate-sign.test.ts test/parse/fromLangium.test.ts test/docs-blocks.test.ts test/cli.test.ts`
Expected: PASS (no doc example carries both tags — verified during review).

- [ ] **Step 5: Update tags.md and commit**

In `docs/language/tags.md` (~:57-60), change the contradictory sentence: it is rejected on **load and init both** (`money-sign-contradictory` from validateModel); only *undecidedness* is init-scoped.

```bash
git add src/ast/validate.ts src/cli.ts test/ast/validate-sign.test.ts test/parse/fromLangium.test.ts docs/language/tags.md
git commit -m "fix(validate): @signed+@unsigned is ill-formed on every path, not just init"
```

### Task 8: `declined` invariants leave projections and reconcile's canonical sets

`decline` flips the tracker status (solver queries respect it) but `writeProjections` (src/cli.ts:83) re-derives `impliedInvariants` filtered only against adopted shapes — the declined rule is still presented in `spec.prose.md` as in force — and `canonicalSet` (src/engine/reconcile.ts:49-53) unions all implied rules into the verdict-replay sets. Honor the ledger's latest adopted/declined word per candidate shape.

**Files:**
- Modify: `src/engine/reconcile.ts` (canonicalSet + reconcile :62/:65/:92), `src/cli.ts` (writeProjections :80-98)
- Test: `test/engine/reconcile.test.ts` if present, else `test/cli-apply.test.ts` (extend), `test/cli-decline.test.ts` (extend)

**Interfaces:**
- Produces: `export function declinedShapes(ledger: LedgerEntry[]): Set<string>` (reconcile.ts) — canonical-candidate strings whose LAST adopted/declined ledger entry is `declined`; `canonicalSet(model, explicit, declined?: Set<string>)` gains the optional third param.

- [ ] **Step 1: Write the failing tests**

In `test/cli-decline.test.ts` (extends the existing `decline` describe; `MODEL` and `fakeDeps` already there):

```typescript
  it('a declined rule stays out of prose and out of reconcile canonical sets across apply', async () => {
    await runCommand(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x'], fakeDeps);
    // hand-write the spec the session would print, then apply it back
    const latPath = join(dir, 'spec.lat');
    writeFileSync(latPath, astToCode(MODEL as any, []));
    const r: any = await runCommand(['apply', '--session', dir, '--lat', latPath], fakeDeps);
    expect(r.error).toBeUndefined();
    const prose = readFileSync(join(dir, 'spec.prose.md'), 'utf8');
    expect(prose).not.toContain('nonNegativeAcctBal');
    // and the tracker was not resurrected
    const s = loadState(dir);
    expect(s.candidates.filter(c => c.inv.id === 'implied-nonNegativeAcctBal')).toHaveLength(1);
    expect(s.candidates.find(c => c.inv.id === 'implied-nonNegativeAcctBal')!.status).toBe('declined');
  });
```

Unit-level, wherever reconcile is unit-tested (else a new `test/engine/reconcile-declined.test.ts`):

```typescript
  it('declinedShapes keys on the LAST word per shape', () => {
    const inv = impliedInvariants(MODEL as any)[0]!;
    expect(declinedShapes([{ kind: 'adopted', at: 't1', invariant: inv, provenance: 'x' },
                           { kind: 'declined', at: 't2', invariant: inv, reason: 'r' }]).size).toBe(1);
    expect(declinedShapes([{ kind: 'declined', at: 't1', invariant: inv, reason: 'r' },
                           { kind: 'adopted', at: 't2', invariant: inv, provenance: 'x' }]).size).toBe(0);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/cli-decline.test.ts`
Expected: FAIL — prose contains the declined rule.

- [ ] **Step 3: Implement**

`src/engine/reconcile.ts`:

```typescript
/** Shapes whose LAST adopted/declined ledger word is 'declined' — a decline (pre-verdict command
 *  or --force-remove hand-removal) must silence the rule everywhere derived rules are re-derived:
 *  prose projection and the replay canonical sets. Keyed by canonical candidate shape because
 *  derived rules are re-minted per call and carry no stable identity across sessions. */
export function declinedShapes(ledger: LedgerEntry[]): Set<string> {
  const last = new Map<string, 'adopted' | 'declined'>();
  for (const e of ledger)
    if (e.kind === 'adopted' || e.kind === 'declined') last.set(cjson(e.invariant.candidate), e.kind);
  return new Set([...last].filter(([, k]) => k === 'declined').map(([shape]) => shape));
}

export function canonicalSet(model: DomainModel, explicit: CandidateInvariant[], declined?: Set<string>): CandidateInvariant[] {
  const derived = impliedInvariants(model).filter(d => !declined?.has(cjson(d.candidate)));
  const derivedShapes = new Set(derived.map(d => cjson(d.candidate)));
  return [...explicit.filter(i => !derivedShapes.has(cjson(i.candidate))), ...derived];
}
```

In `reconcile()`: `const declined = declinedShapes(ledger);` after line 59, then pass `declined` as the third arg at all three `canonicalSet` calls (:62 `after`, :65 `rawBefore`, :92 `before`).

`src/cli.ts` `writeProjections` (:83): import `declinedShapes` and filter:

```typescript
  const declined = declinedShapes(ledger);
  const derived = impliedInvariants(model).filter(d =>
    !shapes.has(canonicalCandidate(d.candidate)) && !declined.has(canonicalCandidate(d.candidate)));
```

- [ ] **Step 4: Run decline, apply, and reconcile suites**

Run: `npx vitest run test/cli-decline.test.ts test/cli-apply.test.ts test/engine/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/reconcile.ts src/cli.ts test/cli-decline.test.ts test/engine/
git commit -m "fix(engine): declined invariants leave prose projections and reconcile canonical sets"
```

## Phase 4 — Test coverage (finding 9 + named gaps)

### Task 9: Real-Alloy integration tests for the three optional gate polarities

The Alloy gates (cmp `implies` / present ungated / unique conjunction) are only string-asserted; the "real Alloy proved it" experiments from the session were manual. Encode them, guarded like the existing Alloy integration suite.

**Files:**
- Test: `test/emit/alloy-optional.integration.test.ts` (new)

- [ ] **Step 1: Write the three tests** (they should pass immediately — they pin behavior that already works; the point is regression armor for the gate emission)

```typescript
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runAlloy } from '../../src/solvers/alloy-adapter.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { ALLOY_JAR } from '../../src/solvers/doctor.js';
import { impliedInvariants } from '../../src/engine/implied.js';
import { expressibleAdopted } from '../../src/engine/planner.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';

// Real-solver armor for the three gate polarities (emit/alloy.ts): the session's manual
// "UNSAT before, SAT after" experiments, made repeatable. String tests can't catch a
// precedence/operator slip that real Alloy would silently invert.
const payment: DomainModel = {
  context: 'BillPayments', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'PayMethod', fields: [
    { name: 'pmId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'fee', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'paymentMethod', type: { kind: 'ref', target: 'PayMethod' }, optional: true }],
    machine: { regions: [{ name: 'intent', initial: 'requiresPaymentMethod', states: [
      { name: 'requiresPaymentMethod', tags: ['active'] }, { name: 'succeeded', tags: ['terminal'] }] }],
      transitions: [{ name: 'succeed', region: 'intent', from: ['requiresPaymentMethod'], to: 'succeeded' }] } }],
  events: [], services: []
};

describe.skipIf(!existsSync(ALLOY_JAR))('alloy — optional-field gates (integration, real Alloy)', () => {
  it('cmp gate: a method-less Payment satisfies a fee rule read through the absent hop', async () => {
    const feePositive: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['paymentMethod', 'fee'] }, right: { kind: 'int', value: 0 } } };
    const mustHaveMethod: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'present', path: ['paymentMethod'] } };
    const adopted = [...expressibleAdopted('alloy', impliedInvariants(payment).map(i => i.candidate)), feePositive];
    // A witness violating `present(paymentMethod)` is exactly the method-less Payment; it must be
    // SAT even with feePositive adopted — pre-gate Alloy's empty join made this UNSAT.
    const als = astToAlloy(payment, { kind: 'probe-forbid', hi: mustHaveMethod, exclusions: [], adopted, scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat, 'the method-less Payment must be reachable under a through-hop fee rule').toBe(true);
  }, 120_000);

  it('present() needs no gate: some x.f is already false on the empty relation', async () => {
    const noMethod: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'not', arg: { kind: 'present', path: ['paymentMethod'] } } };
    const als = astToAlloy(payment, { kind: 'probe-permit', hi: noMethod, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat).toBe(true);
  }, 120_000);

  it('unique gate: two method-less Payments do not collide on a through-hop key (none = none must not convict)', async () => {
    const uniqueByFee: Candidate = { kind: 'unique', aggregate: 'Payment',
      whileStates: { region: 'intent', states: ['requiresPaymentMethod'] }, by: [['paymentMethod', 'fee']] };
    const twoActive: Candidate = { kind: 'cardinality', aggregate: 'Payment', atMost: 1,
      where: { kind: 'inState', owner: 'self', region: 'intent', states: ['requiresPaymentMethod'] } };
    // Violating `atMost 1` needs TWO active Payments; with uniqueByFee adopted, that is only SAT
    // if the collision is gated on hop existence — ungated, none = none convicts every pair.
    const als = astToAlloy(payment, { kind: 'probe-forbid', hi: twoActive, exclusions: [], adopted: [uniqueByFee], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat, 'two method-less Payments must be able to coexist under a through-hop unique').toBe(true);
  }, 120_000);
});
```

- [ ] **Step 2: Run (requires the jar; the suite self-skips without it)**

Run: `npx vitest run test/emit/alloy-optional.integration.test.ts`
Expected: PASS (or SKIP if `vendor/alloy.jar` is absent — then run where the jar exists before merging).

- [ ] **Step 3: Commit**

```bash
git add test/emit/alloy-optional.integration.test.ts
git commit -m "test(alloy): real-solver armor for the three optional-hop gate polarities"
```

### Task 10: Close the remaining named coverage gaps

Four gaps from the review, none needing new source code: the init money-sign rejection branch (never executed — every fixture was retro-tagged `@unsigned`), the conservation/sumOverCollection absence-gate sites, the method-guard `present` arm, and a drift-lock between the two Quint renderers.

**Files:**
- Test: `test/cli.test.ts`, `test/ast/grammar-absence.test.ts`, `test/emit/quint-optional-hop.test.ts` (extend all three)

- [ ] **Step 1: init money-sign rejection tests** (in `test/cli.test.ts`, using its tmp-session + fakeDeps pattern)

```typescript
  it('init refuses an undecided Money field', async () => {
    const model = { ...MODEL, aggregates: [{ kind: 'aggregate', name: 'Acct', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'bal', type: { kind: 'prim', prim: 'Money' } }] }] };   // no sign tag
    writeFileSync(modelPath, JSON.stringify(model));
    const r: any = await runCommand(['init', '--session', dir, '--model', modelPath], fakeDeps);
    expect(r.error).toBe('ill-formed-model');
    expect(r.diagnostics.some((d: any) => d.code === 'money-sign-undecided')).toBe(true);
  });

  it('init refuses a contradictory Money field', async () => {
    const model = { ...MODEL, aggregates: [{ kind: 'aggregate', name: 'Acct', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'bal', type: { kind: 'prim', prim: 'Money' }, tags: ['signed', 'unsigned'] }] }] };
    writeFileSync(modelPath, JSON.stringify(model));
    const r: any = await runCommand(['init', '--session', dir, '--model', modelPath], fakeDeps);
    expect(r.error).toBe('ill-formed-model');
    expect(r.diagnostics.some((d: any) => d.code === 'money-sign-contradictory')).toBe(true);
  });
```

- [ ] **Step 2: conservation/sum absence-gate tests** (in `test/ast/grammar-absence.test.ts`, reusing its model + expectation helpers; the messages are at grammar.ts:301, :304, :325)

```typescript
  it.each([
    ['conservation part', { kind: 'conservation', aggregate: 'A', parts: [['optA'], ['reqB']], total: ['reqTotal'] }],
    ['conservation total', { kind: 'conservation', aggregate: 'A', parts: [['reqB'], ['reqC']], total: ['optTotal'] }],
    ['sumOverCollection total', { kind: 'sumOverCollection', aggregate: 'A', collection: 'lines', child: 'Line', field: 'amount', op: 'eq', total: ['optTotal'] }],
  ])('%s over an optional path is absence-undecided', (_label, candidate) => {
    const diags = validateCandidate(candidate as any, modelWithOptionalMoneyFields);
    expect(diags.some(d => d.code === 'absence-undecided')).toBe(true);
  });
```

- [ ] **Step 3: method-guard drift-lock** (in `test/emit/quint-optional-hop.test.ts`) — the two Quint renderers must never disagree on the shared arms:

```typescript
  it('predToQuintParam renders present()/gated cmp byte-identically to predToQuint', () => {
    const preds: Predicate[] = [
      { kind: 'present', path: ['method', 'tag'] },
      { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['method', 'fee'] }, right: { kind: 'int', value: 0 } },
    ];
    for (const p of preds)
      expect(predToQuintParam(m, p, 'x', 'Payment', {})).toBe(predToQuint(m, p, 'x', 'Payment'));
  });
```

- [ ] **Step 4: Run all three files, then the full unit suite**

Run: `npx vitest run test/cli.test.ts test/ast/grammar-absence.test.ts test/emit/quint-optional-hop.test.ts && npx vitest run`
Expected: PASS (integration files self-skip where solvers are absent).

- [ ] **Step 5: Commit**

```bash
git add test/cli.test.ts test/ast/grammar-absence.test.ts test/emit/quint-optional-hop.test.ts
git commit -m "test: cover the init money-sign gate, conservation/sum absence sites, and renderer drift-lock"
```

## Phase 5 — Docs (finding 10 + stale claims)

### Task 11: Reconcile every doc claim the review falsified

Each edit below states the claim to replace and the truth to write; keep each page's voice. `derived-invariants.md` and `tags.md` were already fixed in Tasks 6 and 7.

**Files:**
- Modify: `docs/language/invariant.md`, `docs/language/invariant-forms.md`, `docs/plan.md`, `docs/language/value.md`, `docs/language/entity.md`, `docs/language/aggregate.md`, `docs/getting-started.md`, `docs/language/field-types.md`
- Test: `test/docs-blocks.test.ts` (must stay green)

- [ ] **Step 1: invariant.md — two corrections**

(a) Line ~142 claims `sumOverCollection`'s *summed child field* rejects an optional path with `absence-undecided`. False — no such gate exists in grammar.ts (its comment says so); the shape is prevented by `optional-owned-child` in validateModel. Rewrite the sentence to name only the gates that exist (`unique` by, `monotonic` field, `conservation` parts/total, `sumOverCollection` **total**) and add: the summed child field cannot be optional at all — `optional-owned-child` rejects it at the model level.

(b) Lines ~180-193 ("Every ref-hop in this language resolves vacuously... in all three engines") describe Quint's gate as `allExist implies cmp` over target existence. After Task 1 that paragraph is true again — update the Quint clause to say the gate conjoins **each optional hop's `Present` flag and each hop target's existence**, so the doc matches the code that now honors it.

- [ ] **Step 2: invariant-forms.md §3 (line ~59-61)** — "every `ref` field on the owner must resolve... implied automatically by the presence of any `ref` field". Post-Task 6, refsResolve again covers every same-context ref, but the semantics are guard-form. Rewrite: every **present** ref must resolve; an absent optional ref is not an orphan; implied automatically for every same-context ref field.

- [ ] **Step 3: plan.md catalog row 9 (~line 538)** — align with Step 2's wording: one rule per owner covering all same-context ref fields, absent optional refs exempt by evaluation (not by exclusion), qualified refs excluded.

- [ ] **Step 4: value.md (~line 27)** — "Fields use the same `<camelId> : <type> [@<tag>]*` grammar as an entity's, minus `key`". Add the second difference: "...minus `key` — and minus the optional marker: `<type>?` is entity/aggregate-only; on a value sub-field it reports `optional-value` (see [field types](field-types.md))."

- [ ] **Step 5: entity.md (~lines 88-93) and aggregate.md (~line 60)** — "No solver encoding yet: ... list-typed fields are dropped before solving (quint/alloy)". False (pre-existing): Alloy gives each owned child its own sig with an `owner: one Parent` relation (`emitChildSigs`); Quint encodes a bounded map plus a `<field>Count` companion; `sumOverCollection` is solver-checked against them. Rewrite both passages to describe the actual encodings; keep the true part (candidate paths may not reach *into* a collection except via `sum over`).

- [ ] **Step 6: getting-started.md (~line 65)** — free template invariants list names "no-skip-transition rules"; no such template exists (plan.md row 10 marks ordered-lifecycle deferred — verify row 10's current wording before citing it). Replace the example with two that are real (e.g. terminal-state rules and `@monotonic` bounds), and make the `@balance` mention honest: conservation needs ≥2 `@balance` plus a `@total`.

- [ ] **Step 7: field-types.md — document the new diagnostic** in the optional-fields section: `present-name-collision` (a sibling named `<f>Present` beside an optional `f` collides with the Quint companion flag).

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run test/docs-blocks.test.ts && npx vitest run`
Expected: PASS.

```bash
git add docs/
git commit -m "docs: reconcile optionality claims with the engine (refsResolve, gates, owned collections, free templates)"
```

## Phase 6 — Elicitation-loop integrity (verified findings from two other agents)

### Task 12: Adoption paths consult declined rulings (guard re-adoption bug)

Verified against the code and the slice-2 session report: `adoptGuard` (src/cli.ts:213-219) refuses re-adoption only when a tracker with the same id is currently `adopted`. A guard the human ruled OFF via `apply --force-remove` leaves a `{kind: 'declined'}` ledger entry (reconcile.ts:107) but no tracker at all (apply's rebuild drops adopted trackers, cli.ts:693), so the next bulk-classify auto-strengthen hook (cli.ts:817) re-derives and re-adopts it — observed live with `guard_settle_eq`. The convergence-adoption path (cli.ts:507) has the same blindness for shape-matching re-proposals of a declined rule. **Depends on Task 8** (`declinedShapes`).

**Files:**
- Modify: `src/cli.ts` (adoptGuard :213-219, the next-question convergence adoption ~:495-510)
- Test: `test/cli-strengthen.test.ts` (extend), `test/cli-decline.test.ts` (extend)

**Interfaces:**
- Consumes: `declinedShapes(ledger)` from Task 8 (src/engine/reconcile.ts); `canonicalCandidate` (src/engine/implied.ts).
- Produces: adoptGuard returns null for a guard whose id's last adopted/declined ledger word is `declined`; convergence adoption parks (open-decision `previously-declined`) instead of adopting a shape the ledger last declined.

- [ ] **Step 1: Write the failing tests**

In `test/cli-strengthen.test.ts` (reuse its session/fakeDeps setup — the file already drives the `strengthen` command through `runCommand`):

```typescript
  it('a guard whose last ledger word is declined is NOT re-adopted by strengthen', async () => {
    // Simulate the human ruling: the guard was adopted once, then hand-removed via
    // apply --force-remove, which appends kind:'declined' (reconcile.ts:107).
    const gInv = /* the guard invariant this file's existing strengthen test expects to adopt,
                    built with the same deterministic id `guard-<agg>-<transition>-<op>` */;
    appendLedger(dir, { kind: 'adopted', at: t1, invariant: gInv, provenance: 'strengthen' });
    appendLedger(dir, { kind: 'declined', at: t2, invariant: gInv, reason: 'hand-removed via --force-remove' });

    const r: any = await runCommand([/* the strengthen invocation the existing test uses */], fakeDeps);
    const s = loadState(dir);
    expect(s.candidates.some(c => c.inv.id === gInv.id && c.status === 'adopted'),
      'a human-declined guard must not be re-adopted without a re-ruling').toBe(false);
    expect(readLedger(dir).filter(e => e.kind === 'adopted' && e.invariant.id === gInv.id))
      .toHaveLength(1);   // only the original adoption — no new entry
  });
```

In `test/cli-decline.test.ts`:

```typescript
  it('a re-proposed shape matching a declined rule parks instead of adopting on convergence', async () => {
    await runCommand(['decline', '--session', dir, '--id', 'implied-nonNegativeAcctBal', '--reason', 'x'], fakeDeps);
    // Re-propose the same shape under a fresh agent id, then converge it (single candidate,
    // fakeDeps produce no distinguishing witnesses → nextQuestion returns converged).
    const same = { id: 'agent-1', name: 'balNonNeg2', prior: 0.6, source: 'agent',
      candidate: { kind: 'statePredicate', aggregate: 'Acct',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['bal'] }, right: { kind: 'int', value: 0 } } } };
    writeFileSync(join(dir, 'c.json'), JSON.stringify([same]));
    await runCommand(['propose', '--session', dir, '--candidates', join(dir, 'c.json')], fakeDeps);
    const r: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    const s = loadState(dir);
    expect(s.candidates.find(c => c.inv.id === 'agent-1')!.status).toBe('parked');
    expect(readLedger(dir).some(e => e.kind === 'open-decision' && (e as any).topic === 'previously-declined')).toBe(true);
  });
```

(Fill the two `/* ... */` holes from the existing strengthen test's own fixtures — the guard id and invocation are already built there; do not invent new ones.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/cli-strengthen.test.ts test/cli-decline.test.ts`
Expected: FAIL — the guard is re-adopted; the shape-matching candidate is adopted.

- [ ] **Step 3: Implement**

`adoptGuard` (cli.ts:213), after the same-id-adopted check:

```typescript
  // A guard the human ruled OFF stays off: `decline` and `apply --force-remove` both append a
  // kind:'declined' ledger entry, and re-deriving the same guard from a CTI does not overrule a
  // recorded human ruling. Last word per id wins, so a later hand-re-adoption re-enables it.
  const lastWord = new Map<string, 'adopted' | 'declined'>();
  for (const e of readLedger(dir))
    if (e.kind === 'adopted' || e.kind === 'declined') lastWord.set(e.invariant.id, e.kind);
  if (lastWord.get(gInv.id) === 'declined') return null;
```

Convergence adoption (cli.ts, inside the `next-question` converged branch, before `survivor.status = 'adopted'`):

```typescript
            if (declinedShapes(priorLedger).has(canonicalCandidate(survivor.inv.candidate))) {
              survivor.status = 'parked';
              appendLedger(dir, { kind: 'open-decision', at: now(), topic: 'previously-declined',
                note: `converged candidate ${survivor.inv.name} matches a shape the ledger last declined; needs an explicit human re-ruling` });
              return done({ ...out, warning: 'previously-declined-parked' });
            }
```

(`open-decision` entries carry `topic` + `note` — match the existing `unanchored-survivor` append two lines above.)

- [ ] **Step 4: Run and verify**

Run: `npx vitest run test/cli-strengthen.test.ts test/cli-decline.test.ts test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-strengthen.test.ts test/cli-decline.test.ts
git commit -m "fix(engine): adoption paths consult declined rulings — a ruled-off guard or shape is not re-adopted"
```

### Task 13: Per-candidate anchoring — provenance, unanchored-survivor, and permit evidence share one predicate

Three verified bugs with one root (no notion of per-candidate anchoring): (1) adoption provenance cites every verdict in the session (cli.ts:508) — reproduced: `journalNetsToZero` cited `(w1, w3, w4, w5, w6)` though it was proposed after w6 and none of the five contains a JournalTransaction; (2) the `unanchored-survivor` park checks whether the SESSION has any verdict (cli.ts:498), not whether any verdict anchors THIS candidate, so after the first judged question every lone candidate is adopted unexamined; (3) `hasPermitEvidence` (planner.ts:197) counts a permit verdict whose witness contains zero instances of the candidate's aggregate — `evaluateCandidate` returns `'permit'` vacuously (`subjects().every` over an empty array, evaluate.ts) — suppressing the permit probe.

**Files:**
- Create: `src/engine/anchoring.ts`
- Modify: `src/engine/session.ts` (TrackedCandidate :16), `src/engine/hypothesis.ts` (:8, :38), `src/cli.ts` (:495-510), `src/engine/planner.ts` (:197)
- Test: `test/engine/anchoring.test.ts` (new), `test/cli.test.ts` (extend)

**Interfaces:**
- Produces: `export function anchorsCandidate(v: { at: string; judge: 'permit' | 'forbid'; witness: CaseState }, c: Candidate, registeredAt?: string): boolean` — true iff the verdict is at-or-after the candidate's registration (missing `registeredAt` = pre-upgrade tracker, time filter waived) AND the witness contains ≥1 entity of `c.aggregate`. `TrackedCandidate` gains optional `registeredAt?: string`, stamped at both `s.candidates.push({ inv, status: 'active' })` sites (hypothesis.ts:8 seed admit, :38 propose admit).

- [ ] **Step 1: Write the failing tests**

Create `test/engine/anchoring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { anchorsCandidate } from '../../src/engine/anchoring.js';
import type { Candidate } from '../../src/ast/invariant.js';

const journalLaw: Candidate = { kind: 'statePredicate', aggregate: 'JournalTransaction',
  body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['netAmount'] }, right: { kind: 'int', value: 0 } } };
const refundWitness = { entities: [{ type: 'Refund', id: 'r1', fields: {} }] };
const journalWitness = { entities: [{ type: 'JournalTransaction', id: 'j1', fields: { netAmount: 0 } }] };

describe('anchorsCandidate', () => {
  it('a witness with no instance of the aggregate anchors nothing (vacuous permit is not evidence)', () => {
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: refundWitness }, journalLaw)).toBe(false);
  });
  it('a verdict judged before the candidate existed does not anchor it', () => {
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: journalWitness },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(false);
  });
  it('an at-or-after verdict whose witness contains the aggregate anchors', () => {
    expect(anchorsCandidate({ at: '2026-07-16T12:00:00Z', judge: 'permit', witness: journalWitness },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(true);
  });
  it('a pre-upgrade tracker (no registeredAt) waives the time filter, not the aggregate filter', () => {
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: journalWitness }, journalLaw)).toBe(true);
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: refundWitness }, journalLaw)).toBe(false);
  });
});
```

In `test/cli.test.ts`, the two regression tests Agent 2 named (reuse the file's tmp-session pattern; fakeDeps that return no witnesses make a lone proposed candidate converge on the next `next-question`):

```typescript
  it('a candidate that converged with no anchoring verdict is PARKED even when the session has verdicts', async () => {
    // seed an unrelated verdict (different aggregate), then propose + converge the journal law
    appendLedger(dir, { kind: 'verdict', at: now(), witnessId: 'w1', judge: 'permit', salient: [],
      question: 'q', witness: { entities: [{ type: 'Refund', id: 'r1', fields: {} }] } });
    /* propose journalLaw under id 'agent-j', run next-question to convergence */
    const s = loadState(dir);
    expect(s.candidates.find(c => c.inv.id === 'agent-j')!.status).toBe('parked');
    expect(readLedger(dir).some(e => e.kind === 'open-decision' && (e as any).topic === 'unanchored-survivor')).toBe(true);
  });

  it('adoption provenance cites only anchoring witnesses, never the whole session', async () => {
    /* same setup, but also seed an anchoring verdict w2 whose witness contains the aggregate,
       registered BEFORE proposing (use appendLedger order to make w2 anchor and w1 not) */
    const adoptedEntry = readLedger(dir).find(e => e.kind === 'adopted' && e.invariant.id === 'agent-j') as any;
    expect(adoptedEntry.provenance).toBe('elicited (w2)');   // w1 (foreign aggregate) not cited
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/engine/anchoring.test.ts test/cli.test.ts`
Expected: FAIL — module does not exist; parked/provenance assertions fail.

- [ ] **Step 3: Implement**

`src/engine/anchoring.ts`:

```typescript
import type { Candidate } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';

/** Does this verdict ANCHOR this candidate? Anchoring is what adoption provenance may cite, what
 *  rescues a lone survivor from unanchored-survivor parking, and what counts as permit evidence —
 *  three call sites, one meaning (the review that motivated this found all three had drifted).
 *  A verdict anchors iff (a) it was judged at-or-after the candidate was registered — a candidate
 *  proposed after a verdict cannot have been vetted by it — and (b) its witness contains at least
 *  one instance of the candidate's aggregate: evaluateCandidate is vacuously 'permit' on a witness
 *  with zero subjects, and a vacuous permit is not evidence. Missing registeredAt (pre-upgrade
 *  trackers persisted in state.json) waives the time filter only. */
export function anchorsCandidate(
  v: { at: string; judge: 'permit' | 'forbid'; witness: CaseState },
  c: Candidate, registeredAt?: string,
): boolean {
  if (registeredAt && v.at < registeredAt) return false;   // ISO-8601 strings order lexically
  return v.witness.entities.some(e => e.type === c.aggregate);
}
```

`src/engine/session.ts:16`: `export interface TrackedCandidate { inv: CandidateInvariant; status: CandidateStatus; mergedInto?: string; registeredAt?: string }`.

`src/engine/hypothesis.ts` (:8 and :38): `s.candidates.push({ inv, status: 'active', registeredAt: new Date().toISOString() })` — match however the module currently timestamps (if it imports a `now()` helper, use that).

`src/cli.ts` next-question converged branch — replace the session-level check and the all-verdict wids (:497-509) with:

```typescript
            const anchoring = priorLedger.filter(e => e.kind === 'verdict'
              && anchorsCandidate(e, survivor.inv.candidate, survivor.registeredAt));
            if (anchoring.length === 0) {
              // Converged with zero judged cases ANCHORING THIS CANDIDATE (per-candidate on
              // purpose — a session full of verdicts about other aggregates vets nothing here).
              survivor.status = 'parked';
              appendLedger(dir, { kind: 'open-decision', at: now(), topic: 'unanchored-survivor',
                note: 'converged with no judged cases anchoring this candidate; needs human confirmation' });
              return done({ ...out, warning: 'unanchored-survivor-parked' });
            }
            survivor.status = 'adopted';
            const wids = anchoring.map(e => e.witnessId).join(', ');
```

`src/engine/planner.ts:197`:

```typescript
  const hasPermitEvidence = verdicts(ledger).some(v => v.judge === 'permit'
    && anchorsCandidate(v, H.inv.candidate, H.registeredAt)
    && evaluateCandidate(H.inv.candidate, v.witness) === 'permit');
```

(`H` is a `TrackedCandidate`; if the surrounding code names it differently, keep the local name.)

- [ ] **Step 4: Run the engine and CLI suites**

Run: `npx vitest run test/engine/ test/cli.test.ts test/cli-decline.test.ts test/pipeline-from-scratch.test.ts test/golden-trace-d.test.ts`
Expected: PASS. Golden traces are the canary for over-tightening: if one now parks a survivor it previously adopted, inspect whether its verdicts genuinely anchor the candidate — the trace, not the predicate, decides which is wrong; surface it rather than loosening `anchorsCandidate` silently.

- [ ] **Step 5: Commit**

```bash
git add src/engine/anchoring.ts src/engine/session.ts src/engine/hypothesis.ts src/cli.ts src/engine/planner.ts test/engine/anchoring.test.ts test/cli.test.ts
git commit -m "fix(engine): per-candidate anchoring — provenance, unanchored-survivor, and permit evidence share one predicate"
```

---

## Self-Review Notes

- Task 2 must precede Task 6 (adapter strip before refsResolve re-inclusion) — encoded in Global Constraints and the task text.
- Task 1 renames `refHopsIn` → `refHopGates`; Task 10's drift-lock and Task 1's method-guard edits both reference the new name. `test/emit/quint-optional.integration.test.ts:76`'s exact-string assertion survives (required hops emit the same atom).
- Task 7 makes `validateModel` strictly stricter; `test/docs-blocks.test.ts` is the canary for doc examples (none carry both tags — verified against the working tree during review).
- Task 5's init belt (`template-out-of-grammar`) may surface latent template/gate drift in fixtures beyond the three filtered templates — the instruction is to fix templates.ts, never to weaken the belt.
- Line numbers were verified against the working tree at plan time (branch `claude/lattice-engine-review-91388b`, even with `main` @ 2db1539); re-locate by the quoted code if drift has occurred.
- Phase 6 was added after verifying two external agent reports against the code: Agent 2's findings 1-3 confirmed verbatim (cli.ts:498/:508, planner.ts:197, vacuous permit in evaluate.ts); Agent 1's re-adoption bug confirmed at adoptGuard (cli.ts:213-219) but their "no ledger record" framing corrected — reconcile.ts:107 already records the ruling as kind:'declined', so Task 12 consults it instead of adding a 'retired' kind. Their findings 4-6 are deferred by design (see Global Constraints).
- Task 12's Step 1 intentionally leaves two fixture holes to be filled from test/cli-strengthen.test.ts's OWN existing guard fixtures — inventing a parallel guard fixture would test a different id than the strengthen path mints.
