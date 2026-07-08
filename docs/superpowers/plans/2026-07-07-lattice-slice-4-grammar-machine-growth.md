# Lattice Slice 4 — Grammar & Machine Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the `.lat` language and engine per the approved design: `lifecycle` blocks with guarded (`requires`) and event-emitting (`emits`) multi-source transitions, nested entities with owned collections, the `sumOverCollection` invariant kind (both solver encodings), `value` objects with type-carried laws, and a `service` construct with `performs`-reference methods — plus phase-0 elicitation growth, golden trace D, and the b02 re-formalization smoke.

**Architecture:** Every feature lands vertically: AST type → `validateModel`/`validateCandidate` → Langium grammar + `fromLangium` mapper → canonical printer (`emit/code.ts`) → round-trip arbitraries → projections (prose/mermaid) → solver emitters where the design routes them. The AST `Machine {regions, transitions}` shape survives; `lifecycle` blocks are pure surface. Services and values are carried structure; the machine remains the only Quint-verified object; sums encode in both solvers.

**Tech Stack:** TypeScript strict, Langium 3 (`npx langium generate` after every `.langium` edit), vitest (real Alloy/Apalache solvers, serialized), fast-check round-trip properties.

**Design spec:** `docs/superpowers/specs/2026-07-07-lattice-slice-4-grammar-machine-growth-design.md` — cite section numbers in commit bodies where a decision is non-obvious.

## Global Constraints

- Worktree bootstrap once: `bash lattice/scripts/ensure-ready.sh` (all-green doctor required).
- Before EVERY commit: `cd lattice && npx tsc --noEmit && npx vitest run` — full suite, real solvers. Golden traces A/B/C stay green; assertions never weakened.
- After EVERY `lat.langium` edit: `cd lattice && npx langium generate` (regenerates `src/parse/generated/`), or tsc fails on stale AST.
- Never `git add -A`; stage exact paths. Conventional commits. Commit doc edits immediately (durable user preference).
- `RESERVED_WORDS` (`src/ast/reserved.ts`) must stay in lockstep with quoted grammar keywords — the sync test in `test/parse/parse.test.ts` enforces both directions; every grammar task updates both sides in the same commit.
- `docs/language/*.md` code blocks are parse-gated by `test/docs-blocks.test.ts` — every surface change updates its reference page in the same commit.
- No simulated validation: new solver encodings get real Apalache/Alloy round-trips in `test/solvers/*.integration.test.ts` style.
- Committed spec files `specs/subscriptions/spec.lat` and `specs/catalog/spec.lat` migrate in the same commit as any syntax change that affects them.
- Solver bounds: owned collections bound `OWNED_BOUND = 3`; Alloy queries involving sums run `but 7 Int` (others stay `but 5 Int`) — design §6.2.

---

### Task 1: Multi-source transitions in the AST (`from: string[]`)

Surface syntax is unchanged in this task (grammar still parses one source; the mapper wraps it). This is the pure-TS ripple so Task 2's grammar change is isolated.

**Files:**
- Modify: `lattice/src/ast/domain.ts:17` (TransitionDef)
- Modify: `lattice/src/ast/validate.ts:78-85` (transition checks + new dup/self-loop rules)
- Modify: `lattice/src/parse/fromLangium.ts:62-66` (mapMachine)
- Modify: `lattice/src/emit/code.ts:73-74` (printer)
- Modify: `lattice/src/emit/quint.ts:230-233` (from-check disjunction)
- Modify: `lattice/src/emit/prose.ts:50-52`
- Modify: `lattice/src/emit/mermaid/statechart.ts:7-8`
- Modify: `lattice/test/parse/arbitraries.ts:160-164` (machineArb)
- Modify: any test fixture with a `from: '...'` transition literal (step 3 greps them)
- Test: `lattice/test/ast/validate-multisource.test.ts` (new)

**Interfaces:**
- Consumes: existing `TransitionDef`.
- Produces: `TransitionDef.from: string[]` — every later task uses the array shape. New `validateModel` codes: `duplicate-source`, `self-loop`.

- [ ] **Step 1: Write the failing tests**

```ts
// lattice/test/ast/validate-multisource.test.ts
import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';

const model = (from: string[], to: string): DomainModel => ({
  context: 'C', enums: [], entities: [], events: [],
  aggregates: [{ kind: 'aggregate', name: 'A',
    fields: [{ name: 'aId', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'lc', initial: 's1',
      states: [{ name: 's1' }, { name: 's2' }, { name: 's3' }] }],
      transitions: [{ name: 't', region: 'lc', from, to }] } }],
});

describe('multi-source transitions', () => {
  it('accepts distinct sources', () => {
    expect(validateModel(model(['s1', 's2'], 's3'))).toEqual([]);
  });
  it('rejects duplicate sources', () => {
    expect(validateModel(model(['s1', 's1'], 's3')).map(d => d.code)).toContain('duplicate-source');
  });
  it('rejects self-loops (to appears in from)', () => {
    expect(validateModel(model(['s1', 's2'], 's2')).map(d => d.code)).toContain('self-loop');
  });
  it('rejects unknown source states', () => {
    expect(validateModel(model(['nope'], 's2')).map(d => d.code)).toContain('unknown-transition-state');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd lattice && npx vitest run test/ast/validate-multisource.test.ts`
Expected: FAIL — TypeScript error first (`from` is `string`), which is the point.

- [ ] **Step 3: Change the AST type and chase the ripple**

`src/ast/domain.ts:17`:
```ts
export interface TransitionDef { name: string; region: string; from: string[]; to: string; when?: string }
```

`src/ast/validate.ts` — replace the transition loop body (lines 78-85):
```ts
    for (const t of a.machine?.transitions ?? []) {
      const r = a.machine!.regions.find(x => x.name === t.region);
      if (!r) { out.push({ code: 'unknown-region', message: `transition ${t.name} names missing region ${t.region}`, at: t.name }); continue; }
      for (const s of [...t.from, t.to]) if (!r.states.some(x => x.name === s))
        out.push({ code: 'unknown-transition-state', message: `transition ${t.name}: no state ${s} in ${a.name}.${t.region}`, at: t.name });
      if (new Set(t.from).size !== t.from.length)
        out.push({ code: 'duplicate-source', message: `transition ${t.name}: repeated source state`, at: t.name });
      if (t.from.includes(t.to))
        out.push({ code: 'self-loop', message: `transition ${t.name}: target ${t.to} is also a source — self-loops need evidence before the grammar admits them (design §5.2)`, at: t.name });
      if (t.when && !events.has(t.when))
        out.push({ code: 'unknown-event', message: `transition ${t.name} triggered by undeclared event ${t.when}`, at: t.name });
    }
```

`src/parse/fromLangium.ts:63` (inside `mapMachine`):
```ts
    const tr: TransitionDef = { name: t.name, region: t.region, from: [t.from], to: t.to };
```

`src/emit/code.ts:73-74`:
```ts
  for (const t of mach.transitions)
    out.push(`      transition ${t.name} { region ${t.region}; from ${t.from.join(', ')} to ${t.to}${t.when ? `; when ${t.when}` : ''} }`);
```

