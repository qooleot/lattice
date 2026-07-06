# Lattice Slice 3 — `.lat` Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.lat` read-write: parse engineer edits, reconcile them against the verdict ledger, apply with provenance or reject naming the witness, re-render all projections; round-trip identity property-tested.

**Architecture:** A Langium grammar (`parse/lat.langium`, plain-ID references, no cross-linking) yields a parser; `fromLangium.ts` maps its AST to the existing `DomainModel`/`CandidateInvariant` types; `diff.ts` + `engine/reconcile.ts` implement ledger reconciliation (asymmetric verdict semantics, append-only renames); the rewritten printer `emit/code.ts` is the parser's round-trip partner. CLI gains `apply`/`sync`/`explain`. Structure-implied invariants (`@terminal`/`ref`/`Money`) are derived at load (`engine/implied.ts`), never printed.

**Tech Stack:** TypeScript strict/NodeNext ESM, Langium ^3.5 + langium-cli, fast-check, chokidar, vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-lattice-slice-3-lat-parser-design.md` (P1–P12). Read it before starting any task.

## Global Constraints

- Before first use in a fresh worktree: `bash lattice/scripts/ensure-ready.sh` (installs deps, links vendored JDK/Alloy, runs `langium:generate` after Task 1).
- Before EVERY commit: `cd lattice && npx tsc --noEmit && npx vitest run` — full suite, real solvers, serialized (~2 min). Golden traces A/B/C must stay green; their assertions must never be weakened.
- Never `git add -A`. Conventional commits. All commands below run from `lattice/` unless a path says otherwise.
- ESM imports end in `.js` (existing codebase pattern). TypeScript strict; no `any` unless the surrounding file already does it.
- The parser accepts nothing `validateCandidate` rejects (closed grammar). New `leadsTo` invariants are template-only: reconcile rejects hand-written ones.
- Ledger is append-only: no code path may rewrite or delete existing `ledger.jsonl` lines.
- No Wizard-of-Oz: property tests use real fast-check generators; integration tests run the real CLI functions against real session dirs (tmp copies).
- The printer's output is the normal form; `parse(astToCode(m, invs)) ≡ (m, invs)` over the model and the **explicit** invariant set (implied invariants are derived, never printed).
- Reserved grammar keywords (cannot be identifiers in `.lat`): `context enum entity aggregate event machine region states transition from to when invariant on where unique while by refs resolve count terminal monotonic conserve leads under fairness state now ref List key ticksPerDay in`. `validate.ts` already reserves the field name `state`.

---

### Task 1: Langium toolchain, grammar, parse service

**Files:**
- Modify: `lattice/package.json` (deps + `langium:generate` script)
- Create: `lattice/langium-config.json`
- Create: `lattice/src/parse/lat.langium`
- Create: `lattice/src/parse/lat-services.ts`
- Create: `lattice/src/parse/parse.ts`
- Modify: `lattice/scripts/ensure-ready.sh` (generate step)
- Modify: `lattice/.gitignore` (or create) — ignore `src/parse/generated/`
- Test: `lattice/test/parse/parse.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `parseLat(text: string): LatParseResult` where
  `type LatParseResult = { ok: true; cst: LatContext } | { ok: false; diagnostics: ParseDiagnostic[] }` and
  `interface ParseDiagnostic { code: string; message: string; line: number; col: number }` (1-based). `LatContext` is the generated Langium AST root. Also `scanBannedComments(text): ParseDiagnostic[]` (exported for direct testing).

- [ ] **Step 1: Install deps and wire scripts**

```bash
cd lattice
npm install langium@^3.5.0 chokidar@^4.0.1
npm install -D langium-cli@^3.5.0 fast-check@^3.23.1
```

Add to `package.json` `"scripts"`: `"langium:generate": "langium generate"`.
If the registry has no 3.5.x, use the latest 3.x; `langium` and `langium-cli` majors+minors must match.

Create `lattice/langium-config.json`:

```json
{
  "projectName": "Lat",
  "languages": [{ "id": "lat", "grammar": "src/parse/lat.langium", "fileExtensions": [".lat"] }],
  "out": "src/parse/generated"
}
```

Append to `lattice/scripts/ensure-ready.sh` (before the final doctor line):

```bash
[ -d src/parse/generated ] || { echo ">> generating langium parser"; npx langium generate; }
```

Add `src/parse/generated/` to `lattice/.gitignore` (create the file if absent). Because generated code is gitignored, `npx tsc --noEmit` in a fresh worktree REQUIRES ensure-ready to have run — that is already a global constraint.

- [ ] **Step 2: Write the grammar**

Create `lattice/src/parse/lat.langium` (complete file):

```
grammar Lat

entry LatContext:
    docs+=DOC* 'context' name=ID '{' items+=ContextItem* '}';

ContextItem:
    EnumDecl | EntityDecl | AggregateDecl | EventDecl | TicksDecl | InvariantDecl;

EnumDecl:
    'enum' name=ID '{' values+=ID (',' values+=ID)* '}';

TicksDecl:
    'ticksPerDay' '=' value=INT;

EntityDecl:
    docs+=DOC* 'entity' name=ID '{' fields+=FieldDecl* '}';

EventDecl:
    docs+=DOC* 'event' name=ID '{' fields+=FieldDecl* '}';

AggregateDecl:
    docs+=DOC* 'aggregate' name=ID '{' fields+=FieldDecl* machine=MachineDecl? invariants+=InvariantDecl* '}';

FieldDecl:
    name=ID ':' type=LatType (key?='key')? tags+=Tag*;

LatType:
    {infer ListType} 'List' '<' of=LatType '>'
  | {infer RefType} 'ref' target=ID
  | {infer NamedType} name=ID;

Tag:
    '@' name=TagName;

TagName returns string:
    ID | 'terminal' | 'monotonic' | 'state' | 'key';

MachineDecl:
    'machine' '{' regions+=RegionDecl+ transitions+=TransitionDecl* '}';

RegionDecl:
    'region' name=ID '{' 'states' '{' states+=StateDecl (',' states+=StateDecl)* '}' '}';

StateDecl:
    name=ID tags+=Tag*;

TransitionDecl:
    'transition' name=ID '{' 'region' region=ID ';' 'from' from=ID 'to' to=ID (';' 'when' when=ID)? '}';

InvariantDecl:
    docs+=DOC* 'invariant' name=ID ('on' target=ID)? ('where' where=Predicate)? '{' body=InvariantBody '}';

InvariantBody:
    UniqueBody | RefsResolveBody | CardinalityBody | TerminalBody | MonotonicBody | ConserveBody | LeadsToBody | PredicateBody;

UniqueBody:
    'unique' 'while' region=ID 'in' '{' states+=ID (',' states+=ID)* '}' 'by' '(' by+=PathExpr (',' by+=PathExpr)* ')';

RefsResolveBody:
    {infer RefsResolveBody} 'refs' 'resolve';

CardinalityBody:
    'count' ('where' where=Predicate)? '<=' atMost=INT;

TerminalBody:
    'terminal' region=ID '.' state=ID;

MonotonicBody:
    'monotonic' field=PathExpr;

ConserveBody:
    'conserve' parts+=PathExpr ('+' parts+=PathExpr)+ '==' total=PathExpr;

LeadsToBody:
    'from' from=Predicate 'leads' 'to' to=Predicate 'under' 'fairness' fairness=STRING;

PredicateBody:
    pred=Predicate;

Predicate:
    Implication;

Implication infers Predicate:
    Disjunction ({infer BinPred.left=current} op='=>' right=Disjunction)?;

Disjunction infers Predicate:
    Conjunction ({infer BinPred.left=current} op='||' right=Conjunction)*;

Conjunction infers Predicate:
    Negation ({infer BinPred.left=current} op='&&' right=Negation)*;

Negation infers Predicate:
    {infer NotPred} '!' arg=Negation | Primary;

Primary infers Predicate:
    '(' Predicate ')' | StatePred | Comparison;

StatePred:
    'state' region=ID 'in' '{' states+=ID (',' states+=ID)* '}';

Comparison:
    left=Expr op=('=='|'!='|'<'|'<='|'>'|'>=') right=Expr;

Expr:
    AddExpr;

AddExpr infers Expr:
    PrimaryExpr ({infer PlusExpr.left=current} '+' right=PrimaryExpr)*;

PrimaryExpr infers Expr:
    {infer IntLit} value=INT
  | {infer NowLit} 'now'
  | {infer PathRef} segments+=ID ('.' segments+=ID)*;

PathExpr:
    segments+=ID ('.' segments+=ID)*;

hidden terminal WS: /\s+/;
terminal DOC: /\/\/\/[^\n\r]*/;
terminal ID: /[A-Za-z_][A-Za-z0-9_]*/;
terminal INT: /[0-9]+/;
terminal STRING: /"[^"]*"/;
```

Notes for the implementer: there is deliberately NO cross-reference syntax (`[Type]`) — all name resolution happens in our own validators, so the plain `LangiumParser` suffices (no document builder, no linking). `TagName` re-admits keywords that are legal tag names. If `langium generate` reports an ambiguity or left-recursion error, fix the grammar (do not restructure the emitted AST names — Task 4 depends on `BinPred`, `NotPred`, `StatePred`, `Comparison`, `IntLit`, `NowLit`, `PathRef`, `PlusExpr`, and the `*Body` type names).

- [ ] **Step 3: Generate and inspect**

```bash
npx langium generate
ls src/parse/generated
```

Expected: `ast.ts`, `grammar.ts`, `module.ts` created. Open `generated/ast.ts` and confirm the interface names listed above exist. If langium-cli emits slightly different module export names (`LatGeneratedModule`, `LatGeneratedSharedModule`), note them for Step 4.

- [ ] **Step 4: Write the failing test**

Create `lattice/test/parse/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLat, scanBannedComments } from '../../src/parse/parse.js';

const GOOD = `/// A tiny spec
context Demo {
  enum Mode { fast, slow }
  /// The one entity
  entity Thing {
    thingId : Id key
    cost    : Money @total
    mode    : Mode
  }
  aggregate Job {
    jobId : Id key
    thing : ref Thing
    machine {
      region run { states { queued @initial, going @active, done @terminal } }
      transition start { region run; from queued to going }
    }
    /// Jobs cost something.
    invariant positiveCost { thing.cost >= 0 && state run in {going} => 1 <= 1 }
  }
  invariant modeSane on Thing { mode == Mode.fast || mode == Mode.slow }
}
`;

describe('parseLat', () => {
  it('parses a well-formed file', () => {
    const r = parseLat(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cst.name).toBe('Demo');
  });

  it('reports syntax errors with 1-based positions, never throws', () => {
    const r = parseLat('context Broken { aggregate }');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0]!.line).toBeGreaterThanOrEqual(1);
      expect(r.diagnostics[0]!.code).toBe('syntax-error');
    }
  });

  it('bans // comments with a friendly diagnostic', () => {
    const r = parseLat('context C {\n  // nope\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.diagnostics.find(x => x.code === 'comment-banned')!;
      expect(d.message).toContain('///');
      expect(d.line).toBe(2);
    }
  });

  it('does not flag /// or // inside strings', () => {
    expect(scanBannedComments('/// fine\ncontext C {}')).toEqual([]);
    expect(scanBannedComments('x "a // b" y')).toEqual([]);
    expect(scanBannedComments('a // b')).toHaveLength(1);
  });

  it('parses every invariant body form', () => {
    const bodies = [
      'unique while run in {going} by (thing)',
      'refs resolve',
      'count where state run in {going} <= 1',
      'count <= 3',
      'terminal run.done',
      'monotonic cost',
      'conserve a + b == c',
      'from state run in {queued} leads to state run in {done} under fairness "start fires"',
      '! (cost < 0) || now + 1 >= 2'
    ];
    for (const b of bodies) {
      const r = parseLat(`context C { aggregate A { aId : Id key\n invariant x { ${b} } } }`);
      expect(r.ok, `body failed: ${b}\n${JSON.stringify(!r.ok && r.diagnostics)}`).toBe(true);
    }
  });
});

describe('ID terminal matches the AST identifier rule (single source, spec §3.3)', () => {
  it('grammar ID regex === validate.ts IDENT_RE', async () => {
    const { readFileSync } = await import('node:fs');
    const g = readFileSync(new URL('../../src/parse/lat.langium', import.meta.url), 'utf8');
    const m = g.match(/terminal ID: \/(.+?)\/;/)!;
    const { IDENT_RE } = await import('../../src/ast/validate.js');
    expect(`^${m[1]}$`).toBe(IDENT_RE.source);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run test/parse/parse.test.ts`
Expected: FAIL — `parse.js` does not exist (and `IDENT_RE` is not exported yet; that export lands in this task's Step 6 since the test needs it).

- [ ] **Step 6: Implement**

In `lattice/src/ast/validate.ts` change line 4 to export the rule:

```ts
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
```

Create `lattice/src/parse/lat-services.ts`:

```ts
import { createDefaultCoreModule, createDefaultSharedCoreModule, inject, EmptyFileSystem } from 'langium';
import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import { LatGeneratedModule, LatGeneratedSharedModule } from './generated/module.js';

// Parse-only services: no LSP, no linking — the grammar has no cross-references (spec P2/P7).
export function createLatServices(): LangiumServices {
  const shared: LangiumSharedServices = inject(
    createDefaultSharedCoreModule(EmptyFileSystem), LatGeneratedSharedModule);
  const lat = inject(createDefaultCoreModule({ shared }), LatGeneratedModule);
  shared.ServiceRegistry.register(lat);
  return lat;
}
```

(If the installed Langium version exports these factory names differently — e.g. `createDefaultModule`/`createDefaultSharedModule` in older 3.x — adapt this file only; check `node_modules/langium/lib/default-module.d.ts`. Types may live in `langium` rather than `langium/lsp`.)

Create `lattice/src/parse/parse.ts`:

```ts
import { createLatServices } from './lat-services.js';
import type { LatContext } from './generated/ast.js';

export interface ParseDiagnostic { code: string; message: string; line: number; col: number }
export type LatParseResult = { ok: true; cst: LatContext } | { ok: false; diagnostics: ParseDiagnostic[] };

/** `//` is banned (spec P5); `///` is the only comment form. Skips string literals. */
export function scanBannedComments(text: string): ParseDiagnostic[] {
  const out: ParseDiagnostic[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let inString = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') inString = !inString;
      if (!inString && ch === '/' && line[j + 1] === '/') {
        if (line[j + 2] === '/') break;                      // /// doc comment — legal, rest of line is comment
        out.push({ code: 'comment-banned', line: i + 1, col: j + 1,
          message: "'//' comments are not part of the language — use '///' for documentation (it becomes part of the spec)" });
        break;
      }
    }
  }
  return out;
}

const services = createLatServices();

export function parseLat(text: string): LatParseResult {
  const banned = scanBannedComments(text);
  if (banned.length) return { ok: false, diagnostics: banned };
  const r = services.parser.LangiumParser.parse<LatContext>(text);
  const diagnostics: ParseDiagnostic[] = [
    ...r.lexerErrors.map(e => ({ code: 'syntax-error', message: e.message,
      line: e.line ?? 1, col: e.column ?? 1 })),
    ...r.parserErrors.map(e => ({ code: 'syntax-error', message: e.message,
      line: e.token.startLine ?? 1, col: e.token.startColumn ?? 1 })),
  ];
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, cst: r.value };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx langium generate && npx vitest run test/parse/parse.test.ts`
Expected: PASS (all 6). If the `every invariant body form` case fails on a specific body, fix the grammar, re-generate, re-run.

- [ ] **Step 8: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add package.json package-lock.json langium-config.json .gitignore scripts/ensure-ready.sh \
  src/parse/lat.langium src/parse/lat-services.ts src/parse/parse.ts src/ast/validate.ts test/parse/parse.test.ts
git commit -m "feat(lattice): langium grammar + parse service for .lat (slice 3)"
```

---

### Task 2: Rename ledger entries and witness resolution

**Files:**
- Modify: `lattice/src/engine/session.ts` (add `rename` LedgerEntry kind)
- Create: `lattice/src/engine/renames.ts`
- Modify: `lattice/src/ast/invariant.ts` (add `doc?: string` to `CandidateInvariant`)
- Test: `lattice/test/engine/renames.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry`, `CaseState` (existing).
- Produces:
  - `type RenameScope = 'field'|'state'|'transition'|'enumValue'|'enum'|'entity'|'aggregate'|'event'|'invariant'|'region'`
  - `interface RenameSpec { scope: RenameScope; path: string; from: string; to: string }` — `path` is the owner-qualified pre-rename location: field `'Subscription.accruedUnits'`, state `'Invoice.settlement.draft'`, enumValue `'UsagePricing.all_units'`, region `'Invoice.settlement'`, top-level scopes `'Subscription'`, invariant `'Never_Overpaid_And_Paid_Exact'`.
  - `renameEntries(ledger: LedgerEntry[]): RenameSpec[]` — rename entries in ledger order.
  - `resolveWitness(w: CaseState, renames: RenameSpec[], current: DomainModel): CaseState` — returns a NEW CaseState with old names mapped to current (entity `type`, field keys, `<region>.state` keys, state values, enum values via current model field types). Chained renames compose by sequential application.
  - `currentInvariantName(oldName: string, renames: RenameSpec[]): string`
  - `applyRenamesToModel(m: DomainModel, renames: RenameSpec[]): DomainModel` — returns a NEW model with the renames applied (aggregate/entity names + `ref` targets, fields, regions + transition region refs + `initial`, states + transition from/to, enums + field type refs, enum values, events + `when` refs, transitions).
  - `applyRenamesToInvariant(i: CandidateInvariant, renames: RenameSpec[]): CandidateInvariant` — rewrites `name` (invariant scope), `candidate.aggregate`, field paths (FIRST segment only, when the rename's owner is the candidate's aggregate — all committed invariants use single-segment paths; multi-hop rename support is out of scope, note it in a comment), `inState`/`whileStates`/`terminal` regions and states, `enumval` enum/value.
  - New ledger kind: `{ kind: 'rename'; at: string; scope: RenameScope; path: string; from: string; to: string }`
  - `CandidateInvariant.doc?: string` (spec P12).

These two apply-functions exist so reconcile (Task 8) can NORMALIZE confirmed renames out of the
stored side before computing the semantic change set — a rename is a name change, not an edit
(spec §5.5 as amended).

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/renames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveWitness, currentInvariantName, renameEntries, applyRenamesToModel,
  applyRenamesToInvariant, type RenameSpec } from '../../src/engine/renames.js';
import type { CaseState } from '../../src/engine/evaluate.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const model: DomainModel = {
  context: 'C', enums: [{ name: 'Mode', values: ['fast', 'slow'] }], events: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
    { name: 'jobId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'speed', type: { kind: 'enum', enum: 'Mode' } },
    { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'run', initial: 'queued',
      states: [{ name: 'queued' }, { name: 'done', tags: ['terminal'] }] }], transitions: [] } }],
};

const witness: CaseState = { entities: [
  { type: 'Task', id: 't1', fields: { 'exec.state': 'waiting', count: 3, kind: 'quick' } }] };

