# Optional Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a model say a fact is sometimes absent (`field : Type?`), make every rule that reads an absent fact say what absence means, and stop `refsResolve` forbidding `Payment`'s own initial state.

**Architecture:** Optionality is a **field property** (`Field.optional`), sitting beside `key`/`const` — not a new `TypeRef` arm. That keeps it out of the 21 files that switch on `type.kind`. Absence semantics are gated, not defaulted: a `present(f)` predicate joins the closed candidate grammar, and an invariant whose path crosses an optional field without a dominating `present(f)` is rejected (`absence-undecided`). Alloy uses native `lone` multiplicity; Quint uses a `${f}Present: bool` companion flag; the TS judge already treats a missing fact as `undefined` and needs no semantic change.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, Langium, Alloy + Quint solvers, fast-check.

**Design:** `docs/superpowers/specs/2026-07-15-optional-fields-design.md` (commit `c307a48`).

## Global Constraints

- **`npx tsc --noEmit -p .` (from `lattice/`) must exit 0.** This is a named gate, not a nicety: Slice A shipped a branch that passed every test and failed compilation for five tasks because no plan step ran it. Run it in **every** task's verification step.
- **The full suite has no known-green baseline on this machine.** The failure set shifts run to run; every failure passes in isolation. **Gate per-file**, and run `bash scripts/cleanup-solvers.sh` (from `lattice/`) before any real-solver file. Argue a failure by whether the change can *reach* the test, never by the suite's verdict.
- **NEVER pipe `vitest` or `tsc` through `tail`/`head` when reading an exit code** — the pipeline returns the pipe's status (you get 0 while the command exits 1). Use:
  `npx vitest run <file> > /tmp/x.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/x.log`
- **All commands run from `lattice/`** unless stated. Repo root is the worktree at `.claude/worktrees/bill-payment-ledger-spec-edffdc`. Never edit `/Users/taras/projects/spec-core/lattice/...` — that is the main checkout with other sessions' work in flight.
- ESM: import paths end in `.js` even for `.ts` files.
- Comment style: comments state constraints the code cannot show. Never narrate what the next line does; never describe the history of your change.
- **Docs must not assert what the code does not do.** Every ```lat block in `docs/language/` is parsed by CI (`test/docs-blocks.test.ts`).
- **Regenerate the parser after any grammar edit:** `npx langium generate` (from `lattice/`). `src/parse/generated/` is gitignored, so a stale generated AST produces confusing missing-export errors from tsc.
- Commit after every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lattice/src/ast/domain.ts` | `Field.optional?: boolean` | 1 |
| `lattice/src/parse/lat.langium` | `?` marker on `FieldDecl` | 1 |
| `lattice/src/parse/fromLangium.ts` | read `?` off the CST into `Field.optional` | 1 |
| `lattice/src/emit/code.ts` | print `Type?` | 1 |
| `lattice/src/ast/validate.ts` | `optional-key`, `optional-list` | 1 |
| `lattice/test/parse/arbitraries.ts` | generator emits optional fields | 1 |
| `lattice/src/ast/invariant.ts` | `{ kind: 'present'; path: Path }` in `Predicate` | 2 |
| `lattice/src/engine/evaluate.ts` | evaluate `present` | 2 |
| `lattice/src/ast/grammar.ts` | `checkPred` handles `present`; **`absence-undecided`** dominance walk | 2, 3 |
| `lattice/src/engine/implied.ts` | derived rules take the guard form | 4 |
| `lattice/src/emit/alloy.ts` | `lone` + `some f` | 5 |
| `lattice/src/emit/quint.ts` | `${f}Present: bool` + `x.fPresent` | 6 |
| `lattice/src/engine/planner.ts`, `src/cli.ts` | absent-field witness → guard/assertion form | 7 |
| `docs/language/field-types.md`, `invariant.md`, `derived-invariants.md` | the language's account of absence | 8 |

**Shippable split:** Tasks 1-6 + 8 deliver optionality with an explicit-absence gate — complete and mergeable on their own (hand-authors write `present()`). **Task 7 is the elicitation half** and is the riskiest work here; if it proves harder than scoped, stop after Task 8 and make Task 7 its own plan. Do not start Task 7 until 1-6 are green.

---

### Task 1: `field : Type?` — surface only, no semantics

**Why:** every field is required (`lat.langium:70`), so a model cannot say a fact is sometimes absent. This task adds only the surface and its two structural rules; nothing yet reads `optional`.

**Files:**
- Modify: `lattice/src/ast/domain.ts:12-18`, `lattice/src/parse/lat.langium:69-70`, `lattice/src/parse/fromLangium.ts:46-55`, `lattice/src/emit/code.ts:7-10,65-68`, `lattice/src/ast/validate.ts`
- Modify: `lattice/test/parse/arbitraries.ts:42-50`
- Test: `lattice/test/ast/validate-optional.test.ts` (new), `lattice/test/parse/roundtrip.test.ts` (existing, via the generator)

**Interfaces:**
- Produces: `Field.optional?: boolean` on `lattice/src/ast/domain.ts`'s `Field`. Printed as `name : Type?` — `?` binds to the type, before `key`/`const`/tags. Diagnostics `optional-key`, `optional-list`.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/ast/validate-optional.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import type { DomainModel, Field } from '../../src/ast/domain.js';

const model = (fields: Field[]): DomainModel => ({
  context: 'Opt', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Thing',
    fields: [{ name: 'thingId', type: { kind: 'prim', prim: 'Id' }, key: true }, ...fields] }],
  events: [], services: []
});

describe('optional fields — structural rules', () => {
  it('accepts an optional prim, ref and enum', () => {
    const m = model([
      { name: 'note', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] },
    ]);
    expect(validateModel(m)).toEqual([]);
  });

  it('rejects an optional key field', () => {
    const m = model([]);
    m.aggregates[0]!.fields[0]!.optional = true;
    expect(validateModel(m).map(d => d.code)).toContain('optional-key');
  });

  it('rejects an optional list', () => {
    const m = model([{ name: 'xs', type: { kind: 'list', of: { kind: 'prim', prim: 'Int' } }, optional: true }]);
    expect(validateModel(m).map(d => d.code)).toContain('optional-list');
  });
});