`src/emit/quint.ts:232-233` — the from-state check becomes a disjunction:
```ts
      for (const t of declared) actions.push(
        `action trans_${o.name}_${t.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) all { (${t.from.map(f => `${v}.get(id).${r.name}_state == "${f}"`).join(' or ')}), ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", "${t.to}")), ${frame([v]).join(', ')} } }`);
```

`src/emit/prose.ts:52`:
```ts
        lines.push(`**${r.name} lifecycle:** ${declared.map(t => `${t.from.map(label).join('/')} → ${label(t.to)} (${t.name})`).join(', ')}`, '');
```

`src/emit/mermaid/statechart.ts:7-8` — one edge per source:
```ts
  for (const t of (agg.machine?.transitions ?? []).filter(t => t.region === region.name))
    for (const f of t.from) out.push(`  ${f} --> ${t.to}: ${t.name}`);
```

`test/parse/arbitraries.ts:161` (machineArb transitions):
```ts
        const t: TransitionDef = { name: transNames[i]!, region, from: [statesPer[i]![0]!], to: statesPer[i]![1]! };
```

- [ ] **Step 4: Find and fix every remaining `from:` transition literal**

Run: `cd lattice && grep -rn "from: '" test/ src/ | grep -v "from: \[" | grep -iv "leadsTo\|predicate"` and `npx tsc --noEmit` — the compiler is the authoritative list. Fix each test-fixture transition object from `from: 'x'` to `from: ['x']` (expect hits in `test/fixtures.ts`, `test/engine/*.test.ts`, `test/emit/quint.test.ts` expectation strings — for emitted-action expectation strings, the guard text changes from `X.get(id).r_state == "a"` to `(X.get(id).r_state == "a")`; update the literal).

- [ ] **Step 5: Full gate, then commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`
Expected: all green (multi-source tests now pass).

```bash
git add lattice/src/ast/domain.ts lattice/src/ast/validate.ts lattice/src/parse/fromLangium.ts \
  lattice/src/emit/code.ts lattice/src/emit/quint.ts lattice/src/emit/prose.ts \
  lattice/src/emit/mermaid/statechart.ts lattice/test/parse/arbitraries.ts \
  lattice/test/ast/validate-multisource.test.ts
# plus each fixture file Step 4 touched
git commit -m "feat(lattice): multi-source TransitionDef.from — AST, validators, emitters (design §3.7)"
```

---

### Task 2: `lifecycle` surface — grammar, printer, spec migration

Replaces `machine { region … }` with `lifecycle <name> { states {…} transition… }`. Transitions lose the `region` param and gain multi-source `from` surface. AST unchanged.

**Files:**
- Modify: `lattice/src/parse/lat.langium:50-51,70-80`
- Modify: `lattice/src/parse/fromLangium.ts:48-68,214-227` (mapMachine → mapLifecycles; AggregateDecl wiring; locs)
- Modify: `lattice/src/emit/code.ts:64-76` (machineLines → lifecycleLines)
- Modify: `lattice/src/ast/reserved.ts` (+`lifecycle`; −`machine`, −`region`)
- Modify: `specs/subscriptions/spec.lat`, `specs/catalog/spec.lat`
- Modify: `lattice/test/dod.test.ts` (old-syntax string literals), plus any test `.lat` literal (step 5 greps)
- Rename+rewrite: `docs/language/machine.md` → `docs/language/lifecycle.md`; update `docs/language/transition.md`, `docs/language/README.md`
- Test: `lattice/test/parse/fromLangium.test.ts` (extend), `lattice/test/parse/roundtrip.test.ts` (existing property covers it)

**Interfaces:**
- Consumes: Task 1's `from: string[]`.
- Produces: grammar rules `LifecycleDecl` (name, states, transitions) and `TransitionDecl` without `region`; printer emits the new surface. All later grammar tasks extend THESE rules.

- [ ] **Step 1: Write the failing parse test**

Add to `lattice/test/parse/fromLangium.test.ts`:
```ts
it('parses lifecycle blocks into Machine regions + region-tagged transitions', () => {
  const r = loadLatText(`context C {
  aggregate Invoice {
    invoiceId : Id key
    lifecycle settlement {
      states { draft @initial, open @active, paid @terminal }
      transition finalize { from draft to open }
      transition close { from draft, open to paid }
    }
  }
}`);
  expect(r.ok).toBe(true);
  const m = (r as any).model;
  expect(m.aggregates[0].machine.regions[0]).toMatchObject({ name: 'settlement', initial: 'draft' });
  expect(m.aggregates[0].machine.transitions).toEqual([
    { name: 'finalize', region: 'settlement', from: ['draft'], to: 'open' },
    { name: 'close', region: 'settlement', from: ['draft', 'open'], to: 'paid' },
  ]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd lattice && npx vitest run test/parse/fromLangium.test.ts`
Expected: FAIL (`lifecycle` does not parse).

- [ ] **Step 3: Grammar change**

`src/parse/lat.langium` — replace lines 70-80 (MachineDecl/RegionDecl/TransitionDecl) with:
```
LifecycleDecl:
    'lifecycle' name=ID '{'
        'states' '{' states+=StateDecl (',' states+=StateDecl)* '}'
        transitions+=TransitionDecl*
    '}';

TransitionDecl:
    'transition' name=ID '{' 'from' from+=ID (',' from+=ID)* 'to' to=ID (';' 'when' when=ID)? '}';
```
and change `AggregateDecl` (line 50-51) to:
```
AggregateDecl:
    docs+=DOC* 'aggregate' name=ID '{' fields+=FieldDecl* lifecycles+=LifecycleDecl* invariants+=InvariantDecl* '}';
```

Run: `cd lattice && npx langium generate`

- [ ] **Step 4: Mapper, printer, reserved words**

`src/parse/fromLangium.ts` — replace `mapMachine` (lines 48-68) with:
```ts
function mapLifecycles(lifs: G.LifecycleDecl[], ownerName: string, diags: ParseDiagnostic[]): Machine {
  const regions: Region[] = lifs.map(r => {
    const states: StateDef[] = r.states.map(s => {
      const tags = s.tags.map(t => t.name).filter(t => t === 'active' || t === 'terminal') as ('active' | 'terminal')[];
      const st: StateDef = { name: s.name };
      if (tags.length) st.tags = tags;
      return st;
    });
    const initials = r.states.filter(s => s.tags.some(t => t.name === 'initial'));
    if (initials.length !== 1)
      diags.push(diag('multiple-initial',
        `lifecycle ${ownerName}.${r.name} must have exactly one @initial state (found ${initials.length})`, r));
    return { name: r.name, initial: initials[0]?.name ?? r.states[0]!.name, states };
  });
  const transitions: TransitionDef[] = lifs.flatMap(r => r.transitions.map(t => {
    const tr: TransitionDef = { name: t.name, region: r.name, from: [...t.from], to: t.to };
    if (t.when) tr.when = t.when;
    return tr;
  }));
  return { regions, transitions };
}
```
In the `AggregateDecl` case (line ~217): replace `if (a.machine) def.machine = mapMachine(a.machine, a.name, diags);` with:
```ts
        if (a.lifecycles.length) def.machine = mapLifecycles([...a.lifecycles], a.name, diags);
```
and update the `locs` loops below it to iterate `a.lifecycles` (regions) and `a.lifecycles.flatMap(l => l.transitions)`:
```ts
        for (const r of a.lifecycles) {
          locs.set(`region:${a.name}.${r.name}`, at(r));
          for (const st of r.states) locs.set(`state:${a.name}.${r.name}.${st.name}`, at(st));
          for (const t of r.transitions) locs.set(`transition:${a.name}.${t.name}`, at(t));
        }
```

`src/emit/code.ts` — replace `machineLines` (lines 64-76) with:
```ts
function machineLines(mach: Machine, out: string[]): void {
  for (const r of mach.regions) {
    out.push(`    lifecycle ${r.name} {`);
    const states = r.states.map(s => {
      const tags = [...(s.name === r.initial ? ['initial'] : []), ...(s.tags ?? [])];
      return s.name + (tags.length ? ' @' + tags.join(' @') : '');
    }).join(', ');
    out.push(`      states { ${states} }`);
    for (const t of mach.transitions.filter(t => t.region === r.name))
      out.push(`      transition ${t.name} { from ${t.from.join(', ')} to ${t.to}${t.when ? `; when ${t.when}` : ''} }`);
    out.push('    }');
  }
}
```
(The caller at line 113 keeps `if (a.machine) { out.push(''); machineLines(a.machine, out); }` — no wrapping `machine {` line anymore.)

`src/ast/reserved.ts`: remove `'machine'`, `'region'`; add `'lifecycle'` (keep the set alphabetized).

- [ ] **Step 5: Migrate committed specs and test literals**

Rewrite the machine blocks in `specs/subscriptions/spec.lat` (keep every name identical — the ledger reconciliation keys on names). The Subscription block becomes:
```
    lifecycle lifecycle {
      states { trialing @initial, active @active, pastDue @active, canceled @terminal, expired @terminal }
      transition activate { from trialing to active }
      transition expireTrial { from trialing to expired }
      transition paymentFailed { from active to pastDue }
      transition recover { from pastDue to active }
      transition cancelFromTrial { from trialing to canceled }
      transition cancelFromActive { from active to canceled }
      transition cancelFromPastDue { from pastDue to canceled }
      transition dunningExhausted { from pastDue to canceled }
    }
```
and the Invoice block:
```
    lifecycle settlement {
      states { draft @initial, open @active, paid @terminal, void @terminal, uncollectible @terminal }
      transition finalize { from draft to open }
      transition settle { from open to paid }
      transition voidDraft { from draft to void }
      transition voidOpen { from open to void }
      transition writeOff { from open to uncollectible }
    }
```
(Note: the Subscription region is literally named `lifecycle`, so the block reads `lifecycle lifecycle` — leave it; the demo task (Task 15) may rename it with the human via `apply --rename`. Do NOT rename it unilaterally — it is ledger-referenced.)
Apply the same mechanical rewrite to `specs/catalog/spec.lat` if it has a machine block (check; the Plan aggregate may be machine-less).

Then find every test literal using old syntax:
Run: `cd lattice && grep -rln "machine {\|region lifecycle\|region settlement\|'region'" test/ ../docs/language/`
Update each — known ones:
- `test/dod.test.ts:27-28`: the `.replace()` needle/insertion become
  `'transition recover { from pastDue to active }'` →
  `'transition recover { from pastDue to active }\n      transition graceToExpired { from pastDue to expired }'`.
- Any `.lat` string in `test/parse/*.test.ts`, `test/cli-apply.test.ts`, `test/engine/reconcile.test.ts`, `test/engine/sync.test.ts`, `test/emit/code-print.test.ts` — mechanical rewrite to the new block shape shown above.

- [ ] **Step 6: Reference docs**

`git mv docs/language/machine.md docs/language/lifecycle.md` and rewrite it: construct = `lifecycle <name> { states {…} transition… }`, one block per orthogonal dimension, block name is the region name referenced by `state <name> in {…}` / `unique while <name> in {…}`, exactly one `@initial`. Every code block must parse (docs gate). Update `docs/language/transition.md` (drop `region` param; show multi-source `from a, b to c`; note `duplicate-source`/`self-loop` diagnostics) and the index table in `docs/language/README.md` (machine → lifecycle). Grep the whole docs dir for stale `machine`/`region` mentions: `grep -rn "machine\|region" docs/language/`.

- [ ] **Step 7: Full gate, then commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`
Expected: all green — including the round-trip property (printer and parser moved together), the reserved-word sync test, and the docs parse gate.

```bash
git add lattice/src/parse/lat.langium lattice/src/parse/generated lattice/src/parse/fromLangium.ts \
  lattice/src/emit/code.ts lattice/src/ast/reserved.ts specs/subscriptions/spec.lat specs/catalog/spec.lat \
  docs/language/lifecycle.md docs/language/transition.md docs/language/README.md lattice/test
git rm docs/language/machine.md 2>/dev/null || true
git commit -m "feat(lattice): lifecycle blocks replace machine/region surface; specs + docs migrated (design §3.1)"
```

### Task 3: `requires` guards on transitions

**Files:**
- Modify: `lattice/src/ast/domain.ts` (TransitionDef.requires), `lattice/src/ast/validate.ts` (guard validation)
- Modify: `lattice/src/parse/lat.langium` (TransitionDecl), `lattice/src/parse/fromLangium.ts` (mapLifecycles gains enums param)
- Modify: `lattice/src/emit/code.ts` (print `; requires …`), `lattice/src/emit/quint.ts` (guard conjunct), `lattice/src/emit/prose.ts`, `lattice/src/emit/mermaid/statechart.ts`
- Modify: `lattice/test/parse/arbitraries.ts` (optional guard), `docs/language/transition.md`
- Test: `lattice/test/ast/validate-guards.test.ts` (new), extend `lattice/test/emit/quint.test.ts`

**Interfaces:**
- Consumes: `Predicate` from `src/ast/invariant.ts`, `predToText` from `emit/code.ts`, `predToQuint`/`predEn` (existing).
- Produces: `TransitionDef.requires?: Predicate`. Validation codes: `guard-cross-aggregate`, plus reuse of `unknown-path`/`unknown-region`/`unknown-state`/`unknown-enum`/`unknown-enum-value`. Statechart label sanitizer `guardLabel(p: Predicate): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// lattice/test/ast/validate-guards.test.ts
import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Predicate } from '../../src/ast/invariant.js';

const model = (requires?: Predicate): DomainModel => ({
  context: 'C', enums: [], entities: [], events: [],
  aggregates: [
    { kind: 'aggregate', name: 'Other',
      fields: [{ name: 'oId', type: { kind: 'prim', prim: 'Id' }, key: true }] },
    { kind: 'aggregate', name: 'Invoice',
      fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'other', type: { kind: 'ref', target: 'Other' } },
        { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' } },
        { name: 'totalDue', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'settlement', initial: 'open',
        states: [{ name: 'open' }, { name: 'paid' }] }],
        transitions: [{ name: 'settle', region: 'settlement', from: ['open'], to: 'paid',
          ...(requires ? { requires } : {}) }] } }],
});
const cmp = (l: string[], r: string[]): Predicate =>
  ({ kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: l }, right: { kind: 'field', owner: 'self', path: r } });

describe('transition guards', () => {
  it('accepts a guard over own numeric fields', () => {
    expect(validateModel(model(cmp(['amountPaid'], ['totalDue'])))).toEqual([]);
  });
  it('rejects ref-hop paths in guards (own-aggregate only, design §3.3)', () => {
    const diags = validateModel(model(cmp(['other', 'oId'], ['totalDue'])));
    expect(diags.map(d => d.code)).toContain('guard-cross-aggregate');
  });
  it('rejects a guard naming a foreign region', () => {
    const diags = validateModel(model({ kind: 'inState', owner: 'self', region: 'nope', states: ['open'] }));
    expect(diags.map(d => d.code)).toContain('unknown-region');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd lattice && npx vitest run test/ast/validate-guards.test.ts` → FAIL (tsc: `requires` unknown).

- [ ] **Step 3: AST + validation**

`src/ast/domain.ts`:
```ts
export interface TransitionDef {
  name: string; region: string; from: string[]; to: string;
  when?: string;
  requires?: Predicate;   // guard over the OWN aggregate's fields + machine state (design §3.3)
  emits?: string;         // filled by Task 4
}
```
Add `import type { Predicate } from './invariant.js';` at the top of `domain.ts`.

`src/ast/validate.ts` — add a guard walker (place above `validateModel`; import `Predicate`, `Term` from `./invariant.js`):
```ts
function checkGuard(a: { name: string; fields: Field[]; machine?: { regions: { name: string; states: { name: string }[] }[] } },
    enums: Map<string, string[]>, t: string, p: Predicate, out: Diagnostic[]): void {
  const term = (tm: Term): void => {
    switch (tm.kind) {
      case 'field': {
        if (tm.path.length !== 1) {
          // multi-segment = ref-hop or value path; guards are own-scalar-only in v1 (§5.2.1)
          out.push({ code: 'guard-cross-aggregate', message: `transition ${t}: guard path ${tm.path.join('.')} leaves the aggregate — v1 guards read own fields only`, at: t });
          return;
        }
        if (!a.fields.some(f => f.name === tm.path[0]))
          out.push({ code: 'unknown-path', message: `transition ${t}: guard reads unknown field ${tm.path[0]}`, at: t });
        break;
      }
      case 'enumval': {
        const e = enums.get(tm.enum);
        if (!e) out.push({ code: 'unknown-enum', message: `transition ${t}: no enum ${tm.enum}`, at: t });
        else if (!e.includes(tm.value)) out.push({ code: 'unknown-enum-value', message: `transition ${t}: ${tm.enum} has no value ${tm.value}`, at: t });
        break;
      }
      case 'plus': term(tm.left); term(tm.right); break;
      case 'int': case 'now': break;
    }
  };
  const walk = (q: Predicate): void => {
    switch (q.kind) {
      case 'cmp': term(q.left); term(q.right); break;
      case 'inState': {
        const r = a.machine?.regions.find(x => x.name === q.region);
        if (!r) { out.push({ code: 'unknown-region', message: `transition ${t}: guard names missing region ${q.region}`, at: t }); return; }
        for (const s of q.states) if (!r.states.some(x => x.name === s))
          out.push({ code: 'unknown-state', message: `transition ${t}: guard names missing state ${s}`, at: t });
        break;
      }
      case 'and': case 'or': q.args.forEach(walk); break;
      case 'not': walk(q.arg); break;
      case 'implies': walk(q.left); walk(q.right); break;
    }
  };
  walk(p);
}
```
In `validateModel`, build `const enumMap = new Map(m.enums.map(e => [e.name, e.values]));` near the top, and inside the transition loop add:
```ts
      if (t.requires) checkGuard(a, enumMap, t.name, t.requires, out);
```

- [ ] **Step 4: Grammar + mapper + printer**

`lat.langium` TransitionDecl:
```
TransitionDecl:
    'transition' name=ID '{' 'from' from+=ID (',' from+=ID)* 'to' to=ID
        (';' 'when' when=ID)?
        (';' 'requires' requires=Predicate)?
    '}';
```
Run `npx langium generate`.

`fromLangium.ts`: `mapLifecycles` gains an `enums: Map<string, string[]>` parameter (thread `enumMap` through from the `AggregateDecl` case); inside the transition mapping add:
```ts
    if (t.requires) tr.requires = mapPred(t.requires, enums);
```

`emit/code.ts` lifecycleLines transition line becomes:
```ts
      out.push(`      transition ${t.name} { from ${t.from.join(', ')} to ${t.to}${t.when ? `; when ${t.when}` : ''}${t.requires ? `; requires ${predToText(t.requires)}` : ''} }`);
```

- [ ] **Step 5: Quint guard conjunct + projections**

`emit/quint.ts` declared-transition action — insert the compiled guard after the from-check:
```ts
      for (const t of declared) {
        const fromChk = `(${t.from.map(f => `${v}.get(id).${r.name}_state == "${f}"`).join(' or ')})`;
        const guard = t.requires ? `, ${predToQuint(m, t.requires, `${v}.get(id)`, o.name)}` : '';
        actions.push(
          `action trans_${o.name}_${t.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) all { ${fromChk}${guard}, ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", "${t.to}")), ${frame([v]).join(', ')} } }`);
      }
```
Extend `test/emit/quint.test.ts` with an expectation that a guarded transition's action source contains the guard conjunct (build a tiny model with `requires: {kind:'cmp',op:'ge',left:{kind:'field',owner:'self',path:['amountPaid']},right:{kind:'field',owner:'self',path:['totalDue']}}` and assert `source` includes `x` — concretely: `expect(em.source).toContain('invoices.get(id).amountPaid >= invoices.get(id).totalDue')`... note `predToQuint` renders `.get(id).amountPaid` via `pathToQuint` with self=`invoices.get(id)`).

`emit/prose.ts` lifecycle line — render the guard:
```ts
        lines.push(`**${r.name} lifecycle:** ${declared.map(t =>
          `${t.from.map(label).join('/')} → ${label(t.to)} (${t.name}${t.requires ? ` — only if ${predEn(t.requires)}` : ''})`).join(', ')}`, '');
```

`emit/mermaid/statechart.ts` — guard label, sanitized for mermaid (no `{}`, no `&&`):
```ts
import type { Predicate } from '../../ast/invariant.js';
import { predToText } from '../code.js';

const guardLabel = (p: Predicate): string =>
  predToText(p).replaceAll('&&', 'and').replaceAll('||', 'or')
    .replaceAll('{', '(').replaceAll('}', ')').replaceAll('!', 'not ');

export function machineToMermaid(agg: AggregateDef, region: Region): string {
  const out = ['stateDiagram-v2', `  [*] --> ${region.initial}`];
  for (const t of (agg.machine?.transitions ?? []).filter(t => t.region === region.name)) {
    const label = `${t.name}${t.requires ? ` [${guardLabel(t.requires)}]` : ''}`;
    for (const f of t.from) out.push(`  ${f} --> ${t.to}: ${label}`);
  }
  for (const s of region.states.filter(s => s.tags?.includes('terminal')))
    out.push(`  ${s.name} --> [*]`);
  return out.join('\n') + '\n';
}
```
The mermaid.parse gate (`test/emit/mermaid-gate.test.ts`) validates syntax — add a guarded-transition fixture there so the sanitizer is exercised through real `mermaid.parse`.

- [ ] **Step 6: Round-trip arbitrary + docs**

`test/parse/arbitraries.ts` machineArb — thread the aggregate's numeric field names in and optionally attach a simple guard (guards may only reference own single-segment numeric fields, matching validate):
```ts
// machineArb signature becomes (fieldNames: string[], eventNames: string[], numFieldNames: string[])
// transitions map gains:
      transitions: regionNames.map((region, i) => {
        const t: TransitionDef = { name: transNames[i]!, region, from: [statesPer[i]![0]!], to: statesPer[i]![1]! };
        if (whens[i]) t.when = whens[i];
        if (guards[i] && numFieldNames.length)
          t.requires = { kind: 'cmp', op: 'ge',
            left: { kind: 'field', owner: 'self', path: [numFieldNames[0]!] },
            right: { kind: 'int', value: guards[i]! } };
        return t;
      }),
```
where `guards` is one more tuple member `fc.tuple(...regionNames.map(() => fc.option(fc.integer({min:0,max:99}), { nil: undefined })))`, and `aggArb` passes `rest.filter(isNumericPrim).map(f => f.name)` (define `isNumericPrim = (f: Field) => f.type.kind === 'prim' && ['Int','Money','Date','Duration'].includes(f.type.prim)`).

Update `docs/language/transition.md`: `requires` clause — predicate grammar reference, own-fields-only rule, `guard-cross-aggregate` diagnostic, honest-ceiling note (guards over machine-evolved counters are declarative-only; design §3.4).

- [ ] **Step 7: Full gate, then commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`

```bash
git add lattice/src lattice/test docs/language/transition.md
git commit -m "feat(lattice): transition guards — requires predicate, quint conjunct, projections (design §3.6/§5.2.1)"
```

---

### Task 4: `emits` — declared-event references on transitions

**Files:**
- Modify: `lattice/src/ast/domain.ts` (already has the field from Task 3's snippet — verify), `lattice/src/ast/validate.ts`
- Modify: `lattice/src/parse/lat.langium`, `lattice/src/parse/fromLangium.ts`, `lattice/src/emit/code.ts`
- Modify: `lattice/src/emit/prose.ts`, `lattice/src/emit/mermaid/statechart.ts`
- Modify: `lattice/test/parse/arbitraries.ts`, `docs/language/transition.md`, `docs/language/event.md`
- Test: extend `lattice/test/ast/validate-multisource.test.ts` or new `validate-emits.test.ts`

**Interfaces:**
- Consumes: `EventDef` set already computed in `validateModel` (`events` Set, line 46).
- Produces: `TransitionDef.emits?: string`; validation reuses code `unknown-event` (same code as `when` uses — message names `emits`).

- [ ] **Step 1: Failing test**

```ts
// in lattice/test/ast/validate-emits.test.ts — model helper like Task 1's, plus events: [{ name: 'Paid', fields: [] }]
it('accepts emits naming a declared event and rejects unknown ones', () => {
  expect(validateModel(model({ emits: 'Paid' }))).toEqual([]);
  const diags = validateModel(model({ emits: 'Nope' }));
  expect(diags.map(d => d.code)).toContain('unknown-event');
  expect(diags.find(d => d.code === 'unknown-event')!.message).toContain('emits');
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

`validate.ts` transition loop:
```ts
      if (t.emits && !events.has(t.emits))
        out.push({ code: 'unknown-event', message: `transition ${t.name} emits undeclared event ${t.emits}`, at: t.name });
```
`lat.langium` TransitionDecl gains `(';' 'emits' emits=ID)?` after the requires clause; `npx langium generate`.
`fromLangium.ts`: `if (t.emits) tr.emits = t.emits;`
`emit/code.ts`: append `${t.emits ? `; emits ${t.emits}` : ''}` before the closing ` }`.
`emit/prose.ts`: in the per-transition render, after the guard clause: `${t.emits ? `, announces ${t.emits}` : ''}`.
`emit/mermaid/statechart.ts` label: `` `${t.name}${t.requires ? ` [${guardLabel(t.requires)}]` : ''}${t.emits ? ` / ${t.emits}` : ''}` ``.
`arbitraries.ts` machineArb: reuse the `whens` pattern for an optional `emits` drawn from `eventNames` (a second `fc.option(fc.constantFrom(...eventNames))` tuple member; set `t.emits = emitses[i]`).
Reserved words: `emits` and `requires` are now grammar keywords — add BOTH to `RESERVED_WORDS` (Task 3 added the `requires` keyword to the grammar; if its reserved entry was missed the sync test fails here — fix in this commit).
Docs: `transition.md` emits clause; `event.md` gains "referenced by `transition … emits`" note.

- [ ] **Step 3: Full gate, then commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`

```bash
git add lattice/src lattice/test docs/language
git commit -m "feat(lattice): transitions declare emitted events — emits clause, checked against declared events (design §3.6)"
```

---

### Task 5: Nested entities + owned collections (surface, AST, validation)

No solver changes here — lists stay solver-dropped until Tasks 6–7; the ed6ea3b dropped-path guard keeps rejecting candidate paths into them, which is correct until then.

**Files:**
- Modify: `lattice/src/ast/domain.ts` (AggregateDef.entities + helper), `lattice/src/ast/validate.ts`
- Modify: `lattice/src/parse/lat.langium` (AggregateDecl), `lattice/src/parse/fromLangium.ts`, `lattice/src/emit/code.ts`
- Modify: `lattice/src/parse/diff.ts` (namedThings covers nested entities), `lattice/test/parse/arbitraries.ts`
- Modify: `docs/language/entity.md`, `docs/language/aggregate.md`
- Test: `lattice/test/ast/validate-nested.test.ts` (new), extend `fromLangium.test.ts`

**Interfaces:**
- Consumes: `EntityDef` (existing).
- Produces:
  - `AggregateDef.entities?: EntityDef[]`
  - `ownedCollectionChild(a: AggregateDef, f: Field): EntityDef | null` exported from `src/ast/domain.ts` — Tasks 6/7/8 all use it. Returns the nested child iff `f.type` is `{kind:'list', of:{kind:'enum', enum:<nestedName>}}`-shaped… **no** — `mapType` maps unknown names to `enum`; step 3 fixes that so a `List<InvoiceLine>` where `InvoiceLine` is a nested entity maps to `{kind:'list', of:{kind:'ref', target:'InvoiceLine'}}`? **No.** Decision (keep it simple and unambiguous): the mapper keeps unknown `NamedType` → enum; `ownedCollectionChild` matches `f.type.kind==='list' && f.type.of.kind==='ref' && a.entities?.some(e => e.name === f.type.of.target)`, and `fromLangium.mapType` gains an `ownersInScope` set so `List<InvoiceLine>` maps to `{kind:'list', of:{kind:'ref', target:'InvoiceLine'}}` (ref-to-owner already maps this way for top-level entities — nested names join that set).
  - Validation codes: `child-key-required` is the existing `missing-key`; new: `nested-entity-flat`.

- [ ] **Step 1: Failing tests**

```ts
// lattice/test/ast/validate-nested.test.ts
import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import { ownedCollectionChild } from '../../src/ast/domain.js';
import type { DomainModel, AggregateDef } from '../../src/ast/domain.js';

const inv = (childFields: any[], listOf = 'InvoiceLine'): DomainModel => ({
  context: 'C', enums: [], entities: [], events: [],
  aggregates: [{ kind: 'aggregate', name: 'Invoice',
    fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: listOf } } }],
    entities: [{ kind: 'entity', name: 'InvoiceLine', fields: childFields }] }],
});
const goodChild = [
  { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
  { name: 'amount', type: { kind: 'prim', prim: 'Money' } }];

describe('nested entities', () => {
  it('accepts a keyed, flat child and classifies the owned collection', () => {
    const m = inv(goodChild);
    expect(validateModel(m)).toEqual([]);
    const a = m.aggregates[0] as AggregateDef;
    expect(ownedCollectionChild(a, a.fields[1]!)?.name).toBe('InvoiceLine');
  });
  it('rejects unkeyed children', () => {
    expect(validateModel(inv([{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }]))
      .map(d => d.code)).toContain('missing-key');
  });
  it('rejects ref/list fields inside children (nested-entity-flat)', () => {
    expect(validateModel(inv([...goodChild, { name: 'bad', type: { kind: 'ref', target: 'Invoice' } }]))
      .map(d => d.code)).toContain('nested-entity-flat');
  });
  it('List of a non-nested target is not an owned collection', () => {
    const m = inv(goodChild, 'Invoice');
    const a = m.aggregates[0] as AggregateDef;
    expect(ownedCollectionChild(a, a.fields[1]!)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement AST + validation:

`src/ast/domain.ts`:
```ts
export interface AggregateDef { kind: 'aggregate'; name: string; fields: Field[]; entities?: EntityDef[]; machine?: Machine; doc?: string }

/** The nested child an owned collection ranges over, or null (design §3.2). */
export function ownedCollectionChild(a: AggregateDef, f: Field): EntityDef | null {
  if (f.type.kind !== 'list' || f.type.of.kind !== 'ref') return null;
  return a.entities?.find(e => e.name === (f.type as any).of.target) ?? null;
}
```

`src/ast/validate.ts` — inside the aggregate loop:
```ts
    for (const child of a.entities ?? []) {
      checkName('entity', child.name, `${a.name}.${child.name}`);
      checkFields(child.fields, `${a.name}.${child.name}`, true);   // missing-key covers child-key-required
      for (const f of child.fields)
        if (f.type.kind === 'ref' || f.type.kind === 'list')
          out.push({ code: 'nested-entity-flat', message: `nested entity ${a.name}.${child.name}.${f.name}: children carry prim/enum fields only in v1 (design §5.2)`, at: `${a.name}.${child.name}.${f.name}` });
    }
```
Add nested names to the duplicate-name pool (`all` array at line 40): `...m.aggregates.flatMap(a => (a.entities ?? []).map(e => e.name))`, and to the `owners` set (line 44) so `List<Child>`'s inner ref resolves: `...m.aggregates.flatMap(a => (a.entities ?? []).map(e => e.name))`.

- [ ] **Step 3: Grammar, mapper, printer, arbitraries, diff**

`lat.langium` AggregateDecl:
```
AggregateDecl:
    docs+=DOC* 'aggregate' name=ID '{' (fields+=FieldDecl | entities+=EntityDecl)* lifecycles+=LifecycleDecl* invariants+=InvariantDecl* '}';
```
`npx langium generate`.

`fromLangium.ts` AggregateDecl case:
```ts
        const def: AggregateDef = { kind: 'aggregate', name: a.name, fields: mapFields([...a.fields], enumSet, diags) };
        if (a.entities.length) def.entities = [...a.entities].map(e => {
          const child: EntityDef = { kind: 'entity', name: e.name, fields: mapFields([...e.fields], enumSet, diags) };
          const d = joinDocs([...e.docs]); if (d) child.doc = d;
          locs.set(`owner:${e.name}`, at(e)); noteFields(e.name, [...e.fields]);
          return child;
        });
```
`mapType` must map a `NamedType` naming any owner (top-level entity, aggregate, or nested entity) to a ref — it currently only handles prims/enums because bare owner names never appeared as field types. Give `loadLatText` an `ownerNames` set (top-level entity+aggregate names plus every nested entity name, collected in a pre-pass over `cst.items`) and change `mapType`'s fallback:
```ts
  const name = (t as G.NamedType).name;
  if (PRIMS.has(name)) return { kind: 'prim', prim: name as any };
  if (owners.has(name)) return { kind: 'ref', target: name };
  return { kind: 'enum', enum: name };
```
(thread `owners: Set<string>` through `mapType`/`mapFields` as a new parameter).

`emit/code.ts` `astToCode` aggregate section — print nested entities after fields, before lifecycles:
```ts
    for (const child of a.entities ?? []) {
      out.push('');
      doc(child.doc, '    ', out);
      out.push(`    entity ${child.name} {`);
      fieldLines(child.fields, '      ', out);
      out.push('    }');
    }
```

`parse/diff.ts` `namedThings` — nested entities participate so `apply` reports adds/removes; inside the owners loop is wrong (they're not top-level); add after it:
```ts
  for (const a of m.aggregates) for (const child of a.entities ?? []) {
    out.push({ scope: 'entity', owner: a.name, name: child.name,
      shape: `owner:${child.fields.map(f => f.name).sort().join(',')}` });
    for (const f of child.fields) out.push({ scope: 'field', owner: child.name, name: f.name, shape: `field:${child.name}:${cjson(f.type)}` });
  }
```

`arbitraries.ts` `aggArb` — with probability ~1/3 attach one nested entity + an owned collection field (a `fc.boolean()` tuple member; child via the existing `entityArb`-style generator but flat: reuse `fieldArb` for child fields, force a key first field; add parent field `{ name: <fresh camel>, type: { kind: 'list', of: { kind: 'ref', target: childName } } }`). Nested child names draw from `pascal` filtered against all existing names.

Docs: `entity.md` gains a "Nested in an aggregate" section (ownership semantics, flat-fields rule, `missing-key`/`nested-entity-flat`); `aggregate.md` mentions child entities + owned collections.

- [ ] **Step 4: Full gate, then commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`

```bash
git add lattice/src lattice/test docs/language
git commit -m "feat(lattice): nested entities + owned collections — surface, AST, validation, diff (design §3.2)"
```

### Task 6: Owned collections in the Quint emitter + witness adapter

Design §6.1. Encoding: bounded map `f: int -> {childFields}` plus `fCount: int` inside the owner record; per-index nondet draws at init (action-scope `nondet` is a Quint rule — per-element draws inside folds are illegal, so we draw `OWNED_BOUND` indexed values flat). Collections are frozen after init like all non-enum data. NOTE (design deviation, documented): the design sketched a `setOfMaps` draw; per-index draws are semantically identical (every bounded map is reachable) and simpler — record this in the commit body.

**Files:**
- Modify: `lattice/src/emit/quint.ts` (record type, init, `varTypes` child entries)
- Modify: `lattice/src/solvers/quint-adapter.ts` (`stateToEntities` materializes children)
- Create: `lattice/src/engine/owned.ts` (shared constants/helpers)
- Test: `lattice/test/emit/quint.test.ts` (extend), `lattice/test/solvers/quint-adapter.test.ts` (extend — ITF parsing is solver-free)

**Interfaces:**
- Produces:
  - `src/engine/owned.ts`: `export const OWNED_BOUND = 3;` and `export const childVarKey = (ownerVar: string, field: string) => `${ownerVar}#${field}`;`
  - Quint record shape per owned collection `lines` of child with solver fields `amount: int`: `lines: int -> { amount: int }, linesCount: int`.
  - `QuintEmission.varTypes` gains `childVarKey(v, f.name)` → child entity name (e.g. `invoices#lines` → `InvoiceLine`), which the adapter uses to type child entities.
  - Witness convention consumed by evaluator/salient/golden-trace fixtures: each live child (index `< linesCount`) becomes a `CaseEntity` `{ type: 'InvoiceLine', id: '<parentId>#lines0', fields: { amount: …, owner: '<parentId>' } }`; the parent keeps `linesCount` as field `'lines.count'`.

- [ ] **Step 1: Failing emitter test**

Add to `test/emit/quint.test.ts` (build a model like Task 5's `inv(goodChild)` helper — extract that helper to `test/fixtures.ts` as `invoiceLinesModel` so emit/adapter/evaluator tests share it):
```ts
it('encodes owned collections as bounded maps with a count', () => {
  const em = astToQuint(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], maxSteps: 3 });
  expect(em.source).toContain('lines: int -> { amount: int }');
  expect(em.source).toContain('linesCount: int');
  // per-index init draws, bounded by OWNED_BOUND
  expect(em.source).toContain('nondet nd_invoice_lines_0_amount');
  expect(em.source).toContain('nondet nd_invoice_linesCount = oneOf(0.to(3))');
  expect(em.varTypes['invoices#lines']).toBe('InvoiceLine');
});
```

- [ ] **Step 2: Run to verify failure**, then implement in `emit/quint.ts`:

Import `ownedCollectionChild` from `../ast/domain.js` and `OWNED_BOUND, childVarKey` from `../engine/owned.js`. In the owner loop:
```ts
    const ownedFields = (o.kind === 'aggregate' ? o.fields.filter(f => ownedCollectionChild(o, f)) : []);
    // record type: scalars as today, plus one map + count per owned collection
    for (const f of ownedFields) {
      const child = ownedCollectionChild(o as AggregateDef, f)!;
      const childFields = child.fields.map(cf => { const t = fieldQType(m, cf); return t ? `${cf.name}: ${t}` : null; }).filter(Boolean) as string[];
      fields.push(`${f.name}: int -> { ${childFields.join(', ')} }`, `${f.name}Count: int`);
      varTypes[childVarKey(v, f.name)] = child.name;
    }
```
(keep the existing scalar-fields line; owned list fields already return null from `fieldQType`, so they are not double-emitted).

Init (inside the same loop, after scalar inits):
```ts
    for (const f of ownedFields) {
      const child = ownedCollectionChild(o as AggregateDef, f)!;
      const entries: string[] = [];
      for (let i = 0; i < OWNED_BOUND; i++) {
        const kv: string[] = [];
        for (const cf of child.fields) {
          const nd = initValue(m, cf, initNondets, `${o.name.toLowerCase()}_${f.name}_${i}`);
          if (nd) kv.push(`${cf.name}: ${nd}`);
        }
        entries.push(`${i} -> { ${kv.join(', ')} }`);
      }
      initNondets.push(`nondet nd_${o.name.toLowerCase()}_${f.name}Count = oneOf(0.to(${OWNED_BOUND}))`);
      inits.push(`${f.name}: Map(${entries.join(', ')})`, `${f.name}Count: nd_${o.name.toLowerCase()}_${f.name}Count`);
    }
```
CAUTION: `initValue`'s `nd` name is `nd_${tag}_${f.name}` — the per-index `tag` above already disambiguates; verify no name collisions in the generated source (the emitter test's `nd_invoice_lines_0_amount` expectation pins it).

- [ ] **Step 3: Adapter materializes children**

`src/solvers/quint-adapter.ts` `stateToEntities` — the per-owner field loop currently copies scalars. ITF encodes maps as `{'#map': [[k, v], …]}`. Extend the loop (import `childVarKey` semantics — the adapter receives `varTypes`):
```ts
      const fields: Record<string, string | number | boolean> = {};
      const children: CaseEntity[] = [];
      for (const [fk, fv] of Object.entries(rec)) {
        if (fv !== null && typeof fv === 'object' && '#map' in (fv as any)) {
          const childType = varTypes[`${k}#${fk}`];
          if (!childType) continue;                       // not an owned collection — ignore
          const count = Number(deBig((rec as any)[`${fk}Count`] ?? 0));
          for (const [ck, cv] of (fv as any)['#map']) {
            if (Number(deBig(ck)) >= count) continue;     // beyond linesCount: not live
            const cf: Record<string, string | number | boolean> = { owner: String(id) };
            for (const [k2, v2] of Object.entries(cv as Record<string, unknown>)) cf[k2] = deBig(v2);
            children.push({ type: childType, id: `${String(id)}#${fk}${Number(deBig(ck))}`, fields: cf });
          }
          continue;
        }
        if (fk.endsWith('Count') && varTypes[`${k}#${fk.slice(0, -'Count'.length)}`]) {
          fields[`${fk.slice(0, -'Count'.length)}.count`] = deBig(fv); continue;
        }
        fields[fk.replace(/_state$/, '.state')] = deBig(fv);
      }
      entities.push({ type, id: String(id), fields }, ...children);