it('resolves chained field renames in order', () => {
  const renames: RenameSpec[] = [
    { scope: 'field', path: 'Job.count', from: 'count', to: 'n' },
    { scope: 'field', path: 'Job.n', from: 'n', to: 'units' },
    { scope: 'aggregate', path: 'Task', from: 'Task', to: 'Job' }];
  // aggregate rename applies to type; field renames key off the CURRENT aggregate name at each step —
  // apply aggregate rename first in this list order? No: sequential means Task→Job must precede if
  // field paths say Job. Order in the list is ledger order; this test pins sequential semantics.
  const r = resolveWitness(witness, [
    { scope: 'aggregate', path: 'Task', from: 'Task', to: 'Job' },
    { scope: 'field', path: 'Job.count', from: 'count', to: 'n' },
    { scope: 'field', path: 'Job.n', from: 'n', to: 'units' }], model);
  expect(r.entities[0]!.type).toBe('Job');
  expect(r.entities[0]!.fields['units']).toBe(3);
  expect(r.entities[0]!.fields['count']).toBeUndefined();
});

it('resolves region, state and enum-value renames', () => {
  const r = resolveWitness(witness, [
    { scope: 'aggregate', path: 'Task', from: 'Task', to: 'Job' },
    { scope: 'region', path: 'Job.exec', from: 'exec', to: 'run' },
    { scope: 'state', path: 'Job.run.waiting', from: 'waiting', to: 'queued' },
    { scope: 'field', path: 'Job.kind', from: 'kind', to: 'speed' },
    { scope: 'enumValue', path: 'Mode.quick', from: 'quick', to: 'fast' }], model);
  expect(r.entities[0]!.fields['run.state']).toBe('queued');
  expect(r.entities[0]!.fields['speed']).toBe('fast');   // enum rename uses model: speed is Mode-typed
});

it('does not mutate the input witness and renames trace snapshots too', () => {
  const w: CaseState = { entities: [{ type: 'Job', id: 'j', fields: { count: 1 } }],
    trace: [[{ type: 'Job', id: 'j', fields: { count: 0 } }]] };
  const r = resolveWitness(w, [{ scope: 'field', path: 'Job.count', from: 'count', to: 'units' }], model);
  expect(w.entities[0]!.fields['count']).toBe(1);
  expect(r.trace![0]![0]!.fields['units']).toBe(0);
});

it('currentInvariantName follows the chain', () => {
  expect(currentInvariantName('A', [
    { scope: 'invariant', path: 'A', from: 'A', to: 'B' },
    { scope: 'invariant', path: 'B', from: 'B', to: 'C' }])).toBe('C');
  expect(currentInvariantName('x', [])).toBe('x');
});

it('renameEntries extracts rename ledger entries in order', () => {
  const ledger: LedgerEntry[] = [
    { kind: 'structure', at: 't', question: 'q', answer: 'a' },
    { kind: 'rename', at: 't', scope: 'field', path: 'Job.count', from: 'count', to: 'units' }];
  expect(renameEntries(ledger)).toEqual([{ scope: 'field', path: 'Job.count', from: 'count', to: 'units' }]);
});

it('applyRenamesToModel rewrites defs and internal references', () => {
  const m2 = applyRenamesToModel(model, [
    { scope: 'state', path: 'Job.run.queued', from: 'queued', to: 'waiting' },
    { scope: 'field', path: 'Job.units', from: 'units', to: 'n' },
    { scope: 'enumValue', path: 'Mode.fast', from: 'fast', to: 'quick' }]);
  const job = m2.aggregates[0]!;
  expect(job.machine!.regions[0]!.initial).toBe('waiting');
  expect(job.machine!.regions[0]!.states[0]!.name).toBe('waiting');
  expect(job.fields.map(f => f.name)).toContain('n');
  expect(m2.enums[0]!.values).toContain('quick');
  expect(model.aggregates[0]!.fields.map(f => f.name)).toContain('units');   // input untouched
});

it('applyRenamesToInvariant rewrites paths, states and its own name', () => {
  const inv = applyRenamesToInvariant({ id: 'x', name: 'old', prior: 1, source: 'template',
    candidate: { kind: 'statePredicate', aggregate: 'Job', body: { kind: 'and', args: [
      { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } },
      { kind: 'inState', owner: 'self', region: 'run', states: ['queued'] }] } } }, [
    { scope: 'invariant', path: 'old', from: 'old', to: 'renamed' },
    { scope: 'field', path: 'Job.units', from: 'units', to: 'n' },
    { scope: 'state', path: 'Job.run.queued', from: 'queued', to: 'waiting' }]);
  expect(inv.name).toBe('renamed');
  const body = inv.candidate as any;
  expect(body.body.args[0].left.path).toEqual(['n']);
  expect(body.body.args[1].states).toEqual(['waiting']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/renames.test.ts`
Expected: FAIL — module `renames.js` not found; `kind: 'rename'` not assignable to `LedgerEntry`.

- [ ] **Step 3: Implement**

In `lattice/src/ast/invariant.ts` add to `CandidateInvariant` (after `name`):

```ts
  doc?: string;                                     // human-owned /// English (spec P12); round-trips
```

In `lattice/src/engine/session.ts` extend the union (after the `structure` line):

```ts
  | { kind: 'structure'; at: string; question: string; answer: string }
  | { kind: 'rename'; at: string; scope: import('./renames.js').RenameScope; path: string; from: string; to: string };
```

Create `lattice/src/engine/renames.ts`:

```ts
import type { CaseState, CaseEntity } from './evaluate.js';
import type { DomainModel } from '../ast/domain.js';
import type { LedgerEntry } from './session.js';

export type RenameScope = 'field' | 'state' | 'transition' | 'enumValue' | 'enum' | 'entity'
  | 'aggregate' | 'event' | 'invariant' | 'region';
export interface RenameSpec { scope: RenameScope; path: string; from: string; to: string }

export const renameEntries = (ledger: LedgerEntry[]): RenameSpec[] =>
  ledger.filter(e => e.kind === 'rename')
    .map(e => ({ scope: (e as any).scope, path: (e as any).path, from: (e as any).from, to: (e as any).to }));

/** Owner of an owner-qualified path: 'Job.count' → 'Job'; 'Job.run.waiting' → 'Job'. */
const pathOwner = (p: string): string => p.split('.')[0]!;

function applyOne(e: CaseEntity, r: RenameSpec, m: DomainModel): CaseEntity {
  const fields: Record<string, string | number | boolean> = {};
  const owner = pathOwner(r.path);
  switch (r.scope) {
    case 'entity': case 'aggregate':
      for (const [k, v] of Object.entries(e.fields)) fields[k] = v;
      return { ...e, type: e.type === r.from ? r.to : e.type, fields };
    case 'field':
      for (const [k, v] of Object.entries(e.fields)) fields[e.type === owner && k === r.from ? r.to : k] = v;
      return { ...e, fields };
    case 'region': {
      const [, region] = r.path.split('.');
      for (const [k, v] of Object.entries(e.fields))
        fields[e.type === owner && k === `${region}.state` ? `${r.to}.state` : k] = v;
      return { ...e, fields };
    }
    case 'state': {
      const [, region] = r.path.split('.');
      for (const [k, v] of Object.entries(e.fields))
        fields[k] = e.type === owner && k === `${region}.state` && v === r.from ? r.to : v;
      return { ...e, fields };
    }
    case 'enumValue': {
      const enumName = pathOwner(r.path);
      const def = m.aggregates.find(a => a.name === e.type) ?? m.entities.find(x => x.name === e.type);
      for (const [k, v] of Object.entries(e.fields)) {
        const f = def?.fields.find(x => x.name === k);
        fields[k] = f?.type.kind === 'enum' && f.type.enum === enumName && v === r.from ? r.to : v;
      }
      return { ...e, fields };
    }
    default: {  // transition | enum | event | invariant: nothing witness-visible
      for (const [k, v] of Object.entries(e.fields)) fields[k] = v;
      return { ...e, fields };
    }
  }
}

/** Map a witness recorded under old names to current names. Renames apply sequentially (ledger order). */
export function resolveWitness(w: CaseState, renames: RenameSpec[], current: DomainModel): CaseState {
  const mapEntity = (e: CaseEntity) => renames.reduce((acc, r) => applyOne(acc, r, current), e);
  return { ...w, entities: w.entities.map(mapEntity),
    trace: w.trace?.map(step => step.map(mapEntity)) };
}

export function currentInvariantName(oldName: string, renames: RenameSpec[]): string {
  return renames.reduce((n, r) => r.scope === 'invariant' && r.from === n ? r.to : n, oldName);
}

/** Apply renames to the model itself (defs + internal references). Pure; input untouched. */
export function applyRenamesToModel(m: DomainModel, renames: RenameSpec[]): DomainModel {
  let cur: DomainModel = JSON.parse(JSON.stringify(m));
  for (const r of renames) {
    const owner = pathOwner(r.path);
    const ren = (n: string, match: string) => (n === match ? r.to : n);
    switch (r.scope) {
      case 'aggregate': case 'entity':
        for (const o of [...cur.aggregates, ...cur.entities]) {
          o.name = ren(o.name, r.from);
          for (const f of o.fields) if (f.type.kind === 'ref') f.type.target = ren(f.type.target, r.from);
        }
        break;
      case 'field': {
        const def = cur.aggregates.find(a => a.name === owner) ?? cur.entities.find(e => e.name === owner);
        for (const f of def?.fields ?? []) f.name = ren(f.name, r.from);
        break;
      }
      case 'region': {
        const def = cur.aggregates.find(a => a.name === owner);
        for (const reg of def?.machine?.regions ?? []) reg.name = ren(reg.name, r.from);
        for (const t of def?.machine?.transitions ?? []) t.region = ren(t.region, r.from);
        break;
      }
      case 'state': {
        const [, regionName] = r.path.split('.');
        const def = cur.aggregates.find(a => a.name === owner);
        const reg = def?.machine?.regions.find(x => x.name === regionName);
        if (reg) {
          reg.initial = ren(reg.initial, r.from);
          for (const s of reg.states) s.name = ren(s.name, r.from);
        }
        for (const t of def?.machine?.transitions.filter(t => t.region === regionName) ?? []) {
          t.from = ren(t.from, r.from); t.to = ren(t.to, r.from);
        }
        break;
      }
      case 'transition': {
        const def = cur.aggregates.find(a => a.name === owner);
        for (const t of def?.machine?.transitions ?? []) t.name = ren(t.name, r.from);
        break;
      }
      case 'enum':
        for (const e of cur.enums) e.name = ren(e.name, r.from);
        for (const o of [...cur.aggregates, ...cur.entities, ...cur.events])
          for (const f of o.fields) if (f.type.kind === 'enum') f.type.enum = ren(f.type.enum, r.from);
        break;
      case 'enumValue': {
        const e = cur.enums.find(x => x.name === owner);
        if (e) e.values = e.values.map(v => ren(v, r.from));
        break;
      }
      case 'event':
        for (const ev of cur.events) ev.name = ren(ev.name, r.from);
        for (const a of cur.aggregates) for (const t of a.machine?.transitions ?? [])
          if (t.when) t.when = ren(t.when, r.from);
        break;
      case 'invariant': break;   // not a model construct
    }
  }
  return cur;
}

/** Apply renames inside a candidate invariant (paths, states, enum values, its own name).
 *  Field renames rewrite the FIRST path segment only when the rename's owner is the candidate's
 *  aggregate — every committed invariant uses single-segment paths; multi-hop renames out of scope. */
export function applyRenamesToInvariant(i: import('../ast/invariant.js').CandidateInvariant,
    renames: RenameSpec[]): import('../ast/invariant.js').CandidateInvariant {
  const inv = JSON.parse(JSON.stringify(i)) as typeof i;
  for (const r of renames) {
    const owner = pathOwner(r.path);
    if (r.scope === 'invariant' && inv.name === r.from) inv.name = r.to;
    const c: any = inv.candidate;
    const renPath = (p: string[]) => { if (owner === c.aggregate && p[0] === r.from && r.scope === 'field') p[0] = r.to; };
    const walkTerm = (t: any) => {
      if (!t) return;
      if (t.kind === 'field') renPath(t.path);
      if (t.kind === 'enumval' && r.scope === 'enumValue' && t.enum === owner && t.value === r.from) t.value = r.to;
      if (t.kind === 'enumval' && r.scope === 'enum' && t.enum === r.from) t.enum = r.to;
      if (t.kind === 'plus') { walkTerm(t.left); walkTerm(t.right); }
    };
    const walkPred = (p: any) => {
      if (!p) return;
      switch (p.kind) {
        case 'cmp': walkTerm(p.left); walkTerm(p.right); break;
        case 'inState':
          if (owner === c.aggregate) {
            if (r.scope === 'region' && p.region === r.from) p.region = r.to;
            if (r.scope === 'state' && p.region === r.path.split('.')[1])
              p.states = p.states.map((s: string) => (s === r.from ? r.to : s));
          }
          break;
        case 'and': case 'or': p.args.forEach(walkPred); break;
        case 'not': walkPred(p.arg); break;
        case 'implies': walkPred(p.left); walkPred(p.right); break;
      }
    };
    switch (c.kind) {
      case 'statePredicate': walkPred(c.where); walkPred(c.body); break;
      case 'unique':
        if (owner === c.aggregate) {
          if (r.scope === 'region' && c.whileStates.region === r.from) c.whileStates.region = r.to;
          if (r.scope === 'state' && c.whileStates.region === r.path.split('.')[1])
            c.whileStates.states = c.whileStates.states.map((s: string) => (s === r.from ? r.to : s));
        }
        c.by.forEach(renPath);
        break;
      case 'cardinality': walkPred(c.where); break;
      case 'terminal':
        if (owner === c.aggregate) {
          if (r.scope === 'region' && c.region === r.from) c.region = r.to;
          if (r.scope === 'state' && c.region === r.path.split('.')[1] && c.state === r.from) c.state = r.to;
        }
        break;
      case 'monotonic': renPath(c.field); break;
      case 'conservation': c.parts.forEach(renPath); renPath(c.total); break;
      case 'leadsTo': walkPred(c.from); walkPred(c.to); break;
    }
    if ((r.scope === 'aggregate' || r.scope === 'entity') && c.aggregate === r.from) c.aggregate = r.to;
  }
  return inv;
}
```

Note: `enumValue` resolution uses the **current** model's field types — exact for the committed
specs (enum-typed fields keep enum-typed after renames); pinned by the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/engine/renames.test.ts`
Expected: PASS (7).

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/engine/renames.ts src/engine/session.ts src/ast/invariant.ts test/engine/renames.test.ts
git commit -m "feat(lattice): append-only rename ledger entries + witness resolution"
```

---
### Task 3: Structure-implied invariants

**Files:**
- Create: `lattice/src/engine/implied.ts`
- Test: `lattice/test/engine/implied.test.ts`

**Interfaces:**
- Consumes: `DomainModel`, `CandidateInvariant`, `Candidate`.
- Produces:
  - `impliedInvariants(m: DomainModel): CandidateInvariant[]` — deterministic ids `implied-<name>`, names `terminal<Owner><Region><State>` / `refsResolve<Owner>` / `nonNegative<Owner><Field>` (each part capitalized then joined, first letter lowercased overall), `source: 'template'`, `prior: 1`.
  - `isImplied(c: Candidate, m: DomainModel): boolean` — deep candidate equality against any derived candidate (ignores id/name/prior/source).
  - Suppression: a `Money` field tagged `@signed` yields no nonNegative rule (spec P9).

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/implied.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { impliedInvariants, isImplied } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';

const m: DomainModel = {
  context: 'C', enums: [], events: [],
  entities: [{ kind: 'entity', name: 'Plan', fields: [
    { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'licenseFee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'adjustment', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
  aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
    { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'plan', type: { kind: 'ref', target: 'Plan' } },
    { name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
    machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
      { name: 'draft' }, { name: 'paid', tags: ['terminal'] }, { name: 'void', tags: ['terminal'] }] }],
      transitions: [] } }],
};

describe('impliedInvariants', () => {
  const derived = impliedInvariants(m);
  const names = derived.map(d => d.name).sort();

  it('derives terminal, refsResolve, nonNegative with deterministic names', () => {
    expect(names).toEqual(['nonNegativeInvoiceTotalDue', 'nonNegativePlanLicenseFee',
      'refsResolveInvoice', 'terminalInvoiceSettlementPaid', 'terminalInvoiceSettlementVoid'].sort());
  });

  it('suppresses nonNegative for @signed Money fields', () => {
    expect(names).not.toContain('nonNegativePlanAdjustment');
  });

  it('candidates carry the exact closed-grammar shapes', () => {
    const t = derived.find(d => d.name === 'terminalInvoiceSettlementPaid')!;
    expect(t.candidate).toEqual({ kind: 'terminal', aggregate: 'Invoice', region: 'settlement', state: 'paid' });
    const n = derived.find(d => d.name === 'nonNegativeInvoiceTotalDue')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'int', value: 0 } } });
    expect(t.id).toBe('implied-terminalInvoiceSettlementPaid');
  });

  it('isImplied matches by candidate shape, ignoring metadata', () => {
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Invoice' }, m)).toBe(true);
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Plan' }, m)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/implied.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lattice/src/engine/implied.ts`:

```ts
import type { AggregateDef, DomainModel, EntityDef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const mk = (name: string, candidate: Candidate): CandidateInvariant =>
  ({ id: `implied-${name}`, name, prior: 1, source: 'template', candidate });

/**
 * Structure-implied invariants (spec P9): @terminal ⇒ stays-terminal, ref ⇒ refs-resolve,
 * Money (unless @signed) ⇒ non-negative. Derived at load, never printed (spec §3.4).
 * The elicitation flow (templates.ts) is untouched — golden traces must not shift.
 */
export function impliedInvariants(m: DomainModel): CandidateInvariant[] {
  const out: CandidateInvariant[] = [];
  const owners: (AggregateDef | EntityDef)[] = [...m.aggregates, ...m.entities];
  for (const o of owners) {
    for (const f of o.fields)
      if (f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed'))
        out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`, { kind: 'statePredicate', aggregate: o.name,
          body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [f.name] },
            right: { kind: 'int', value: 0 } } }));
    if (o.fields.some(f => f.type.kind === 'ref'))
      out.push(mk(`refsResolve${cap(o.name)}`, { kind: 'refsResolve', aggregate: o.name }));
    const machine = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of machine?.regions ?? [])
      for (const s of r.states.filter(s => s.tags?.includes('terminal')))
        out.push(mk(`terminal${cap(o.name)}${cap(r.name)}${cap(s.name)}`,
          { kind: 'terminal', aggregate: o.name, region: r.name, state: s.name }));
  }
  return out;
}

const canonical = (c: Candidate) => JSON.stringify(c, Object.keys(c).sort());
export function isImplied(c: Candidate, m: DomainModel): boolean {
  const mine = canonical(c);
  return impliedInvariants(m).some(d => canonical(d.candidate) === mine);
}
```

Note: `canonical` sorts only top-level keys; nested predicate objects are compared via
`JSON.stringify` of construction-ordered keys. Both sides are built by this codebase's constructors
(templates.ts, implied.ts, fromLangium.ts) which use identical property order per kind — pinned by
the tests here and in Task 5 (printer omission of tpl-2/3/9 duplicates against the real
subscriptions session).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/engine/implied.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/engine/implied.ts test/engine/implied.test.ts
git commit -m "feat(lattice): structure-implied invariants (terminal/refsResolve/nonNegative)"
```