describe('optional fields — surface round-trips', () => {
  it('parses `Type?` and prints it back', async () => {
    const src = `context Opt {
  aggregate Thing {
    thingId : Id key
    note    : Money? @unsigned
    owner   : ref Other?
  }
  entity Other {
    otherId : Id key
  }
}
`;
    const r = await loadLatText(src);
    if (!r.ok) throw new Error(`expected parse: ${JSON.stringify(r.diagnostics)}`);
    const t = r.model.aggregates.find(a => a.name === 'Thing')!;
    expect(t.fields.find(f => f.name === 'note')!.optional).toBe(true);
    expect(t.fields.find(f => f.name === 'owner')!.optional).toBe(true);
    expect(t.fields.find(f => f.name === 'thingId')!.optional).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/ast/validate-optional.test.ts > /tmp/t1.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t1.log
```
Expected: FAIL — `optional` is not a property of `Field`, and the grammar rejects `Money?`.

- [ ] **Step 3: Add `optional` to the AST**

`lattice/src/ast/domain.ts`, in `interface Field` (after `const?`):

```ts
  optional?: boolean;   // `Type?` — the fact may be absent. Absence is never inferred: an
                        // invariant reading an optional path must say what absence means
                        // (see grammar.ts's absence-undecided).
```

- [ ] **Step 4: Add the `?` marker to the grammar**

`lattice/src/parse/lat.langium:70` — `?` binds to the type, before `key`:

```
FieldDecl:
    name=ID ':' type=LatType (optional?='?')? (key?='key')? (const?='const')? tags+=Tag*;
```

Then regenerate — the generated AST is gitignored, and a stale one gives confusing tsc errors:

```bash
npx langium generate
```

- [ ] **Step 5: Read it off the CST**

`lattice/src/parse/fromLangium.ts`, in `mapFields` (beside the `f.key` line):

```ts
    if (f.optional) field.optional = true;
```

- [ ] **Step 6: Print it**

`lattice/src/emit/code.ts:68` — `?` goes on the type, before `key`:

```ts
    out.push(`${indent}${pad(f.name, w)}: ${typeStr(f)}${f.optional ? '?' : ''}${f.key ? ' key' : ''}${f.const ? ' const' : ''}${f.tags?.length ? ' @' + f.tags.join(' @') : ''}`);
```

Note `typeStr` recurses for `List<T>` (`code.ts:10`) — it passes `{ ...f, type: f.type.of }`, which would carry `optional` inward. That is harmless because `List<T>?` is rejected in Step 7, but `typeStr` itself must not print `?` — only `fieldLines` does.

- [ ] **Step 7: Add the two structural rules**

`lattice/src/ast/validate.ts`, inside `checkFields` (beside the existing `reserved-field-name` / `missing-key` checks), so every owner kind gets them:

```ts
    if (f.optional && f.key)
      out.push({ code: 'optional-key', message: `${owner}.${f.name} is a key field and cannot be optional — identity is never absent`, at: `${owner}.${f.name}` });
    if (f.optional && f.type.kind === 'list')
      out.push({ code: 'optional-list', message: `${owner}.${f.name} is a List and cannot be optional — an absent list and an empty list are the same fact; List<T> already means zero or more`, at: `${owner}.${f.name}` });
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npx vitest run test/ast/validate-optional.test.ts > /tmp/t1.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t1.log
npx tsc --noEmit -p . > /tmp/t1-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t1-tsc.log
```
Expected: both exit 0.

- [ ] **Step 9: Teach the round-trip generator about optionality**

`lattice/test/parse/arbitraries.ts:42-50` — without this, `roundtrip.test.ts` never exercises `Type?` through parse ∘ print. Add an `isOptional` draw beside `isConst`, and set it only where legal (never on a key field; never on a list):

```ts
  return fc.record({
    type,
    isConst: constDrawArb,
    isOptional: fc.boolean(),
    tags: fc.option(fc.constantFrom(['total'], ['balance'], ['signed']), { nil: undefined }),
  }).map(({ type, isConst, isOptional, tags }) => {
    const f: Field = { name, type };
    if (isConst) f.const = true;
    // `?` is illegal on a key field (optional-key) and on a list (optional-list); this generator
    // never emits key fields here, so only the list case needs excluding.
    if (isOptional && type.kind !== 'list') f.optional = true;
    if (tags) f.tags = tags;
    return f;
```

Read the file first — if `fieldArb` is also used to build key fields, gate on that too rather than assuming.

- [ ] **Step 10: Verify the round-trip**

```bash
npx vitest run test/parse/roundtrip.test.ts test/parse/ > /tmp/t1-rt.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t1-rt.log
```
Expected: exit 0. `roundtrip.test.ts:60` runs **200 unseeded fast-check iterations**, so it now explores `Type?` randomly — a failure here is a real parse ∘ print counterexample, but arrives with no reproducible seed. If it fails, re-run to see whether it reproduces, and read the printed counterexample rather than assuming flake.

- [ ] **Step 11: Verify nothing else broke**

```bash
npx vitest run test/ast/ test/parse/ test/emit/ test/docs-blocks.test.ts > /tmp/t1-all.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t1-all.log
```
Expected: exit 0 with **no doc edits** — no existing `.lat` uses `?`, so every doc block must still parse untouched.

- [ ] **Step 12: Commit**

```bash
git add lattice/src/ast/domain.ts lattice/src/parse/lat.langium lattice/src/parse/fromLangium.ts lattice/src/emit/code.ts lattice/src/ast/validate.ts lattice/test/ast/validate-optional.test.ts lattice/test/parse/arbitraries.ts
git commit -m "feat(lang): optional fields — \`field : Type?\`

Every field was required, so a model could not say a fact is sometimes absent.
Optionality is a field property beside key/const, not a TypeRef arm — it stays
out of the 21 files that switch on type.kind.

Surface and structure only: nothing reads \`optional\` yet. A key field cannot be
optional (identity is never absent) and a List cannot be (an absent list and an
empty list are the same fact; List<T> already means zero or more)."
```

---

### Task 2: `present(f)` joins the closed candidate grammar

**Why:** absence must be sayable before it can be required. `present(f)` is what the **engine** writes (Task 7) and what a hand-author writes when the diagnostic (Task 3) fires.

**Files:**
- Modify: `lattice/src/ast/invariant.ts:15-21`, `lattice/src/engine/evaluate.ts`, `lattice/src/ast/grammar.ts:205-211`, `lattice/src/emit/code.ts`, `lattice/src/parse/lat.langium`, `lattice/src/parse/fromLangium.ts`
- Test: `lattice/test/engine/evaluate-present.test.ts` (new)

**Interfaces:**
- Consumes: `Field.optional` (Task 1).
- Produces: `{ kind: 'present'; path: Path }` in `Predicate` (`ast/invariant.ts`). Surface syntax `present(<path>)`. Evaluates true iff the path resolves to a defined value.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/evaluate-present.test.ts`. **Read `test/engine/evaluate.test.ts` first and copy its `CaseState` construction exactly** — do not invent a fixture shape:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Refund', fields: [
    { name: 'refundId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    { name: 'approvedAmount', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] }] }],
  events: [], services: []
};

// present(approvedAmount) && approvedAmount > 0
const cand: Candidate = { kind: 'statePredicate', aggregate: 'Refund',
  body: { kind: 'and', args: [
    { kind: 'present', path: ['approvedAmount'] },
    { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['approvedAmount'] }, right: { kind: 'int', value: 0 } }] } };

describe('present()', () => {
  it('is false when the field is absent, so the conjunction fails', () => {
    const s = { entities: [{ type: 'Refund', id: 'r1', fields: { amount: 100 } }] } as any;
    expect(evaluateCandidate(cand, m, s)).toBe(false);
  });

  it('is true when the field is present, and defers to the comparison', () => {
    const s = { entities: [{ type: 'Refund', id: 'r1', fields: { amount: 100, approvedAmount: 40 } }] } as any;
    expect(evaluateCandidate(cand, m, s)).toBe(true);
  });

  it('an absent field alone still does not convict a bare comparison', () => {
    const bare: Candidate = { kind: 'statePredicate', aggregate: 'Refund',
      body: { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['approvedAmount'] }, right: { kind: 'int', value: 0 } } };
    const s = { entities: [{ type: 'Refund', id: 'r1', fields: { amount: 100 } }] } as any;
    expect(evaluateCandidate(bare, m, s)).toBe(true);   // evaluate.ts:45 — unknown facts don't convict
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/engine/evaluate-present.test.ts > /tmp/t2.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t2.log
```
Expected: FAIL — `'present'` is not a member of `Predicate`.

- [ ] **Step 3: Add `present` to the closed grammar**

`lattice/src/ast/invariant.ts`, in the `Predicate` union:

```ts
  | { kind: 'present'; path: Path }
```

The file's header comment says growing this union is "a versioned act, not implicit" — that is what this task is.

- [ ] **Step 4: Evaluate it**

`lattice/src/engine/evaluate.ts`, in `evalPred`'s switch (beside `case 'cmp'`):

```ts
    // The one predicate that reads absence as a FACT rather than as an unknown: `cmp` treats a
    // missing operand as unknown and returns true (line 45), which is why an invariant over an
    // optional field needs this to say anything at all.
    case 'present': return evalTerm({ kind: 'field', owner: 'self', path: p.path }, self, s) !== undefined;
```

Check `evalTerm`'s real signature before writing this — match it exactly.

- [ ] **Step 5: Accept it in the candidate validator**

`lattice/src/ast/grammar.ts`, in `checkPred`'s switch:

```ts
      case 'present': checkPath(p.path, at); break;
```

`checkPath` will reject a `Text`/`Id` path with `unrepresentable-path` — correct: those are structural-only, so `present()` over them is meaningless to the solver.

- [ ] **Step 6: Parse and print it**

`lattice/src/parse/lat.langium` — add to the predicate grammar (find the atom/primary rule that `PredicateBody` bottoms out in, and add an alternative beside the comparison and `state … in {…}` forms):

```
PresentPred:
    'present' '(' path=PathExpr ')';
```

Add `PresentPred` to the atom alternatives, then `npx langium generate`.

`lattice/src/parse/fromLangium.ts` — map it to `{ kind: 'present', path: … }` using the same path mapper the comparison arm uses.

`lattice/src/emit/code.ts` — in the predicate printer:

```ts
    case 'present': return `present(${p.path.join('.')})`;
```

Find the existing `predToText`/`prec` functions and add the case in the same style; `present(…)` is an atom, so give it the tightest precedence (like a comparison).

- [ ] **Step 7: Run tests to verify they pass**

```bash
npx vitest run test/engine/evaluate-present.test.ts test/engine/ test/parse/ test/emit/ > /tmp/t2b.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t2b.log
npx tsc --noEmit -p . > /tmp/t2-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t2-tsc.log
```
Expected: both exit 0. **tsc is the real gate here** — adding a `Predicate` arm breaks every exhaustive switch over it, and the compiler is what finds them. Fix each one it names; do not add a `default:` to silence it.

- [ ] **Step 8: Commit**

```bash
git add lattice/src/ast/invariant.ts lattice/src/engine/evaluate.ts lattice/src/ast/grammar.ts lattice/src/parse/lat.langium lattice/src/parse/fromLangium.ts lattice/src/emit/code.ts lattice/test/engine/evaluate-present.test.ts
git commit -m "feat(grammar): present(f) predicate — absence as a fact, not an unknown

Growing the closed candidate grammar is a versioned act; this is that act.

cmp treats a missing operand as unknown and returns true (evaluate.ts:45), so
an invariant over an optional field cannot say anything about absence without
a predicate that reads it as a fact. present(f) is that predicate."
```

---

### Task 3: `absence-undecided` — the gate

**Why:** extending "unknown facts don't convict" to optional fields silently makes absence *satisfy* rules. `approvedAmount <= amount` is right to skip an unapproved refund; `succeeded => approvedAmount > 0` is **wrong** to pass one. The two are indistinguishable in the spec text. The engine refuses to pick.

**Files:**
- Modify: `lattice/src/ast/grammar.ts` (near `checkPath`, `:159`)
- Test: `lattice/test/ast/grammar-absence.test.ts` (new)

**Interfaces:**
- Consumes: `Field.optional` (Task 1), `{ kind: 'present' }` (Task 2), `resolveFieldPath(m, ownerName, path, out?) => Field | null` (`grammar.ts:18`).
- Produces: diagnostic `absence-undecided` from `validateCandidate`.

**The rule.** An optional path read by a `cmp` (or a `unique` `by`, or `conservation`/`sumOverCollection` path) must be **dominated** by a `present()` for that same path. Dominance is deliberately syntactic and conservative — widen it later if evidence demands:

- the invariant's `where` guard contributes its `present()` atoms to the covered set for the whole body;
- inside an `and`, every `present(x)` conjunct covers `x` for **all** other conjuncts (`&&` is symmetric, so `present(f) && f > 0` and `f > 0 && present(f)` both cover);
- inside an `implies`, the antecedent's `present()` atoms cover the consequent;
- `or` covers nothing (either side may be read when the other is false);
- `not` covers nothing.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/ast/grammar-absence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateCandidate } from '../../src/ast/grammar.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate, Predicate } from '../../src/ast/invariant.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Refund', fields: [
    { name: 'refundId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    { name: 'approvedAmount', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] }] }],
  events: [], services: []
};
const approved = (): Predicate => ({ kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['approvedAmount'] }, right: { kind: 'int', value: 0 } });
const sp = (body: Predicate, where?: Predicate): Candidate => ({ kind: 'statePredicate', aggregate: 'Refund', ...(where ? { where } : {}), body });
const codes = (c: Candidate) => validateCandidate(c, m).map(d => d.code);

describe('absence-undecided', () => {
  it('rejects a bare read of an optional field', () =>
    expect(codes(sp(approved()))).toContain('absence-undecided'));

  it('accepts it under a where-guard present()', () =>
    expect(codes(sp(approved(), { kind: 'present', path: ['approvedAmount'] }))).toEqual([]));

  it('accepts present(f) && f > 0', () =>
    expect(codes(sp({ kind: 'and', args: [{ kind: 'present', path: ['approvedAmount'] }, approved()] }))).toEqual([]));

  it('accepts f > 0 && present(f) — && is symmetric', () =>
    expect(codes(sp({ kind: 'and', args: [approved(), { kind: 'present', path: ['approvedAmount'] }] }))).toEqual([]));

  it('accepts present(f) => f > 0', () =>
    expect(codes(sp({ kind: 'implies', left: { kind: 'present', path: ['approvedAmount'] }, right: approved() }))).toEqual([]));

  it('rejects present(f) || f > 0 — either side may be read when the other is false', () =>
    expect(codes(sp({ kind: 'or', args: [{ kind: 'present', path: ['approvedAmount'] }, approved()] }))).toContain('absence-undecided'));

  it('does not fire for a required field', () => {
    const req: Candidate = sp({ kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } });
    expect(codes(req)).toEqual([]);
  });

  it('fires for an optional path in a unique by-clause', () => {
    const u: Candidate = { kind: 'unique', aggregate: 'Refund',
      whileStates: { region: 'r', states: ['s'] }, by: [['approvedAmount']] };
    expect(validateCandidate(u, m).map(d => d.code)).toContain('absence-undecided');
  });
});
```

The last test's model has no machine, so it will also report `unknown-region` — assert with `toContain`, not `toEqual`, exactly as written.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/ast/grammar-absence.test.ts > /tmp/t3.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t3.log
```
Expected: FAIL — no `absence-undecided` is ever emitted.

- [ ] **Step 3: Implement the dominance walk**

In `lattice/src/ast/grammar.ts`, inside `validateCandidate` (it already closes over `m`, `c`, `out`). Add above `checkPred`:

```ts
  // An optional field's absence is a fact the model must account for, never a default it inherits:
  // `cmp` returns true on a missing operand ("unknown facts don't convict", evaluate.ts), so a rule
  // reading an optional path without a dominating present() is satisfied BY absence — right for
  // `approvedAmount <= amount`, silently wrong for `succeeded => approvedAmount > 0`, and identical
  // in the spec text either way. Dominance is syntactic and conservative on purpose; widen it only
  // on evidence.
  const isOptionalPath = (p: Path): boolean => {
    const f = resolveFieldPath(m, c.aggregate, p);
    return !!f?.optional;
  };
  const presentsIn = (p: Predicate): string[] => {
    switch (p.kind) {
      case 'present': return [p.path.join('.')];
      case 'and': return p.args.flatMap(presentsIn);
      default: return [];
    }
  };
  const optionalPathsInTerm = (t: Term): Path[] => {
    switch (t.kind) {
      case 'field': return isOptionalPath(t.path) ? [t.path] : [];
      case 'plus': return [...optionalPathsInTerm(t.left), ...optionalPathsInTerm(t.right)];
      default: return [];
    }
  };
  const checkAbsence = (p: Predicate, covered: Set<string>, at: string): void => {
    switch (p.kind) {
      case 'cmp': {
        for (const path of [...optionalPathsInTerm(p.left), ...optionalPathsInTerm(p.right)])
          if (!covered.has(path.join('.')))
            out.push({ code: 'absence-undecided', message: `path ${path.join('.')} is optional — say what absence means: guard the rule with present(${path.join('.')}), or assert it with present(${path.join('.')}) && …`, at });
        break;
      }
      case 'and': {
        const inner = new Set([...covered, ...p.args.flatMap(presentsIn)]);
        p.args.forEach((a, i) => checkAbsence(a, inner, `${at}.and[${i}]`));
        break;
      }
      case 'implies':
        checkAbsence(p.left, covered, `${at}.if`);
        checkAbsence(p.right, new Set([...covered, ...presentsIn(p.left)]), `${at}.then`);
        break;
      case 'or': p.args.forEach((a, i) => checkAbsence(a, covered, `${at}.or[${i}]`)); break;
      case 'not': checkAbsence(p.arg, covered, at); break;
      case 'present': case 'inState': break;
    }
  };
```

Then call it from the `switch (c.kind)` block, alongside the existing `checkPred` calls:

```ts
    case 'statePredicate': {
      if (c.where) checkPred(c.where, 'where');
      checkPred(c.body, 'body');
      checkAbsence(c.body, new Set(c.where ? presentsIn(c.where) : []), 'body');
      break;
    }
    case 'unique':
      checkStates(c.whileStates.region, c.whileStates.states, 'whileStates');
      c.by.forEach((p, i) => {
        checkPath(p, `by[${i}]`);
        if (isOptionalPath(p)) out.push({ code: 'absence-undecided', message: `by[${i}] path ${p.join('.')} is optional — a unique-by cannot say what absence means; make the field required or drop it from the by-clause`, at: `by[${i}]` });
      });
      break;
```

Do the same for `conservation`'s `parts`/`total` paths and `sumOverCollection`'s `total`: an optional path there is `absence-undecided` with the unique-style message, since those forms have no predicate to guard.

No new imports are needed — `grammar.ts:1` already imports `Path`, `Predicate` and `Term` from `./invariant.js`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/ast/grammar-absence.test.ts test/ast/ > /tmp/t3b.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t3b.log
npx tsc --noEmit -p . > /tmp/t3-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t3-tsc.log
```
Expected: both exit 0.

- [ ] **Step 5: Verify the gate reaches nothing that exists today**

```bash
npx vitest run test/engine/ test/cli.test.ts test/pipeline-from-scratch.test.ts > /tmp/t3c.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t3c.log
```
Expected: exit 0 with **no fixture edits**. No current fixture has an optional field, so `absence-undecided` must fire zero times. If it fires, `isOptionalPath` is wrong — fix it, do not edit the fixture.

- [ ] **Step 6: Commit**

```bash
git add lattice/src/ast/grammar.ts lattice/test/ast/grammar-absence.test.ts
git commit -m "feat(grammar): absence-undecided — an optional read must say what absence means

cmp returns true on a missing operand, so a rule reading an optional path is
satisfied BY absence. That is correct for 'approvedAmount <= amount' and
silently wrong for 'succeeded => approvedAmount > 0' — and the two are
identical in the spec text. Rejected at checkPath's choke point, which propose
and admit both pass through.

Dominance is syntactic and conservative: a where-guard covers the body; && is
symmetric; an antecedent covers its consequent; || and ! cover nothing."
```

---

### Task 4: Derived invariants take the guard form

**Why:** `refsResolve` is auto-derived for every owner with a same-context ref, so today `Payment.paymentMethod` being required means **the model forbids its own `requiresPaymentMethod` initial state**. The engine writes derived rules; there is no author to ask; and for these families the guard form is the only meaningful reading — an absent amount is not a negative one, and an absent ref is not an orphan. Forced, not chosen.

**Files:**
- Modify: `lattice/src/engine/implied.ts`
- Test: `lattice/test/engine/implied-optional.test.ts` (new)

**Interfaces:**
- Consumes: `Field.optional`, `{ kind: 'present' }`.
- Produces: `nonNegative<Owner><Field>` over an optional Money is `present(f) => f >= 0`. `refsResolve<Owner>`'s `fields` list **excludes** optional refs.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/implied-optional.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { impliedInvariants } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [{ name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
    { name: 'bill', type: { kind: 'ref', target: 'Method' } },
    { name: 'approved', type: { kind: 'prim', prim: 'Money' }, optional: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
  events: [], services: []
};

describe('derived invariants over optional fields', () => {
  const d = impliedInvariants(m);

  it('refsResolve excludes an optional ref — absent is not an orphan', () => {
    const r = d.find(i => i.name === 'refsResolvePayment')!;
    expect(r.candidate).toEqual({ kind: 'refsResolve', aggregate: 'Payment', fields: ['bill'] });
  });

  it('nonNegative over an optional Money is guarded, not asserted', () => {
    const n = d.find(i => i.name === 'nonNegativePaymentApproved')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'implies',
        left: { kind: 'present', path: ['approved'] },
        right: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['approved'] }, right: { kind: 'int', value: 0 } } } });
  });

  it('nonNegative over a required Money is unchanged', () => {
    const n = d.find(i => i.name === 'nonNegativePaymentAmount')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/engine/implied-optional.test.ts > /tmp/t4.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t4.log
```
Expected: FAIL — `refsResolvePayment` lists both refs; `nonNegativePaymentApproved` is a bare `cmp`.

- [ ] **Step 3: Guard the derived non-negative**

`lattice/src/engine/implied.ts` — `nonNegativeBody` currently returns the bare comparison. Wrap it for optional fields at the call site in `impliedInvariants`, keeping `nonNegativeBody` itself as the unguarded comparison (`templates.ts` no longer imports it — Slice A's delegation left `impliedInvariants` its only consumer):

```ts
    for (const f of nonNegativeMoneyFields(o))
      out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`,
        { kind: 'statePredicate', aggregate: o.name,
          // An absent amount is not a negative one. The assertion form would make every optional
          // Money mandatory and defeat optionality, so the guard form is forced, not chosen.
          body: f.optional
            ? { kind: 'implies', left: { kind: 'present', path: [f.name] }, right: nonNegativeBody(f.name) }
            : nonNegativeBody(f.name) }));
```

- [ ] **Step 4: Exclude optional refs from refsResolve**

Same file, the `sameContextRefFields` line — an absent ref is not an orphan:

```ts
    const sameContextRefFields = o.fields
      .filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type) && !f.optional)
      .map(f => f.name);