```
Add a solver-free test in `test/solvers/quint-adapter.test.ts`: feed `parseITF` a hand-built ITF state with a `lines` `#map` of 3 entries and `linesCount: 2`, assert exactly 2 `InvoiceLine` entities with `owner` set and the parent carries `'lines.count': 2`.

- [ ] **Step 4: Real-solver round-trip**

Add to `test/solvers/quint-adapter.integration.test.ts`: emit `astToQuint(invoiceLinesModel, {kind: 'probe-permit', hi: <statePredicate 'totalDue >= 0' on Invoice>, exclusions: [], maxSteps: 2})`, run through the real adapter, assert the witness parses and any returned `InvoiceLine` entities have numeric `amount` and an `owner` matching an Invoice id. (Serialized suite; follows the existing integration-test port-isolation pattern.)

- [ ] **Step 5: Full gate, then commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`

```bash
git add lattice/src/emit/quint.ts lattice/src/solvers/quint-adapter.ts lattice/src/engine/owned.ts lattice/test
git commit -m "feat(lattice): owned collections in quint — bounded-map encoding, child witness materialization (design §6.1)"
```

---

### Task 7: Owned collections in the Alloy emitter

**Files:**
- Modify: `lattice/src/emit/alloy.ts` (child sigs, skip owned list on parent)
- Test: `lattice/test/emit/alloy.test.ts` (extend), `lattice/test/solvers/alloy-adapter.integration.test.ts` (extend)

**Interfaces:**
- Produces: per owned collection, a child sig `sig InvoiceLine { owner: one Invoice, amount: one Int }` — containment by construction (`one owner`); the parent sig has NO lines relation (children point up; Alloy witnesses put `owner` in the child's fields, which the existing adapter already maps to an `owner` field because it resolves relation atoms — matching Task 6's evaluator convention exactly).
- Child `key` fields stay dropped (keys are witness-invisible across the board); within-parent key uniqueness is enforced by `validateModel` + evaluator convention only — documented in `entity.md` (design accepts this: keys never reach solvers).

- [ ] **Step 1: Failing test**

```ts
// test/emit/alloy.test.ts
it('emits owned children as sigs with one owner, and no list relation on the parent', () => {
  const src = astToAlloy(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], scope: 4 });
  expect(src).toContain('sig InvoiceLine {');
  expect(src).toContain('owner: one Invoice');
  expect(src).toContain('amount: one Int');
  expect(src).not.toContain('lines:');
});
```

- [ ] **Step 2: Implement** in `emit/alloy.ts`:

`emitOwnerSig` already ignores list fields (no branch matches) — verify, don't change. Add:
```ts
import { ownedCollectionChild } from '../ast/domain.js';