---

### Task 4: Mapping layer — Langium AST → domain AST

**Files:**
- Create: `lattice/src/parse/fromLangium.ts`
- Test: `lattice/test/parse/fromLangium.test.ts`

**Interfaces:**
- Consumes: `parseLat`/`LatParseResult` (Task 1), generated AST types, `validateModel`, `validateCandidate`, `IDENT_RE`, `impliedInvariants`/`isImplied` (Task 3).
- Produces:
  - `loadLatText(text: string): LoadResult` where
    `type LoadResult = { ok: true; model: DomainModel; invariants: CandidateInvariant[]; warnings: ParseDiagnostic[] } | { ok: false; diagnostics: ParseDiagnostic[] }`
  - Semantics: parse → map → `validateModel` → `validateCandidate` per invariant (closed grammar, spec §5.2). Explicit invariants duplicating an implied one produce warning `redundant-invariant` and are DROPPED from `invariants` (printer normalizes them away, spec §3.4). Warning `naming-convention` (camelCase members / PascalCase types, spec P8) is non-fatal.
  - Mapped invariant ids are `hand-<name>`; `doc` joined from `///` lines; `where` from the header; owner = enclosing aggregate or `on` target (`on` missing at context level → diagnostic `missing-target`; `on` present inside an aggregate → diagnostic `redundant-target` if it differs).
  - Term mapping: a 2-segment path whose head names an enum → `enumval`; otherwise field path with `owner:'self'`. `state r in {…}` → `inState` with `owner:'self'`. `a => b` → `implies`; chained `&&`/`||` flatten to n-ary `and`/`or`.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/parse/fromLangium.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadLatText } from '../../src/parse/fromLangium.js';

const SPEC = `/// Top doc
context Demo {
  ticksPerDay = 24
  enum Mode { fast, slow }
  /// Entity doc
  entity Plan {
    planId : Id key
    fee    : Money
    bonus  : Money @signed
    mode   : Mode
  }
  event kicked { reason : Text }
  aggregate Job {
    jobId : Id key
    plan  : ref Plan
    units : Int
    machine {
      region run { states { queued @initial, going @active, done @terminal } }
      transition start { region run; from queued to going; when kicked }
    }
    /// Units stay sane.
    invariant unitsSane { units >= 0 && (state run in {going} => units <= 100) }
    invariant oneGoing { unique while run in {going} by (plan) }
  }
  invariant planMode on Plan where fee >= 1 { mode == Mode.fast || ! (fee + 1 <= 3) }
}
`;

describe('loadLatText', () => {
  const r = loadLatText(SPEC);
  it('maps the model', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { model } = r;
    expect(model.context).toBe('Demo');
    expect(model.doc).toBe('Top doc');
    expect(model.ticksPerDay).toBe(24);
    expect(model.enums).toEqual([{ name: 'Mode', values: ['fast', 'slow'] }]);
    expect(model.entities[0]!.doc).toBe('Entity doc');
    expect(model.entities[0]!.fields[1]).toEqual({ name: 'fee', type: { kind: 'prim', prim: 'Money' } });
    expect(model.entities[0]!.fields[2]!.tags).toEqual(['signed']);
    expect(model.events).toEqual([{ name: 'kicked', fields: [{ name: 'reason', type: { kind: 'prim', prim: 'Text' } }] }]);
    const job = model.aggregates[0]!;
    expect(job.machine!.regions[0]).toEqual({ name: 'run', initial: 'queued', states: [
      { name: 'queued' }, { name: 'going', tags: ['active'] }, { name: 'done', tags: ['terminal'] }] });
    expect(job.machine!.transitions[0]).toEqual({ name: 'start', region: 'run', from: 'queued', to: 'going', when: 'kicked' });
  });

  it('maps invariants with docs, owners, bodies', () => {
    if (!r.ok) throw new Error('parse failed');
    const [unitsSane, oneGoing, planMode] = r.invariants;
    expect(unitsSane!.name).toBe('unitsSane');
    expect(unitsSane!.doc).toBe('Units stay sane.');
    expect(unitsSane!.id).toBe('hand-unitsSane');
    expect(unitsSane!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Job',
      body: { kind: 'and', args: [
        { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } },
        { kind: 'implies',
          left: { kind: 'inState', owner: 'self', region: 'run', states: ['going'] },
          right: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 100 } } }] } });
    expect(oneGoing!.candidate).toEqual({ kind: 'unique', aggregate: 'Job',
      whileStates: { region: 'run', states: ['going'] }, by: [['plan']] });
    expect(planMode!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Plan',
      where: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['fee'] }, right: { kind: 'int', value: 1 } },
      body: { kind: 'or', args: [
        { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['mode'] }, right: { kind: 'enumval', enum: 'Mode', value: 'fast' } },
        { kind: 'not', arg: { kind: 'cmp', op: 'le',
          left: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['fee'] }, right: { kind: 'int', value: 1 } },
          right: { kind: 'int', value: 3 } } }] } });
  });

  it('drops explicit duplicates of implied invariants with a warning', () => {
    const dup = loadLatText(`context C { aggregate A { aId : Id key
      machine { region r { states { s @initial, t @terminal } } transition x { region r; from s to t } }
      invariant stays { terminal r.t } } }`);
    expect(dup.ok).toBe(true);
    if (dup.ok) {
      expect(dup.invariants).toHaveLength(0);
      expect(dup.warnings.some(w => w.code === 'redundant-invariant')).toBe(true);
    }
  });

  it('closed grammar: unknown paths/states are structured diagnostics, not crashes', () => {
    const bad = loadLatText('context C { aggregate A { aId : Id key\n invariant x { nosuch >= 0 } } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'unknown-path')).toBe(true);
  });

  it('missing on-target at context level is a diagnostic', () => {
    const bad = loadLatText('context C { entity E { eId : Id key }\n invariant x { 1 <= 1 } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'missing-target')).toBe(true);
  });

  it('ill-formed model (two @initial) is a diagnostic', () => {
    const bad = loadLatText(`context C { aggregate A { aId : Id key
      machine { region r { states { s @initial, t @initial } } transition x { region r; from s to t } } } }`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'multiple-initial')).toBe(true);
  });

  it('warns on naming convention violations without failing', () => {
    const r2 = loadLatText('context C { entity Plan { plan_id : Id key } }');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.warnings.some(w => w.code === 'naming-convention')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parse/fromLangium.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lattice/src/parse/fromLangium.ts`:

```ts
import { parseLat, type ParseDiagnostic } from './parse.js';
import type * as G from './generated/ast.js';
import type { DomainModel, EnumDef, EntityDef, AggregateDef, EventDef, Field, TypeRef, Machine, Region, StateDef, TransitionDef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term, Path } from '../ast/invariant.js';
import { validateModel } from '../ast/validate.js';
import { validateCandidate } from '../ast/grammar.js';
import { isImplied } from '../engine/implied.js';

export type LoadResult =
  | { ok: true; model: DomainModel; invariants: CandidateInvariant[]; warnings: ParseDiagnostic[] }
  | { ok: false; diagnostics: ParseDiagnostic[] };

const PRIMS = new Set(['Int', 'Text', 'Date', 'Duration', 'Money', 'Id']);
const stripDoc = (d: string) => d.replace(/^\/\/\/\s?/, '');
const joinDocs = (docs: string[]): string | undefined =>
  docs.length ? docs.map(stripDoc).join(' ') : undefined;

const at = (node: any): { line: number; col: number } => {
  const c = node?.$cstNode;
  return { line: (c?.range?.start?.line ?? 0) + 1, col: (c?.range?.start?.character ?? 0) + 1 };
};
const diag = (code: string, message: string, node?: any): ParseDiagnostic =>
  ({ code, message, ...at(node) });

function mapType(t: G.LatType, enums: Set<string>, diags: ParseDiagnostic[]): TypeRef {
  if (t.$type === 'ListType') return { kind: 'list', of: mapType((t as G.ListType).of, enums, diags) };
  if (t.$type === 'RefType') return { kind: 'ref', target: (t as G.RefType).target };
  const name = (t as G.NamedType).name;
  if (PRIMS.has(name)) return { kind: 'prim', prim: name as any };
  return { kind: 'enum', enum: name };   // unresolved enum → validateModel reports unresolved-enum
}

function mapFields(fs: G.FieldDecl[], enums: Set<string>, diags: ParseDiagnostic[]): Field[] {
  return fs.map(f => {
    const field: Field = { name: f.name, type: mapType(f.type, enums, diags) };
    if (f.key) field.key = true;
    if (f.tags.length) field.tags = f.tags.map(t => t.name);
    return field;
  });
}

function mapMachine(m: G.MachineDecl, ownerName: string, diags: ParseDiagnostic[]): Machine {
  const regions: Region[] = m.regions.map(r => {
    const states: StateDef[] = r.states.map(s => {
      const tags = s.tags.map(t => t.name).filter(t => t === 'active' || t === 'terminal') as ('active' | 'terminal')[];
      const st: StateDef = { name: s.name };
      if (tags.length) st.tags = tags;
      return st;
    });
    const initials = r.states.filter(s => s.tags.some(t => t.name === 'initial'));
    if (initials.length !== 1)
      diags.push(diag('multiple-initial',
        `region ${ownerName}.${r.name} must have exactly one @initial state (found ${initials.length})`, r));
    return { name: r.name, initial: initials[0]?.name ?? r.states[0]!.name, states };
  });
  const transitions: TransitionDef[] = m.transitions.map(t => {
    const tr: TransitionDef = { name: t.name, region: t.region, from: t.from, to: t.to };
    if (t.when) tr.when = t.when;
    return tr;
  });
  return { regions, transitions };
}

function mapTerm(e: G.Expr, enums: Map<string, string[]>): Term {
  switch (e.$type) {
    case 'IntLit': return { kind: 'int', value: (e as G.IntLit).value };
    case 'NowLit': return { kind: 'now' };
    case 'PlusExpr': {
      const p = e as G.PlusExpr;
      return { kind: 'plus', left: mapTerm(p.left, enums), right: mapTerm(p.right, enums) };
    }
    case 'PathRef': {
      const segs = (e as G.PathRef).segments;
      if (segs.length === 2 && enums.has(segs[0]!) && enums.get(segs[0]!)!.includes(segs[1]!))
        return { kind: 'enumval', enum: segs[0]!, value: segs[1]! };
      return { kind: 'field', owner: 'self', path: [...segs] };
    }
    default: throw new Error(`unmapped expr ${e.$type}`);
  }
}

function mapPred(p: G.Predicate, enums: Map<string, string[]>): Predicate {
  switch (p.$type) {
    case 'BinPred': {
      const b = p as G.BinPred;
      const l = mapPred(b.left, enums), r = mapPred(b.right, enums);
      if (b.op === '=>') return { kind: 'implies', left: l, right: r };
      const kind = b.op === '&&' ? 'and' as const : 'or' as const;
      // flatten left-assoc chains of the SAME connective into n-ary args
      const args = l.kind === kind ? [...(l as any).args, r] : [l, r];
      return { kind, args };
    }
    case 'NotPred': return { kind: 'not', arg: mapPred((p as G.NotPred).arg, enums) };
    case 'StatePred': {
      const s = p as G.StatePred;
      return { kind: 'inState', owner: 'self', region: s.region, states: [...s.states] };
    }
    case 'Comparison': {
      const c = p as G.Comparison;
      const ops: Record<string, 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'> =
        { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
      return { kind: 'cmp', op: ops[c.op]!, left: mapTerm(c.left, enums), right: mapTerm(c.right, enums) };
    }
    default: throw new Error(`unmapped predicate ${p.$type}`);
  }
}

const mapPath = (p: G.PathExpr): Path => [...p.segments];

function mapBody(inv: G.InvariantDecl, aggregate: string, enums: Map<string, string[]>): Candidate {
  const b = inv.body;
  const where = inv.where ? mapPred(inv.where, enums) : undefined;
  switch (b.$type) {
    case 'UniqueBody': return { kind: 'unique', aggregate,
      whileStates: { region: (b as G.UniqueBody).region, states: [...(b as G.UniqueBody).states] },
      by: (b as G.UniqueBody).by.map(mapPath) };
    case 'RefsResolveBody': return { kind: 'refsResolve', aggregate };
    case 'CardinalityBody': return { kind: 'cardinality', aggregate,
      where: (b as G.CardinalityBody).where ? mapPred((b as G.CardinalityBody).where!, enums) : null,
      atMost: (b as G.CardinalityBody).atMost };
    case 'TerminalBody': return { kind: 'terminal', aggregate,
      region: (b as G.TerminalBody).region, state: (b as G.TerminalBody).state };
    case 'MonotonicBody': return { kind: 'monotonic', aggregate, field: mapPath((b as G.MonotonicBody).field) };
    case 'ConserveBody': return { kind: 'conservation', aggregate,
      parts: (b as G.ConserveBody).parts.map(mapPath), total: mapPath((b as G.ConserveBody).total) };
    case 'LeadsToBody': return { kind: 'leadsTo', aggregate,
      from: mapPred((b as G.LeadsToBody).from, enums), to: mapPred((b as G.LeadsToBody).to, enums),
      fairness: (b as G.LeadsToBody).fairness.slice(1, -1) };
    default: {
      const c: Candidate = { kind: 'statePredicate', aggregate, body: mapPred((b as G.PredicateBody).pred, enums) };
      if (where) (c as any).where = where;
      return c;
    }
  }
}

const CAMEL = /^[a-z][A-Za-z0-9]*$/, PASCAL = /^[A-Z][A-Za-z0-9]*$/;
function namingWarnings(m: DomainModel, invNames: string[]): ParseDiagnostic[] {
  const out: ParseDiagnostic[] = [];
  const warn = (kind: string, n: string, re: RegExp, style: string) => {
    if (!re.test(n)) out.push({ code: 'naming-convention', line: 1, col: 1,
      message: `${kind} '${n}' should be ${style} (spec P8)` });
  };
  warn('context', m.context, PASCAL, 'PascalCase');
  for (const e of m.enums) { warn('enum', e.name, PASCAL, 'PascalCase'); e.values.forEach(v => warn('enum value', v, CAMEL, 'camelCase')); }
  const owners = [...m.entities, ...m.aggregates];
  for (const o of owners) {
    warn(o.kind, o.name, PASCAL, 'PascalCase');
    o.fields.forEach(f => warn('field', f.name, CAMEL, 'camelCase'));
    const mach = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of mach?.regions ?? []) { warn('region', r.name, CAMEL, 'camelCase'); r.states.forEach(s => warn('state', s.name, CAMEL, 'camelCase')); }
    mach?.transitions.forEach(t => warn('transition', t.name, CAMEL, 'camelCase'));
  }
  for (const e of m.events) warn('event', e.name, PASCAL, 'PascalCase');
  invNames.forEach(n => warn('invariant', n, CAMEL, 'camelCase'));
  return out;
}

export function loadLatText(text: string): LoadResult {
  const parsed = parseLat(text);
  if (!parsed.ok) return parsed;
  const cst = parsed.cst;
  const diags: ParseDiagnostic[] = [];

  const enumDecls = cst.items.filter((i): i is G.EnumDecl => i.$type === 'EnumDecl');
  const enumSet = new Set(enumDecls.map(e => e.name));
  const enumMap = new Map(enumDecls.map(e => [e.name, [...e.values]]));

  const model: DomainModel = {
    context: cst.name,
    enums: enumDecls.map(e => ({ name: e.name, values: [...e.values] }) as EnumDef),
    entities: [], aggregates: [], events: [],
  };
  const topDoc = joinDocs([...cst.docs]);
  if (topDoc) model.doc = topDoc;

  for (const item of cst.items) {
    switch (item.$type) {
      case 'TicksDecl': model.ticksPerDay = (item as G.TicksDecl).value; break;
      case 'EntityDecl': {
        const e = item as G.EntityDecl;
        const def: EntityDef = { kind: 'entity', name: e.name, fields: mapFields([...e.fields], enumSet, diags) };
        const d = joinDocs([...e.docs]); if (d) def.doc = d;
        model.entities.push(def); break;
      }
      case 'EventDecl': {
        const e = item as G.EventDecl;
        model.events.push({ name: e.name, fields: mapFields([...e.fields], enumSet, diags) } as EventDef); break;
      }
      case 'AggregateDecl': {
        const a = item as G.AggregateDecl;
        const def: AggregateDef = { kind: 'aggregate', name: a.name, fields: mapFields([...a.fields], enumSet, diags) };
        if (a.machine) def.machine = mapMachine(a.machine, a.name, diags);
        const d = joinDocs([...a.docs]); if (d) def.doc = d;
        model.aggregates.push(def); break;
      }
    }
  }

  // invariants: inside aggregates (implicit owner) and at context level (require `on`)
  const rawInvs: { decl: G.InvariantDecl; owner: string }[] = [];
  for (const item of cst.items) {
    if (item.$type === 'AggregateDecl')
      for (const inv of (item as G.AggregateDecl).invariants) {
        if (inv.target && inv.target !== (item as G.AggregateDecl).name)
          diags.push(diag('redundant-target', `invariant ${inv.name}: 'on ${inv.target}' inside aggregate ${(item as G.AggregateDecl).name}`, inv));
        rawInvs.push({ decl: inv, owner: (item as G.AggregateDecl).name });
      }
    if (item.$type === 'InvariantDecl') {
      const inv = item as G.InvariantDecl;
      if (!inv.target) { diags.push(diag('missing-target', `context-level invariant ${inv.name} needs 'on <Entity|Aggregate>'`, inv)); continue; }
      rawInvs.push({ decl: inv, owner: inv.target });
    }
  }

  const modelDiags = validateModel(model).map(d => ({ code: d.code, message: d.message, line: 1, col: 1 }));
  diags.push(...modelDiags);
  if (diags.length) return { ok: false, diagnostics: diags };

  const warnings: ParseDiagnostic[] = [];
  const invariants: CandidateInvariant[] = [];
  for (const { decl, owner } of rawInvs) {
    let candidate: Candidate;
    try { candidate = mapBody(decl, owner, enumMap); }
    catch (err) { diags.push(diag('unmapped-construct', String(err), decl)); continue; }
    if (decl.where && candidate.kind !== 'statePredicate') {
      // grammar accepts a header `where` on any body; only statePredicate carries one in the AST
      diags.push(diag('where-unsupported', `invariant ${decl.name}: 'where' guards apply only to predicate bodies`, decl));
      continue;
    }
    const gram = validateCandidate(candidate, model);
    if (gram.length) { gram.forEach(g => diags.push({ code: g.code, message: `invariant ${decl.name}: ${g.message}`, ...at(decl) })); continue; }
    if (isImplied(candidate, model)) {
      warnings.push({ code: 'redundant-invariant',
        message: `invariant ${decl.name} restates a structure-implied rule; it is derived automatically and will not be printed`, ...at(decl) });
      continue;
    }
    const inv: CandidateInvariant = { id: `hand-${decl.name}`, name: decl.name, prior: 1, source: 'template', candidate };
    const d = joinDocs([...decl.docs]); if (d) inv.doc = d;
    invariants.push(inv);
  }
  if (diags.length) return { ok: false, diagnostics: diags };

  warnings.push(...namingWarnings(model, invariants.map(i => i.name)));
  return { ok: true, model, invariants, warnings };
}
```

Implementer notes: (a) generated AST arrays are typed readonly in some Langium versions — the
spreads (`[...e.values]`) handle that; (b) if generated property names differ (e.g. `$type`
literals), fix HERE, not in consumers; (c) `source: 'template'` is a placeholder — reconcile
(Task 8) sets real provenance in the ledger; the `source` union has no better member and adding
one is out of scope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/parse/fromLangium.test.ts`
Expected: PASS (7).

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/parse/fromLangium.ts test/parse/fromLangium.test.ts
git commit -m "feat(lattice): map parsed .lat to domain AST behind the closed grammar"
```

---
### Task 5: Printer rewrite (`astToCode`)

**Files:**
- Modify: `lattice/src/emit/code.ts` (full rewrite)
- Modify: `lattice/src/emit/prose.ts` (implied-invariant note)
- Modify: `lattice/src/cli.ts` (emit call site — `astToCode` loses the ledger param, gains implied filtering internally)
- Modify: `lattice/test/emit/projections.test.ts` (new-syntax assertions; do NOT touch other assertions in the file)
- Test: `lattice/test/emit/code-print.test.ts`

**Interfaces:**
- Consumes: `DomainModel`, `CandidateInvariant` (with `doc`), `impliedInvariants`/`isImplied` (Task 3).
- Produces: `astToCode(m: DomainModel, adopted: CandidateInvariant[]): string` — prints new syntax; SKIPS adopted invariants whose candidate `isImplied` (spec §3.4); no `//` anywhere; `///` docs; `@initial`; events; `ticksPerDay`. Also exports `predToText(p: Predicate): string` and `candidateBodyText(c: Candidate): string` for reuse by diagnostics/explain.
- Round-trip contract with Task 4: for every construct, `loadLatText(astToCode(m, invs))` reproduces `(m, invs)` — Task 6 enforces it; this task pins exact text.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/emit/code-print.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { astToCode } from '../../src/emit/code.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

const m: DomainModel = {
  context: 'Demo', doc: 'Top doc', ticksPerDay: 24,
  enums: [{ name: 'Mode', values: ['fast', 'slow'] }],
  entities: [{ kind: 'entity', name: 'Plan', doc: 'Entity doc', fields: [
    { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'fee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'bonus', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
  aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
    { name: 'jobId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'plan', type: { kind: 'ref', target: 'Plan' } },
    { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'run', initial: 'queued', states: [
      { name: 'queued' }, { name: 'going', tags: ['active'] }, { name: 'done', tags: ['terminal'] }] }],
      transitions: [{ name: 'start', region: 'run', from: 'queued', to: 'going', when: 'kicked' }] } }],
  events: [{ name: 'kicked', fields: [{ name: 'reason', type: { kind: 'prim', prim: 'Text' } }] }],
};

const invs: CandidateInvariant[] = [
  { id: 'hand-unitsSane', name: 'unitsSane', prior: 1, source: 'template', doc: 'Units stay sane.',
    candidate: { kind: 'statePredicate', aggregate: 'Job', body: { kind: 'and', args: [
      { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } },
      { kind: 'implies', left: { kind: 'inState', owner: 'self', region: 'run', states: ['going'] },
        right: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 100 } } }] } } },
  // duplicates the implied refsResolveJob → must NOT print
  { id: 'tpl-9-Job', name: 'NoOrphan_Job', prior: 0.9, source: 'template',
    candidate: { kind: 'refsResolve', aggregate: 'Job' } },
  { id: 'hand-planMode', name: 'planMode', prior: 1, source: 'template',
    candidate: { kind: 'statePredicate', aggregate: 'Plan',
      where: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['fee'] }, right: { kind: 'int', value: 1 } },
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['mode'] },
        right: { kind: 'enumval', enum: 'Mode', value: 'fast' } } } },
];