```

This is the `Payment.paymentMethod` fix: the model stops forbidding its own initial state.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/engine/implied-optional.test.ts test/engine/ > /tmp/t4b.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t4b.log
npx tsc --noEmit -p . > /tmp/t4-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t4-tsc.log
```
Expected: both exit 0. `templates.ts` adopts `impliedInvariants`' output verbatim (Slice A), so this change flows to the template layer with no edit there — confirm by reading `templates.ts`'s opening, do not assume.

- [ ] **Step 6: Commit**

```bash
git add lattice/src/engine/implied.ts lattice/test/engine/implied-optional.test.ts
git commit -m "fix(engine): derived rules take the guard form over optional fields

refsResolve is auto-derived for every ref-bearing owner, so a required
Payment.paymentMethod made the model forbid its own requiresPaymentMethod
initial state. An absent ref is not an orphan; an absent amount is not a
negative one.

The engine writes these rules and has no author to ask, but no judgement is
available either: the assertion form would make every optional field mandatory
and defeat optionality. Guard form is forced, not chosen."
```

---

### Task 5: Alloy — `lone` and `some f`

**Why:** `alloy.ts:40-43` emits every field as `one X`, which is why `refsResolve` is a no-op there (`:149`: "refs are total in Alloy sigs by construction — vacuously true"). Optionality is Alloy's native `lone`.