function emitChildSigs(a: AggregateDef): string[] {
  const out: string[] = [];
  for (const f of a.fields) {
    const child = ownedCollectionChild(a, f);
    if (!child) continue;
    const fields = [`  owner: one ${a.name}`];
    for (const cf of child.fields) {
      if (cf.key) continue;
      if (cf.type.kind === 'enum') fields.push(`  ${cf.name}: one ${cf.type.enum}`);
      else if (cf.type.kind === 'prim' && isIntPrim(cf.type.prim)) fields.push(`  ${cf.name}: one Int`);
    }
    out.push(`sig ${child.name} {\n${fields.join(',\n')}\n}`);
  }
  return out;
}
```
and in `astToAlloy` after `parts.push(emitOwnerSig(a))`: `parts.push(...emitChildSigs(a));`

- [ ] **Step 3: Real-solver check** — extend `alloy-adapter.integration.test.ts`: run the Task-1-style probe on `invoiceLinesModel`, assert the parsed witness's `InvoiceLine` entities carry `owner` ids resolving to Invoice entities.

- [ ] **Step 4: Full gate, then commit**

```bash
git add lattice/src/emit/alloy.ts lattice/test
git commit -m "feat(lattice): owned collections in alloy — child sigs with one-owner containment (design §6.1/§6.3)"
```

---

### Task 8: `sumOverCollection` — candidate kind, validation, evaluator, surface

**Files:**
- Modify: `lattice/src/ast/invariant.ts` (Candidate union), `lattice/src/ast/grammar.ts` (shapeErrors + semantic checks + routeCandidate)
- Modify: `lattice/src/engine/evaluate.ts`, `lattice/src/parse/lat.langium` (SumBody), `lattice/src/parse/fromLangium.ts` (mapBody signature gains the aggregate's def), `lattice/src/emit/code.ts` (candidateBodyText), `lattice/src/emit/prose.ts` (renderCandidateEnglish)
- Modify: `lattice/test/parse/arbitraries.ts` (sum arm), `docs/language/invariant-forms.md`
- Test: `lattice/test/ast/grammar-sum.test.ts`, extend `lattice/test/engine/evaluate.test.ts`

**Interfaces:**
- Produces the candidate kind (note `child` — carried so the model-free evaluator can find rows; validated to match the collection's declared child; design delta recorded in the design doc):
```ts
| { kind: 'sumOverCollection'; aggregate: string;
    collection: string;                 // owned List field name on the aggregate
    child: string;                      // the nested entity's name (== ownedCollectionChild(...).name)
    field: string;                      // numeric field on the child
    op: 'eq' | 'le' | 'ge';
    total: Path }                       // single-segment numeric path on the aggregate