it('prints the reference form exactly', () => {
  expect(astToCode(m, invs)).toBe(`/// Top doc
context Demo {

  ticksPerDay = 24

  enum Mode { fast, slow }

  /// Entity doc
  entity Plan {
    planId : Id key
    fee    : Money
    bonus  : Money @signed
  }

  event kicked {
    reason : Text
  }

  aggregate Job {
    jobId : Id key
    plan  : ref Plan
    units : Int

    machine {
      region run { states { queued @initial, going @active, done @terminal } }
      transition start { region run; from queued to going; when kicked }
    }

    /// Units stay sane.
    invariant unitsSane { units >= 0 && (state run in {going} => units <= 100) }
  }

  invariant planMode on Plan where fee >= 1 { mode == Mode.fast }
}
`);
});

it('never emits // and always emits every candidate kind parseably', () => {
  const kinds: CandidateInvariant[] = [
    { id: 'a', name: 'u', prior: 1, source: 'template', candidate: { kind: 'unique', aggregate: 'Job', whileStates: { region: 'run', states: ['going', 'queued'] }, by: [['plan'], ['units']] } },
    { id: 'b', name: 'c', prior: 1, source: 'template', candidate: { kind: 'cardinality', aggregate: 'Job', where: null, atMost: 2 } },
    { id: 'd', name: 'mono', prior: 1, source: 'template', candidate: { kind: 'monotonic', aggregate: 'Job', field: ['units'] } },
    { id: 'e', name: 'cons', prior: 1, source: 'template', candidate: { kind: 'conservation', aggregate: 'Job', parts: [['units'], ['units']], total: ['units'] } },
    { id: 'f', name: 'lt', prior: 1, source: 'template', candidate: { kind: 'leadsTo', aggregate: 'Job',
      from: { kind: 'inState', owner: 'self', region: 'run', states: ['queued'] },
      to: { kind: 'inState', owner: 'self', region: 'run', states: ['done'] }, fairness: 'start fires' } },
  ];
  const text = astToCode(m, kinds);
  expect(text).toContain('invariant u { unique while run in {going, queued} by (plan, units) }');
  expect(text).toContain('invariant c { count <= 2 }');
  expect(text).toContain('invariant mono { monotonic units }');
  expect(text).toContain('invariant cons { conserve units + units == units }');
  expect(text).toContain('invariant lt { from state run in {queued} leads to state run in {done} under fairness "start fires" }');
  for (const line of text.split('\n')) expect(line).not.toMatch(/(^|[^/])\/\/([^/]|$)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/code-print.test.ts`
Expected: FAIL — current printer emits old syntax and takes a third parameter.

- [ ] **Step 3: Rewrite the printer**

Replace the entire contents of `lattice/src/emit/code.ts`:

```ts
import type { DomainModel, Field, Machine } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import { isImplied } from '../engine/implied.js';

const typeStr = (f: Field): string =>
  f.type.kind === 'prim' ? f.type.prim : f.type.kind === 'enum' ? f.type.enum
  : f.type.kind === 'ref' ? `ref ${f.type.target}` : `List<${typeStr({ ...f, type: f.type.of })}>`;

const OPS = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' } as const;
// precedence: implies(1) < or(2) < and(3) < not(4) < atoms(5)
const prec = (p: Predicate): number =>
  p.kind === 'implies' ? 1 : p.kind === 'or' ? 2 : p.kind === 'and' ? 3 : p.kind === 'not' ? 4 : 5;
const wrap = (child: Predicate, parent: number): string =>
  prec(child) <= parent ? `(${predToText(child)})` : predToText(child);

function termToText(t: Term): string {
  switch (t.kind) {
    case 'field': return t.path.join('.');
    case 'int': return String(t.value);
    case 'enumval': return `${t.enum}.${t.value}`;
    case 'now': return 'now';
    case 'plus': return `${termToText(t.left)} + ${termToText(t.right)}`;
  }
}

export function predToText(p: Predicate): string {
  switch (p.kind) {
    case 'cmp': return `${termToText(p.left)} ${OPS[p.op]} ${termToText(p.right)}`;
    case 'inState': return `state ${p.region} in {${p.states.join(', ')}}`;
    case 'and': return p.args.map(a => wrap(a, 3)).join(' && ');
    case 'or': return p.args.map(a => wrap(a, 2)).join(' || ');
    case 'not': return `! ${wrap(p.arg, 4)}`;
    case 'implies': return `${wrap(p.left, 1)} => ${wrap(p.right, 1)}`;
  }
}

export function candidateBodyText(c: Candidate): string {
  switch (c.kind) {
    case 'statePredicate': return predToText(c.body);
    case 'unique': return `unique while ${c.whileStates.region} in {${c.whileStates.states.join(', ')}} by (${c.by.map(p => p.join('.')).join(', ')})`;
    case 'refsResolve': return 'refs resolve';
    case 'cardinality': return `count ${c.where ? `where ${predToText(c.where)} ` : ''}<= ${c.atMost}`;
    case 'terminal': return `terminal ${c.region}.${c.state}`;
    case 'monotonic': return `monotonic ${c.field.join('.')}`;
    case 'conservation': return `conserve ${c.parts.map(p => p.join('.')).join(' + ')} == ${c.total.join('.')}`;
    case 'leadsTo': return `from ${predToText(c.from)} leads to ${predToText(c.to)} under fairness "${c.fairness}"`;
  }
}

const doc = (d: string | undefined, indent: string, out: string[]) => { if (d) out.push(`${indent}/// ${d}`); };
const pad = (n: string, w: number) => n + ' '.repeat(Math.max(1, w - n.length));

function fieldLines(fields: Field[], indent: string, out: string[]): void {
  const w = Math.max(...fields.map(f => f.name.length)) + 1;
  for (const f of fields)
    out.push(`${indent}${pad(f.name, w)}: ${typeStr(f)}${f.key ? ' key' : ''}${f.tags?.length ? ' @' + f.tags.join(' @') : ''}`);
}

function machineLines(mach: Machine, out: string[]): void {
  out.push('    machine {');
  for (const r of mach.regions) {
    const states = r.states.map(s => {
      const tags = [...(s.name === r.initial ? ['initial'] : []), ...(s.tags ?? [])];
      return s.name + (tags.length ? ' @' + tags.join(' @') : '');
    }).join(', ');
    out.push(`      region ${r.name} { states { ${states} } }`);
  }
  for (const t of mach.transitions)
    out.push(`      transition ${t.name} { region ${t.region}; from ${t.from} to ${t.to}${t.when ? `; when ${t.when}` : ''} }`);
  out.push('    }');
}

function invariantLines(inv: CandidateInvariant, indent: string, on: string | undefined, out: string[]): void {
  doc(inv.doc, indent, out);
  const c = inv.candidate;
  const where = c.kind === 'statePredicate' && c.where ? ` where ${predToText(c.where)}` : '';
  out.push(`${indent}invariant ${inv.name}${on ? ` on ${on}` : ''}${where} { ${candidateBodyText(c)} }`);
}

export function astToCode(m: DomainModel, adopted: CandidateInvariant[]): string {
  const explicit = adopted.filter(i => !isImplied(i.candidate, m));   // spec §3.4: implied never printed
  const out: string[] = [];
  doc(m.doc, '', out);
  out.push(`context ${m.context} {`, '');
  if (m.ticksPerDay !== undefined) out.push(`  ticksPerDay = ${m.ticksPerDay}`, '');
  for (const e of m.enums) out.push(`  enum ${e.name} { ${e.values.join(', ')} }`);
  if (m.enums.length) out.push('');
  for (const ent of m.entities) {
    doc(ent.doc, '  ', out);
    out.push(`  entity ${ent.name} {`);
    fieldLines(ent.fields, '    ', out);
    out.push('  }', '');
  }
  for (const ev of m.events) {
    out.push(`  event ${ev.name} {`);
    fieldLines(ev.fields, '    ', out);
    out.push('  }', '');
  }
  for (const a of m.aggregates) {
    doc(a.doc, '  ', out);
    out.push(`  aggregate ${a.name} {`);
    fieldLines(a.fields, '    ', out);
    if (a.machine) { out.push(''); machineLines(a.machine, out); }
    for (const inv of explicit.filter(i => i.candidate.aggregate === a.name)) {
      out.push('');
      invariantLines(inv, '    ', undefined, out);
    }
    out.push('  }', '');
  }
  for (const inv of explicit.filter(i => !m.aggregates.some(a => a.name === i.candidate.aggregate))) {
    invariantLines(inv, '  ', inv.candidate.aggregate, out);
    out.push('');
  }
  while (out[out.length - 1] === '') out.pop();
  out.push('}');
  return out.join('\n') + '\n';
}
```

- [ ] **Step 4: Update call sites and prose note**

In `lattice/src/cli.ts` `emit` case, change the `astToCode` call and pass implied invariants to prose:

```ts
      case 'emit': {
        const adopted = s.candidates.filter(c => c.status === 'adopted').map(c => c.inv);
        const ledger = readLedger(dir);
        const derived = impliedInvariants(model()).filter(d => !adopted.some(a => JSON.stringify(a.candidate) === JSON.stringify(d.candidate)));
        mkdirSync(values.out!, { recursive: true });
        const prose = join(values.out!, 'spec.prose.md'), lat = join(values.out!, 'spec.lat');
        writeFileSync(prose, astToProse(model(), [...adopted, ...derived], ledger));
        writeFileSync(lat, astToCode(model(), adopted));
        return { written: [prose, lat] };
      }
```

Add `import { impliedInvariants } from './engine/implied.js';` to cli.ts imports.

In `lattice/src/emit/prose.ts` change the "Always true" provenance line (line 61) to note implied rules:

```ts
  for (const inv of adopted.filter(i => i.candidate.kind !== 'leadsTo'))
    lines.push(`- ${renderCandidateEnglish(inv.candidate)}  (${
      inv.id.startsWith('implied-') ? 'implied by structure' : provenance.get(inv.id) ?? inv.source}: ${inv.name})`);
```

In `lattice/test/emit/projections.test.ts`, `describe('astToCode')` block: update the two-arg call `astToCode(traceAModel, [H3])` (drop `ledger`) and replace old-syntax `toContain` assertions with their new-syntax equivalents (e.g. `invariant <name> { unique while ... }`, `///` instead of `//` for the doc-string test, and the `⚓` assertion is deleted — provenance no longer prints, spec P11). Update the `emitted .lat smoke tripwire` block the same way. Keep assertion COUNT equal or higher — do not delete coverage, translate it.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/emit/`
Expected: PASS (code-print + updated projections tests).

- [ ] **Step 6: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/emit/code.ts src/emit/prose.ts src/cli.ts test/emit/code-print.test.ts test/emit/projections.test.ts
git commit -m "feat(lattice): printer emits full concrete syntax (docs, @initial, predicate bodies)"
```

---

### Task 6: Round-trip property tests

**Files:**
- Create: `lattice/test/parse/arbitraries.ts`
- Test: `lattice/test/parse/roundtrip.test.ts`

**Interfaces:**
- Consumes: `astToCode` (Task 5), `loadLatText` (Task 4), fixtures `lattice/fixtures/domains/*.json`, session `.lattice-session-subscriptions/` (repo root).
- Produces: `arbSpec: fc.Arbitrary<{ model: DomainModel; invariants: CandidateInvariant[] }>` (exported for reuse in any later fuzzing).

- [ ] **Step 1: Write the generators**

Create `lattice/test/parse/arbitraries.ts`. Generators must produce CANONICAL ASTs — the round-trip
property is over normal forms (spec §7.1): identifiers camelCase/PascalCase-ish from safe alphabets
avoiding the reserved-keyword list, `and`/`or` args length ≥ 2 with no directly-nested same-kind,
docs without newlines or `/`, every region exactly one initial (first state), enums non-empty,
every owner has a key field, paths reference real fields, `where` only on statePredicate.

```ts
import fc from 'fast-check';
import type { DomainModel, AggregateDef, Field } from '../../src/ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term, Cmp } from '../../src/ast/invariant.js';

const RESERVED = new Set(['context', 'enum', 'entity', 'aggregate', 'event', 'machine', 'region', 'states',
  'transition', 'from', 'to', 'when', 'invariant', 'on', 'where', 'unique', 'while', 'by', 'refs', 'resolve',
  'count', 'terminal', 'monotonic', 'conserve', 'leads', 'under', 'fairness', 'state', 'now', 'ref', 'List',
  'key', 'ticksPerDay', 'in']);
const lower = 'abcdefghijklmnopqrstuvwxyz';
const ident = (first: string) => fc.tuple(
  fc.constantFrom(...first.split('')),
  fc.string({ unit: fc.constantFrom(...(lower + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').split('')), maxLength: 6 }))
  .map(([a, b]) => a + b).filter(s => !RESERVED.has(s));
const camel = ident(lower);
const pascal = ident('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const uniqNames = (arb: fc.Arbitrary<string>, min: number, max: number) =>
  fc.uniqueArray(arb, { minLength: min, maxLength: max });

const docText = fc.string({ unit: fc.constantFrom(...'abc XYZ,.'.split('')), minLength: 1, maxLength: 30 })
  .map(s => s.trim()).filter(s => s.length > 0);

function fieldArb(name: string, enumNames: string[]): fc.Arbitrary<Field> {
  const prim = fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id').map(p => ({ kind: 'prim' as const, prim: p as any }));
  const type = enumNames.length
    ? fc.oneof({ weight: 3, arbitrary: prim }, { weight: 1, arbitrary: fc.constantFrom(...enumNames).map(e => ({ kind: 'enum' as const, enum: e })) })
    : prim;
  return fc.record({
    type,
    tags: fc.option(fc.constantFrom(['total'], ['balance'], ['signed']), { nil: undefined }),
  }).map(({ type, tags }) => {
    const f: Field = { name, type };
    if (tags) f.tags = tags;
    return f;
  });
}

const cmpOps: Cmp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
function predArb(agg: AggregateDef, enums: { name: string; values: string[] }[], depth: number): fc.Arbitrary<Predicate> {
  const numFields = agg.fields.filter(f => f.type.kind === 'prim' && ['Int', 'Money', 'Date', 'Duration'].includes((f.type as any).prim));
  const enumFields = agg.fields.filter(f => f.type.kind === 'enum');
  const term: fc.Arbitrary<Term> = fc.oneof(
    fc.constantFrom(...(numFields.length ? numFields : agg.fields)).map(f => ({ kind: 'field' as const, owner: 'self', path: [f.name] })),
    fc.integer({ min: 0, max: 999 }).map(value => ({ kind: 'int' as const, value })),
    fc.constant({ kind: 'now' as const }));
  const sum: fc.Arbitrary<Term> = fc.oneof({ weight: 4, arbitrary: term },
    { weight: 1, arbitrary: fc.tuple(term, term).map(([left, right]) => ({ kind: 'plus' as const, left, right })) });
  const cmpNum: fc.Arbitrary<Predicate> = fc.tuple(fc.constantFrom(...cmpOps), sum, sum)
    .map(([op, left, right]) => ({ kind: 'cmp' as const, op, left, right }));
  const cmpEnum: fc.Arbitrary<Predicate> | null = enumFields.length ? fc.constantFrom(...enumFields).chain(f => {
    const e = enums.find(x => x.name === (f.type as any).enum)!;
    return fc.constantFrom(...e.values).map(v => ({ kind: 'cmp' as const, op: 'eq' as const,
      left: { kind: 'field' as const, owner: 'self', path: [f.name] },
      right: { kind: 'enumval' as const, enum: e.name, value: v } }));
  }) : null;
  const inState: fc.Arbitrary<Predicate> | null = agg.machine ? fc.constantFrom(...agg.machine.regions).chain(r =>
    fc.uniqueArray(fc.constantFrom(...r.states.map(s => s.name)), { minLength: 1, maxLength: r.states.length })
      .map(states => ({ kind: 'inState' as const, owner: 'self', region: r.name, states }))) : null;
  const atoms = [cmpNum, ...(cmpEnum ? [cmpEnum] : []), ...(inState ? [inState] : [])];
  const atom = fc.oneof(...atoms);
  if (depth <= 0) return atom;
  const sub = predArb(agg, enums, depth - 1);
  const differentKind = (kind: 'and' | 'or') => (args: Predicate[]) => args.every(a => a.kind !== kind);
  return fc.oneof({ weight: 4, arbitrary: atom },
    { weight: 1, arbitrary: fc.array(sub, { minLength: 2, maxLength: 3 }).filter(differentKind('and')).map(args => ({ kind: 'and' as const, args })) },
    { weight: 1, arbitrary: fc.array(sub, { minLength: 2, maxLength: 3 }).filter(differentKind('or')).map(args => ({ kind: 'or' as const, args })) },
    { weight: 1, arbitrary: sub.map(arg => ({ kind: 'not' as const, arg })) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([left, right]) => ({ kind: 'implies' as const, left, right })) });
}

function candidateArb(agg: AggregateDef, enums: { name: string; values: string[] }[]): fc.Arbitrary<Candidate> {
  const paths = agg.fields.map(f => [f.name]);
  const arbs: fc.Arbitrary<Candidate>[] = [
    fc.tuple(predArb(agg, enums, 2), fc.option(predArb(agg, enums, 1), { nil: undefined }))
      .map(([body, where]) => {
        const c: Candidate = { kind: 'statePredicate', aggregate: agg.name, body };
        if (where) (c as any).where = where;
        return c;
      }),
    fc.tuple(fc.option(predArb(agg, enums, 1), { nil: null }), fc.integer({ min: 0, max: 9 }))
      .map(([where, atMost]) => ({ kind: 'cardinality' as const, aggregate: agg.name, where, atMost })),
    fc.constantFrom(...paths).map(field => ({ kind: 'monotonic' as const, aggregate: agg.name, field })),
  ];
  if (paths.length >= 3) arbs.push(fc.constant({ kind: 'conservation' as const, aggregate: agg.name,
    parts: [paths[0]!, paths[1]!], total: paths[2]! }));
  if (agg.machine) {
    const r = agg.machine.regions[0]!;
    arbs.push(fc.uniqueArray(fc.constantFrom(...r.states.map(s => s.name)), { minLength: 1, maxLength: 2 })
      .chain(states => fc.uniqueArray(fc.constantFrom(...paths.map(p => p.join('.'))), { minLength: 1, maxLength: 2 })
        .map(by => ({ kind: 'unique' as const, aggregate: agg.name,
          whileStates: { region: r.name, states }, by: by.map(s => s.split('.')) }))));
    arbs.push(fc.tuple(predArb(agg, enums, 1), predArb(agg, enums, 1), docText)
      .map(([from, to, fairness]) => ({ kind: 'leadsTo' as const, aggregate: agg.name, from, to, fairness })));
  }
  return fc.oneof(...arbs);
}

export const arbSpec: fc.Arbitrary<{ model: DomainModel; invariants: CandidateInvariant[] }> =
  fc.tuple(pascal, uniqNames(pascal, 0, 2), fc.option(docText, { nil: undefined }))
    .chain(([ctx, enumNames, topDoc]) =>
      fc.tuple(
        fc.constant(ctx), fc.constant(topDoc),
        fc.array(fc.tuple(fc.constant(0), uniqNames(camel, 1, 3)), { minLength: enumNames.length, maxLength: enumNames.length })
          .map(vals => enumNames.map((name, i) => ({ name, values: vals[i]![1] }))),
        uniqNames(pascal.filter(n => !enumNames.includes(n)), 1, 2))
      .chain(([context, doc, enums, aggNames]) =>
        fc.tuple(...aggNames.map(name =>
          fc.tuple(uniqNames(camel.filter(n => n !== 'state'), 2, 4), fc.boolean(), fc.option(docText, { nil: undefined }))
            .chain(([fieldNames, hasMachine, aggDoc]) =>
              fc.tuple(...fieldNames.slice(1).map(fn => fieldArb(fn, enums.map(e => e.name))))
                .chain(rest => {
                  const fields: Field[] = [{ name: fieldNames[0]!, type: { kind: 'prim', prim: 'Id' }, key: true }, ...rest];
                  const base: AggregateDef = { kind: 'aggregate', name, fields };
                  if (aggDoc) base.doc = aggDoc;
                  if (!hasMachine) return fc.constant(base);
                  return fc.tuple(camel.filter(n => !fieldNames.includes(n)), uniqNames(camel, 2, 4), camel)
                    .map(([regionName, stateNames, transName]) => ({ ...base, machine: {
                      regions: [{ name: regionName, initial: stateNames[0]!, states: stateNames.map((s, i) => {
                        const st: any = { name: s };
                        if (i === stateNames.length - 1) st.tags = ['terminal'];
                        return st;
                      }) }],
                      transitions: [{ name: transName, region: regionName, from: stateNames[0]!, to: stateNames[1]! }] } } as AggregateDef));
                }))))
        .chain(aggs => {
          const model: DomainModel = { context, enums, entities: [], aggregates: [...aggs], events: [] };
          if (doc) model.doc = doc;
          return fc.tuple(...aggs.map(a =>
            fc.array(fc.tuple(camel, fc.option(docText, { nil: undefined }), candidateArb(a, enums)), { maxLength: 2 })))
            .map(perAgg => {
              const used = new Set<string>();
              const invariants: CandidateInvariant[] = [];
              for (const list of perAgg) for (const [nm, d, candidate] of list) {
                if (used.has(nm)) continue;
                used.add(nm);
                const inv: CandidateInvariant = { id: `hand-${nm}`, name: nm, prior: 1, source: 'template', candidate };
                if (d) inv.doc = d;
                invariants.push(inv);
              }
              return { model, invariants };
            });
        })));
```

- [ ] **Step 2: Write the failing round-trip test**

Create `lattice/test/parse/roundtrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { arbSpec } from './arbitraries.js';
import { astToCode } from '../../src/emit/code.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { isImplied } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/domains');
const SESSION = join(import.meta.dirname, '../../../.lattice-session-subscriptions');

function roundTrip(model: DomainModel, invariants: CandidateInvariant[]) {
  const text = astToCode(model, invariants);
  const r = loadLatText(text);
  expect(r.ok, `parse failed:\n${text}\n${JSON.stringify(!r.ok && r.diagnostics, null, 2)}`).toBe(true);
  if (!r.ok) return;
  expect(r.model).toEqual(model);
  const explicit = invariants.filter(i => !isImplied(i.candidate, model));
  // parse assigns hand-<name> ids and prior 1/source template; compare name+doc+candidate (spec §7.1)
  const shape = (i: CandidateInvariant) => ({ name: i.name, doc: i.doc, candidate: i.candidate });
  expect(r.invariants.map(shape)).toEqual(explicit.map(shape));
  // normalization idempotence: one more print∘parse is a fixed point
  expect(astToCode(r.model, r.invariants)).toBe(text);
}

describe('round-trip: parse ∘ print = id (spec §7.1)', () => {
  it('holds on generated specs (property)', () => {
    fc.assert(fc.property(arbSpec, ({ model, invariants }) => { roundTrip(model, invariants); }),
      { numRuns: 200 });
  });

  it('holds on all fixture domains', () => {
    for (const f of readdirSync(FIXTURES).filter(f => f.endsWith('.json'))) {
      const model = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as DomainModel;
      roundTrip(model, []);
    }
  });

  it('holds on the real subscriptions session (model + adopted)', () => {
    const model = JSON.parse(readFileSync(join(SESSION, 'model.json'), 'utf8')) as DomainModel;
    const state = JSON.parse(readFileSync(join(SESSION, 'state.json'), 'utf8'));
    const adopted: CandidateInvariant[] = state.candidates
      .filter((c: any) => c.status === 'adopted').map((c: any) => c.inv);
    roundTrip(model, adopted);
  });
});
```

Note: `model.json` stores the model separately from `state.json` in this session; if
`state.json.model` is non-null prefer it — inspect once and use whichever holds the model.

- [ ] **Step 3: Run, then fix until green**

Run: `npx vitest run test/parse/roundtrip.test.ts`
Expected: FAILS initially are LEGITIMATE FINDINGS — each is a printer/parser/mapper mismatch. Fix
the responsible side (usually the printer's precedence/spacing or the generator emitting a
non-canonical AST), re-run until PASS. Do not weaken `toEqual` to partial matching. Two known
traps: (a) fixture models may have `machine.regions[].initial` not first in the states list —
the printer emits `@initial` explicitly so this must round-trip as-is; (b) optional keys —
mapping must not materialize `tags: []` or `doc: undefined` (deep-equal distinguishes absent
from undefined only if the key exists — use conditional assignment, both sides already do).

- [ ] **Step 4: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add test/parse/arbitraries.ts test/parse/roundtrip.test.ts
git commit -m "test(lattice): round-trip identity property over generated + real specs"
```

---
### Task 7: Model diff + rename detection

**Files:**
- Create: `lattice/src/parse/diff.ts`
- Test: `lattice/test/parse/diff.test.ts`

**Interfaces:**
- Consumes: `DomainModel`, `CandidateInvariant`, `RenameSpec` (Task 2), `LedgerEntry`.
- Produces:
  - `ledgerReferences(scopeRef: RenameSpec, ledger: LedgerEntry[]): string[]` — witness ids / entry descriptions that mention the OLD name (fields: witness field keys on entities of the owner type; states: `<region>.state` values; enumValues: enum-typed field values — pass the stored model; aggregates/entities: witness entity types; invariants: adopted/declined entry names). Transitions/regions/enums/events return `[]` from witnesses (not witness-visible) but invariant/adopted references still count for `invariant`.
  - `diffModels(before: { model: DomainModel; canonical: CandidateInvariant[] }, after: { model: DomainModel; canonical: CandidateInvariant[] }, ledger: LedgerEntry[], storedModel: DomainModel): ModelDiff` where

```ts
export interface InvariantChange { name: string; before: CandidateInvariant; after: CandidateInvariant }
export interface ModelDiff {
  addedInvariants: CandidateInvariant[];
  changedInvariants: InvariantChange[];      // same name, different candidate (or doc-only edits → applied silently)
  removedInvariants: CandidateInvariant[];   // includes implied ones killed by tag edits (derived names)
  renameProposals: RenameSpec[];             // delete+add pairs of like kind whose old name is ledger-referenced
  structuralNotes: string[];                 // human-readable structural adds/removes that apply without ceremony
}
```

  - Pairing heuristic (spec P4): removed+added of the same kind AND same shape (field: identical `TypeRef`; state: same region; invariant: deep-equal candidate; aggregate/entity: ≥ half the field names shared) AND `ledgerReferences(old)` non-empty ⇒ a `renameProposal` (and the pair is EXCLUDED from added/removed/structuralNotes). Unreferenced pairs stay plain delete+add.
  - `diffModels` treats invariants by NAME as the join key; doc-only changes are NOT `changedInvariants` (reconcile applies them without replay).

- [ ] **Step 1: Write the failing test**

Create `lattice/test/parse/diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffModels, ledgerReferences } from '../../src/parse/diff.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const mk = (name: string, field: string): DomainModel => ({
  context: 'C', enums: [], events: [], entities: [],
  aggregates: [{ kind: 'aggregate', name, fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: field, type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'r', initial: 's1', states: [{ name: 's1' }, { name: 's2', tags: ['terminal'] }] }], transitions: [] } }],
});
const inv = (name: string, field: string): CandidateInvariant => ({
  id: `hand-${name}`, name, prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Job',
    body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [field] }, right: { kind: 'int', value: 0 } } } });

const ledger: LedgerEntry[] = [
  { kind: 'verdict', at: '2026-07-05T00:00:00Z', witnessId: 'w1', judge: 'permit', question: '',
    witness: { entities: [{ type: 'Job', id: 'j1', fields: { units: 3, 'r.state': 's1' } }] }, salient: [] },
  { kind: 'adopted', at: '2026-07-05T00:00:00Z', invariant: inv('unitsSane', 'units'), provenance: 'elicited (w1)' },
];

describe('ledgerReferences', () => {
  const stored = mk('Job', 'units');
  it('finds field references in witnesses', () => {
    expect(ledgerReferences({ scope: 'field', path: 'Job.units', from: 'units', to: 'n' }, ledger)).toEqual(['w1']);
    expect(ledgerReferences({ scope: 'field', path: 'Job.other', from: 'other', to: 'n' }, ledger)).toEqual([]);
  });
  it('finds state and type and invariant references', () => {
    expect(ledgerReferences({ scope: 'state', path: 'Job.r.s1', from: 's1', to: 'x' }, ledger)).toEqual(['w1']);
    expect(ledgerReferences({ scope: 'aggregate', path: 'Job', from: 'Job', to: 'Task' }, ledger)).toEqual(['w1']);
    expect(ledgerReferences({ scope: 'invariant', path: 'unitsSane', from: 'unitsSane', to: 'x' }, ledger))
      .toEqual(['adopted:unitsSane']);
    expect(ledgerReferences({ scope: 'transition', path: 'Job.t', from: 't', to: 'x' }, ledger)).toEqual([]);
  });
});

describe('diffModels', () => {
  const before = { model: mk('Job', 'units'), canonical: [inv('unitsSane', 'units')] };

  it('detects ledger-referenced field rename as a proposal, not delete+add', () => {
    const d = diffModels(before, { model: mk('Job', 'usedUnits'), canonical: [inv('unitsSane', 'usedUnits')] }, ledger, before.model);
    expect(d.renameProposals).toEqual([{ scope: 'field', path: 'Job.units', from: 'units', to: 'usedUnits' }]);
    // the invariant body changed only via the renamed path — after rename confirmation reconcile
    // re-diffs; at this layer it still reports the body change:
    expect(d.changedInvariants.map(c => c.name)).toEqual(['unitsSane']);
  });

  it('unreferenced delete+add stays structural', () => {
    const quiet: LedgerEntry[] = [];
    const d = diffModels(before, { model: mk('Job', 'usedUnits'), canonical: [inv('unitsSane', 'usedUnits')] }, quiet, before.model);
    expect(d.renameProposals).toEqual([]);
    expect(d.structuralNotes.join(' ')).toContain('usedUnits');
  });

  it('detects invariant rename by identical candidate', () => {
    const d = diffModels(before, { model: before.model, canonical: [inv('unitsStaySane', 'units')] }, ledger, before.model);
    expect(d.renameProposals).toEqual([{ scope: 'invariant', path: 'unitsSane', from: 'unitsSane', to: 'unitsStaySane' }]);
    expect(d.addedInvariants).toEqual([]);
    expect(d.removedInvariants).toEqual([]);
  });

  it('reports added/changed/removed invariants by name', () => {
    const extra = inv('another', 'units');
    const changed = { ...inv('unitsSane', 'units'), candidate: { kind: 'refsResolve' as const, aggregate: 'Job' } };
    const d = diffModels(before, { model: before.model, canonical: [changed, extra] }, [], before.model);
    expect(d.addedInvariants.map(i => i.name)).toEqual(['another']);
    expect(d.changedInvariants.map(c => c.name)).toEqual(['unitsSane']);
  });

  it('doc-only change is not a changedInvariant', () => {
    const docd = { ...inv('unitsSane', 'units'), doc: 'now documented' };
    const d = diffModels(before, { model: before.model, canonical: [docd] }, [], before.model);
    expect(d.changedInvariants).toEqual([]);
    expect(d.addedInvariants).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parse/diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lattice/src/parse/diff.ts`:

```ts
import type { DomainModel, AggregateDef, EntityDef } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';
import type { RenameSpec } from '../engine/renames.js';

export interface InvariantChange { name: string; before: CandidateInvariant; after: CandidateInvariant }
export interface ModelDiff {
  addedInvariants: CandidateInvariant[];
  changedInvariants: InvariantChange[];
  removedInvariants: CandidateInvariant[];
  renameProposals: RenameSpec[];
  structuralNotes: string[];
}

const cjson = (v: unknown) => JSON.stringify(v);
type Owner = AggregateDef | EntityDef;
const owners = (m: DomainModel): Owner[] => [...m.aggregates, ...m.entities];

/** Ledger entries that mention the old name (spec P4 — witness keys/values + invariant records). */
export function ledgerReferences(r: RenameSpec, ledger: LedgerEntry[]): string[] {
  const hits: string[] = [];
  const owner = r.path.split('.')[0]!;
  for (const e of ledger) {
    if (e.kind === 'verdict' || (e.kind === 'open-decision' && e.witness)) {
      const w = (e as any).witness as { entities: { type: string; fields: Record<string, unknown> }[] };
      const id = (e as any).witnessId ?? 'open-decision';
      const touched = w.entities.some(ent => {
        switch (r.scope) {
          case 'aggregate': case 'entity': return ent.type === r.from;
          case 'field': return ent.type === owner && r.from in ent.fields;
          case 'region': return ent.type === owner && `${r.path.split('.')[1]}.state` in ent.fields;
          case 'state': {
            const region = r.path.split('.')[1]!;
            return ent.type === owner && ent.fields[`${region}.state`] === r.from;
          }
          case 'enumValue': return Object.values(ent.fields).includes(r.from);
          default: return false;
        }
      });
      if (touched) hits.push(id);
    }
    if (r.scope === 'invariant' && (e.kind === 'adopted' || e.kind === 'declined')
        && (e as any).invariant.name === r.from)
      hits.push(`${e.kind}:${r.from}`);
  }
  return [...new Set(hits)];
}

interface NamedThing { scope: RenameSpec['scope']; owner?: string; region?: string; name: string; shape: string }
function namedThings(m: DomainModel): NamedThing[] {
  const out: NamedThing[] = [];
  for (const e of m.enums) {
    out.push({ scope: 'enum', name: e.name, shape: 'enum' });
    for (const v of e.values) out.push({ scope: 'enumValue', owner: e.name, name: v, shape: `enumValue:${e.name}` });
  }
  for (const o of owners(m)) {
    out.push({ scope: o.kind === 'entity' ? 'entity' : 'aggregate', name: o.name,
      shape: `owner:${o.fields.map(f => f.name).sort().join(',')}` });
    for (const f of o.fields) out.push({ scope: 'field', owner: o.name, name: f.name, shape: `field:${o.name}:${cjson(f.type)}` });
    const mach = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of mach?.regions ?? []) {
      out.push({ scope: 'region', owner: o.name, name: r.name, shape: `region:${o.name}` });
      for (const s of r.states) out.push({ scope: 'state', owner: o.name, region: r.name, name: s.name, shape: `state:${o.name}.${r.name}` });
    }
    for (const t of mach?.transitions ?? []) out.push({ scope: 'transition', owner: o.name, name: t.name, shape: `transition:${o.name}.${t.region}` });
  }
  for (const ev of m.events) out.push({ scope: 'event', name: ev.name, shape: 'event' });
  return out;
}
const qualify = (t: NamedThing): string =>
  t.scope === 'state' ? `${t.owner}.${t.region}.${t.name}` : t.owner ? `${t.owner}.${t.name}` : t.name;

/** For owner renames, shape-match on ≥ half shared field names instead of exact shape. */
const ownerShapeMatch = (a: NamedThing, b: NamedThing): boolean => {
  const fa = a.shape.split(':')[1]!.split(',').filter(Boolean);
  const fb = b.shape.split(':')[1]!.split(',').filter(Boolean);
  const shared = fa.filter(f => fb.includes(f)).length;
  return shared * 2 >= Math.max(fa.length, fb.length, 1);
};

export function diffModels(
  before: { model: DomainModel; canonical: CandidateInvariant[] },
  after: { model: DomainModel; canonical: CandidateInvariant[] },
  ledger: LedgerEntry[],
  _storedModel: DomainModel,
): ModelDiff {
  const notes: string[] = [];
  const proposals: RenameSpec[] = [];

  const b = namedThings(before.model), a = namedThings(after.model);
  const akeys = new Set(a.map(x => `${x.scope}|${qualify(x)}`));
  const bkeys = new Set(b.map(x => `${x.scope}|${qualify(x)}`));
  const removed = b.filter(x => !akeys.has(`${x.scope}|${qualify(x)}`));
  const added = a.filter(x => !bkeys.has(`${x.scope}|${qualify(x)}`));

  const consumedAdds = new Set<NamedThing>();
  for (const r of removed) {
    const candidates = added.filter(x => !consumedAdds.has(x) && x.scope === r.scope && x.owner === r.owner && x.region === r.region
      && (r.scope === 'aggregate' || r.scope === 'entity' ? ownerShapeMatch(r, x) : x.shape === r.shape));
    const spec: RenameSpec = { scope: r.scope, path: qualify(r), from: r.name, to: candidates[0]?.name ?? '' };
    if (candidates.length && ledgerReferences(spec, ledger).length) {
      proposals.push(spec);
      consumedAdds.add(candidates[0]!);
    } else {
      notes.push(`removed ${r.scope} ${qualify(r)}`);
    }
  }
  for (const x of added) if (!consumedAdds.has(x)) notes.push(`added ${x.scope} ${qualify(x)}`);

  // invariants by name
  const bInv = new Map(before.canonical.map(i => [i.name, i]));
  const aInv = new Map(after.canonical.map(i => [i.name, i]));
  let addedInvariants = [...aInv.values()].filter(i => !bInv.has(i.name));
  let removedInvariants = [...bInv.values()].filter(i => !aInv.has(i.name));
  const changedInvariants: InvariantChange[] = [...aInv.values()]
    .filter(i => bInv.has(i.name) && cjson(bInv.get(i.name)!.candidate) !== cjson(i.candidate))
    .map(i => ({ name: i.name, before: bInv.get(i.name)!, after: i }));

  // invariant rename: identical candidate, different name, old name ledger-referenced
  for (const rem of [...removedInvariants]) {
    const match = addedInvariants.find(ad => cjson(ad.candidate) === cjson(rem.candidate));
    if (!match) continue;
    const spec: RenameSpec = { scope: 'invariant', path: rem.name, from: rem.name, to: match.name };
    if (ledgerReferences(spec, ledger).length) {
      proposals.push(spec);
      addedInvariants = addedInvariants.filter(x => x !== match);
      removedInvariants = removedInvariants.filter(x => x !== rem);
    }
  }

  return { addedInvariants, changedInvariants, removedInvariants, renameProposals: proposals, structuralNotes: notes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/parse/diff.test.ts`
Expected: PASS (7).

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/parse/diff.ts test/parse/diff.test.ts
git commit -m "feat(lattice): name-keyed model diff with ledger-aware rename proposals"
```

---

### Task 8: Reconciler (asymmetric ledger replay)

**Files:**
- Create: `lattice/src/engine/reconcile.ts`
- Test: `lattice/test/engine/reconcile.test.ts`

**Interfaces:**
- Consumes: `diffModels`/`ModelDiff` (Task 7), `resolveWitness`/`renameEntries`/`RenameSpec` (Task 2), `impliedInvariants` (Task 3), `evaluateCandidate`, `LedgerEntry`.
- Produces:

```ts
export interface ReconcileInput {
  parsed: { model: DomainModel; invariants: CandidateInvariant[] };   // from loadLatText
  storedModel: DomainModel;
  storedExplicit: CandidateInvariant[];      // state.json adopted list
  ledger: LedgerEntry[];
  confirmedRenames: RenameSpec[];            // from --rename flags
  forceRemove: string[];                     // invariant names acknowledged for removal
  at: string;                                // ISO timestamp injected by the caller
}
export interface Refusal {
  code: 'needs-rename-confirmation' | 'needs-force-remove' | 'contradicts-verdict' | 'template-only-kind';
  message: string; invariant?: string; witnessId?: string; verdict?: 'permit' | 'forbid'; judgedAt?: string;
  rename?: RenameSpec;
}
export type ReconcileOutcome =
  | { ok: true; model: DomainModel; adopted: CandidateInvariant[]; ledgerAppends: LedgerEntry[];
      applied: string[]; warnings: string[] }
  | { ok: false; refusals: Refusal[]; warnings: string[] };
export function reconcile(input: ReconcileInput): ReconcileOutcome;
```

- Semantics (spec §5 steps 3–6, amended step 5):
  1. canonical sets: `before = storedExplicit ∪ implied(storedModel)`, `after = parsed.invariants ∪ implied(parsed.model)` — dedupe implied against explicit by candidate JSON.
  2. **detection diff** on the RAW stored side: `diffModels(before, after, ledger, storedModel)`; every `renameProposal` not present in `confirmedRenames` (match scope+from+to) → refusal `needs-rename-confirmation` with the exact flag text `--rename <path>=<to>` in the message. Confirmed renames become ledger appends `{kind:'rename', at, ...spec}`.
  3. **normalization**: a rename is a name change, not a semantic edit — build `normBefore` by `applyRenamesToModel(storedModel, confirmedRenames)` + `applyRenamesToInvariant` over `storedExplicit`, recompute its canonical set, and take the **change diff** `diffModels(normBefore, after, …)`. A pure rename now vanishes from `changedInvariants`. All subsequent steps use the change diff.
  4. removals: each `removedInvariant` (change diff) not in `forceRemove` → refusal `needs-force-remove`; in `forceRemove` → ledger append `{kind:'declined', at, invariant, reason: 'hand-removed via --force-remove'}`.
  5. verdict replay — witnesses resolved via `resolveWitness(w, [...renameEntries(ledger), ...confirmedRenames], parsed.model)`:
     - for each `permit` verdict: an ADDED invariant that forbids it, or a CHANGED invariant whose `before` candidate permits it and whose `after` candidate forbids it (**delta rule** — the edit introduced the forbid), → refusal `contradicts-verdict` naming invariant, witnessId, `verdict: 'permit'`, `judgedAt` (the entry's `at`). The real subscriptions ledger contains baseline noise (w1 judged permit yet forbidden by the adopted one-draft rule) — an absolute rule would false-flag it.
     - for each `forbid` verdict: if some invariant in `normBefore`'s canonical set forbids the (resolved) witness and NO invariant in `after` forbids it → refusal `contradicts-verdict` with message `this edit permits the state in <wId>, judged forbid on <date> — re-judge with the domain expert or revert`.
     - any invariant in `after` forbidding a permit witness without triggering the delta rule → warning `baseline: <name> forbids <wId> (judged permit) — pre-existing, not this edit` (not a refusal).
  6. new invariants of kind `leadsTo` (in the change diff's `addedInvariants`) → refusal `template-only-kind` (spec §3.2 table).
  7. if no refusals: `ok: true` with `model = parsed.model`, `adopted = parsed.invariants` (ids: keep the NORMALIZED stored invariant's id when the name matches, else the parsed `hand-<name>` id), ledgerAppends = rename entries + declined entries + one `{kind:'adopted', at, invariant, provenance: 'hand-edited <date>, consistent with <w-ids>'}` per ADDED/CHANGED invariant (`<date>` = `at.slice(0,10)`, `<w-ids>` = all verdict witnessIds, comma-joined, or `no judged cases` when none), `applied` = human-readable list.
  8. atomicity is the caller's job (Task 9 writes only on `ok: true`); `reconcile` itself is pure.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/reconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileInput } from '../../src/engine/reconcile.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const model: DomainModel = {
  context: 'C', enums: [], events: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'r', initial: 's1', states: [{ name: 's1' }, { name: 's2', tags: ['terminal'] }] }],
      transitions: [{ name: 'go', region: 'r', from: 's1', to: 's2' }] } }],
};
const nonNeg: CandidateInvariant = { id: 'hand-unitsSane', name: 'unitsSane', prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Job',
    body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } } } };

const ledger: LedgerEntry[] = [
  // negative units judged forbid — only unitsSane forbids it
  { kind: 'verdict', at: '2026-07-05T10:00:00Z', witnessId: 'w1', judge: 'forbid', question: '',
    witness: { entities: [{ type: 'Job', id: 'j', fields: { units: -5, 'r.state': 's1' } }] }, salient: [] },
  // positive units judged permit
  { kind: 'verdict', at: '2026-07-05T11:00:00Z', witnessId: 'w2', judge: 'permit', question: '',
    witness: { entities: [{ type: 'Job', id: 'j', fields: { units: 7, 'r.state': 's1' } }] }, salient: [] },
  { kind: 'adopted', at: '2026-07-05T12:00:00Z', invariant: nonNeg, provenance: 'elicited (w1, w2)' },
];

const base = (over: Partial<ReconcileInput>): ReconcileInput => ({
  parsed: { model, invariants: [nonNeg] }, storedModel: model, storedExplicit: [nonNeg],
  ledger, confirmedRenames: [], forceRemove: [], at: '2026-07-06T00:00:00Z', ...over });

describe('reconcile', () => {
  it('no-op edit applies cleanly with no ledger appends', () => {
    const r = reconcile(base({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ledgerAppends).toEqual([]);
  });

  it('rejects an edit that permits a forbid-judged state, naming witness/verdict/date', () => {
    const weakened = { ...nonNeg, candidate: { ...nonNeg.candidate,
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: -100 } } } } as CandidateInvariant;
    const r = reconcile(base({ parsed: { model, invariants: [weakened] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'contradicts-verdict')!;
      expect(f.witnessId).toBe('w1');
      expect(f.verdict).toBe('forbid');
      expect(f.judgedAt).toBe('2026-07-05T10:00:00Z');
      expect(f.message).toContain('w1');
      expect(f.message).toContain('re-judge');
    }
  });

  it('rejects a changed invariant that forbids a permit-judged state', () => {
    const tooStrict = { ...nonNeg, candidate: { ...nonNeg.candidate,
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 10 } } } } as CandidateInvariant;
    const r = reconcile(base({ parsed: { model, invariants: [tooStrict] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // w1 (forbid) still forbidden by the stricter rule, but w2 (permit) now forbidden → refusal
      const f = r.refusals.find(x => x.code === 'contradicts-verdict')!;
      expect(f.witnessId).toBe('w2');
      expect(f.verdict).toBe('permit');
      expect(f.invariant).toBe('unitsSane');
    }
  });

  it('consistent edit applies with hand-edited provenance', () => {
    const stricter = { ...nonNeg, candidate: { ...nonNeg.candidate,
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: -1 } } } } as CandidateInvariant;
    // still forbids w1 (units -5 < -1) and permits w2
    const r = reconcile(base({ parsed: { model, invariants: [stricter] } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ad = r.ledgerAppends.find(e => e.kind === 'adopted') as any;
      expect(ad.provenance).toBe('hand-edited 2026-07-06, consistent with w1, w2');
      expect(ad.invariant.name).toBe('unitsSane');
      expect(ad.invariant.id).toBe('hand-unitsSane');
    }
  });

  it('removal needs --force-remove and appends a declined entry when forced', () => {
    const r1 = reconcile(base({ parsed: { model, invariants: [] } }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.refusals[0]!.code).toBe('needs-force-remove');
    const r2 = reconcile(base({ parsed: { model, invariants: [] }, forceRemove: ['unitsSane'] }));
    // removing unitsSane un-forbids w1 → still a contradiction refusal even when forced
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.refusals.some(x => x.code === 'contradicts-verdict' && x.witnessId === 'w1')).toBe(true);
  });

  it('tag edit that kills an implied invariant follows the removal flow', () => {
    const untagged: DomainModel = JSON.parse(JSON.stringify(model));
    delete (untagged.aggregates[0]!.machine!.regions[0]!.states[1] as any).tags;   // s2 no longer @terminal
    const r = reconcile(base({ parsed: { model: untagged, invariants: [nonNeg] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'needs-force-remove')!;
      expect(f.invariant).toBe('terminalJobRS2');
    }
  });

  it('unconfirmed ledger-referenced rename refuses with the exact flag', () => {
    const renamed: DomainModel = JSON.parse(JSON.stringify(model));
    renamed.aggregates[0]!.fields[1]!.name = 'usedUnits';
    const inv2 = JSON.parse(JSON.stringify(nonNeg));
    inv2.candidate.body.left.path = ['usedUnits'];
    const r = reconcile(base({ parsed: { model: renamed, invariants: [inv2] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'needs-rename-confirmation')!;
      expect(f.message).toContain('--rename Job.units=usedUnits');
    }
  });

  it('confirmed rename applies: witnesses replay under the mapping, rename entry appended', () => {
    const renamed: DomainModel = JSON.parse(JSON.stringify(model));
    renamed.aggregates[0]!.fields[1]!.name = 'usedUnits';
    const inv2 = JSON.parse(JSON.stringify(nonNeg));
    inv2.candidate.body.left.path = ['usedUnits'];
    const r = reconcile(base({ parsed: { model: renamed, invariants: [inv2] },
      confirmedRenames: [{ scope: 'field', path: 'Job.units', from: 'units', to: 'usedUnits' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ledgerAppends.some(e => e.kind === 'rename' && (e as any).to === 'usedUnits')).toBe(true);
      // the body "changed" (path rename) but replay under mapping keeps w1 forbidden / w2 permitted
      expect(r.applied.join(' ')).toContain('usedUnits');
    }
  });

  it('rejects new hand-written leadsTo', () => {
    const lt: CandidateInvariant = { id: 'hand-lt', name: 'lt', prior: 1, source: 'template',
      candidate: { kind: 'leadsTo', aggregate: 'Job',
        from: { kind: 'inState', owner: 'self', region: 'r', states: ['s1'] },
        to: { kind: 'inState', owner: 'self', region: 'r', states: ['s2'] }, fairness: 'go' } };
    const r = reconcile(base({ parsed: { model, invariants: [nonNeg, lt] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]!.code).toBe('template-only-kind');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lattice/src/engine/reconcile.ts`:

```ts
import type { DomainModel } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { LedgerEntry } from './session.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';
import { impliedInvariants } from './implied.js';
import { renameEntries, resolveWitness, applyRenamesToModel, applyRenamesToInvariant,
  type RenameSpec } from './renames.js';
import { diffModels } from '../parse/diff.js';

export interface ReconcileInput {
  parsed: { model: DomainModel; invariants: CandidateInvariant[] };
  storedModel: DomainModel;
  storedExplicit: CandidateInvariant[];
  ledger: LedgerEntry[];
  confirmedRenames: RenameSpec[];
  forceRemove: string[];
  at: string;
}
export interface Refusal {
  code: 'needs-rename-confirmation' | 'needs-force-remove' | 'contradicts-verdict' | 'template-only-kind';
  message: string; invariant?: string; witnessId?: string; verdict?: 'permit' | 'forbid'; judgedAt?: string;
  rename?: RenameSpec;
}
export type ReconcileOutcome =
  | { ok: true; model: DomainModel; adopted: CandidateInvariant[]; ledgerAppends: LedgerEntry[];
      applied: string[]; warnings: string[] }
  | { ok: false; refusals: Refusal[]; warnings: string[] };

const cjson = (v: unknown) => JSON.stringify(v);
/** explicit ∪ implied under DERIVED names: explicit entries whose candidate matches an implied
 *  rule are replaced by the derived-name version. Without this, the pre-migration session (whose
 *  state.json still lists the 13 template invariants under old names) would diff as 13 renames
 *  on every apply. Ledger adopted entries keep the old names — explain still finds them. */
function canonicalSet(model: DomainModel, explicit: CandidateInvariant[]): CandidateInvariant[] {
  const derived = impliedInvariants(model);
  const derivedShapes = new Set(derived.map(d => cjson(d.candidate)));
  return [...explicit.filter(i => !derivedShapes.has(cjson(i.candidate))), ...derived];
}

export function reconcile(input: ReconcileInput): ReconcileOutcome {
  const { parsed, storedModel, storedExplicit, ledger, confirmedRenames, forceRemove, at } = input;
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const appends: LedgerEntry[] = [];
  const applied: string[] = [];

  const after = { model: parsed.model, canonical: canonicalSet(parsed.model, parsed.invariants) };

  // detection diff on the RAW stored side — this is where rename proposals come from
  const rawBefore = { model: storedModel, canonical: canonicalSet(storedModel, storedExplicit) };
  const detection = diffModels(rawBefore, after, ledger, storedModel);
  const confirmedKey = new Set(confirmedRenames.map(r => `${r.scope}|${r.from}|${r.to}`));
  for (const p of detection.renameProposals) {
    if (confirmedKey.has(`${p.scope}|${p.from}|${p.to}`)) continue;
    refusals.push({ code: 'needs-rename-confirmation', rename: p,
      message: `'${p.from}' → '${p.to}' looks like a rename of ledger-referenced ${p.scope} ${p.path}; ` +
        `confirm with --rename ${p.path}=${p.to} (or --force-remove if it is really a delete+add)` });
  }
  for (const r of confirmedRenames)
    appends.push({ kind: 'rename', at, scope: r.scope, path: r.path, from: r.from, to: r.to });

  // normalization: renames are name changes, not semantic edits (spec §5.5 as amended) —
  // apply confirmed renames to the stored side, then diff again for the real change set
  const normModel = applyRenamesToModel(storedModel, confirmedRenames);
  const normExplicit = storedExplicit.map(i => applyRenamesToInvariant(i, confirmedRenames));
  const before = { model: normModel, canonical: canonicalSet(normModel, normExplicit) };
  const diff = diffModels(before, after, ledger, storedModel);

  // removals (spec §5.6) — tag edits surface here as removed implied invariants
  for (const rem of diff.removedInvariants) {
    if (forceRemove.includes(rem.name)) {
      appends.push({ kind: 'declined', at, invariant: rem, reason: 'hand-removed via --force-remove' });
      applied.push(`removed invariant ${rem.name}`);
    } else {
      refusals.push({ code: 'needs-force-remove', invariant: rem.name,
        message: `invariant ${rem.name} is ledger-backed; removing it overrules the record — acknowledge with --force-remove ${rem.name}` });
    }
  }

  // template-only kinds (spec §3.2)
  for (const add of diff.addedInvariants.filter(i => i.candidate.kind === 'leadsTo')) {
    refusals.push({ code: 'template-only-kind', invariant: add.name,
      message: `invariant ${add.name}: 'leads to' invariants are template-instantiated only (slice-1 §6.1); they cannot be hand-written` });
  }

  // verdict replay (spec §5.5, asymmetric + delta rule)
  const allRenames = [...renameEntries(ledger), ...confirmedRenames];
  const verdicts = ledger.filter(e => e.kind === 'verdict') as Extract<LedgerEntry, { kind: 'verdict' }>[];
  const judgeable = (i: CandidateInvariant) => i.candidate.kind !== 'leadsTo';
  const changedOrAdded = [...diff.addedInvariants, ...diff.changedInvariants.map(c => c.after)].filter(judgeable);
  for (const v of verdicts) {
    const w: CaseState = resolveWitness(v.witness, allRenames, parsed.model);
    if (v.judge === 'permit') {
      const refused = new Set<string>();
      // delta rule: refuse only forbids INTRODUCED by this edit
      for (const inv of diff.addedInvariants.filter(judgeable))
        if (evaluateCandidate(inv.candidate, w) === 'forbid') {
          refused.add(inv.name);
          refusals.push({ code: 'contradicts-verdict', invariant: inv.name, witnessId: v.witnessId,
            verdict: 'permit', judgedAt: v.at,
            message: `invariant ${inv.name} forbids the state in ${v.witnessId}, judged permit on ${v.at.slice(0, 10)} — re-judge with the domain expert or revert` });
        }
      for (const ch of diff.changedInvariants.filter(c => judgeable(c.after)))
        if (evaluateCandidate(ch.before.candidate, w) === 'permit'
            && evaluateCandidate(ch.after.candidate, w) === 'forbid') {
          refused.add(ch.name);
          refusals.push({ code: 'contradicts-verdict', invariant: ch.name, witnessId: v.witnessId,
            verdict: 'permit', judgedAt: v.at,
            message: `invariant ${ch.name} now forbids the state in ${v.witnessId}, judged permit on ${v.at.slice(0, 10)} — re-judge with the domain expert or revert` });
        }
      for (const inv of after.canonical.filter(i => judgeable(i) && !refused.has(i.name)))
        if (evaluateCandidate(inv.candidate, w) === 'forbid')
          warnings.push(`baseline: ${inv.name} forbids ${v.witnessId} (judged permit) — pre-existing, not this edit`);
    } else {
      const forbids = (set: CandidateInvariant[]) =>
        set.some(i => judgeable(i) && evaluateCandidate(i.candidate, w) === 'forbid');
      if (forbids(before.canonical) && !forbids(after.canonical))
        refusals.push({ code: 'contradicts-verdict', witnessId: v.witnessId, verdict: 'forbid', judgedAt: v.at,
          message: `this edit permits the state in ${v.witnessId}, judged forbid on ${v.at.slice(0, 10)} — re-judge with the domain expert or revert` });
    }
  }

  if (refusals.length) return { ok: false, refusals, warnings };

  // adoption records for added/changed invariants (spec §5.5)
  const wids = verdicts.map(v => v.witnessId).join(', ');
  const storedByName = new Map(normExplicit.map(i => [i.name, i]));
  const adopted = parsed.invariants.map(i => {
    const prev = storedByName.get(i.name);
    return prev ? { ...i, id: prev.id, prior: prev.prior, source: prev.source } : i;
  });
  for (const inv of changedOrAdded) {
    const final = adopted.find(a => a.name === inv.name) ?? inv;
    appends.push({ kind: 'adopted', at, invariant: final,
      provenance: `hand-edited ${at.slice(0, 10)}, consistent with ${wids || 'no judged cases'}` });
    applied.push(`invariant ${inv.name}`);
  }
  applied.push(...diff.structuralNotes, ...confirmedRenames.map(r => `renamed ${r.scope} ${r.path} → ${r.to}`));
  return { ok: true, model: parsed.model, adopted, ledgerAppends: appends, applied, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/engine/reconcile.test.ts`
Expected: PASS (9). The `tag edit` test pins the derived name `terminalJobRS2` — if it fails on
the name, check Task 3's capitalization (region `r` → `R`, state `s2` → `S2`).

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/engine/reconcile.ts test/engine/reconcile.test.ts
git commit -m "feat(lattice): ledger reconciliation with asymmetric verdict replay"
```

---
### Task 9: CLI `apply` (atomic write-through)

**Files:**
- Modify: `lattice/src/cli.ts` (new `apply` command + arg parsing)
- Test: `lattice/test/cli-apply.test.ts`

**Interfaces:**
- Consumes: `loadLatText` (Task 4), `reconcile` (Task 8), `astToCode`/`astToProse`/`impliedInvariants`, `loadState`/`saveState`/`appendLedger`/`readLedger`.
- Produces: `engine apply --session <dir> --lat <file> [--dry-run] [--rename <path>=<new>]... [--force-remove <name>]...`
  - Returns (JSON, matching CLI idiom): on success `{ ok: true, applied: string[], warnings: string[], written: string[] }`; dry-run `{ ok: true, dryRun: true, applied, warnings }`; refusal `{ error: 'refused', refusals: Refusal[], warnings }`; parse failure `{ error: 'parse-failed', diagnostics }`; mid-flight session `{ error: 'session-busy', phase, pendingWitnesses }`.
  - Projections re-render NEXT TO the `--lat` file (`spec.lat` normalized + `spec.prose.md`).
  - Missing session dir (spec §5.8): fresh session, all invariants adopt `hand-authored <date>` (no verdicts exist), phase `converged`.
  - Atomic: on any refusal nothing is written anywhere.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/cli-apply.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, realDeps } from '../src/cli.js';

const SESSION_SRC = join(import.meta.dirname, '../../.lattice-session-subscriptions');

// NOTE: these tests run AFTER Task 12's migration in plan order, but they are written to be
// order-independent: they regenerate the .lat from the session model via `emit` first, so they
// never depend on the committed spec.lat's naming era.
let dir: string, sessionDir: string, specDir: string, latFile: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lat-apply-'));
  sessionDir = join(dir, 'session');
  specDir = join(dir, 'spec');
  cpSync(SESSION_SRC, sessionDir, { recursive: true });
  mkdirSync(specDir, { recursive: true });
  const r: any = await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
  expect(r.written).toBeDefined();
  latFile = join(specDir, 'spec.lat');
});

const apply = (extra: string[] = []) =>
  runCommand(['apply', '--session', sessionDir, '--lat', latFile, ...extra], realDeps);

describe('engine apply', () => {
  it('no-op apply succeeds and is idempotent on the normalized file', async () => {
    const before = readFileSync(latFile, 'utf8');
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(readFileSync(latFile, 'utf8')).toBe(before);
    expect(existsSync(join(specDir, 'spec.prose.md'))).toBe(true);
  });

  it('parse errors refuse and write nothing', async () => {
    const before = readFileSync(latFile, 'utf8');
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    writeFileSync(latFile, before + '\n// stray comment\n');
    const r: any = await apply();
    expect(r.error).toBe('parse-failed');
    expect(r.diagnostics[0]!.code).toBe('comment-banned');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });

  it('new transition applies with provenance-free structural note', async () => {
    const text = readFileSync(latFile, 'utf8')
      .replace('transition recover { region lifecycle; from past_due to active }',
        'transition recover { region lifecycle; from past_due to active }\n      transition graceToExpired { region lifecycle; from past_due to expired }');
    writeFileSync(latFile, text);
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(r.applied.join(' ')).toContain('graceToExpired');
    expect(readFileSync(latFile, 'utf8')).toContain('graceToExpired');
    const model = JSON.parse(readFileSync(join(sessionDir, 'model.json'), 'utf8'));
    expect(JSON.stringify(model)).toContain('graceToExpired');
  });

  it('ledger-referenced field rename refuses without the flag, applies with it', async () => {
    const renamed = readFileSync(latFile, 'utf8').replaceAll('accruedUnits', 'usedUnits');
    writeFileSync(latFile, renamed);
    const r1: any = await apply();
    expect(r1.error).toBe('refused');
    expect(JSON.stringify(r1.refusals)).toContain('--rename Subscription.accruedUnits=usedUnits');
    const r2: any = await apply(['--rename', 'Subscription.accruedUnits=usedUnits']);
    expect(r2.ok).toBe(true);
    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"rename"');
    // append-only: original first line untouched
    expect(ledger.split('\n')[0]).toContain('"kind":"structure"');
  });

  it('invariant edit contradicting a judged forbid case is rejected naming the witness', async () => {
    // w5 is forbidden ONLY by the one-draft-per-subscription unique rule (see plan preamble analysis)
    const text = readFileSync(latFile, 'utf8')
      .replace('unique while settlement in {draft} by (subscription)',
        'unique while settlement in {draft} by (invoiceId)');
    writeFileSync(latFile, text);
    const r: any = await apply();
    expect(r.error).toBe('refused');
    const f = r.refusals.find((x: any) => x.code === 'contradicts-verdict');
    expect(f.witnessId).toBe('w5');
    expect(f.verdict).toBe('forbid');
    expect(f.message).toContain('re-judge');
  });

  it('session mid-flight refuses', async () => {
    const state = JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8'));
    state.phase = 'distinguish';
    writeFileSync(join(sessionDir, 'state.json'), JSON.stringify(state));
    const r: any = await apply();
    expect(r.error).toBe('session-busy');
  });

  it('missing session dir hand-authors a fresh one', async () => {
    const fresh = join(dir, 'fresh-session');
    const r: any = await runCommand(['apply', '--session', fresh, '--lat', latFile], realDeps);
    expect(r.ok).toBe(true);
    const ledger = readFileSync(join(fresh, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('hand-authored');
    const state = JSON.parse(readFileSync(join(fresh, 'state.json'), 'utf8'));
    expect(state.phase).toBe('converged');
  });

  it('--dry-run reports and writes nothing', async () => {
    const text = readFileSync(latFile, 'utf8')
      .replace('transition recover { region lifecycle; from past_due to active }',
        'transition recover { region lifecycle; from past_due to active }\n      transition graceToExpired { region lifecycle; from past_due to expired }');
    writeFileSync(latFile, text);
    const modelBefore = readFileSync(join(sessionDir, 'model.json'), 'utf8');
    const r: any = await apply(['--dry-run']);
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(readFileSync(join(sessionDir, 'model.json'), 'utf8')).toBe(modelBefore);
  });
});
```

NOTE: the two `.replace(...)` targets assume the PRE-migration snake_case names emitted from the
current session (`past_due`, `accruedUnits`). Task 12 (migration) renames these; its final step
updates the four affected literals in this file to the camelCase names (`pastDue`, keeps
`accruedUnits`→`usedUnits` test with the then-current name). That update is listed in Task 12
Step 6 — do not improvise it here.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli-apply.test.ts`
Expected: FAIL — `unknown-command apply` (all cases).

- [ ] **Step 3: Implement in `cli.ts`**

Add imports:

```ts
import { loadLatText } from './parse/fromLangium.js';
import { reconcile } from './engine/reconcile.js';
import type { RenameSpec, RenameScope } from './engine/renames.js';
import { dirname } from 'node:path';
```

In `parseArgs` options add:

```ts
      lat: { type: 'string' }, 'dry-run': { type: 'boolean' },
      rename: { type: 'string', multiple: true }, 'force-remove': { type: 'string', multiple: true },
      name: { type: 'string' },
```

Add to the arg-validation switch:

```ts
      case 'apply': if (!values.lat) return { error: 'missing-arg', arg: 'lat' }; break;
```

`apply` is not in `MODEL_COMMANDS` (it creates the model on fresh sessions). Add the case to the main
switch (before `default`). The rename-flag parser must reject malformed input, and scope inference
derives from the path shape against the PARSED model (2 segments + enum head → enumValue; 3 → state
or region member; single → top-level; otherwise field/transition/invariant looked up by the stored
model — implement `inferRenameSpec` as shown):

```ts
      case 'apply': {
        const latPath = values.lat!;
        let text: string;
        try { text = readFileSync(latPath, 'utf8'); }
        catch (err) { return { error: 'unreadable-lat', message: String(err) }; }
        const loaded = loadLatText(text);
        if (!loaded.ok) return { error: 'parse-failed', diagnostics: loaded.diagnostics };

        const sessionExists = existsSync(join(dir, 'state.json'));
        if (sessionExists && (s.phase !== 'converged' || Object.keys(s.pendingWitnesses).length > 0) && s.model)
          return { error: 'session-busy', phase: s.phase, pendingWitnesses: Object.keys(s.pendingWitnesses),
            hint: 'finish or abandon the elicitation session before applying hand edits' };

        const storedModel: DomainModel | null = sessionExists
          ? (s.model ?? JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')))
          : null;
        const storedExplicit = sessionExists
          ? s.candidates.filter(c => c.status === 'adopted').map(c => c.inv) : [];

        const renames: RenameSpec[] = [];
        for (const rv of values.rename ?? []) {
          const m2 = rv.match(/^([A-Za-z_][\w.]*)=([A-Za-z_]\w*)$/);
          if (!m2) return { error: 'bad-rename-flag', flag: rv, hint: 'use --rename Owner.oldName=newName' };
          const spec = inferRenameSpec(m2[1]!, m2[2]!, storedModel ?? loaded.model);
          if (!spec) return { error: 'unknown-rename-path', flag: rv };
          renames.push(spec);
        }

        const at = now();
        const outcomeBase = { warnings: loaded.warnings.map(w => `${w.code}: ${w.message}`) };
        if (!storedModel) {
          // hand-authored new spec (spec §5.8): everything adopts, no verdicts to contradict
          if (values['dry-run']) return { ok: true, dryRun: true, applied: ['fresh session'], ...outcomeBase };
          s.model = loaded.model;
          s.phase = 'converged';
          s.candidates = loaded.invariants.map(inv => ({ inv, status: 'adopted' as const }));
          for (const inv of loaded.invariants)
            appendLedger(dir, { kind: 'adopted', at, invariant: inv, provenance: `hand-authored ${at.slice(0, 10)}` });
          writeFileSync(join(dir, 'model.json'), JSON.stringify(loaded.model, null, 2));
          const written = writeProjections(latPath, loaded.model, loaded.invariants, readLedger(dir));
          return done({ ok: true, applied: ['fresh session', ...loaded.invariants.map(i => `invariant ${i.name}`)], written, ...outcomeBase });
        }

        const r = reconcile({ parsed: { model: loaded.model, invariants: loaded.invariants },
          storedModel, storedExplicit, ledger: readLedger(dir),
          confirmedRenames: renames, forceRemove: values['force-remove'] ?? [], at });
        const warnings = [...outcomeBase.warnings, ...r.warnings];
        if (!r.ok) return { error: 'refused', refusals: r.refusals, warnings };
        if (values['dry-run']) return { ok: true, dryRun: true, applied: r.applied, warnings };

        s.model = r.model;
        s.candidates = [
          ...s.candidates.filter(c => c.status !== 'adopted'),
          ...r.adopted.map(inv => ({ inv, status: 'adopted' as const }))];
        for (const e of r.ledgerAppends) appendLedger(dir, e);
        writeFileSync(join(dir, 'model.json'), JSON.stringify(r.model, null, 2));
        const written = writeProjections(latPath, r.model, r.adopted, readLedger(dir));
        return done({ ok: true, applied: r.applied, written, warnings });
      }
```

Add the two helpers near the top of cli.ts (module scope):

```ts
function writeProjections(latPath: string, model: DomainModel, adopted: CandidateInvariant[],
    ledger: LedgerEntry[]): string[] {
  const outDir = dirname(latPath);
  const derived = impliedInvariants(model).filter(d => !adopted.some(a => JSON.stringify(a.candidate) === JSON.stringify(d.candidate)));
  const lat = join(outDir, 'spec.lat'), prose = join(outDir, 'spec.prose.md');
  writeFileSync(lat, astToCode(model, adopted));
  writeFileSync(prose, astToProse(model, [...adopted, ...derived], ledger));
  return [lat, prose];
}

function inferRenameSpec(path: string, to: string, m: DomainModel): RenameSpec | null {
  const segs = path.split('.');
  const from = segs[segs.length - 1]!;
  const scope = ((): RenameScope | null => {
    if (segs.length === 1) {
      if (m.aggregates.some(a => a.name === from)) return 'aggregate';
      if (m.entities.some(e => e.name === from)) return 'entity';
      if (m.enums.some(e => e.name === from)) return 'enum';
      if (m.events.some(e => e.name === from)) return 'event';
      return 'invariant';   // bare name defaults to invariant rename
    }
    const owner = m.aggregates.find(a => a.name === segs[0]) ?? m.entities.find(e => e.name === segs[0]);
    if (segs.length === 2) {
      if (m.enums.some(e => e.name === segs[0] && e.values.includes(from))) return 'enumValue';
      if (!owner) return null;
      if (owner.fields.some(f => f.name === from)) return 'field';
      const mach = owner.kind === 'aggregate' ? owner.machine : undefined;
      if (mach?.regions.some(r => r.name === from)) return 'region';
      if (mach?.transitions.some(t => t.name === from)) return 'transition';
      return null;
    }
    if (segs.length === 3 && owner?.kind === 'aggregate'
        && owner.machine?.regions.some(r => r.name === segs[1] && r.states.some(st => st.name === from))) return 'state';
    return null;
  })();
  return scope ? { scope, path, from, to } : null;
}
```

CRITICAL wiring detail: `inferRenameSpec` resolves against the STORED model (old names) — the path
in `--rename Subscription.accruedUnits=usedUnits` uses pre-rename names, matching `RenameSpec.path`
semantics from Task 2. Both `writeProjections` call sites read the ledger AFTER the appends, so
prose provenance includes this apply's own adoption entries. `LedgerEntry` is already imported as
a type in cli.ts via session.js — extend that import if the type-only import complains.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli-apply.test.ts`
Expected: PASS (8). The w5-contradiction test exercises the full pipeline against the REAL
45-entry ledger — if it fails, debug with `--dry-run` output before touching reconcile.

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/cli.ts test/cli-apply.test.ts
git commit -m "feat(lattice): engine apply — atomic hand-edit reconciliation via CLI"
```

---

### Task 10: CLI `explain`

**Files:**
- Modify: `lattice/src/cli.ts`
- Test: `lattice/test/cli-explain.test.ts`

**Interfaces:**
- Consumes: `readLedger`, `currentInvariantName`/`renameEntries` (Task 2), `impliedInvariants` (Task 3), `renderCandidateEnglish` (existing prose.ts).
- Produces: `engine explain --session <dir> --name <invariantName>` → JSON
  `{ name, english, provenance, witnesses: [{ id, judge, at, salient }], renames: [{ from, to, at }], implied?: string }`
  or `{ error: 'unknown-invariant', name }`. Resolves the name through rename history in BOTH
  directions (query by old or current name).

- [ ] **Step 1: Write the failing test**

Create `lattice/test/cli-explain.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';

const SESSION = join(import.meta.dirname, '../../.lattice-session-subscriptions');

describe('engine explain', () => {
  it('explains an elicited invariant with witnesses and provenance', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'One_Draft_Invoice_Per_Subscription'], realDeps);
    // post-migration (Task 12) the current name is oneDraftInvoicePerSubscription; explain resolves
    // old names through rename history, so this query works in both eras.
    expect(r.error).toBeUndefined();
    expect(r.provenance).toContain('elicited');
    expect(r.witnesses.map((w: any) => w.id)).toContain('w5');
    expect(r.witnesses.find((w: any) => w.id === 'w5').judge).toBe('forbid');
    expect(r.english.toLowerCase()).toContain('one');
  });

  it('explains implied invariants by their deriving structure', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'terminalInvoiceSettlementVoid'], realDeps);
    expect(r.implied).toContain('@terminal');
  });

  it('unknown name errors cleanly', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'nope'], realDeps);
    expect(r.error).toBe('unknown-invariant');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli-explain.test.ts`
Expected: FAIL — unknown-command.

- [ ] **Step 3: Implement in cli.ts**

Arg validation: `case 'explain': if (!values.name) return { error: 'missing-arg', arg: 'name' }; break;`
Add `explain` to `MODEL_COMMANDS`. Main switch case:

```ts
      case 'explain': {
        const ledger = readLedger(dir);
        const renames = renameEntries(ledger).filter(r => r.scope === 'invariant');
        const current = currentInvariantName(values.name!, renames);
        const chain = renames.filter(r => currentInvariantName(r.from, renames) === current);
        const adoptions = ledger.filter(e => e.kind === 'adopted'
          && currentInvariantName((e as any).invariant.name, renames) === current) as any[];
        const derived = impliedInvariants(model()).find(d => d.name === current);
        if (!adoptions.length && !derived) return { error: 'unknown-invariant', name: values.name };
        const latest = adoptions[adoptions.length - 1];
        const inv = latest?.invariant ?? derived!;
        const witnessIds = new Set((latest?.provenance.match(/w\d+/g) ?? []));
        const witnesses = ledger.filter(e => e.kind === 'verdict' && witnessIds.has((e as any).witnessId))
          .map(e => ({ id: (e as any).witnessId, judge: (e as any).judge, at: (e as any).at, salient: (e as any).salient }));
        const out: any = { name: current, english: renderCandidateEnglish(inv.candidate),
          provenance: latest?.provenance ?? 'implied by structure', witnesses,
          renames: chain.map(r => ({ from: r.from, to: r.to })) };
        if (derived) {
          // set whenever the rule is CURRENTLY implied — historical adoption entries may coexist
          // (post-migration the 13 template adoptions remain in the ledger under old names)
          const c = derived.candidate;
          out.implied = c.kind === 'terminal' ? `implied by @terminal on ${c.aggregate}.${c.region}.${c.state}`
            : c.kind === 'refsResolve' ? `implied by ref fields on ${c.aggregate}`
            : `implied by Money field on ${c.aggregate}`;
        }
        return out;
      }
```

Add imports: `renameEntries`, `currentInvariantName` from `./engine/renames.js`;
`renderCandidateEnglish` from `./emit/prose.js` (extend the existing prose import).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli-explain.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/cli.ts test/cli-explain.test.ts
git commit -m "feat(lattice): engine explain — invariant lineage from the ledger"
```

---

### Task 11: CLI `sync` (watcher)

**Files:**
- Create: `lattice/src/engine/sync.ts`
- Modify: `lattice/src/cli.ts` (thin `sync` command)
- Test: `lattice/test/engine/sync.test.ts`

**Interfaces:**
- Consumes: `runCommand` shape — sync calls the same apply routine.
- Produces: `startSync(opts: { lat: string; session: string; onOutcome: (o: object) => void; deps: SolverDeps }): { close(): Promise<void> }` — chokidar watcher, `awaitWriteFinish` 200 ms, keeps watching through failures; refusals needing flags are reported via `onOutcome` with the exact `apply --rename …` command line in a `hint`. CLI: `engine sync --session <dir> --lat <file>` runs until SIGINT, printing each outcome as JSON lines.

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSync } from '../../src/engine/sync.js';
import { runCommand, realDeps } from '../../src/cli.js';

const SESSION_SRC = join(import.meta.dirname, '../../../.lattice-session-subscriptions');

describe('engine sync', () => {
  it('applies on change, reports refusals with a hint, survives parse errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-sync-'));
    const sessionDir = join(dir, 'session'); const specDir = join(dir, 'spec');
    cpSync(SESSION_SRC, sessionDir, { recursive: true });
    mkdirSync(specDir);
    await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
    const lat = join(specDir, 'spec.lat');

    const outcomes: any[] = [];
    const seen = (n: number) => new Promise<void>((res, rej) => {
      const t = setInterval(() => { if (outcomes.length >= n) { clearInterval(t); res(); } }, 50);
      setTimeout(() => { clearInterval(t); rej(new Error(`timeout waiting for outcome ${n}: ${JSON.stringify(outcomes)}`)); }, 15000);
    });
    const watcher = startSync({ lat, session: sessionDir, onOutcome: o => outcomes.push(o), deps: realDeps });
    try {
      // 1: broken edit → parse-failed outcome, watcher stays alive
      writeFileSync(lat, readFileSync(lat, 'utf8') + '\n// bad\n');
      await seen(1);
      expect(outcomes[0].error).toBe('parse-failed');
      // 2: valid no-op rewrite → applies
      await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
      await seen(2);
      expect(outcomes[1].ok).toBe(true);
    } finally { await watcher.close(); }
  }, 30000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lattice/src/engine/sync.ts`:

```ts
import { watch } from 'chokidar';
import type { SolverDeps } from './planner.js';

export interface SyncHandle { close(): Promise<void> }

/** Thin watcher over the identical apply routine (spec §5). Never confirms renames itself —
 *  a watcher cannot pass flags; it prints the exact command instead. */
export function startSync(opts: { lat: string; session: string; onOutcome: (o: object) => void;
  deps: SolverDeps }): SyncHandle {
  let running = false, queued = false;
  const runApply = async () => {
    if (running) { queued = true; return; }
    running = true;
    try {
      const { runCommand } = await import('../cli.js');   // lazy: avoids a cli↔sync import cycle
      const out: any = await runCommand(['apply', '--session', opts.session, '--lat', opts.lat], opts.deps);
      if (out.error === 'refused' && out.refusals?.some((r: any) => r.code === 'needs-rename-confirmation')) {
        const flags = out.refusals.filter((r: any) => r.rename)
          .map((r: any) => `--rename ${r.rename.path}=${r.rename.to}`).join(' ');
        out.hint = `run once: engine apply --session ${opts.session} --lat ${opts.lat} ${flags}`;
      }
      opts.onOutcome(out);
    } catch (err) {
      opts.onOutcome({ error: 'internal', message: String(err) });
    } finally {
      running = false;
      if (queued) { queued = false; void runApply(); }
    }
  };
  const watcher = watch(opts.lat, { ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
  watcher.on('change', () => void runApply());
  watcher.on('add', () => void runApply());
  return { close: () => watcher.close() };
}
```

In `cli.ts`, arg validation `case 'sync': if (!values.lat) return { error: 'missing-arg', arg: 'lat' }; break;`
and main-switch case (sync never returns — special-case it BEFORE `loadState`, right after arg validation):

```ts
    if (cmd === 'sync') {
      const { startSync } = await import('./engine/sync.js');
      startSync({ lat: values.lat!, session: dir, deps,
        onOutcome: o => console.log(JSON.stringify(o)) });
      await new Promise(() => {});   // run until SIGINT
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/engine/sync.test.ts`
Expected: PASS (1, ~2-5 s). If flaky on CI-style machines, raise `stabilityThreshold` to 300 —
do not delete the parse-error phase of the test.

- [ ] **Step 5: Full gate + commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/engine/sync.ts src/cli.ts test/engine/sync.test.ts
git commit -m "feat(lattice): engine sync — file watcher over apply"
```

---
### Task 12: Migration of the committed subscriptions spec + definition-of-done test

**Files:**
- Modify: `specs/subscriptions/spec.lat`, `specs/subscriptions/spec.prose.md` (regenerated)
- Modify: `.lattice-session-subscriptions/{ledger.jsonl,model.json,state.json}` (append-only ledger; model/state updated by apply)
- Modify: `lattice/test/cli-apply.test.ts` (post-migration name literals, per Task 9's note)
- Test: `lattice/test/dod.test.ts` (definition-of-done integration)

This task runs REAL CLI invocations against the REAL committed session (from the repo root,
inside the worktree). It is the slice's dogfood: the camelCase migration goes through apply's
rename machinery, appending rename entries — never editing existing ledger lines (verify in the
diff).

- [ ] **Step 1: Produce the new-syntax file and inspect the rename proposals**

```bash
cd lattice
npx tsx src/cli.ts emit --session ../.lattice-session-subscriptions --out ../specs/subscriptions
```

This rewrites `specs/subscriptions/spec.lat` in the new syntax with OLD names (and drops the 13
implied invariant blocks). Now hand-edit `specs/subscriptions/spec.lat` applying the camelCase
renames (spec P8):
states `past_due→pastDue`; enum value `all_units→allUnits`; transitions `expire_trial→expireTrial`,
`payment_failed→paymentFailed`, `cancel_from_trial→cancelFromTrial`, `cancel_from_active→cancelFromActive`,
`cancel_from_past_due→cancelFromPastDue`, `dunning_exhausted→dunningExhausted`; invariant names
`Positive_Period_NonNegative_Usage→positivePeriodNonNegativeUsage`, `TotalDue_At_Most_Parts→totalDueAtMostParts`,
`Never_Overpaid_And_Paid_Exact→neverOverpaidAndPaidExact`, `One_Draft_Invoice_Per_Subscription→oneDraftInvoicePerSubscription`,
`Overage_Implies_Real_Allowance→overageImpliesRealAllowance`.
Then seed the `///` docs (spec P12) above each of the five invariant blocks with the English from
the design spec §3.1 reference example (e.g. `/// At most one draft invoice exists per subscription at any time.`).

```bash
npx tsx src/cli.ts apply --session ../.lattice-session-subscriptions --lat ../specs/subscriptions/spec.lat --dry-run
```

Expected: `error: refused` listing `needs-rename-confirmation` for every ledger-referenced rename.
Reality check against the actual witnesses: the five witnesses never mention `past_due` or
`all_units` as VALUES, so the state/enum renames may apply silently; what WILL be demanded are the
five elicited invariant renames (referenced by their adopted entries). The 13 old template
invariants do NOT surface as renames at all — `canonicalSet` (Task 8) already presents them under
derived names on both sides, so they simply stop being printed. Collect the exact `--rename`
flags from the refusal messages — do not guess the list, read it. Passing extra flags for the
silent renames (states, enum values) is encouraged anyway: each appends a rename ledger entry,
keeping the history queryable.

- [ ] **Step 2: Apply with confirmations**

Run apply with every flag the dry-run demanded, e.g. (adjust to the actual refusal list):

```bash
npx tsx src/cli.ts apply --session ../.lattice-session-subscriptions --lat ../specs/subscriptions/spec.lat \
  --rename Subscription.lifecycle.past_due=pastDue \
  --rename UsagePricing.all_units=allUnits \
  --rename Positive_Period_NonNegative_Usage=positivePeriodNonNegativeUsage \
  --rename TotalDue_At_Most_Parts=totalDueAtMostParts \
  --rename Never_Overpaid_And_Paid_Exact=neverOverpaidAndPaidExact \
  --rename One_Draft_Invoice_Per_Subscription=oneDraftInvoicePerSubscription \
  --rename Overage_Implies_Real_Allowance=overageImpliesRealAllowance
```

Expected: `ok: true`; `specs/subscriptions/spec.lat` re-normalized (byte-stable on a second
apply), `spec.prose.md` regenerated with provenance lineage intact, ledger grown by rename +
adopted entries ONLY (verify: `git diff ../.lattice-session-subscriptions/ledger.jsonl` shows
appended lines exclusively). The 13 old template invariants: their explicit blocks are gone from
`.lat` but the canonical set still contains them as implied — the diff pairs them by identical
candidate into invariant renames (e.g. `Terminal_Invoice_void→terminalInvoiceSettlementVoid`);
confirm those with `--rename` flags too if the dry-run demands them.

- [ ] **Step 3: Update the two spec.lat-era literals in cli-apply tests**

In `lattice/test/cli-apply.test.ts` replace `past_due` with `pastDue` in the two transition-adding
`.replace()` literals (the emitted file now uses camelCase). The `accruedUnits` rename test keeps
working — that field was never renamed.

- [ ] **Step 4: Write the definition-of-done integration test**

Create `lattice/test/dod.test.ts` — the brief's one-sentence definition of done, as one test:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, realDeps } from '../src/cli.js';
import { loadLatText } from '../src/parse/fromLangium.js';

const SESSION_SRC = join(import.meta.dirname, '../../.lattice-session-subscriptions');
const SPEC_SRC = join(import.meta.dirname, '../../specs/subscriptions');

describe('definition of done (brief): rename + new transition + contradicting invariant edit', () => {
  it('applies the first two with provenance, rejects the third naming witness+verdict, re-renders projections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-dod-'));
    const sessionDir = join(dir, 'session'); const specDir = join(dir, 'spec');
    cpSync(SESSION_SRC, sessionDir, { recursive: true });
    cpSync(SPEC_SRC, specDir, { recursive: true });
    const lat = join(specDir, 'spec.lat');
    const original = readFileSync(lat, 'utf8');

    // Edit 1 (rename): accruedUnits → usedUnits (ledger-referenced field)
    // Edit 2 (new transition): pastDue → expired grace exhaustion
    // Edit 3 (invariant change contradicting w5): unique by (invoiceId) instead of by (subscription)
    const edited = original
      .replaceAll('accruedUnits', 'usedUnits')
      .replace('transition recover { region lifecycle; from pastDue to active }',
        'transition recover { region lifecycle; from pastDue to active }\n      transition graceToExpired { region lifecycle; from pastDue to expired }')
      .replace('unique while settlement in {draft} by (subscription)',
        'unique while settlement in {draft} by (invoiceId)');
    writeFileSync(lat, edited);

    // The contradicting edit must be rejected — atomically: nothing applies
    const r1: any = await runCommand(['apply', '--session', sessionDir, '--lat', lat,
      '--rename', 'Subscription.accruedUnits=usedUnits'], realDeps);
    expect(r1.error).toBe('refused');
    const contradiction = r1.refusals.find((x: any) => x.code === 'contradicts-verdict');
    expect(contradiction.witnessId).toBe('w5');
    expect(contradiction.verdict).toBe('forbid');
    expect(contradiction.judgedAt).toContain('2026-07-05');
    expect(contradiction.message).toContain('re-judge with the domain expert or revert');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8'))
      .toBe(readFileSync(join(SESSION_SRC, 'ledger.jsonl'), 'utf8'));   // atomic: no appends

    // Revert edit 3; the rename + transition now apply with provenance
    writeFileSync(lat, edited.replace('by (invoiceId)', 'by (subscription)'));
    const r2: any = await runCommand(['apply', '--session', sessionDir, '--lat', lat,
      '--rename', 'Subscription.accruedUnits=usedUnits'], realDeps);
    expect(r2.ok).toBe(true);
    expect(r2.applied.join(' ')).toContain('graceToExpired');
    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"rename"');
    expect(ledger).toContain('usedUnits');

    // every projection re-renders from the updated canonical store
    const normalized = readFileSync(lat, 'utf8');
    expect(normalized).toContain('usedUnits');
    expect(normalized).toContain('graceToExpired');
    expect(readFileSync(join(specDir, 'spec.prose.md'), 'utf8')).toContain('graceToExpired');

    // round-trip identity holds on the result
    const reparsed = loadLatText(normalized);
    expect(reparsed.ok).toBe(true);

    // and the ledger history remains queryable across the rename
    const ex: any = await runCommand(['explain', '--session', sessionDir, '--name', 'positivePeriodNonNegativeUsage'], realDeps);
    expect(ex.witnesses.length).toBeGreaterThan(0);
  }, 60000);
});
```

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run test/dod.test.ts test/cli-apply.test.ts`
Expected: PASS. The `positivePeriodNonNegativeUsage` explain assertion assumes Step 2's invariant
renames landed — if explain misses, check the rename entries exist in the ledger.

- [ ] **Step 6: Full gate + commit (spec files + code + tests together)**

```bash
npx tsc --noEmit && npx vitest run
cd ..
git add specs/subscriptions/spec.lat specs/subscriptions/spec.prose.md \
  .lattice-session-subscriptions/ledger.jsonl .lattice-session-subscriptions/model.json \
  .lattice-session-subscriptions/state.json \
  lattice/test/dod.test.ts lattice/test/cli-apply.test.ts
git commit -m "feat(lattice): migrate subscriptions spec to hand-editable .lat via apply (dogfood)"
```

Before committing, eyeball `git diff --stat` and confirm: ledger diff is append-only; spec.lat is
the 5-invariant camelCase form; NO other session files were touched.

---

### Task 13: Final verification sweep

**Files:**
- Modify (only if gaps found): whatever the sweep uncovers.

- [ ] **Step 1: Fresh-worktree bootstrap check**

From the repo root:

```bash
rm -rf lattice/src/parse/generated
bash lattice/scripts/ensure-ready.sh
cd lattice && npx tsc --noEmit
```

Expected: generation re-runs, typecheck clean — a fresh worktree can build without committed
generated code.

- [ ] **Step 2: Full suite, twice**

```bash
npx vitest run && npx vitest run
```

Expected: green both times (catches order-dependence and watcher flake). Confirm golden traces
A/B/C ran (search output for `golden`) and were not skipped.

- [ ] **Step 3: Spec-coverage audit against the design doc**

Walk `docs/superpowers/specs/2026-07-05-lattice-slice-3-lat-parser-design.md` §§3–8 and check each
requirement has a shipped artifact: P1–P12 decisions, grammar table forms, `apply` steps 1–8,
`sync`, `explain`, round-trip property, migration. Fix any gap as a follow-up commit in this task.

- [ ] **Step 4: Commit any fixes; final commit message**

```bash
git add <specific files>
git commit -m "chore(lattice): slice-3 verification sweep fixes"
```

---

## Task-order dependencies

1 → (2, 3 independent) → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13.
Tasks 2 and 3 can run in either order after 1 (both only need existing types); everything else is
strictly sequential.