**Files:**
- Modify: `lattice/src/emit/alloy.ts:33-60`, plus its predicate emitter
- Test: `lattice/test/emit/alloy-optional.test.ts` (new)

**Interfaces:**
- Consumes: `Field.optional`, `{ kind: 'present' }`.
- Produces: optional fields emit `lone`; `present(f)` emits `some <self>.f`.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/emit/alloy-optional.test.ts`. **Read `test/emit/` first for how existing tests assert on emitted Alloy source** and match that style:

```ts
import { describe, it, expect } from 'vitest';
import { astToAlloy } from '../../src/emit/alloy.js';
import type { DomainModel } from '../../src/ast/domain.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [{ name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'approved', type: { kind: 'prim', prim: 'Money' }, optional: true }] }],
  events: [], services: []
};

describe('alloy — optional fields', () => {
  const src = astToAlloy(m, { candidate: { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'present', path: ['approved'] } } } as any);

  it('emits lone for an optional ref and an optional prim', () => {
    expect(src).toContain('method: lone Method');
    expect(src).toContain('approved: lone Int');
  });

  it('leaves required fields as one', () => expect(src).toContain('amount: one Int'));

  it('emits present(f) as `some`', () => expect(src).toMatch(/some\s+\w+\.approved/));
});
```

The `astToAlloy` second argument is a query object — read its real shape (`AlloyQuery` or similar in `alloy.ts`) and construct it properly rather than casting `as any` if the type allows.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/emit/alloy-optional.test.ts > /tmp/t5.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t5.log
```
Expected: FAIL — everything is `one`; `present` throws or emits nothing.