```
- Surface: `invariant totalMatchesLines { totalDue == sum(lines, amount) }` (ops `==`, `<=`, `>=`).
- `routeCandidate('sumOverCollection') → 'quint'` (conservation precedent; Alloy encodes it only as an adopted constraint — Task 10).
- Evaluator ground truth: children are `s.entities` with `type === c.child && fields.owner === subject.id`; sum of `fields[c.field]`; unknown facts don't convict (any child missing the field, or missing total → permit).
- Validation codes: `sum-not-owned-collection`, `ill-typed` (field/total non-numeric), reuse `unknown-aggregate`/`unknown-path`.

- [ ] **Step 1: Failing tests**

```ts
// lattice/test/ast/grammar-sum.test.ts  — uses invoiceLinesModel + a totalDue field on Invoice
const sum = (over: Partial<any> = {}): any => ({ kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'eq', total: ['totalDue'], ...over });

it('accepts the b02 shape', () => expect(validateCandidate(sum(), invoiceLinesModel)).toEqual([]));
it('rejects non-owned collections', () =>
  expect(validateCandidate(sum({ collection: 'totalDue' }), invoiceLinesModel).map(d => d.code)).toContain('sum-not-owned-collection'));
it('rejects a child mismatch', () =>
  expect(validateCandidate(sum({ child: 'Invoice' }), invoiceLinesModel).map(d => d.code)).toContain('sum-not-owned-collection'));
it('rejects non-numeric child fields', () =>
  expect(validateCandidate(sum({ field: 'lineId' }), invoiceLinesModel).map(d => d.code)).toContain('ill-typed'));
it('routes to quint', () => expect(routeCandidate(sum())).toBe('quint'));
```
```ts
// test/engine/evaluate.test.ts — evaluator semantics
const st = (amounts: number[], total: number): CaseState => ({ entities: [
  { type: 'Invoice', id: 'i1', fields: { totalDue: total, 'lines.count': amounts.length } },
  ...amounts.map((a, i) => ({ type: 'InvoiceLine', id: `i1#lines${i}`, fields: { amount: a, owner: 'i1' } })),
]});
it('sumOverCollection: forbids mismatched totals, permits exact and unknown', () => {
  expect(evaluateCandidate(sum(), st([3, 4], 7))).toBe('permit');
  expect(evaluateCandidate(sum(), st([3, 4], 8))).toBe('forbid');
  expect(evaluateCandidate(sum({ op: 'le' }), st([3, 4], 9))).toBe('forbid');   // total <= sum fails: 9 > 7
  expect(evaluateCandidate(sum(), { entities: [{ type: 'Invoice', id: 'i1', fields: {} }] })).toBe('permit'); // unknown
});
```
NOTE the `le` reading: the candidate asserts `total <= sum(...)` when `op:'le'` — total on the LEFT, matching the surface `totalDue <= sum(lines, amount)`.

- [ ] **Step 2: Implement**

`invariant.ts`: add the union member (block comment above it: "elicitable; quint-routed; alloy encodes as adopted constraint only").

`grammar.ts`: add `'sumOverCollection'` to `KNOWN_KINDS`; `shapeErrors` case:
```ts
    case 'sumOverCollection':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isString(c.collection), 'collection', 'string', c.collection)
        ?? check(isString(c.child), 'child', 'string', c.child)
        ?? check(isString(c.field), 'field', 'string', c.field)
        ?? check(['eq', 'le', 'ge'].includes(c.op), 'op', "'eq'|'le'|'ge'", c.op)
        ?? check(isPath(c.total), 'total', 'Path (array of string)', c.total);
      break;
```
Semantic checks in `validateCandidate`:
```ts
    case 'sumOverCollection': {
      const a = m.aggregates.find(x => x.name === c.aggregate);
      const f = a?.fields.find(x => x.name === c.collection);
      const child = a && f ? ownedCollectionChild(a, f) : null;
      if (!child || child.name !== c.child) {
        out.push({ code: 'sum-not-owned-collection', message: `${c.collection} is not an owned collection of ${c.aggregate} with child ${c.child}`, at: 'collection' });
        break;
      }
      const cf = child.fields.find(x => x.name === c.field);
      if (!cf || cf.key || cf.type.kind !== 'prim' || !SOLVER_INT_PRIMS.includes(cf.type.prim))
        out.push({ code: 'ill-typed', message: `sum field ${c.child}.${c.field} must be a numeric (Int/Money/Date/Duration) non-key field`, at: 'field' });
      checkPath(c.total, 'total');   // numeric own path; reuses key-path/unrepresentable-path guards
      break;
    }
```
(import `ownedCollectionChild`; `routeCandidate` gains `case 'sumOverCollection': return 'quint';`)

`evaluate.ts`:
```ts
    case 'sumOverCollection': {
      for (const e of subjects()) {
        const kids = s.entities.filter(x => x.type === c.child && x.fields['owner'] === e.id);
        const vals = kids.map(k => k.fields[c.field]);
        const total = resolveValue(s, e, c.total);
        if (vals.some(v => typeof v !== 'number') || typeof total !== 'number') continue;  // unknown facts don't convict
        const sum = (vals as number[]).reduce((a, b) => a + b, 0);
        const ok = c.op === 'eq' ? total === sum : c.op === 'le' ? total <= sum : total >= sum;
        if (!ok) return 'forbid';
      }
      return 'permit';
    }
```

`lat.langium` — add `SumBody` to InvariantBody alternatives (FIRST among them is fine; keyword-led, unambiguous):
```
InvariantBody:
    UniqueBody | RefsResolveBody | CardinalityBody | TerminalBody | MonotonicBody | ConserveBody | LeadsToBody | SumBody | PredicateBody;

SumBody:
    total=PathExpr op=('=='|'<='|'>=') 'sum' '(' collection=ID ',' field=ID ')';
```
CAUTION: `SumBody` and `PredicateBody` both start with a path — Langium needs lookahead past the op to `'sum'`. If `langium generate` reports an ambiguity, reorder so SumBody precedes PredicateBody (shown above) — Langium's ALL(*) handles it; the round-trip property is the behavioral check. `npx langium generate` + add `'sum'` to `RESERVED_WORDS`.

`fromLangium.ts` `mapBody` — thread the OWNING AggregateDef in (change signature to `mapBody(inv, aggregate: string, aggDef: AggregateDef | undefined, enums)` and pass `model.aggregates.find(x => x.name === owner)` at both call sites):
```ts
    case 'SumBody': {
      const b2 = b as G.SumBody;
      const f = aggDef?.fields.find(x => x.name === b2.collection);
      const child = aggDef && f ? ownedCollectionChild(aggDef, f) : null;
      const ops: Record<string, 'eq' | 'le' | 'ge'> = { '==': 'eq', '<=': 'le', '>=': 'ge' };
      return { kind: 'sumOverCollection', aggregate, collection: b2.collection,
        child: child?.name ?? '', field: b2.field, op: ops[b2.op]!, total: mapPath(b2.total) };
    }
```
(`child: ''` when unresolvable — `validateCandidate` then rejects with `sum-not-owned-collection`, which `loadLatText` reports; no throw.)

`emit/code.ts` `candidateBodyText`:
```ts
    case 'sumOverCollection': {
      const ops = { eq: '==', le: '<=', ge: '>=' } as const;
      return `${c.total.join('.')} ${ops[c.op]} sum(${c.collection}, ${c.field})`;
    }
```
`emit/prose.ts` `renderCandidateEnglish`:
```ts
    case 'sumOverCollection': {
      const rel = c.op === 'eq' ? 'always equals' : c.op === 'le' ? 'never exceeds' : 'is never below';
      return `On every ${c.aggregate}, ${c.total.join('.')} ${rel} the sum of ${c.field} over its ${c.collection}.`;
    }
```
`arbitraries.ts` `candidateArb` — when the aggregate has an owned collection (Task 5's arb produces them), add the arm:
```ts
  const owned = agg.fields.map(f => ({ f, child: ownedCollectionChild(agg, f) })).filter(x => x.child);
  if (owned.length && paths.length) {
    const numChildFields = owned[0]!.child!.fields.filter(representable).map(f => f.name);
    if (numChildFields.length) arbs.push(fc.constantFrom<'eq' | 'le' | 'ge'>('eq', 'le', 'ge').map(op =>
      ({ kind: 'sumOverCollection' as const, aggregate: agg.name, collection: owned[0]!.f.name,
         child: owned[0]!.child!.name, field: numChildFields[0]!, op, total: paths[0]! })));
  }
```
Docs: `invariant-forms.md` gains the sum form with the b02 provenance note.

- [ ] **Step 3: Full gate, then commit**

```bash
git add lattice/src lattice/test docs/language/invariant-forms.md
git commit -m "feat(lattice): sumOverCollection candidate kind — validation, evaluator, .lat surface (design §4.1/§5)"
```

### Task 9: Sum in the solvers — quint fold, alloy adopted-constraint + bitwidth, salient dims, masking regressions

The checklist-critical task (points 3, 4, 5, 7 for the sum form). Design §6.2/§6.4.

**Files:**
- Modify: `lattice/src/emit/quint.ts` (`candidateToQuint` sum case; `shapeToQuint` new dim branches)
- Modify: `lattice/src/emit/alloy.ts` (`candidateToPred` sum case; bitwidth policy; `shapeToPred` numeric-dim branch)
- Modify: `lattice/src/engine/salient.ts` (`extractSalient` sum dims)
- Modify: `lattice/src/engine/planner.ts` — ONLY if `expressibleAdopted` filters by kind-list (check; add `sumOverCollection` so adopted sums conjoin into queries)
- Modify: `lattice/src/ast/grammar.ts` — narrow the ed6ea3b dropped-path guard: `checkPath` on `c.total` stays; the collection/field pair is validated by the sum case itself, NOT by `checkPath` (owned collections never appear as generic paths) — verify no `unknown-path` fires on sum candidates (Task 8's tests already pin this).
- Test: extend `lattice/test/emit/quint.test.ts`, `lattice/test/emit/alloy.test.ts`, `lattice/test/engine/salient.test.ts` (masking regressions), `lattice/test/solvers/quint-adapter.integration.test.ts` (real fold round-trip)

**Interfaces:**
- Salient dim formats (consumed by BOTH shape rebuilders; all-subjects-agree guard applies to each):
  - `<collection>.count` (numeric value)
  - `sum(<collection>.<field>)` (numeric value)
  - `<total-path> value` (numeric value)
- Quint fold: `range(0, <OWNED_BOUND>).foldl(0, (acc, i) => if (i < x.linesCount) acc + x.lines.get(i).amount else acc)`
- Alloy adopted form: `pred AdoptedN { all x: Invoice | (sum l: { l: InvoiceLine | l.owner = x } | l.amount) = x.totalDue }` (op-mapped)
- Bitwidth: `astToAlloy` uses `but 7 Int` when the query (hi/hj/adopted) contains any `sumOverCollection`, else `but 5 Int`.

- [ ] **Step 1: Failing emitter tests**

```ts
// test/emit/quint.test.ts
it('compiles adopted sums to a bounded fold', () => {
  const em = astToQuint(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice,
    exclusions: [], adopted: [sumCandidate], maxSteps: 2 });
  expect(em.source).toContain('range(0, 3).foldl(0, (acc, i) => if (i < x.linesCount) acc + x.lines.get(i).amount else acc)');
});
// test/emit/alloy.test.ts
it('conjoins adopted sums with alloy sum and raises bitwidth to 7 Int', () => {
  const src = astToAlloy(invoiceLinesModel, { kind: 'probe-forbid', hi: someUniqueOnInvoice,
    exclusions: [], adopted: [sumCandidate], scope: 4 });
  expect(src).toContain('(sum l: { l: InvoiceLine | l.owner = x } | l.amount) = x.totalDue');
  expect(src).toContain('but 7 Int');
});
it('keeps 5 Int without sums', () => {
  const src = astToAlloy(invoiceLinesModel, { kind: 'probe-forbid', hi: someUniqueOnInvoice, exclusions: [], scope: 4 });
  expect(src).toContain('but 5 Int');
});
```

- [ ] **Step 2: Implement emitters**

`emit/quint.ts` `candidateToQuint` — add before the throw (import `OWNED_BOUND`):
```ts
  if (c.kind === 'sumOverCollection') {
    const fold = `range(0, ${OWNED_BOUND}).foldl(0, (acc, i) => if (i < x.${c.collection}Count) acc + x.${c.collection}.get(i).${c.field} else acc)`;
    const ops = { eq: '==', le: '<=', ge: '>=' } as const;
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${pathToQuint(m, c.total, 'x', c.aggregate)} ${ops[c.op]} ${fold}) })`;
  }
```
`emit/alloy.ts` `candidateToPred` — add a case (import `ownedCollectionChild` — child name is on the candidate):
```ts
    case 'sumOverCollection': {
      const ops = { eq: '=', le: '<=', ge: '>=' } as const;
      return `pred ${name} { all x: ${c.aggregate} | (sum l: { l: ${c.child} | l.owner = x } | l.${c.field}) ${flip(ops[c.op])} x.${c.total.join('.')} }`;
    }
```
CAREFUL with operand order: the candidate asserts `total <op> sum`; the Alloy text above puts sum first, so flip the op: `flip = (o) => o === '<=' ? '>=' : o === '>=' ? '<=' : '='`. Alternatively emit `x.total <op> (sum …)` and skip flipping — DO THAT (simpler, mirrors quint):
```ts
      return `pred ${name} { all x: ${c.aggregate} | x.${c.total.join('.')} ${ops[c.op]} (sum l: { l: ${c.child} | l.owner = x } | l.${c.field}) }`;
```
(update the Step-1 alloy expectation string accordingly: `x.totalDue = (sum l: { l: InvoiceLine | l.owner = x } | l.amount)`).