- [ ] **Step 3: Emit `lone` for optional fields**

`lattice/src/emit/alloy.ts`, in `emitOwnerSig` — introduce the multiplicity once and use it in each arm:

```ts
  for (const f of o.fields) {
    if (f.key) continue;
    // Alloy's native multiplicity is exactly this language's optionality: `lone` is zero-or-one.
    // Required refs stay `one`, which is why refsResolve remains vacuous here (see its emitter).
    const mult = f.optional ? 'lone' : 'one';
    if (f.type.kind === 'ref') {
      const target = f.type.target;
      if (isQualifiedRef(f.type)) continue;
      fields.push(`  ${f.name}: ${mult} ${target}`);
    }
    else if (f.type.kind === 'enum') fields.push(`  ${f.name}: ${mult} ${f.type.enum}`);
    else if (f.type.kind === 'prim' && isIntPrim(f.type.prim)) fields.push(`  ${f.name}: ${mult} Int`);
```

Leave the `value` arm's flattened sub-fields as `one` — a value type is keyless and flat, and `Type?` on a value field is out of this slice's evidence; if the sub-field loop is reached with `f.optional`, that is a case no test covers, so leave it `one` rather than guess.

- [ ] **Step 4: Emit `present(f)`**

Same file, in the predicate emitter (beside `case 'inState'`):

```ts
    case 'present': return `some ${v}.${p.path.join('.')}`;
```

Use whatever the local subject variable is named in that function (the `inState` arm shows it) — do not invent `v`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/emit/alloy-optional.test.ts test/emit/ > /tmp/t5b.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t5b.log
npx tsc --noEmit -p . > /tmp/t5-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t5-tsc.log
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add lattice/src/emit/alloy.ts lattice/test/emit/alloy-optional.test.ts
git commit -m "feat(alloy): lone multiplicity for optional fields; present(f) is some

Alloy's native multiplicity is exactly this language's optionality. Required
fields stay one, so refsResolve remains vacuous in Alloy — unchanged."
```

---

### Task 6: Quint — the `Present` companion flag

**Why:** Quint has no Option type — `fieldQType` maps fields to plain `int`/`str` (`quint.ts:43`). The codebase already carries existence beside data twice: `exists: bool` for instances (`quint.ts:123-127`) and `${collection}Count: int` for owned collections (`quint.ts:264`). This is the same pattern.

**This task carries the headline guard.** It must be tested on the **Quint** path: Alloy never enforced `refsResolve` (`alloy.ts:149` emits `pred { }`), so an Alloy-only test would pass before the fix and prove nothing.

**Files:**
- Modify: `lattice/src/emit/quint.ts` (`fieldQType`, `initValue`, `emitOwnerSig`, the predicate emitter)
- Test: `lattice/test/emit/quint-optional.test.ts` (new)

**Interfaces:**
- Consumes: `Field.optional`, `{ kind: 'present' }`.
- Produces: an optional field emits its own type **plus** a sibling `${f.name}Present: bool`. `present(f)` emits `<self>.${f}Present`.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/emit/quint-optional.test.ts`. **Read `test/emit/quint-classify.test.ts` first** for how these tests build a query and assert on emitted source:

```ts
import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import type { DomainModel } from '../../src/ast/domain.js';

const m: DomainModel = {
  context: 'Opt', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'Method', fields: [{ name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
  events: [], services: []
};

describe('quint — optional fields', () => {
  const out = astToQuint(m, { candidate: { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'present', path: ['method'] } } } as any);
  const src = out.source;

  it('emits a Present companion flag beside the field', () => {
    expect(src).toContain('methodPresent: bool');
    expect(src).toContain('method: str');
  });

  it('emits no companion for a required field', () => expect(src).not.toContain('amountPresent'));

  it('emits present(f) as the flag', () => expect(src).toMatch(/\w+\.methodPresent/));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/emit/quint-optional.test.ts > /tmp/t6.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t6.log
```
Expected: FAIL — no companion flag; `present` throws.

- [ ] **Step 3: Emit the companion flag**

`lattice/src/emit/quint.ts` — wherever `fieldQType` is consumed to build the record type and the init value (`emitOwnerSig` and `initValue`), emit a sibling `bool` for optional fields. Read those two functions fully before editing: `fieldQType` returns `null` for Text/Id, and a field with no quint type must **not** get a companion flag either (a flag for a field the solver cannot see is a promise the engine cannot keep — the same reason `Id?` is structural-only).

The record type gains `${f.name}Present: bool` beside `${f.name}: <t>`; `initValue` gains a nondeterministic `bool` for it, mirroring how the field's own nondet value is drawn.

- [ ] **Step 4: Emit `present(f)`**

Same file, in `predToQuint`'s switch:

```ts
    case 'present': return `${self}.${p.path.join('_')}Present`;
```

Check how `pathToQuint` joins multi-segment paths before writing this — a one-hop path is the only case this slice's evidence needs, and a ref-hop into an optional field is a case no test covers. If `pathToQuint` handles it, reuse it rather than hand-joining.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/emit/quint-optional.test.ts test/emit/ > /tmp/t6b.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t6b.log
npx tsc --noEmit -p . > /tmp/t6-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t6-tsc.log
```
Expected: both exit 0.

- [ ] **Step 6: Write the headline guard — the `Payment.paymentMethod` fix, end to end**

Append to `lattice/test/emit/quint-optional.test.ts`. This is the test the whole slice exists for: a `Payment` in `requiresPaymentMethod` with no payment method must be a **legal instance**.

```ts
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';   // check the real export name first
import { impliedInvariants } from '../../src/engine/implied.js';