Bitwidth — in `astToAlloy`, before the run lines:
```ts
  const hasSum = [q.hi, q.hj, ...(q.adopted ?? [])].some(c => c?.kind === 'sumOverCollection');
  const intW = hasSum ? 7 : 5;   // 3 children × values ≤15 sum to ≤45 < 2^6−1 (design §6.2)
```
and replace the three `but 5 Int` literals with `` but ${intW} Int ``.

`engine/planner.ts`: locate `expressibleAdopted` — if it whitelists kinds, add `'sumOverCollection'` (it must conjoin in BOTH engines now that both encode it). If it filters by `routeCandidate`, no change; verify with a planner test asserting an adopted sum reaches `QuintQuery.adopted` and `AlloyQuery.adopted`.

- [ ] **Step 3: Salient dims + shape rebuilders + masking regressions**

`engine/salient.ts` `extractSalient` — add alongside the statePredicate branch:
```ts
    if (c.kind === 'sumOverCollection') {
      const subjects = s.entities.filter(e => e.type === c.aggregate);
      const per = subjects.map(e => {
        const kids = s.entities.filter(x => x.type === c.child && x.fields['owner'] === e.id);
        const vals = kids.map(k => k.fields[c.field]);
        const total = resolveValue(s, e, c.total);
        return { n: kids.length,
          sum: vals.every(v => typeof v === 'number') ? (vals as number[]).reduce((a, b) => a + b, 0) : undefined,
          total: typeof total === 'number' ? total : undefined };
      });
      // all-subjects-agree guard (same rationale as the inState capture above): single-existential
      // shapes cannot express "which subject", so a disagreement drops the dim.
      const agree = <T>(vs: (T | undefined)[]): T | undefined => {
        const set = new Set(vs.filter(v => v !== undefined));
        return set.size === 1 ? [...set][0] as T : undefined;
      };
      const n = agree(per.map(p => p.n)), sum = agree(per.map(p => p.sum)), total = agree(per.map(p => p.total));
      if (n !== undefined) facts.set(`${c.collection}.count`, { dim: `${c.collection}.count`, value: n });
      if (sum !== undefined) facts.set(`sum(${c.collection}.${c.field})`, { dim: `sum(${c.collection}.${c.field})`, value: sum });
      if (total !== undefined) facts.set(`${c.total.join('.')} value`, { dim: `${c.total.join('.')} value`, value: total });
    }
```
`emit/quint.ts` `shapeToQuint` — add branches BEFORE the generic ones (import `OWNED_BOUND`):
```ts
    const mCount = f.dim.match(/^(\w+)\.count$/);
    if (mCount) { conj.push(`x.${mCount[1]}Count == ${f.value}`); continue; }
    const mSum = f.dim.match(/^sum\((\w+)\.(\w+)\)$/);
    if (mSum) { conj.push(`range(0, ${OWNED_BOUND}).foldl(0, (acc, i) => if (i < x.${mSum[1]}Count) acc + x.${mSum[1]}.get(i).${mSum[2]} else acc) == ${f.value}`); continue; }
    const mTot = f.dim.match(/^([\w.]+) value$/);
    if (mTot) { conj.push(`${pathToQuint(m, splitPathStr(mTot[1]!), 'x', agg)} == ${f.value}`); continue; }
```
`emit/alloy.ts` `shapeToPred` — same three dims (child name is not in the dim string; recover it from the subject candidate when it's a sum, else skip the sum dim — a non-sum Alloy subject never carries sum dims):
```ts
    const mCount = f.dim.match(/^(\w+)\.count$/);
    if (mCount && subject.kind === 'sumOverCollection')
      { conj.push(`#{ l: ${subject.child} | l.owner = a } = ${f.value}`); continue; }
    const mSum = f.dim.match(/^sum\((\w+)\.(\w+)\)$/);
    if (mSum && subject.kind === 'sumOverCollection')
      { conj.push(`(sum l: { l: ${subject.child} | l.owner = a } | l.${mSum[2]}) = ${f.value}`); continue; }
    const mTot = f.dim.match(/^([\w.]+) value$/);
    if (mTot) { conj.push(`${alloyPath('a', mTot[1]!.split('.'))} = ${f.value}`); continue; }
```
Masking regressions in `test/engine/salient.test.ts` (checklist point 7, the Task-17/18 bug family):
```ts
it('sum dims: same count+sum+total ⇒ same salient key regardless of row split (shape may exclude both)', () => {
  const a = extractSalient([sumCandidate], st([3, 4], 7));
  const b = extractSalient([sumCandidate], st([5, 2], 7));
  expect(salientKey(a)).toBe(salientKey(b));
});
it('sum dims: different sums ⇒ different keys (a judged shape must not cancel a distinct pair)', () => {
  const a = extractSalient([sumCandidate], st([3, 4], 7));
  const b = extractSalient([sumCandidate], st([3, 5], 7));
  expect(salientKey(a)).not.toBe(salientKey(b));
});
it('sum dims: two subjects disagreeing on sums drop the dim (all-subjects-agree)', () => {
  const twoInvoices: CaseState = { entities: [...st([3], 3).entities,
    { type: 'Invoice', id: 'i2', fields: { totalDue: 9, 'lines.count': 1 } },
    { type: 'InvoiceLine', id: 'i2#lines0', fields: { amount: 9, owner: 'i2' } }] };
  expect(extractSalient([sumCandidate], twoInvoices).map(f => f.dim)).not.toContain('sum(lines.amount)');
});
```

- [ ] **Step 4: Real-solver distinguish round-trip**

Extend `test/solvers/quint-adapter.integration.test.ts`: distinguish `total == sum` vs `total <= sum` on `invoiceLinesModel` with real Apalache; assert a witness arrives, `evaluateCandidate` splits the two candidates on it (one permit, one forbid), and the witness's child rows + parent total are consistent with the reported verdicts. This is the sum form's propose→distinguish reality check ahead of golden trace D.

- [ ] **Step 5: Full gate, then commit**

```bash
git add lattice/src lattice/test
git commit -m "feat(lattice): sum encodings — quint fold, alloy adopted sum, 7-Int bitwidth, salient dims + masking regressions (design §6.2/§6.4)"
```

---

### Task 10: Value objects — surface, AST, validation, printer

**Files:**
- Modify: `lattice/src/ast/domain.ts` (ValueDef, TypeRef value kind, DomainModel.values), `lattice/src/ast/validate.ts`
- Modify: `lattice/src/parse/lat.langium` (ValueDecl in ContextItem), `lattice/src/parse/fromLangium.ts` (mapType value resolution; ValueDecl case incl. its invariants via mapPred), `lattice/src/emit/code.ts`
- Modify: `lattice/src/ast/reserved.ts` (+`value`), `lattice/test/parse/arbitraries.ts`
- Create: `docs/language/value.md`; modify `docs/language/README.md`, `docs/language/field-types.md`
- Test: `lattice/test/ast/validate-values.test.ts`, extend `fromLangium.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ValueDef {
  kind: 'value'; name: string; fields: Field[];          // prim/enum only (v1)
  invariants?: { name: string; body: Predicate; doc?: string }[];   // own-field structural laws
  doc?: string;
}
// DomainModel gains values: ValueDef[]   (REQUIRED array like entities/events — update every
// literal DomainModel in tests; tsc enumerates them)
// TypeRef gains | { kind: 'value'; value: string }
```
- Surface:
```
value Period {
  start : Date
  end   : Date
  invariant wellOrdered { start < end }
}
```
- Validation: `value-flat` (non-prim/enum field), `value-no-key`, name pool joins duplicate-name/reserved checks; value invariant predicates validated against the value's OWN fields (reuse `checkGuard`'s term walker pattern with the value's field list and no machine).

- [ ] **Step 1: Failing tests** (validate: accepts Period; rejects keyed field; rejects ref field; rejects invariant referencing unknown field. Parse: `.lat` above round-trips; a field `period : Period` maps to `{kind:'value', value:'Period'}`.)

Write them in the same style as Tasks 3/5 — value model helper + `loadLatText` snippet asserting the mapped shapes.

- [ ] **Step 2: Implement**

`domain.ts`: types above; `DomainModel.values: ValueDef[]`.
`validate.ts`: iterate `m.values` — checkName; per field: `checkType`, no key (`value-no-key`), only prim/enum (`value-flat`); invariants' predicates walked with a field-list-scoped checker (extract Task 3's `checkGuard` into a shared `checkScopedPred(fields, regions, enums, at, p, out, crossCode)` and call it with the value's fields, no regions, code `value-cross-field` → design says own-fields-only; reuse `guard-cross-aggregate`? NO — use a distinct message but the same walker). Add value names to the duplicate-name pool. `checkType` gains: `if (t.kind === 'value' && !values.has(t.value)) out.push({ code: 'unresolved-value', … })`.
`lat.langium`:
```
ContextItem:
    EnumDecl | EntityDecl | AggregateDecl | EventDecl | TicksDecl | InvariantDecl | ValueDecl;

ValueDecl:
    docs+=DOC* 'value' name=ID '{' fields+=FieldDecl* invariants+=InvariantDecl* '}';
```
`npx langium generate`; reserved +`value`.
`fromLangium.ts`: pre-pass collects value names; `mapType` resolution order: prim → value → owner-ref → enum. ValueDecl case maps fields + invariants (`mapPred` with enumMap; `where`/`on` on a value invariant → diagnostic `value-invariant-plain`). Naming warnings: value PascalCase, its fields camelCase.
`emit/code.ts`: print value blocks after enums, before entities:
```ts
  for (const v of m.values) {
    doc(v.doc, '  ', out);
    out.push(`  value ${v.name} {`);
    fieldLines(v.fields, '    ', out);
    for (const inv of v.invariants ?? []) {
      doc(inv.doc, '    ', out);
      out.push(`    invariant ${inv.name} { ${predToText(inv.body)} }`);
    }
    out.push('  }', '');
  }
```
`typeStr` in code.ts gains `: f.type.kind === 'value' ? f.type.value` branch. `domainDiagram.ts` `typeStr` gains the same (`case 'value': return t.value;`).
`arbitraries.ts`: optional one value type (flat prim fields, optional `start < end`-style invariant when it has ≥2 numeric fields) + optionally use it as an aggregate field type. All model literals in tests gain `values: []` (tsc enumerates).
Docs: new `value.md` (structural equality, no key, flat, laws auto-enforced per use site — with a parse-gated example), README index row, `field-types.md` mentions value-typed fields.

- [ ] **Step 3: Full gate, then commit**

```bash
git add lattice/src lattice/test docs/language
git commit -m "feat(lattice): value objects — surface, AST, validation, printer (design §3.5)"
```

---

### Task 11: Value semantics — solver inlining, path resolution, type-carried laws

**Files:**
- Modify: `lattice/src/ast/grammar.ts` (`resolveFieldPath` through value fields), `lattice/src/engine/evaluate.ts` (`resolveValue` dotted-key fast path)
- Modify: `lattice/src/emit/quint.ts` (nested record + value-hop paths), `lattice/src/emit/alloy.ts` (flattened `_`-joined fields + value-aware path rendering)
- Create: `lattice/src/engine/witness.ts` (`remapValueKeys`) — both adapter results pass through it
- Modify: `lattice/src/engine/hypothesis.ts` (call `remapValueKeys` after each solver returns — locate the two `deps.alloy(...)`/`deps.quint(...)` result-to-CaseState sites)
- Modify: `lattice/src/engine/implied.ts` + `lattice/src/engine/templates.ts` (type-carried laws — mirrors the Money pattern exactly)
- Test: extend `grammar-sum`-style path tests, `evaluate.test.ts`, `quint.test.ts`, `alloy.test.ts`, `implied.test.ts`, `templates.test.ts`; real-solver witness round-trip in the integration tests

**Interfaces:**
- Path convention everywhere: value paths are dotted (`['period','start']` ⇒ dim/witness key `period.start`).
- Quint: value field = nested record (`period: { start: int, end: int }`); `pathToQuint` renders `.period.start` (plain hop, no `.get`).
- Alloy: value field flattens to `period_start: one Int`; a new `alloyFieldPath(m, ownerName, p)` joins value hops with `_` and everything else with `.` — `termToAlloy`/`shapeToPred`/`extraComparisonPaths` route through it (they gain `m`/`ownerName` params).
- Witness normalization: `remapValueKeys(m: DomainModel, cs: CaseState): CaseState` — renames entity field keys `period_start` → `period.start` for every value-typed field of the entity's declared type (both adapters produce `_`-flattened keys: Alloy natively; Quint's adapter flattens nested non-`#map` objects with `_` — add that in this task).
- Type-carried laws (design §3.5): for each owner field `f` of value type V, each V-invariant instantiates a `statePredicate` on the owner with every term path prefixed `[f.name, …]`:
  - `impliedInvariants` gains these (id `implied-val<V><Owner><f><inv>`) — parse-dedup + never printed per site;
  - `matchTemplates.adopt` gains the same candidates (id `tpl-val-${V}-${o.name}-${f.name}-${inv.name}`, name `ValueLaw_${o.name}_${f.name}_${inv.name}`) — enforcement with template provenance, exactly like Money non-negativity exists in both.

- [ ] **Step 1: Failing tests** — key ones:

```ts
// grammar: value paths resolve
expect(resolveFieldPath(periodModel, 'Subscription', ['period', 'start'])?.type).toEqual({ kind: 'prim', prim: 'Date' });
// evaluate: dotted-key fast path
expect(resolveValue({ entities: [] }, { type: 'S', id: 's', fields: { 'period.start': 5 } }, ['period', 'start'])).toBe(5);
// quint: nested record + path
expect(em.source).toContain('period: { start: int, end: int }');
expect(candidateToQuintSource).toContain('x.period.start');
// alloy: flattened field + path
expect(src).toContain('period_start: one Int');
expect(src).toContain('x.period_start');
// implied + templates: law instantiated per use site with prefixed paths
const laws = impliedInvariants(periodModel).filter(i => i.id.includes('val'));
expect(laws[0]!.candidate).toMatchObject({ kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'cmp', op: 'lt', left: { kind: 'field', path: ['period', 'start'] }, right: { kind: 'field', path: ['period', 'end'] } } });
// remap: underscore keys become dotted for value fields only
const cs = remapValueKeys(periodModel, { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3, other_thing: 1 } }] });
expect(cs.entities[0]!.fields).toEqual({ 'period.start': 3, other_thing: 1 });
```
(`periodModel`: Subscription aggregate with `period: Period`, Period = {start: Date, end: Date, invariant wellOrdered { start < end }} — add to `test/fixtures.ts`.)

- [ ] **Step 2: Implement each site**

`grammar.ts` `resolveFieldPath` — value hop: when `f.type.kind === 'value'` and not last, resolve the next segment against the ValueDef's fields:
```ts
    if (f.type.kind === 'value') {
      if (i === path.length - 1) return f;
      const vdef = m.values.find(x => x.name === (f.type as any).value);
      const sub = vdef?.fields.find(x => x.name === path[i + 1]);
      return i + 2 === path.length ? (sub ?? null) : null;   // one value hop, flat values (v1)
    }
```
`evaluate.ts` `resolveValue` — before the per-segment walk: `const direct = e.fields[path.join('.')]; if (direct !== undefined) return direct;`
`emit/quint.ts`: `fieldQType` value case returns the inline record type (`{ start: int, end: int }` built from the ValueDef, model lookup); `initValue` value case pushes per-subfield nondets and returns `{ start: nd_a, end: nd_b }`; `pathToQuint` value hop appends `.seg` without map-get (default behavior — verify the owner-tracking doesn't break: set `owner` unchanged and continue).
`emit/alloy.ts`: `emitOwnerSig` value case flattens (`for (const sub of vdef.fields) fields.push(\`  ${f.name}_${sub.name}: one …\`)`); introduce `alloyFieldPath(m, ownerName, p)` and convert `termToAlloy`/`predToAlloy`/`candidateToPred`/`shapeToPred`/`nonVacuousPred` signatures to carry `m` + owner (mechanical; tsc drives it).
`engine/witness.ts` + `hypothesis.ts` wiring; quint-adapter nested-plain-object flatten (`period: {start: 3}` ITF record → `period_start: 3`).
`implied.ts` + `templates.ts` law instantiation (shared helper `valueLawInstances(m)` in `implied.ts`, imported by `templates.ts`; prefix paths via a small `prefixPredicate(p, prefix)` recursion over Predicate/Term).
Salient: no changes — dims render dotted paths already (`renderTerm` joins with '.'); `splitPathStr` handles only `.state` specially; a dotted value path splits into segments that `resolveFieldPath` now resolves. Verify with a salient test on a candidate comparing `period.start` vs `period.end`.

- [ ] **Step 3: Real-solver round-trips** — extend both integration tests with `periodModel`: a probe whose witness must carry `period.start`/`period.end` (post-remap) and judge consistently via `evaluateCandidate`.

- [ ] **Step 4: Full gate, then commit**

```bash
git add lattice/src lattice/test
git commit -m "feat(lattice): value semantics — quint nesting, alloy flattening, witness remap, type-carried laws (design §3.5/§6)"
```

### Task 12: Services — construct, validation, printer, projections

Carried structure only (design §3.6): validated, printed, diffed, rendered; never solver-encoded.

**Files:**
- Modify: `lattice/src/ast/domain.ts` (ServiceDef/MethodDef/ParamDef; DomainModel.services), `lattice/src/ast/invariant.ts` (Term param kind), `lattice/src/ast/validate.ts`, `lattice/src/ast/grammar.ts` (validateCandidate rejects `param` terms — candidates never carry them)
- Modify: `lattice/src/parse/lat.langium`, `lattice/src/parse/fromLangium.ts`, `lattice/src/emit/code.ts`, `lattice/src/ast/reserved.ts` (+`service`, `performs`, `creates`, `read-only`)
- Modify: `lattice/src/emit/prose.ts` (Services section), `lattice/src/emit/mermaid/domainDiagram.ts` (service class boxes), `lattice/src/parse/diff.ts` (service structural notes)
- Modify: `lattice/test/parse/arbitraries.ts`, docs: new `docs/language/service.md`, README index
- Test: `lattice/test/ast/validate-services.test.ts`, extend `fromLangium.test.ts`, `code-print.test.ts`, `mermaid.test.ts`

**Interfaces:**
- AST (exact, from the design §5.1):
```ts
export interface ParamDef { name: string; type: TypeRef }
export interface MethodDef {
  name: string; params: ParamDef[]; returns?: TypeRef; doc?: string;
  kind: { readOnly: true } | { performs: { aggregate: string; transition: string } } | { creates: string };
  requires?: Predicate;   // Term kind 'param' legal ONLY here
}
export interface ServiceDef { name: string; methods: MethodDef[]; doc?: string }
// invariant.ts Term gains: | { kind: 'param'; name: string }
```
- Surface:
```
service SubscriptionService {
  createSubscription(plan: ref Catalog.Plan, seats: Int): Subscription creates Subscription
  getSubscription(subId: Id): Subscription read-only
  activate(subId: Id) performs Subscription.activate
  reserve(subId: Id, delta: Int) performs Subscription.reserve requires available >= delta
}
```
- Grammar:
```
ServiceDecl:
    docs+=DOC* 'service' name=ID '{' methods+=MethodDecl* '}';
MethodDecl:
    docs+=DOC* name=ID '(' (params+=ParamDecl (',' params+=ParamDecl)*)? ')' (':' returns=LatType)?
        ( readOnly?='read-only'
        | 'performs' performsAgg=ID '.' performsTransition=ID
        | 'creates' creates=ID )
        ('requires' requires=Predicate)?;
ParamDecl:
    name=ID ':' type=LatType;
```
(`ServiceDecl` joins `ContextItem`.)
- Validation codes: `unknown-transition`, `unknown-aggregate` (creates), `param-outside-method` (a `param` term anywhere but a method guard — enforced in `grammar.ts`'s `checkTerm` with code `ill-typed` message "param terms are method-guard-only" AND in validateModel for transition guards), method `requires` on `performs`/`creates` may reference params + the TARGET aggregate's own fields/states (reuse `checkScopedPred` with the target's fields, plus a param-name set); on `read-only`, params only.
- `fromLangium` mapTerm: inside a method guard, a single-segment `PathRef` matching a param name maps to `{kind:'param', name}` (params shadow fields; document in service.md); thread a `params: Set<string>` through `mapPred`/`mapTerm` (default empty for all existing call sites).
- Diff: services don't join `namedThings` (RenameSpec scopes unchanged); `diffModels` appends `structuralNotes` for added/removed services and, per surviving service, added/removed/changed methods (compare `cjson` of the MethodDef). No rename proposals for services in v1 (no ledger references exist).

- [ ] **Step 1: Failing tests** — validation:

```ts
// lattice/test/ast/validate-services.test.ts — base: Task 3's Invoice model + a service
const svc = (m: Partial<MethodDef>): DomainModel => ({ ...invoiceModel(), services: [{ name: 'Billing',
  methods: [{ name: 'settle', params: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' } }],
    kind: { performs: { aggregate: 'Invoice', transition: 'settle' } }, ...m }] }] });

it('accepts performs targeting a declared transition', () => expect(validateModel(svc({}))).toEqual([]));
it('rejects unknown transitions', () =>
  expect(validateModel(svc({ kind: { performs: { aggregate: 'Invoice', transition: 'nope' } } }))
    .map(d => d.code)).toContain('unknown-transition'));
it('accepts a param+field guard on performs; rejects unknown params/fields', () => {
  expect(validateModel(svc({ params: [{ name: 'delta', type: { kind: 'prim', prim: 'Int' } }],
    requires: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
      right: { kind: 'param', name: 'delta' } } }))).toEqual([]);
  expect(validateModel(svc({ requires: { kind: 'cmp', op: 'ge',
    left: { kind: 'param', name: 'ghost' }, right: { kind: 'int', value: 0 } } }))
    .map(d => d.code)).toContain('unknown-param');
});
it('read-only guards may reference params only', () =>
  expect(validateModel(svc({ kind: { readOnly: true }, requires: { kind: 'cmp', op: 'ge',
    left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: 0 } } }))
    .map(d => d.code)).toContain('guard-cross-aggregate'));
```
Parse: the surface block above round-trips (printer output re-parses to the same AST — extend `code-print.test.ts` with an exact-string expectation for one service).

- [ ] **Step 2: Implement AST + validation + grammar + mapper + printer** (mechanical from the Interfaces block; the printer emits one line per method:
```ts
  for (const s of m.services) {
    doc(s.doc, '  ', out);
    out.push(`  service ${s.name} {`);
    for (const mm of s.methods) {
      doc(mm.doc, '    ', out);
      const params = mm.params.map(p => `${p.name}: ${typeStr({ name: p.name, type: p.type })}`).join(', ');
      const ret = mm.returns ? `: ${typeStr({ name: '', type: mm.returns })}` : '';
      const kind = 'readOnly' in mm.kind ? 'read-only'
        : 'creates' in mm.kind ? `creates ${mm.kind.creates}`
        : `performs ${mm.kind.performs.aggregate}.${mm.kind.performs.transition}`;
      out.push(`    ${mm.name}(${params})${ret} ${kind}${mm.requires ? ` requires ${predToText(mm.requires)}` : ''}`);
    }
    out.push('  }', '');
  }
```
`predToText` needs a `param` term case: `case 'param': return t.name;` — and `termToText`/`termEn`/`renderTerm` (salient) each gain the same one-liner; `evalTerm`/`termToQuint`/`termToAlloy` THROW on param (`throw new Error('param terms never reach solvers/evaluator — method guards are carried structure')`) so misuse fails loudly (checklist point 3's routing restriction, tested).
`DomainModel.services: ServiceDef[]` — required array; tsc enumerates every literal to update (add `services: []`).
Naming warnings: service PascalCase, methods/params camelCase.

- [ ] **Step 3: Projections + diff + docs**

`emit/prose.ts` — after the aggregate loop:
```ts
  if (m.services.length) {
    lines.push('## Services', '');
    for (const s of m.services) {
      if (s.doc) lines.push(`*${s.doc}*`, '');
      for (const mm of s.methods) {
        const what = 'readOnly' in mm.kind ? 'reads'
          : 'creates' in mm.kind ? `creates a ${mm.kind.creates}`
          : `performs ${mm.kind.performs.aggregate}.${mm.kind.performs.transition}`;
        lines.push(`- **${mm.name}**(${mm.params.map(p => p.name).join(', ')}) — ${what}${mm.requires ? `, requires ${predEn(mm.requires)}` : ''}`);
      }
      lines.push('');
    }
  }
```
`emit/mermaid/domainDiagram.ts` — service boxes inside the namespace (after enums):
```ts
  for (const s of m.services) {
    out.push(`    class ${s.name} {`, '      <<service>>');
    for (const mm of s.methods)
      out.push(`      +${mm.name}(${mm.params.map(p => p.name).join(', ')})`);
    out.push('    }');
  }
```
plus one dashed dependency edge per performed/created aggregate: `out.push(\`  ${s.name} ..> ${target} : ${mm.name}\`)` collected into the `local` bucket (dedupe per service+target). Extend `mermaid.test.ts` and the mermaid-gate fixture.
`parse/diff.ts` `diffModels` — append service notes:
```ts
  const bSvc = new Map(before.model.services.map(s => [s.name, s]));
  const aSvc = new Map(after.model.services.map(s => [s.name, s]));
  for (const [n] of aSvc) if (!bSvc.has(n)) notes.push(`added service ${n}`);
  for (const [n] of bSvc) if (!aSvc.has(n)) notes.push(`removed service ${n}`);
  for (const [n, sa] of aSvc) { const sb = bSvc.get(n); if (!sb) continue;
    const bm = new Map(sb.methods.map(x => [x.name, x])), am = new Map(sa.methods.map(x => [x.name, x]));
    for (const [mn] of am) if (!bm.has(mn)) notes.push(`added method ${n}.${mn}`);
    for (const [mn] of bm) if (!am.has(mn)) notes.push(`removed method ${n}.${mn}`);
    for (const [mn, mv] of am) if (bm.has(mn) && cjson(mv) !== cjson(bm.get(mn))) notes.push(`changed method ${n}.${mn}`);
  }
```
`arbitraries.ts`: optional service per model — methods drawn against generated aggregates' transitions (`performs`) plus one `read-only`; optional param-guard only when the target has a numeric field. Docs: `service.md` — construct reference including the one-method-one-transition rule and Stripe delete-vs-void rationale (design §3.6), `performs` reference semantics, method kinds, param guards + honest ceiling (carried, not verified); README index row.

- [ ] **Step 4: Full gate, then commit**

```bash
git add lattice/src lattice/test docs/language
git commit -m "feat(lattice): service construct — performs-reference methods, param guards, projections (design §3.6)"
```

---

### Task 13: Elicitation surfaces — skill text + CLI guard + structure phases

**Files:**
- Modify: `.claude/skills/elicit-spec/SKILL.md`
- Modify: `lattice/src/cli.ts` (only if needed — verify `UNELICITABLE_KINDS` at line 53 does NOT list `sumOverCollection`; it lists terminal/monotonic/leadsTo/refsResolve, so sums are already elicitable once `validateCandidate` knows the kind — add a regression test instead of code)
- Test: extend `lattice/test/cli.test.ts`

**Interfaces:** consumes everything Tasks 1–12 produced; produces the updated elicitation contract (design §7).

- [ ] **Step 1: CLI regression test** — `propose` accepts a `sumOverCollection` candidate (fakeDeps, `invoiceLinesModel`-shaped session) and `regenerate` doesn't reject it as `not-elicitable`:

```ts
it('sumOverCollection is proposable (design §8: elicitable kind)', async () => {
  // init with invoiceLinesModel, then:
  const r: any = await runCommand(['propose', '--session', dir, '--candidates', candsFile], fakeDeps);
  expect(r.error).toBeUndefined();
});
```

- [ ] **Step 2: SKILL.md updates** (surgical edits, keep the file's voice):
  - Phase 0 gains the design-§7 steps after the current structure bullet: (1) propose the full transition set per lifecycle, one correction round; (2) 1–3 skip-probes per lifecycle for tempting missing edges — a confirmed absent edge IS template #10, record it as structure Q&A; (3) guard elicitation per transition, multiple-choice over own fields, surfacing missing fields (the b03 pre-aggregated-field pattern); (4) event elicitation (past-tense names → `event` decls + `emits`); (5) service seeding — "which moves are operations someone invokes vs. system-driven?" → `performs`/`creates`/`read-only` methods. Budget line changes from "~10 questions" to "~15 questions; the service-seeding step is the first to compress if the budget strains".
  - Phase 1's elicitable-kinds sentence becomes: "only statePredicate / unique / cardinality / conservation / sumOverCollection may be elicited."
  - Add one rule line: "Transition guards are structure, not candidates — they are recorded via `engine structure` and land in the model; they never enter the hypothesis loop (design §3.3)."

- [ ] **Step 3: Full gate, then commit**

```bash
git add .claude/skills/elicit-spec/SKILL.md lattice/test/cli.test.ts
git commit -m "docs(elicit-spec): phase-0 transition/guard/event/service elicitation; sum elicitable (design §7)"
```

---

### Task 14: Golden trace D — invoice-lines domain end-to-end with real solvers

**Files:**
- Create: `lattice/test/golden-trace-d.test.ts`
- Modify: `lattice/test/fixtures.ts` (traceDModel)

**Interfaces:** consumes the full stack; produces the slice's DoD item 3. Model: context `Invoicing`; `value Period { start: Date, end: Date, invariant wellOrdered { start < end } }`; aggregate `Invoice { invId: Id key, period: Period, totalDue: Money @total, lines: List<InvoiceLine> }` with nested `entity InvoiceLine { lineId: Id key, amount: Money }` and lifecycle `settlement { states { draft @initial, open @active, paid @terminal } transition finalize { from draft to open; requires totalDue >= 0 } transition settle { from open to paid; emits InvoicePaid } }`, `event InvoicePaid { invId: Id }`, `service Billing { settle(invId: Id) performs Invoice.settle }`.

- [ ] **Step 1: Write the trace test** (structure mirrors `cli.test.ts`'s end-to-end but with `realDeps` — the pattern `dod.test.ts` uses):
  1. `init` with traceDModel → template adoptions fire (Money non-negativity on `totalDue`/`amount`; value law `ValueLaw_Invoice_period_wellOrdered` present — assert both).
  2. `propose` two candidates: H1 `total == sum` (the b02 shape) and H2 `total <= sum` (both `sumOverCollection`, priors .5/.5).
  3. Loop `next-question` with real solvers: expect a `distinguish` witness; assert `evaluateCandidate` splits H1/H2 on it; `verdict --judge` per the domain truth (equality — a witness where sum≠total with total below sum is a forbid); continue until `converged`; assert H1 adopted with ledger anchors.
  4. `emit` → assert `spec.lat` contains `totalDue == sum(lines, amount)` under Invoice, the prose contains the sum sentence with its anchor, and the statechart contains the guarded/emitting edges.
  5. Masking regression inside the trace: after the first verdict, fetch the recorded exclusion shape (session state) and assert its salient dims are exactly a subset of `{lines.count, sum(lines.amount), totalDue value}` — no per-row dims (design §6.4).
  6. Budget: assert each solver call completes; keep `maxSteps`/scope small (scope 4, maxSteps 3). Mark the suite serialized like other integration tests.

- [ ] **Step 2: Run it alone first** — `cd lattice && npx vitest run test/golden-trace-d.test.ts` (expect the loop to converge in ≤ ~6 questions; if the planner asks an unhelpful probe, tighten priors rather than weakening assertions).

- [ ] **Step 3: Full gate, then commit**

```bash
git add lattice/test/golden-trace-d.test.ts lattice/test/fixtures.ts
git commit -m "test(lattice): golden trace D — sum-over-collection elicited end-to-end with real solvers (DoD 3)"
```

---

### Task 15: b02 one-shot re-formalization smoke (DoD 2)

**Files:**
- Create: `lattice/test/fidelity/b02-regrammar.test.ts`
- Read (fixtures): `lattice/fidelity/results/b02.json`, `lattice/fidelity/first-shot/` (locate b02's original rule prose + judged cases; adjust paths to what exists)

**Interfaces:** consumes `validateCandidate` + `evaluateCandidate`. This is NOT a gate re-run: one rule, fresh formalization, same protocol shape.

- [ ] **Step 1: Read `lattice/fidelity/results/b02.json`** to extract (a) the rule's English ("line items sum to invoice total"), (b) its model shape, (c) its judged cases (each a CaseState + expected verdict). Write the test:
  1. Hand-author the formalization the formalizer SHOULD now produce against the grown grammar — `{ kind: 'sumOverCollection', aggregate: <b02's aggregate>, collection: …, child: …, field: …, op: 'eq', total: […] }` — mapped onto b02's recorded model (adapt field names from the JSON; if b02's model used `lines: List<ref>` to a top-level entity, mirror it as a nested entity in a test-local model — the point is the FORM formalizes, record the mapping note in a comment).
  2. `expect(validateCandidate(cand, model)).toEqual([])` — the form that was 2× not-formalizable now validates.
  3. For each judged case in b02.json: `expect(evaluateCandidate(cand, caseState)).toBe(expectedVerdict)` — the formalization passes its own judged cases.
- [ ] **Step 2:** If b02's recorded witnesses encode children differently than the Task-6 convention (`owner` field), write a small adapter in the test that maps b02's case JSON into the convention — keep the original JSON untouched (append-only evidence).
- [ ] **Step 3: Full gate, then commit**

```bash
git add lattice/test/fidelity/b02-regrammar.test.ts
git commit -m "test(lattice): b02 re-formalizes one-shot against the grown grammar and passes its judged cases (DoD 2)"
```

---

### Task 16: Subscriptions demo — HUMAN-IN-THE-LOOP elicitation + spec migration (DoD 1)

⚠️ This task requires the human: transition guards, missing fields (`paidInvoiceCount`, `retryCount`, `maxRetries` or their real names), event names, and the service surface are DOMAIN DECISIONS. Do not invent them. Conduct phase-0-style questioning in chat (design §7), record every Q&A via `engine structure`, then apply the edits.

**Files:**
- Modify: `specs/subscriptions/spec.lat` (+ regenerated `spec.prose.md`, `spec.diagrams.md`, `diagrams/`)
- Modify: `.lattice-session-subscriptions/` (ledger structure entries + model via `apply`)

**Steps:**
- [ ] 1. Prepare the question script from the committed spec: per lifecycle — proposed guard for `activate` (b03 shape: needs a payment fact on Subscription; propose adding a field), guard for `dunningExhausted` (b10: retry counter + cap — propose fields), skip-probes ("trialing → canceled directly is declared today via cancelFromTrial — confirm"), event names per notable transition, the multi-source collapse (`cancelFromTrial`/`cancelFromActive`/`cancelFromPastDue` → one `cancel` — NOTE: this is a ledger-referenced transition rename set; use `apply --rename` semantics: ask the human, then apply with `--rename` flags so provenance carries), and service seeding ("which transitions are operations someone invokes?").
- [ ] 2. Ask the human, one question per message, multiple-choice where possible; record each via `cd lattice && npx tsx src/cli.ts structure --session ../.lattice-session-subscriptions --question "…" --answer "…"`.
- [ ] 3. Edit `specs/subscriptions/spec.lat` per the answers (fields, guards, `emits` + `event` decls, multi-source `cancel`, `service SubscriptionService`), then `npx tsx src/cli.ts apply --session ../.lattice-session-subscriptions --lat ../specs/subscriptions/spec.lat` with the needed `--rename` flags. Fix diagnostics by asking, not guessing.
- [ ] 4. Verify DoD 1: guards and events render in `spec.prose.md` AND in the statechart mermaid (check the regenerated files); `.lat` round-trips (`apply` is the round-trip); ledger gained the structure trace.
- [ ] 5. Full gate (`npx tsc --noEmit && npx vitest run` — dod.test.ts consumes the committed session; if its fixtures conflict with the new spec state, update the test's expectations to the new committed reality WITHOUT weakening what it asserts), then commit:

```bash
git add specs/subscriptions .lattice-session-subscriptions lattice/test/dod.test.ts
git commit -m "feat(specs): subscriptions gains guarded transitions, events, multi-source cancel, service (DoD 1, human-elicited)"
```

---

### Task 17: Closing sweep — deferred-work registry check, design-doc deltas, plan.md pointer

**Files:**
- Modify: `docs/superpowers/specs/2026-07-07-lattice-slice-4-grammar-machine-growth-design.md` (record any implementation deviations discovered en route — known already: per-index nondet draws instead of `setOfMaps` (Task 6), `child` field on the sum candidate (Task 8), `when` was already event-checked (design §4.1 note))
- Modify: `docs/plan.md` §5.1 — one-line pointer that `machine`/`transition` constructs are implemented as `lifecycle` surface per the slice-4 design (do not rewrite §5.1's vision text)
- Verify: every item in the design's §11.1 deferred-work registry is still deferred (grep for accidental scope creep) and every §12 DoD row has its artifact; `docs/language/README.md` index lists lifecycle/value/service pages; `grep -rn "machine" docs/language/ specs/` returns nothing stale.

- [ ] Run the checks, make the edits, full gate, commit:
```bash
git add docs
git commit -m "docs: slice-4 closing sweep — design deltas recorded, plan §5.1 pointer, registry verified"
```

---

## Self-review notes (already applied)

- **Spec coverage:** design §3.1→T2, §3.2→T5-7, §3.3/§3.4→T3 (+honest-ceiling text in docs), §3.5→T10-11, §3.6→T12, §3.7→T1/T2, §4.1/§4.2→T2-5/T8/T10/T12, §5→T1/T3/T5/T8/T10/T12, §6.1→T6/T7, §6.2→T9, §6.3→T3/T9/T12 (throwing param/solver guards), §6.4→T9, §7→T13/T16, §8→T13 (template #10 as elicitation; #4/#5/#12 nowhere — correctly absent), §9→each task's docs step, §12 DoD→T14/T15/T16/T9/T17.
- **Type consistency:** `TransitionDef.from: string[]` (T1) used by T2/T3/T16; `ownedCollectionChild` (T5) used by T6/T7/T8/T9; `childVarKey`/`OWNED_BOUND` (T6) used by T9; dim strings `<col>.count` / `sum(<col>.<field>)` / `<path> value` identical in T9's extractor and both rebuilders; `sumOverCollection.child` (T8) used by T9's alloy shapes and T14/T15.
- **Known execution risks, called out in-place:** Langium ambiguity SumBody-vs-PredicateBody (T8 caution), `initValue` name collisions (T6 caution), quint.test emitted-string expectations (T1 step 4), `dod.test.ts` literals (T2 step 5), required-array additions `values`/`services` breaking every DomainModel literal (T10/T12 — tsc enumerates).