describe('the Payment.paymentMethod fix (quint path — Alloy never enforced refsResolve)', () => {
  const payment: DomainModel = {
    context: 'BillPayments', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'PaymentMethod', fields: [{ name: 'pmId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'paymentMethod', type: { kind: 'ref', target: 'PaymentMethod' }, optional: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'intent', initial: 'requiresPaymentMethod', states: [
        { name: 'requiresPaymentMethod' }, { name: 'succeeded', tags: ['terminal'] }] }],
        transitions: [{ name: 'succeed', region: 'intent', from: ['requiresPaymentMethod'], to: 'succeeded' }] } }],
    events: [], services: []
  };

  it('refsResolve no longer names the optional ref, so the initial state is legal', () => {
    const d = impliedInvariants(payment);
    // Anchor FIRST: prove the derivation actually ran over this model. Without this, the
    // absence assertion below passes vacuously if impliedInvariants returns [] for any reason
    // (a renamed derivation, a model the walker skips) — an unfalsifiable guard, which is the
    // exact defect class this codebase keeps producing.
    expect(d.map(i => i.name)).toContain('nonNegativePaymentAmount');
    // every ref on Payment is optional, so no refsResolve rule exists at all
    expect(d.find(i => i.name === 'refsResolvePayment')).toBeUndefined();
  });
});
```

If `impliedInvariants` still emits `refsResolvePayment` with an empty `fields` array rather than omitting it, adjust Task 4's Step 4 so the rule is not emitted when no required refs remain — an empty refs-resolve is a rule about nothing.

- [ ] **Step 7: Verify, including the real solver**

```bash
bash scripts/cleanup-solvers.sh
npx vitest run test/emit/ test/engine/ > /tmp/t6c.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t6c.log
npx tsc --noEmit -p . > /tmp/t6-tsc2.log 2>&1; echo "tsc exit=$?"; cat /tmp/t6-tsc2.log
```
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add lattice/src/emit/quint.ts lattice/test/emit/quint-optional.test.ts
git commit -m "feat(quint): Present companion flag for optional fields

Quint has no Option type, so existence rides beside the data — the pattern this
encoding already uses for instances (exists: bool) and owned collections
(fCount: int).

A field the solver cannot see (Text/Id) gets no flag: a flag for an invisible
field is a promise the engine cannot keep."
```

---

### Task 7: Elicit what absence means

**Why:** the gate (Task 3) makes absence a decision. This makes answering it recognition rather than recall: the engine draws a witness with the field absent, the user judges permit/forbid, and the engine writes `present()` in the right position. `present()` becomes something the engine writes, not something you type.

**Do not start until Tasks 1-6 are green.** If this proves harder than scoped, stop after Task 8 — Tasks 1-6+8 are complete and shippable without it.

**Files:**
- Modify: `lattice/src/engine/planner.ts`, `lattice/src/cli.ts`
- Test: `lattice/test/cli-absence.test.ts` (new)

**Interfaces:**
- Consumes: `absence-undecided` (Task 3), `{ kind: 'present' }` (Task 2).
- Produces: a `PlannerOutput` variant carrying the undecided path and a witness with the field absent; a verdict on it rewrites the candidate into guard form (permit) or assertion form (forbid).

- [ ] **Step 1: Read the planner's contract before designing the variant**

`PlannerOutput` (`planner.ts:21-28`) is a seven-variant union; `cli.ts`'s `next-question` passes each through, and `.claude/skills/elicit-spec/SKILL.md`'s Phase 2 has a bullet per variant. Read all three before adding an eighth — an unhandled variant leaves the model improvising at runtime, which is exactly the `parked` gap Slice A found and fixed.

Record in your report: the variant's exact shape, which `cli.ts` case handles it, and the SKILL.md bullet you will need in Step 6.

- [ ] **Step 2: Write the failing test**

Create `lattice/test/cli-absence.test.ts`. Model the harness on `test/cli-decline.test.ts` (which uses `runCommand(argv, fakeDeps)` — `cli.ts` has no `main` export). The test drives: propose a candidate that reads an optional field bare → expect it rejected with `absence-undecided`; propose the same under elicitation → expect the planner to offer an absence question; verdict `permit` → the stored candidate is guard-form; verdict `forbid` → assertion-form.

Write the concrete assertions from the shapes you recorded in Step 1 — do not guess the response JSON.

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run test/cli-absence.test.ts > /tmp/t7.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t7.log
```
Expected: FAIL — no absence question exists.

- [ ] **Step 4: Implement the planner variant and the rewrite**

Guard-form rewrite (permit — absence is fine, the rule does not apply):

```ts
{ ...c, where: c.where ? { kind: 'and', args: [c.where, { kind: 'present', path }] } : { kind: 'present', path } }
```

Assertion-form rewrite (forbid — absence is illegal):

```ts
{ ...c, body: { kind: 'and', args: [{ kind: 'present', path }, c.body] } }
```

Both must round-trip `validateCandidate` cleanly — assert that in the test, since a rewrite that reintroduces `absence-undecided` is the bug this task exists to prevent.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bash scripts/cleanup-solvers.sh
npx vitest run test/cli-absence.test.ts test/engine/ test/cli.test.ts > /tmp/t7b.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t7b.log
npx tsc --noEmit -p . > /tmp/t7-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/t7-tsc.log
```
Expected: both exit 0.

- [ ] **Step 6: Teach the skill the new variant**

`.claude/skills/elicit-spec/SKILL.md` — add a Phase 2 bullet for the absence question, in the union's own order. It must tell the model: present the table verbatim, frame it as "this field is absent here — is that legal?", and that permit means the rule does not apply while forbid means absence violates it. The model must never write `present()` itself; the engine does.

Verify every command and diagnostic the file names still exists:

```bash
grep -n "absence\|present(" .claude/skills/elicit-spec/SKILL.md
grep -c "absence-undecided" lattice/src/ast/grammar.ts
```

- [ ] **Step 7: Commit**

```bash
git add lattice/src/engine/planner.ts lattice/src/cli.ts lattice/test/cli-absence.test.ts .claude/skills/elicit-spec/SKILL.md
git commit -m "feat(engine): elicit what absence means, and write present() for the user

The gate makes absence a decision; this makes answering it recognition. The
engine draws a witness with the field absent and asks permit/forbid — permit
writes the guard form, forbid the assertion form.

Auto-inserting present() is impossible: the two forms are semantically opposite
and only a domain expert knows which is meant. Asking with a concrete case is
what this engine is for."
```

---

### Task 8: The language's account of absence

**Why:** a doc claim the code does not honour is a defect — Slice A produced five of them, each an unqualified universal a grep refutes. Write only what you can cite.

**Files:**
- Modify: `docs/language/field-types.md`, `docs/language/invariant.md`, `docs/language/derived-invariants.md`

- [ ] **Step 1: `field-types.md` — the surface**

Document `field : Type?` in the field grammar line (`<camelId> : <type>[?] [key] [const] [@tag]*`). Add Semantic Rules bullets: `optional-key`, `optional-list`.

Add a subsection for `Text?`/`Id?` modelled on the existing **"Cross-context refs are structural only"** section (`field-types.md:81`) — same shape, same reasoning: legal, accepted by the grammar, but excluded from derived invariants and unusable in any invariant path, because `Text`/`Id` already are (`quint.ts:43` returns null for non-int prims; `alloy.ts:43` only pushes `isIntPrim`). Say plainly that optionality on those types is documentation, not a constraint.

- [ ] **Step 2: `invariant.md` — `present()` and the gate**

Add `present(<path>)` to the predicate/operator table. Add a Semantic Rules bullet for `absence-undecided`, and state the dominance rule exactly as implemented (where-guard covers the body; `&&` is symmetric; an antecedent covers its consequent; `||` and `!` cover nothing).

State the asymmetry honestly, because it is the thing a reader will trip on: a **comparison** treats a missing operand as unknown and returns true ("unknown facts don't convict", `evaluate.ts:45`), while **`present()`** reads absence as a fact. That is why an invariant over an optional field needs it.

Note the cost the design accepted: ref-hops through a never-created record stay vacuous (`quint.ts:171`), so the language has two absence rules. Say so, and say why (unifying them would change the semantics of every ref-crossing invariant already written).

- [ ] **Step 3: `derived-invariants.md` — the guard form**

The three-family table gains the optional case: a `Money` field that is optional and unsigned implies `present(f) => f >= 0`, and `refsResolve` covers only **required** same-context refs. State that this is forced rather than chosen — an absent amount is not a negative one, an absent ref is not an orphan, and the assertion form would make every optional field mandatory.

- [ ] **Step 4: Verify every doc block still parses**

```bash
npx vitest run test/docs-blocks.test.ts > /tmp/t8.log 2>&1; echo "exit=$?"; grep -E "Tests |FAIL" /tmp/t8.log
```
Expected: exit 0. If you added a ```lat example using `?`, this is what proves it parses.

- [ ] **Step 5: Verify every claim you wrote**

For each factual claim, grep the code and record `claim → file:line` in your report. Prefer a narrower claim you can cite over a stronger one you cannot. If a claim needs a qualifier to be true, write the qualifier.

- [ ] **Step 6: Commit**

```bash
git add docs/language/field-types.md docs/language/invariant.md docs/language/derived-invariants.md
git commit -m "docs(language): optional fields, present(), and what absence means

A comparison treats a missing operand as unknown and returns true; present()
reads absence as a fact. An invariant over an optional field must say which it
means — the language will not pick.

Text?/Id? are structural-only, documented like cross-context refs: legal, and
inert to the solver, which the docs say rather than imply."
```

---

## Final verification

- [ ] **Per-file gate** (no green full-suite baseline exists — see Global Constraints):

```bash
cd lattice && bash scripts/cleanup-solvers.sh
npx tsc --noEmit -p . > /tmp/f-tsc.log 2>&1; echo "tsc exit=$?"; cat /tmp/f-tsc.log
npx vitest run test/ast/ test/engine/ test/parse/ test/emit/ test/cli.test.ts test/cli-decline.test.ts test/docs-blocks.test.ts test/pipeline-from-scratch.test.ts > /tmp/f-fast.log 2>&1; echo "fast exit=$?"; grep -E "Test Files|Tests |FAIL" /tmp/f-fast.log
```
Expected: both exit 0.

- [ ] **Real-solver files, one at a time, each after `cleanup-solvers.sh`:**

```bash
for t in golden/trace-a.test.ts golden/trace-b.test.ts golden/trace-c.test.ts \
         test/golden-trace-d.test.ts test/cli-strengthen.test.ts test/cli-classify.test.ts \
         test/cli-explain.test.ts test/cli-classify.integration.test.ts \
         test/cli-strengthen.integration.test.ts; do
  bash scripts/cleanup-solvers.sh >/dev/null 2>&1
  npx vitest run "$t" > "/tmp/f-$(basename $t).log" 2>&1
  echo "$t exit=$?"
done
```
Expected: `exit=0` each. `trace-b` (p50 latency budget) and `cli-strengthen.integration` (~433s real quint) are load-sensitive: a failure there that passes on a re-run alone is environmental, not a regression. Argue causation by whether this slice can *reach* the test.

- [ ] **Prove the headline claim by hand** — a `Payment` that begins without a payment method:

```bash
cd lattice && cat > /tmp/opt-check.json <<'EOF'
{"context":"BillPayments","enums":[],"values":[],"events":[],"services":[],
 "entities":[{"kind":"entity","name":"PaymentMethod","fields":[{"name":"pmId","type":{"kind":"prim","prim":"Id"},"key":true}]}],
 "aggregates":[{"kind":"aggregate","name":"Payment","fields":[
   {"name":"paymentId","type":{"kind":"prim","prim":"Id"},"key":true},
   {"name":"paymentMethod","type":{"kind":"ref","target":"PaymentMethod"},"optional":true},
   {"name":"amount","type":{"kind":"prim","prim":"Money"},"tags":["unsigned"]}],
  "machine":{"regions":[{"name":"intent","initial":"requiresPaymentMethod","states":[
    {"name":"requiresPaymentMethod"},{"name":"succeeded","tags":["terminal"]}]}],
   "transitions":[{"name":"succeed","region":"intent","from":["requiresPaymentMethod"],"to":"succeeded"}]}}]}
EOF
rm -rf /tmp/opt-sess /tmp/opt-out
npx tsx src/cli.ts init --session /tmp/opt-sess --model /tmp/opt-check.json
npx tsx src/cli.ts emit --session /tmp/opt-sess --out /tmp/opt-out >/dev/null
cat /tmp/opt-out/spec.lat
rm -rf /tmp/opt-sess /tmp/opt-out /tmp/opt-check.json
```
Expected: `init` succeeds, and **no `refsResolve` rule is adopted for `Payment`** — its only ref is optional, so an absent payment method is not an orphan. The printed spec shows `paymentMethod : ref PaymentMethod?`. Before this slice, the auto-derived `refsResolve` forbade the model's own initial state.

- [ ] **Merge to `main`** — re-check it first; it moved three times during Slice A, and its checkout has had uncommitted work from other sessions:

```bash
cd /Users/taras/projects/spec-core
test -f .git/MERGE_HEAD && echo "MID-MERGE — stop" || echo "clear"
git status --short
git log --oneline -1 main
git rev-list --left-right --count main...claude/bill-payment-ledger-spec-edffdc
```
If `main` has moved, rebase and **re-run the gates on the rebased result** — a clean rebase is not evidence the code still works. Then `git merge --ff-only`. Re-run `bash lattice/scripts/ensure-ready.sh` after any rebase: it reinstalls when `package-lock.json` changes, and a stale `node_modules` makes `npx tsc`/`npx quint` vanish in ways that look like real failures.
