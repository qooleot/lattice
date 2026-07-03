# Lattice Slice #1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Lattice elicitation slice end-to-end: a deterministic TypeScript engine (closed invariant grammar, version space, question planner, two solver adapters, ledger, projections) driven by a Claude Code skill, gated by a 20-rule autoformalization fidelity experiment, validated by three golden traces.

**Architecture:** Claude Code is the NL Translator; everything rigorous is a deterministic TS engine invoked as a session-backed CLI. Candidates live in a closed grammar (spec §6.1) routed by shape to Alloy 6 (structural, via a thin Java shim) or Quint/Apalache (temporal/arithmetic, `verify --invariant="iff(Hi,Hj)"` — a counterexample to the *agreement* is the distinguishing witness). The verdict ledger (JSONL) is the canonical artifact.

**Tech Stack:** TypeScript (strict) / Node ≥ 20, vitest, tsx, fast-xml-parser, `@informalsystems/quint`, Alloy 6.2 jar + JDK 21 (Temurin), Apalache (auto-fetched by quint).

**Spec:** `docs/superpowers/specs/2026-07-03-lattice-elicitation-slice-1-design.md` — section numbers below (§) refer to it.

## Global Constraints

- **The fidelity gate (Task 4) blocks Tasks 5–20.** Do not start adapter/engine work until the gate is read against thresholds: < ~10% subtle-wrong → proceed; 10–30% → stop, flag example-set-as-spec pivot; > 30% → stop entirely (§2.0).
- Latency budget (pre-registered, §2.4): witness generation p50 ≤ 10s, worst ≤ 45s. Golden tests assert it.
- Regeneration cap: **3** attempts, then park as open decision. Alternatives phase: **2** attempts. Boundary probes: at most **1 forbid-side + 1 permit-side** per sole a-priori survivor; regenerated/alternative candidates get **no probes** (they converge via the alternatives phase).
- The candidate grammar (§6.1) is **closed**: `engine propose`/`regenerate` reject anything outside it with a structured error. Growing it is out of scope.
- The ledger is canonical (§3.1): candidates are validated against every prior verdict via the pure-TS evaluator, never trusted from the LLM.
- Prose is output-only. No `.lat` parser (D6). No MCP wrapper. No Reachability-Bridge (routing only; a pair routes to Quint if *either* candidate needs Quint).
- Machine host check: this machine has Java 8. Alloy 6.2 and Apalache need **JDK 17+** — Task 5 installs Temurin 21 and every solver invocation uses its explicit `JAVA_HOME`.
- Runtime deps limited to: `fast-xml-parser`, `@informalsystems/quint`. Dev deps: `typescript`, `tsx`, `vitest`, `@types/node`.
- All code lives under `lattice/`; the skill under `.claude/skills/elicit-spec/`. Conventional commits (`feat:`/`test:`/`chore:`/`docs:`).

## File Structure

```
lattice/
  package.json  tsconfig.json  vitest.config.ts
  src/
    ast/domain.ts        — domain AST types (Task 2)
    ast/validate.ts      — validateModel (Task 2)
    ast/invariant.ts     — closed candidate grammar types (Task 1)
    ast/grammar.ts       — validateCandidate + routeCandidate (Task 1)
    engine/evaluate.ts   — CaseState + evaluateCandidate (Task 3)
    engine/salient.ts    — salient facts, witness table, shape exclusions (Task 7)
    engine/session.ts    — session store: state.json + ledger.jsonl (Task 6)
    engine/templates.ts  — 8-template matcher (Task 12)
    engine/hypothesis.ts — version space: prune / admit / phases (Task 13)
    engine/planner.ts    — question policy (Task 14)
    emit/alloy.ts        — astToAlloy (Task 8)
    emit/quint.ts        — astToQuint (Task 10)
    emit/prose.ts        — astToProse (Task 15)
    emit/code.ts         — astToCode .lat pretty-printer (Task 15)
    solvers/doctor.ts    — toolchain check (Task 5)
    solvers/alloy-adapter.ts  — shim runner + XML parse (Task 9)
    solvers/quint-adapter.ts  — quint verify + ITF parse (Task 11)
    cli.ts               — engine CLI (Task 16)
  vendor/AlloyRunner.java     — enumeration shim (Task 9)
  scripts/fetch-solvers.sh    — Alloy jar + JDK guidance (Task 5)
  fidelity/rules.json  fidelity/harness.ts  fidelity/tally.ts  fidelity/PROTOCOL.md  (Task 4)
  fixtures/domains/{trace-a,trace-b,revrec}.json   (Tasks 17–19)
  golden/trace-a.test.ts  golden/trace-b.test.ts  golden/trace-c.test.ts
  golden/trace-c-interactive.md  golden/parseback/PROTOCOL.md
  test/…                 — unit tests mirroring src/
.claude/skills/elicit-spec/SKILL.md   (Task 20)
```

---

### Task 1: Project scaffold + the closed candidate-invariant grammar

**Files:**
- Create: `lattice/package.json`, `lattice/tsconfig.json`, `lattice/vitest.config.ts`
- Create: `lattice/src/ast/invariant.ts`, `lattice/src/ast/grammar.ts`
- Test: `lattice/test/ast/grammar.test.ts`

**Interfaces:**
- Consumes: nothing (first task). `DomainModel` from Task 2 is forward-declared as an import; Task 1's validation functions take it as a parameter but Task 1's tests use a minimal inline stub typed `any` until Task 2 lands (acceptable: `validateCandidate` only reads `aggregates/entities/enums` arrays).
- Produces: types `Path`, `Cmp`, `Term`, `Predicate`, `Candidate`, `CandidateInvariant`, `Engine`, `Diagnostic`; functions `validateCandidate(c: Candidate, m: DomainModel): Diagnostic[]`, `routeCandidate(c: Candidate): Engine`. Every later task imports these names verbatim.

- [ ] **Step 1: Scaffold the package**

```bash
mkdir -p lattice/src/ast lattice/test/ast && cd lattice
```

`lattice/package.json`:
```json
{
  "name": "@lattice/engine",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "engine": "tsx src/cli.ts",
    "fidelity": "tsx fidelity/harness.ts",
    "tally": "tsx fidelity/tally.ts"
  },
  "dependencies": {
    "@informalsystems/quint": "^0.26.0",
    "fast-xml-parser": "^4.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`lattice/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "outDir": "dist", "rootDir": "."
  },
  "include": ["src", "test", "fidelity", "golden"]
}
```

`lattice/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts', 'golden/**/*.test.ts'], testTimeout: 120_000 } });
```

Run: `cd lattice && npm install` — expect clean install.

- [ ] **Step 2: Write the failing test**

`lattice/test/ast/grammar.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateCandidate, routeCandidate } from '../../src/ast/grammar.js';
import type { Candidate } from '../../src/ast/invariant.js';

// Minimal model stub — real DomainModel arrives in Task 2; grammar.ts only reads these arrays.
const model: any = {
  context: 'Billing',
  enums: [{ name: 'Status', values: ['Paid', 'Unpaid'] }],
  entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'grace', type: { kind: 'prim', prim: 'Duration' } },
      { name: 'dueDate', type: { kind: 'prim', prim: 'Date' } },
      { name: 'status', type: { kind: 'enum', enum: 'Status' } }
    ],
    machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [{ name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] }
  }],
  events: []
};

const uniqueCand: Candidate = {
  kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']]
};

const graceCand: Candidate = {
  kind: 'statePredicate', aggregate: 'Subscription',
  body: {
    kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['status'] }, right: { kind: 'enumval', enum: 'Status', value: 'Unpaid' } }
    ]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' }, right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } }
  }
};

describe('validateCandidate', () => {
  it('accepts a well-formed unique candidate', () => {
    expect(validateCandidate(uniqueCand, model)).toEqual([]);
  });
  it('rejects unknown aggregate', () => {
    const bad = { ...uniqueCand, aggregate: 'Nope' };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-aggregate');
  });
  it('rejects unknown field path', () => {
    const bad: Candidate = { ...uniqueCand, by: [['nonexistent']] };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-path');
  });
  it('rejects unknown state in whileStates', () => {
    const bad: Candidate = { ...uniqueCand, whileStates: { region: 'Access', states: ['Zombie'] } };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-state');
  });
  it('rejects unknown enum value', () => {
    const bad: Candidate = JSON.parse(JSON.stringify(graceCand));
    (bad as any).body.left.args[1].right.value = 'Bogus';
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-enum-value');
  });
});

describe('routeCandidate', () => {
  it('routes structural forms to alloy', () => {
    expect(routeCandidate(uniqueCand)).toBe('alloy');
    expect(routeCandidate({ kind: 'refsResolve', aggregate: 'Subscription' })).toBe('alloy');
    expect(routeCandidate({ kind: 'cardinality', aggregate: 'Subscription', where: null, atMost: 1 })).toBe('alloy');
  });
  it('routes temporal/arithmetic forms to quint', () => {
    expect(routeCandidate(graceCand)).toBe('quint');
    expect(routeCandidate({ kind: 'terminal', aggregate: 'Subscription', region: 'Access', state: 'Ended' })).toBe('quint');
    expect(routeCandidate({ kind: 'monotonic', aggregate: 'Subscription', field: ['recognized'] })).toBe('quint');
    expect(routeCandidate({ kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] })).toBe('quint');
  });
  it('routes an arithmetic-free statePredicate to alloy', () => {
    const rel: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active', 'Trialing', 'Ended'] } };
    expect(routeCandidate(rel)).toBe('alloy');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/ast/grammar.test.ts`
Expected: FAIL — cannot resolve `src/ast/grammar.js`.

- [ ] **Step 4: Implement the grammar types**

`lattice/src/ast/invariant.ts`:
```ts
// The CLOSED candidate-invariant grammar (spec §6.1). Growing it is a versioned act, not implicit.
export type Engine = 'alloy' | 'quint';
export type Path = string[];
export type Cmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type Term =
  | { kind: 'field'; owner: string; path: Path }   // owner: 'self' (quantified subject) or an aggregate name
  | { kind: 'int'; value: number }
  | { kind: 'enumval'; enum: string; value: string }
  | { kind: 'now' }                                // current tick (Date/Duration are ticks)
  | { kind: 'plus'; left: Term; right: Term };     // linear arithmetic only

export type Predicate =
  | { kind: 'cmp'; op: Cmp; left: Term; right: Term }
  | { kind: 'inState'; owner: string; region: string; states: string[] }
  | { kind: 'and'; args: Predicate[] }
  | { kind: 'or'; args: Predicate[] }
  | { kind: 'not'; arg: Predicate }
  | { kind: 'implies'; left: Predicate; right: Predicate };

export type Candidate =
  | { kind: 'statePredicate'; aggregate: string; where?: Predicate; body: Predicate }
  | { kind: 'unique'; aggregate: string; whileStates: { region: string; states: string[] }; by: Path[] }
  | { kind: 'refsResolve'; aggregate: string }
  | { kind: 'cardinality'; aggregate: string; where: Predicate | null; atMost: number }
  | { kind: 'terminal'; aggregate: string; region: string; state: string }
  | { kind: 'monotonic'; aggregate: string; field: Path }
  | { kind: 'conservation'; aggregate: string; parts: Path[]; total: Path }
  | { kind: 'leadsTo'; aggregate: string; from: Predicate; to: Predicate; fairness: string }; // template-instantiated ONLY

export interface CandidateInvariant {
  id: string;
  name: string;
  prior: number;                                    // LLM plausibility weight, 0..1
  source: 'seed' | 'template' | 'regen' | 'alternative';
  candidate: Candidate;
}

export interface Diagnostic { code: string; message: string; at?: string }
```

`lattice/src/ast/grammar.ts`:
```ts
import type { Candidate, Diagnostic, Engine, Path, Predicate, Term } from './invariant.js';
import type { DomainModel } from './domain.js';

type Owner = { name: string };  // aggregate or entity definition subset we need

function ownerDef(m: DomainModel, name: string): any | undefined {
  return (m.aggregates as any[]).find(a => a.name === name) ?? (m.entities as any[]).find(e => e.name === name);
}

/** Resolve a field path from an owner, following refs across entities/aggregates. Returns the terminal field or null. */
export function resolveFieldPath(m: DomainModel, ownerName: string, path: Path): any | null {
  let def = ownerDef(m, ownerName);
  for (let i = 0; i < path.length; i++) {
    if (!def) return null;
    const f = (def.fields as any[]).find(x => x.name === path[i]);
    if (!f) return null;
    if (i === path.length - 1) return f;
    def = f.type.kind === 'ref' ? ownerDef(m, f.type.target) : undefined;
  }
  return null;
}

export function validateCandidate(c: Candidate, m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const agg = ownerDef(m, c.aggregate);
  if (!agg) return [{ code: 'unknown-aggregate', message: `no aggregate/entity named ${c.aggregate}` }];

  const checkPath = (p: Path, at: string) => {
    if (!resolveFieldPath(m, c.aggregate, p)) out.push({ code: 'unknown-path', message: `path ${p.join('.')} not found on ${c.aggregate}`, at });
  };
  const checkStates = (region: string, states: string[], at: string) => {
    const r = agg.machine?.regions.find((x: any) => x.name === region);
    if (!r) { out.push({ code: 'unknown-region', message: `no region ${region} on ${c.aggregate}`, at }); return; }
    for (const s of states) if (!r.states.some((x: any) => x.name === s))
      out.push({ code: 'unknown-state', message: `no state ${s} in ${c.aggregate}.${region}`, at });
  };
  const checkTerm = (t: Term, at: string) => {
    switch (t.kind) {
      case 'field': checkPath(t.path, at); break;
      case 'enumval': {
        const e = m.enums.find(x => x.name === t.enum);
        if (!e) out.push({ code: 'unknown-enum', message: `no enum ${t.enum}`, at });
        else if (!e.values.includes(t.value)) out.push({ code: 'unknown-enum-value', message: `${t.enum} has no value ${t.value}`, at });
        break;
      }
      case 'plus': checkTerm(t.left, at); checkTerm(t.right, at); break;
      case 'int': case 'now': break;
    }
  };
  const checkPred = (p: Predicate, at: string) => {
    switch (p.kind) {
      case 'cmp': checkTerm(p.left, at); checkTerm(p.right, at); break;
      case 'inState': checkStates(p.region, p.states, at); break;
      case 'and': case 'or': p.args.forEach((a, i) => checkPred(a, `${at}.${p.kind}[${i}]`)); break;
      case 'not': checkPred(p.arg, at); break;
      case 'implies': checkPred(p.left, `${at}.if`); checkPred(p.right, `${at}.then`); break;
    }
  };

  switch (c.kind) {
    case 'statePredicate': if (c.where) checkPred(c.where, 'where'); checkPred(c.body, 'body'); break;
    case 'unique': checkStates(c.whileStates.region, c.whileStates.states, 'whileStates'); c.by.forEach((p, i) => checkPath(p, `by[${i}]`)); break;
    case 'refsResolve': break;
    case 'cardinality': if (c.where) checkPred(c.where, 'where'); if (c.atMost < 0) out.push({ code: 'bad-cardinality', message: 'atMost must be >= 0' }); break;
    case 'terminal': checkStates(c.region, [c.state], 'terminal'); break;
    case 'monotonic': checkPath(c.field, 'field'); break;
    case 'conservation': c.parts.forEach((p, i) => checkPath(p, `parts[${i}]`)); checkPath(c.total, 'total'); break;
    case 'leadsTo': checkPred(c.from, 'from'); checkPred(c.to, 'to'); break;
  }
  return out;
}

function predNeedsArith(p: Predicate): boolean {
  switch (p.kind) {
    case 'cmp': return [p.left, p.right].some(termNeedsArith) || ['lt', 'le', 'gt', 'ge'].includes(p.op);
    case 'inState': return false;
    case 'and': case 'or': return p.args.some(predNeedsArith);
    case 'not': return predNeedsArith(p.arg);
    case 'implies': return predNeedsArith(p.left) || predNeedsArith(p.right);
  }
}
function termNeedsArith(t: Term): boolean {
  return t.kind === 'now' || t.kind === 'plus' || t.kind === 'int';
}

/** Spec §6.1 routing: structural → alloy; temporal/aggregation/arithmetic → quint. */
export function routeCandidate(c: Candidate): Engine {
  switch (c.kind) {
    case 'unique': case 'refsResolve': case 'cardinality': return 'alloy';
    case 'terminal': case 'monotonic': case 'conservation': case 'leadsTo': return 'quint';
    case 'statePredicate': {
      const arith = (c.where ? predNeedsArith(c.where) : false) || predNeedsArith(c.body);
      return arith ? 'quint' : 'alloy';
    }
  }
}
```

Note: `grammar.ts` imports `DomainModel` from `./domain.js` which doesn't exist yet. Create a one-line placeholder now (Task 2 replaces it):

`lattice/src/ast/domain.ts`:
```ts
// Placeholder — Task 2 replaces this file with the full domain AST.
export interface DomainModel { context: string; enums: { name: string; values: string[] }[]; entities: any[]; aggregates: any[]; events: any[]; ticksPerDay?: number }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd lattice && npx vitest run test/ast/grammar.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add lattice/package.json lattice/tsconfig.json lattice/vitest.config.ts lattice/src/ast lattice/test/ast lattice/package-lock.json
git commit -m "feat(lattice): scaffold engine package + closed candidate-invariant grammar (spec §6.1)"
```

---

### Task 2: Domain AST + model well-formedness validation

**Files:**
- Modify: `lattice/src/ast/domain.ts` (replace placeholder)
- Create: `lattice/src/ast/validate.ts`
- Test: `lattice/test/ast/validate.test.ts`

**Interfaces:**
- Consumes: `Diagnostic` from `src/ast/invariant.ts`.
- Produces: types `PrimType`, `TypeRef`, `Field`, `StateDef`, `Region`, `TransitionDef`, `Machine`, `EnumDef`, `EntityDef`, `AggregateDef`, `EventDef`, `DomainModel`; function `validateModel(m: DomainModel): Diagnostic[]`. `DomainModel.ticksPerDay` (default 24) is the time-granularity used for rendering Durations (§2.2 "units rendering").

- [ ] **Step 1: Write the failing test**

`lattice/test/ast/validate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';

const good: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [{ name: 'Status', values: ['Paid', 'Unpaid'] }],
  entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'status', type: { kind: 'enum', enum: 'Status' } }
    ],
    machine: {
      regions: [{ name: 'Access', initial: 'Trialing', states: [{ name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }],
      transitions: [{ name: 'activate', region: 'Access', from: 'Trialing', to: 'Active', when: 'PaymentSucceeded' }]
    }
  }],
  events: [{ name: 'PaymentSucceeded', fields: [] }]
};

describe('validateModel', () => {
  it('accepts a well-formed model', () => expect(validateModel(good)).toEqual([]));

  it('rejects a ref to a missing target', () => {
    const m = structuredClone(good);
    (m.aggregates[0]!.fields[1]!.type as any).target = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unresolved-ref');
  });

  it('rejects an unknown enum', () => {
    const m = structuredClone(good);
    (m.aggregates[0]!.fields[2]!.type as any).enum = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unresolved-enum');
  });

  it('rejects a transition whose from-state is missing', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.from = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-transition-state');
  });

  it('rejects a region whose initial state is missing', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.regions[0]!.initial = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-initial-state');
  });

  it('rejects duplicate top-level names', () => {
    const m = structuredClone(good);
    m.entities.push({ kind: 'entity', name: 'Subscription', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('duplicate-name');
  });

  it('rejects an aggregate without a key field', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields = m.aggregates[0]!.fields.filter(f => !f.key);
    expect(validateModel(m).map(d => d.code)).toContain('missing-key');
  });

  it('rejects an event trigger that names no declared event', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.when = 'GhostEvent';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-event');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/ast/validate.test.ts`
Expected: FAIL — `validate.js` not found / placeholder types mismatch.

- [ ] **Step 3: Implement**

`lattice/src/ast/domain.ts` (replaces placeholder):
```ts
export type PrimType = 'Int' | 'Text' | 'Date' | 'Duration' | 'Money' | 'Id';

export type TypeRef =
  | { kind: 'prim'; prim: PrimType }
  | { kind: 'enum'; enum: string }
  | { kind: 'ref'; target: string }
  | { kind: 'list'; of: TypeRef };

export interface Field {
  name: string;
  type: TypeRef;
  key?: boolean;
  tags?: string[];   // semantic tags (spec plan §10.1): 'balance', 'total', 'monotonic', …
}
export interface StateDef { name: string; tags?: ('active' | 'terminal')[] }
export interface Region { name: string; initial: string; states: StateDef[] }
export interface TransitionDef { name: string; region: string; from: string; to: string; when?: string }
export interface Machine { regions: Region[]; transitions: TransitionDef[] }
export interface EnumDef { name: string; values: string[] }
export interface EntityDef { kind: 'entity'; name: string; fields: Field[]; doc?: string }
export interface AggregateDef { kind: 'aggregate'; name: string; fields: Field[]; machine?: Machine; doc?: string }
export interface EventDef { name: string; fields: Field[] }

export interface DomainModel {
  context: string;
  ticksPerDay?: number;      // time granularity; default 24 (tick = 1 hour)
  enums: EnumDef[];
  entities: EntityDef[];
  aggregates: AggregateDef[];
  events: EventDef[];
}
```

`lattice/src/ast/validate.ts`:
```ts
import type { Diagnostic } from './invariant.js';
import type { DomainModel, Field, TypeRef } from './domain.js';

export function validateModel(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const names = new Map<string, number>();
  const all = [...m.enums.map(e => e.name), ...m.entities.map(e => e.name), ...m.aggregates.map(a => a.name)];
  for (const n of all) names.set(n, (names.get(n) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) out.push({ code: 'duplicate-name', message: `name ${n} declared ${c} times` });

  const owners = new Set([...m.entities.map(e => e.name), ...m.aggregates.map(a => a.name)]);
  const enums = new Set(m.enums.map(e => e.name));
  const events = new Set(m.events.map(e => e.name));

  const checkType = (t: TypeRef, at: string) => {
    if (t.kind === 'ref' && !owners.has(t.target)) out.push({ code: 'unresolved-ref', message: `ref target ${t.target} not declared`, at });
    if (t.kind === 'enum' && !enums.has(t.enum)) out.push({ code: 'unresolved-enum', message: `enum ${t.enum} not declared`, at });
    if (t.kind === 'list') checkType(t.of, at);
  };
  const checkFields = (fs: Field[], owner: string, needKey: boolean) => {
    fs.forEach(f => checkType(f.type, `${owner}.${f.name}`));
    if (needKey && !fs.some(f => f.key)) out.push({ code: 'missing-key', message: `${owner} has no key field`, at: owner });
  };

  m.entities.forEach(e => checkFields(e.fields, e.name, true));
  m.events.forEach(e => e.fields.forEach(f => checkType(f.type, `${e.name}.${f.name}`)));
  m.aggregates.forEach(a => {
    checkFields(a.fields, a.name, true);
    for (const r of a.machine?.regions ?? []) {
      if (!r.states.some(s => s.name === r.initial))
        out.push({ code: 'unknown-initial-state', message: `region ${a.name}.${r.name} initial ${r.initial} not a state`, at: r.name });
    }
    for (const t of a.machine?.transitions ?? []) {
      const r = a.machine!.regions.find(x => x.name === t.region);
      if (!r) { out.push({ code: 'unknown-region', message: `transition ${t.name} names missing region ${t.region}`, at: t.name }); continue; }
      for (const s of [t.from, t.to]) if (!r.states.some(x => x.name === s))
        out.push({ code: 'unknown-transition-state', message: `transition ${t.name}: no state ${s} in ${a.name}.${t.region}`, at: t.name });
      if (t.when && !events.has(t.when))
        out.push({ code: 'unknown-event', message: `transition ${t.name} triggered by undeclared event ${t.when}`, at: t.name });
    }
  });
  return out;
}
```

- [ ] **Step 4: Run all tests to verify pass (including Task 1's, against the real DomainModel)**

Run: `cd lattice && npx vitest run`
Expected: PASS (grammar + validate suites).

- [ ] **Step 5: Commit**

```bash
git add lattice/src/ast/domain.ts lattice/src/ast/validate.ts lattice/test/ast/validate.test.ts
git commit -m "feat(lattice): domain AST + model well-formedness validation"
```

---

### Task 3: The case evaluator (pure-TS semantics of the grammar)

This is the semantic heart shared by the fidelity gate (Task 4), pruning (Task 13), and regeneration validation: it decides `permit | forbid` for any candidate over any concrete case, with no solver.

**Files:**
- Create: `lattice/src/engine/evaluate.ts`
- Test: `lattice/test/engine/evaluate.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Predicate`, `Term`, `Path` (Task 1); `DomainModel` (Task 2).
- Produces: `CaseEntity { type: string; id: string; fields: Record<string, string | number | boolean> }` — machine state is stored as field key `"<Region>.state"`; ref fields hold the target entity's `id`. `CaseState { now?: number; entities: CaseEntity[]; trace?: CaseEntity[][] }` — `trace` is the sequence of prior entity-snapshots (Quint counterexamples), used by `terminal`/`monotonic`. `Verdict = 'permit' | 'forbid'`. `evaluateCandidate(c: Candidate, s: CaseState): Verdict`. `resolveValue(s: CaseState, e: CaseEntity, path: Path): string | number | boolean | undefined` (follows refs by id).

- [ ] **Step 1: Write the failing test**

`lattice/test/engine/evaluate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { evaluateCandidate, type CaseState } from '../../src/engine/evaluate.js';
import type { Candidate } from '../../src/ast/invariant.js';

const uniqueByCustomerFamily: Candidate = {
  kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']]
};

// DPSF: two active subs, same customer, different plan, SAME family (spec §2.1)
const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p2', fields: { family: 'storage' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
// DPDF: same customer, DIFFERENT family
const dpdf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} }, { type: 'Family', id: 'compute', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p3', fields: { family: 'compute' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

const graceRule: Candidate = {
  kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['invoice', 'status'] }, right: { kind: 'enumval', enum: 'Status', value: 'Unpaid' } }
    ]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' }, right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } }
  }
};
const mkGraceCase = (now: number): CaseState => ({ now, entities: [
  { type: 'Invoice', id: 'i1', fields: { status: 'Unpaid', dueDate: 100 } },
  { type: 'Subscription', id: 's1', fields: { grace: 72, invoice: 'i1', 'Access.state': 'Active' } }
]});

describe('evaluateCandidate', () => {
  it('unique: forbids two active in same (customer, family)', () =>
    expect(evaluateCandidate(uniqueByCustomerFamily, dpsf)).toBe('forbid'));
  it('unique: permits two active in different families', () =>
    expect(evaluateCandidate(uniqueByCustomerFamily, dpdf)).toBe('permit'));
  it('statePredicate: forbids unpaid beyond grace (5 days = 120 ticks past due, grace 72)', () =>
    expect(evaluateCandidate(graceRule, mkGraceCase(220))).toBe('forbid'));
  it('statePredicate: permits unpaid within grace (5 hours past due)', () =>
    expect(evaluateCandidate(graceRule, mkGraceCase(105))).toBe('permit'));
  it('cardinality: at most one Open period', () => {
    const c: Candidate = { kind: 'cardinality', aggregate: 'AccountingPeriod',
      where: { kind: 'inState', owner: 'self', region: 'Lifecycle', states: ['Open'] }, atMost: 1 };
    const two: CaseState = { entities: [
      { type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Open' } },
      { type: 'AccountingPeriod', id: 'p2', fields: { 'Lifecycle.state': 'Open' } }
    ]};
    expect(evaluateCandidate(c, two)).toBe('forbid');
    two.entities[1]!.fields['Lifecycle.state'] = 'Closed';
    expect(evaluateCandidate(c, two)).toBe('permit');
  });
  it('conservation: recognized + deferred == allocated', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] };
    const ok: CaseState = { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 60, allocated: 100 } }] };
    const leak: CaseState = { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 50, allocated: 100 } }] };
    expect(evaluateCandidate(c, ok)).toBe('permit');
    expect(evaluateCandidate(c, leak)).toBe('forbid');
  });
  it('refsResolve: forbids a dangling ref', () => {
    const c: Candidate = { kind: 'refsResolve', aggregate: 'RevenueEntry' };
    const s: CaseState = { entities: [{ type: 'RevenueEntry', id: 'e1', fields: { obligation: 'ghost' } }] };
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
  it('monotonic: forbids a decrease across the trace', () => {
    const c: Candidate = { kind: 'monotonic', aggregate: 'Obligation', field: ['recognized'] };
    const s: CaseState = {
      entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 30 } }],
      trace: [[{ type: 'Obligation', id: 'o1', fields: { recognized: 40 } }]]
    };
    expect(evaluateCandidate(c, s)).toBe('forbid');
    expect(evaluateCandidate(c, { ...s, trace: [[{ type: 'Obligation', id: 'o1', fields: { recognized: 10 } }]] })).toBe('permit');
  });
  it('terminal: forbids leaving a terminal state across the trace', () => {
    const c: Candidate = { kind: 'terminal', aggregate: 'AccountingPeriod', region: 'Lifecycle', state: 'Closed' };
    const s: CaseState = {
      entities: [{ type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Open' } }],
      trace: [[{ type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Closed' } }]]
    };
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/engine/evaluate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lattice/src/engine/evaluate.ts`:
```ts
import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';

export interface CaseEntity { type: string; id: string; fields: Record<string, string | number | boolean> }
export interface CaseState { now?: number; entities: CaseEntity[]; trace?: CaseEntity[][] }
export type Verdict = 'permit' | 'forbid';

export function resolveValue(s: CaseState, e: CaseEntity, path: Path): string | number | boolean | undefined {
  let cur: CaseEntity | undefined = e;
  for (let i = 0; i < path.length; i++) {
    if (!cur) return undefined;
    const v = cur.fields[path[i]!];
    if (i === path.length - 1) return v;
    cur = s.entities.find(x => x.id === v);
  }
  return undefined;
}

function evalTerm(t: Term, self: CaseEntity, s: CaseState): number | string | boolean | undefined {
  switch (t.kind) {
    case 'field': return resolveValue(s, self, t.path);
    case 'int': return t.value;
    case 'enumval': return t.value;
    case 'now': return s.now;
    case 'plus': {
      const l = evalTerm(t.left, self, s), r = evalTerm(t.right, self, s);
      return typeof l === 'number' && typeof r === 'number' ? l + r : undefined;
    }
  }
}

function evalPred(p: Predicate, self: CaseEntity, s: CaseState): boolean {
  switch (p.kind) {
    case 'cmp': {
      const l = evalTerm(p.left, self, s), r = evalTerm(p.right, self, s);
      if (l === undefined || r === undefined) return true; // unknown facts don't convict
      switch (p.op) {
        case 'eq': return l === r; case 'ne': return l !== r;
        case 'lt': return (l as number) < (r as number); case 'le': return (l as number) <= (r as number);
        case 'gt': return (l as number) > (r as number); case 'ge': return (l as number) >= (r as number);
      }
    }
    case 'inState': return p.states.includes(String(self.fields[`${p.region}.state`]));
    case 'and': return p.args.every(a => evalPred(a, self, s));
    case 'or': return p.args.some(a => evalPred(a, self, s));
    case 'not': return !evalPred(p.arg, self, s);
    case 'implies': return !evalPred(p.left, self, s) || evalPred(p.right, self, s);
  }
}

const inStates = (e: CaseEntity, w: { region: string; states: string[] }) =>
  w.states.includes(String(e.fields[`${w.region}.state`]));

export function evaluateCandidate(c: Candidate, s: CaseState): Verdict {
  const subjects = () => s.entities.filter(e => e.type === c.aggregate);
  switch (c.kind) {
    case 'statePredicate': {
      const ok = subjects().every(e =>
        (c.where && !evalPred(c.where, e, s)) ? true : evalPred(c.body, e, s));
      return ok ? 'permit' : 'forbid';
    }
    case 'unique': {
      const seen = new Set<string>();
      for (const e of subjects().filter(e => inStates(e, c.whileStates))) {
        const key = c.by.map(p => String(resolveValue(s, e, p))).join('|');
        if (seen.has(key)) return 'forbid';
        seen.add(key);
      }
      return 'permit';
    }
    case 'cardinality': {
      const n = subjects().filter(e => !c.where || evalPred(c.where, e, s)).length;
      return n <= c.atMost ? 'permit' : 'forbid';
    }
    case 'refsResolve': {
      const ids = new Set(s.entities.map(e => e.id));
      for (const e of subjects())
        for (const [k, v] of Object.entries(e.fields))
          if (!k.includes('.') && typeof v === 'string' && !ids.has(v) && looksLikeRef(s, k, e)) return 'forbid';
      return 'permit';
    }
    case 'terminal': {
      for (const e of subjects()) {
        const history = [...(s.trace ?? []).map(step => step.find(x => x.id === e.id)), e].filter(Boolean) as CaseEntity[];
        let entered = false;
        for (const snap of history) {
          const st = String(snap.fields[`${c.region}.state`]);
          if (entered && st !== c.state) return 'forbid';
          if (st === c.state) entered = true;
        }
      }
      return 'permit';
    }
    case 'monotonic': {
      for (const e of subjects()) {
        const history = [...(s.trace ?? []).map(step => step.find(x => x.id === e.id)), e].filter(Boolean) as CaseEntity[];
        let prev = -Infinity;
        for (const snap of history) {
          const v = resolveValue(s, snap, c.field);
          if (typeof v === 'number') { if (v < prev) return 'forbid'; prev = v; }
        }
      }
      return 'permit';
    }
    case 'conservation': {
      for (const e of subjects()) {
        const parts = c.parts.map(p => resolveValue(s, e, p));
        const total = resolveValue(s, e, c.total);
        if (parts.every(v => typeof v === 'number') && typeof total === 'number' &&
            (parts as number[]).reduce((a, b) => a + b, 0) !== total) return 'forbid';
      }
      return 'permit';
    }
    case 'leadsTo': return 'permit'; // liveness is not judgeable on a finite case; template-only (§6.1)
  }
}

// A string field value that matches another entity's id-shape but no entity: treat 'obligation', 'customer',
// 'plan', 'period', 'invoice', 'subscription' style fields as refs when their value is not any entity id AND
// at least one entity id exists (so plain string data isn't misread). Conservative on purpose.
function looksLikeRef(s: CaseState, _field: string, _e: CaseEntity): boolean {
  return s.entities.length > 0;
}
```

Note on `refsResolve`: for solver-produced witnesses every non-state string field IS a ref id (the emitters guarantee it), so the conservative check is exact there; for hand-authored fidelity cases, authors use numeric/enum values for data fields, so no false positives. This constraint is documented in `fidelity/PROTOCOL.md` (Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lattice && npx vitest run test/engine/evaluate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lattice/src/engine/evaluate.ts lattice/test/engine/evaluate.test.ts
git commit -m "feat(lattice): pure-TS case evaluator — grammar semantics for gate, pruning, regen validation"
```

---

### Task 4: The fidelity gate — 20 rules, harness, tally, protocol  ⛔ CHECKPOINT

The existential-risk gate (§2.0/§8). Needs no solver: formalizations are validated by `validateCandidate` and evaluated on hand-authored cases by `evaluateCandidate`. **After this task, STOP and run the gate with the human before touching Task 5.**

**Files:**
- Create: `lattice/fidelity/rules.json`, `lattice/fidelity/harness.ts`, `lattice/fidelity/tally.ts`, `lattice/fidelity/PROTOCOL.md`, `lattice/fidelity/results/.gitkeep`
- Test: `lattice/test/fidelity/harness.test.ts`

**Interfaces:**
- Consumes: `validateCandidate` (Task 1), `evaluateCandidate`, `CaseState` (Task 3).
- Produces: `FidelityRecord` JSON schema (below) written to `fidelity/results/<ruleId>.json`; `npm run fidelity -- <file>` validates one record; `npm run tally` prints rates + threshold verdict. No later task imports from here.

- [ ] **Step 1: Write the 20 rules**

`lattice/fidelity/rules.json`:
```json
{
  "billing": [
    { "id": "b01", "rule": "A customer may have at most one active subscription per product family." },
    { "id": "b02", "rule": "An invoice's line-item amounts must sum exactly to its total." },
    { "id": "b03", "rule": "A trialing subscription becomes active only after its first successful payment." },
    { "id": "b04", "rule": "An active subscription whose latest invoice is unpaid past the grace period must not remain active." },
    { "id": "b05", "rule": "A canceled subscription never transitions to any other state." },
    { "id": "b06", "rule": "Total refunds for an invoice may never exceed the amount captured for it." },
    { "id": "b07", "rule": "Every invoice references an existing subscription." },
    { "id": "b08", "rule": "The same billing period is never invoiced twice for one subscription." },
    { "id": "b09", "rule": "Available plus reserved balance always equals the account's total balance." },
    { "id": "b10", "rule": "After the configured maximum failed payment retries, a subscription is marked delinquent and no further retries occur." }
  ],
  "revrec": [
    { "id": "r01", "rule": "For every performance obligation, recognized plus deferred revenue equals its allocated contract value." },
    { "id": "r02", "rule": "Cumulative recognized revenue for an obligation never decreases." },
    { "id": "r03", "rule": "A ratable obligation recognizes an equal amount in every period of its service term." },
    { "id": "r04", "rule": "No revenue entry may post to a closed accounting period." },
    { "id": "r05", "rule": "A usage-based obligation recognizes revenue only in or after the period in which the usage was reported." },
    { "id": "r06", "rule": "At most one accounting period is open at any time." },
    { "id": "r07", "rule": "Every revenue entry references an existing obligation and an existing accounting period." },
    { "id": "r08", "rule": "Recognized revenue for an obligation never exceeds its allocated amount." },
    { "id": "r09", "rule": "A closed period's recognized total is immutable; late adjustments post as corrections to an open period." },
    { "id": "r10", "rule": "An on-delivery obligation recognizes its full allocated amount in the period of delivery." }
  ]
}
```

- [ ] **Step 2: Write the failing harness test**

`lattice/test/fidelity/harness.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { checkRecord, type FidelityRecord } from '../../fidelity/harness.js';

const record: FidelityRecord = {
  ruleId: 'r01',
  status: 'formalized',
  model: {
    context: 'RevRec', enums: [], entities: [], events: [],
    aggregates: [{ kind: 'aggregate', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' } },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' } },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' } }
    ]}]
  },
  formalization: { kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] },
  cases: [
    { desc: 'balanced', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 60, allocated: 100 } }] }, expected: 'permit' },
    { desc: 'leak', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 50, allocated: 100 } }] }, expected: 'forbid' },
    { desc: 'nothing recognized', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 0, deferred: 100, allocated: 100 } }] }, expected: 'permit' }
  ],
  adversarial: { desc: 'over-recognized but sums', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 120, deferred: -20, allocated: 100 } }] }, expected: 'forbid' },
  humanVerdict: null
};

describe('fidelity harness', () => {
  it('reports obvious-case agreement and adversarial disagreement', () => {
    const r = checkRecord(record);
    expect(r.grammarErrors).toEqual([]);
    expect(r.obviousPass).toBe(true);
    // conservation permits (120 + -20 == 100) but intent forbids ⇒ subtle-wrong candidate, surfaced:
    expect(r.adversarialAgrees).toBe(false);
  });
  it('flags grammar violations', () => {
    const bad = structuredClone(record);
    (bad.formalization as any).kind = 'wibble';
    expect(checkRecord(bad).grammarErrors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd lattice && npx vitest run test/fidelity/harness.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 4: Implement harness + tally**

`lattice/fidelity/harness.ts`:
```ts
import { readFileSync } from 'node:fs';
import { validateCandidate } from '../src/ast/grammar.js';
import { validateModel } from '../src/ast/validate.js';
import { evaluateCandidate, type CaseState, type Verdict } from '../src/engine/evaluate.js';
import type { Candidate, Diagnostic } from '../src/ast/invariant.js';
import type { DomainModel } from '../src/ast/domain.js';

export interface FidelityCase { desc: string; state: CaseState; expected: Verdict }
export interface FidelityRecord {
  ruleId: string;
  status: 'formalized' | 'not-formalizable';    // not-formalizable = grammar can't express it (honest coverage signal)
  model: DomainModel;
  formalization: Candidate | null;
  cases: FidelityCase[];                         // exactly 3 "obvious" cases
  adversarial: FidelityCase | null;              // the 4th, expert-flagged case
  humanVerdict: 'faithful' | 'subtle-wrong' | 'failed-obvious' | null;   // filled by the human after review
}
export interface CheckResult { grammarErrors: Diagnostic[]; obviousPass: boolean; adversarialAgrees: boolean | null; perCase: { desc: string; got: Verdict; expected: Verdict }[] }

export function checkRecord(r: FidelityRecord): CheckResult {
  if (r.status === 'not-formalizable' || !r.formalization)
    return { grammarErrors: [], obviousPass: false, adversarialAgrees: null, perCase: [] };
  const known = new Set(['statePredicate','unique','refsResolve','cardinality','terminal','monotonic','conservation','leadsTo']);
  const grammarErrors = known.has((r.formalization as any).kind)
    ? [...validateModel(r.model), ...validateCandidate(r.formalization, r.model)]
    : [{ code: 'out-of-grammar', message: `unknown candidate kind ${(r.formalization as any).kind}` }];
  if (grammarErrors.length) return { grammarErrors, obviousPass: false, adversarialAgrees: null, perCase: [] };
  const perCase = r.cases.map(c => ({ desc: c.desc, got: evaluateCandidate(r.formalization!, c.state), expected: c.expected }));
  const obviousPass = perCase.every(c => c.got === c.expected);
  const adversarialAgrees = r.adversarial
    ? evaluateCandidate(r.formalization, r.adversarial.state) === r.adversarial.expected
    : null;
  return { grammarErrors, obviousPass, adversarialAgrees, perCase };
}

// CLI: npm run fidelity -- results/r01.json
if (process.argv[2]) {
  const rec: FidelityRecord = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(checkRecord(rec), null, 2));
}
```

`lattice/fidelity/tally.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRecord, type FidelityRecord } from './harness.js';

const dir = join(import.meta.dirname, 'results');
const recs = readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FidelityRecord);

let faithful = 0, subtle = 0, failedObvious = 0, notFormalizable = 0, unjudged = 0;
for (const r of recs) {
  if (r.status === 'not-formalizable') { notFormalizable++; continue; }
  const c = checkRecord(r);
  if (c.grammarErrors.length) { notFormalizable++; continue; }
  if (!c.obviousPass) { failedObvious++; continue; }
  if (r.humanVerdict === 'faithful') faithful++;
  else if (r.humanVerdict === 'subtle-wrong') subtle++;
  else unjudged++;
}
const passing = faithful + subtle;
const rate = passing ? subtle / passing : 0;
console.log({ total: recs.length, faithful, subtleWrong: subtle, failedObvious, notFormalizable, unjudged,
  subtleWrongRate: `${(rate * 100).toFixed(0)}%` });
console.log(rate < 0.10 ? 'VERDICT: proceed as designed (<10%)'
  : rate <= 0.30 ? 'VERDICT: STOP — example-set-as-spec pivot required (10–30%)'
  : 'VERDICT: STOP — do not build further (>30%)');
if (unjudged) console.log(`WARNING: ${unjudged} records lack humanVerdict — tally incomplete`);
```

`lattice/fidelity/PROTOCOL.md`:
```markdown
# Fidelity Gate Protocol (spec §2.0 / §8) — run BEFORE any adapter work

For each of the 20 rules in `rules.json` (10 billing + 10 rev-rec):
1. In a FRESH Claude conversation, give it: the rule text, the §6.1 grammar (src/ast/invariant.ts),
   and ask it to produce a FidelityRecord JSON: a minimal DomainModel + a formalization (or
   status: "not-formalizable"), + 3 obvious cases with expected verdicts.
   Case-authoring constraint: data fields use numbers/enums; string values are ONLY entity ids (refs).
2. Save as fidelity/results/<ruleId>.json. Run: npm run fidelity -- fidelity/results/<ruleId>.json
   - grammarErrors non-empty → count as not-formalizable (record it, move on).
   - obviousPass false → humanVerdict: "failed-obvious".
3. For survivors, the HUMAN authors 1 adversarial case (a 4th case a domain expert would flag —
   boundary, sign trick, off-by-one-period). Add it, re-run.
4. Human sets humanVerdict: "faithful" (formalization matches intent incl. adversarial) or
   "subtle-wrong" (passed 3 obvious cases but disagrees with intent on the adversarial case).
5. Run: npm run tally  → read the verdict against spec §2.0 thresholds. Report BOTH domains'
   rates separately too (billing b* vs revrec r*) — degradation on revrec informs trace-C trust.

Decision: <10% proceed · 10–30% pivot (examples-as-spec) · >30% stop.
```

- [ ] **Step 5: Run tests, commit**

Run: `cd lattice && npx vitest run test/fidelity/harness.test.ts` — Expected: PASS.

```bash
git add lattice/fidelity lattice/test/fidelity
git commit -m "feat(lattice): fidelity gate — 20 rules, harness, tally, protocol (spec §2.0)"
```

- [ ] **Step 6: ⛔ CHECKPOINT — run the gate**

Execute `fidelity/PROTOCOL.md` with the human (this is a human+Claude working session, not code). Commit the filled `fidelity/results/*.json`. **Do not proceed to Task 5 unless the tally verdict is "proceed as designed."** If 10–30%: stop, revisit spec §3.1 pivot with the user. If >30%: stop entirely.

---

### Task 5: Solver toolchain — JDK 21, Alloy jar, quint, doctor

**Files:**
- Create: `lattice/scripts/fetch-solvers.sh`, `lattice/src/solvers/doctor.ts`
- Test: `lattice/test/solvers/doctor.test.ts`

**Interfaces:**
- Produces: `vendor/alloy.jar` (git-ignored), `findJava(): string` (absolute path to a ≥17 JVM binary, honoring `LATTICE_JAVA` env override), `doctor(): Promise<DoctorReport>` where `DoctorReport = { java: { ok: boolean; version: string; path: string }; alloyJar: boolean; quint: boolean }`. Tasks 9/11 use `findJava()`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the fetch script**

`lattice/scripts/fetch-solvers.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor

# 1. JDK 17+ (host has Java 8 — too old for Alloy 6.2 / Apalache)
if ! /usr/libexec/java_home -v 17+ >/dev/null 2>&1; then
  echo ">> No JDK 17+ found. Install Temurin 21:  brew install --cask temurin@21"
  echo ">> Then re-run this script."
  exit 1
fi
echo "JDK: $(/usr/libexec/java_home -v 17+)"

# 2. Alloy 6.2 dist jar
if [ ! -f vendor/alloy.jar ]; then
  curl -fL -o vendor/alloy.jar \
    "https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v6.2.0/org.alloytools.alloy.dist.jar"
fi
echo "Alloy jar: $(ls -lh vendor/alloy.jar | awk '{print $5}')"

# 3. Quint is an npm dep (installed already); Apalache is auto-fetched by `quint verify` on first use.
npx quint --version
echo "OK — run 'npx tsx src/solvers/doctor.ts' to verify."
```

Also add to repo root `.gitignore` (create if absent): `lattice/vendor/*.jar`, `lattice/node_modules/`, `lattice/dist/`, `lattice/.lattice-session*/`.

- [ ] **Step 2: Write the failing doctor test**

`lattice/test/solvers/doctor.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { doctor, findJava } from '../../src/solvers/doctor.js';

describe('doctor', () => {
  it('finds a JDK >= 17', () => {
    const java = findJava();
    expect(java).toMatch(/java$/);
  });
  it('reports toolchain status', async () => {
    const r = await doctor();
    expect(r.java.ok).toBe(true);
    expect(r.alloyJar).toBe(true);
    expect(r.quint).toBe(true);
  });
});
```

- [ ] **Step 3: Implement doctor**

`lattice/src/solvers/doctor.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const VENDOR = join(import.meta.dirname, '..', '..', 'vendor');
export const ALLOY_JAR = join(VENDOR, 'alloy.jar');

/** Absolute path to a >=17 java binary. Override with LATTICE_JAVA=/path/to/java. */
export function findJava(): string {
  if (process.env.LATTICE_JAVA) return process.env.LATTICE_JAVA;
  const home = execFileSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' }).trim();
  return join(home, 'bin', 'java');
}

export interface DoctorReport { java: { ok: boolean; version: string; path: string }; alloyJar: boolean; quint: boolean }

export async function doctor(): Promise<DoctorReport> {
  let java = { ok: false, version: 'none', path: '' };
  try {
    const path = findJava();
    const v = execFileSync(path, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ||
      execFileSync(path, ['-version'], { encoding: 'utf8' });
    java = { ok: true, version: v.split('\n')[0] ?? '', path };
  } catch { /* stays not-ok */ }
  let quint = false;
  try { execFileSync('npx', ['quint', '--version'], { encoding: 'utf8' }); quint = true; } catch { /* absent */ }
  return { java, alloyJar: existsSync(ALLOY_JAR), quint };
}

if (import.meta.url === `file://${process.argv[1]}`) doctor().then(r => console.log(JSON.stringify(r, null, 2)));
```

(Note: `java -version` writes to stderr on some JDKs — the try/fallback covers it; if flaky, use `execFileSync(path, ['-version'], {stdio:'pipe'})` and read from the thrown error's stderr.)

- [ ] **Step 4: Install JDK + fetch, run tests**

Run:
```bash
brew install --cask temurin@21   # if step 1's check demanded it
cd lattice && bash scripts/fetch-solvers.sh && npx vitest run test/solvers/doctor.test.ts
```
Expected: script prints JDK path + jar size + quint version; test PASSES.

- [ ] **Step 5: Commit**

```bash
git add lattice/scripts/fetch-solvers.sh lattice/src/solvers/doctor.ts lattice/test/solvers/doctor.test.ts .gitignore
git commit -m "chore(lattice): solver toolchain — JDK 21 check, Alloy 6.2 fetch, doctor"
```

---

### Task 6: Session store + decision ledger

**Files:**
- Create: `lattice/src/engine/session.ts`
- Test: `lattice/test/engine/session.test.ts`

**Interfaces:**
- Consumes: `CandidateInvariant` (Task 1), `DomainModel` (Task 2), `CaseState` (Task 3).
- Produces (used by hypothesis/planner/CLI):

```ts
type CandidateStatus = 'active' | 'pruned' | 'merged' | 'refuted' | 'adopted' | 'parked';
type Phase = 'structure' | 'distinguish' | 'probe-forbid' | 'probe-permit' | 'alternatives' | 'regenerate' | 'converged';
interface TrackedCandidate { inv: CandidateInvariant; status: CandidateStatus; mergedInto?: string }
interface SessionState {
  model: DomainModel | null;
  candidates: TrackedCandidate[];
  phase: Phase;
  regenAttempts: number;          // cap 3
  alternativeAttempts: number;    // cap 2
  probesAsked: { forbid: boolean; permit: boolean };
  pendingWitnesses: Record<string, { witness: CaseState; purpose: 'distinguish' | 'probe-forbid' | 'probe-permit'; pair?: [string, string]; salient: SalientFact[] }>;
}
type LedgerEntry =
  | { kind: 'verdict'; at: string; witnessId: string; witness: CaseState; salient: SalientFact[]; judge: 'permit' | 'forbid'; question: string }
  | { kind: 'open-decision'; at: string; topic: string; note: string; witnessId?: string }
  | { kind: 'adopted'; at: string; invariant: CandidateInvariant; provenance: string }
  | { kind: 'declined'; at: string; invariant: CandidateInvariant; reason: string }
  | { kind: 'structure'; at: string; question: string; answer: string };
```
- Functions: `newSession(): SessionState`, `loadState(dir): SessionState`, `saveState(dir, s): void`, `appendLedger(dir, e: LedgerEntry): void`, `readLedger(dir): LedgerEntry[]`. (`SalientFact` is `{ dim: string; value: string | number | boolean }`, defined here and re-exported by Task 7 to avoid a cycle.)

- [ ] **Step 1: Write the failing test**

`lattice/test/engine/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession, loadState, saveState, appendLedger, readLedger } from '../../src/engine/session.js';

describe('session store', () => {
  it('round-trips state.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-'));
    const s = newSession();
    s.phase = 'distinguish';
    saveState(dir, s);
    expect(loadState(dir).phase).toBe('distinguish');
  });
  it('appends and reads ledger.jsonl in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-'));
    appendLedger(dir, { kind: 'structure', at: 't1', question: 'q', answer: 'a' });
    appendLedger(dir, { kind: 'open-decision', at: 't2', topic: 'usage-after-close', note: 'parked' });
    const l = readLedger(dir);
    expect(l.length).toBe(2);
    expect(l[1]!.kind).toBe('open-decision');
  });
  it('loadState on a fresh dir returns a new session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-'));
    expect(loadState(dir).candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/engine/session.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { DomainModel } from '../ast/domain.js';
import type { CaseState } from './evaluate.js';

export interface SalientFact { dim: string; value: string | number | boolean }
export type CandidateStatus = 'active' | 'pruned' | 'merged' | 'refuted' | 'adopted' | 'parked';
export type Phase = 'structure' | 'distinguish' | 'probe-forbid' | 'probe-permit' | 'alternatives' | 'regenerate' | 'converged';
export interface TrackedCandidate { inv: CandidateInvariant; status: CandidateStatus; mergedInto?: string }
export interface PendingWitness { witness: CaseState; purpose: 'distinguish' | 'probe-forbid' | 'probe-permit'; pair?: [string, string]; salient: SalientFact[] }
export interface SessionState {
  model: DomainModel | null;
  candidates: TrackedCandidate[];
  phase: Phase;
  regenAttempts: number;
  alternativeAttempts: number;
  probesAsked: { forbid: boolean; permit: boolean };
  pendingWitnesses: Record<string, PendingWitness>;
}
export type LedgerEntry =
  | { kind: 'verdict'; at: string; witnessId: string; witness: CaseState; salient: SalientFact[]; judge: 'permit' | 'forbid'; question: string }
  | { kind: 'open-decision'; at: string; topic: string; note: string; witnessId?: string }
  | { kind: 'adopted'; at: string; invariant: CandidateInvariant; provenance: string }
  | { kind: 'declined'; at: string; invariant: CandidateInvariant; reason: string }
  | { kind: 'structure'; at: string; question: string; answer: string };

export function newSession(): SessionState {
  return { model: null, candidates: [], phase: 'structure', regenAttempts: 0, alternativeAttempts: 0,
    probesAsked: { forbid: false, permit: false }, pendingWitnesses: {} };
}
const stateFile = (dir: string) => join(dir, 'state.json');
const ledgerFile = (dir: string) => join(dir, 'ledger.jsonl');

export function loadState(dir: string): SessionState {
  return existsSync(stateFile(dir)) ? JSON.parse(readFileSync(stateFile(dir), 'utf8')) : newSession();
}
export function saveState(dir: string, s: SessionState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(dir), JSON.stringify(s, null, 2));
}
export function appendLedger(dir: string, e: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(ledgerFile(dir), JSON.stringify(e) + '\n');
}
export function readLedger(dir: string): LedgerEntry[] {
  if (!existsSync(ledgerFile(dir))) return [];
  return readFileSync(ledgerFile(dir), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
```

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/engine/session.ts lattice/test/engine/session.test.ts
git commit -m "feat(lattice): session store — state.json + append-only ledger.jsonl (the canonical artifact)"
```

---

### Task 7: Salient facts, canonical witness table, shape exclusions

**Files:**
- Create: `lattice/src/engine/salient.ts`
- Test: `lattice/test/engine/salient.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Path` (Task 1); `CaseState`, `resolveValue` (Task 3); re-exports `SalientFact` (Task 6).
- Produces:
  - `extractSalient(cands: Candidate[], s: CaseState): SalientFact[]` — the witness's characteristic dimensions. For structural candidates (`unique`): pairwise path-equality booleans over in-state subject pairs, dims named `"<path> equal"`, plus `"<field> = <value>"` string dims for enum-ish fields mentioned. For arithmetic `statePredicate`s: one boolean dim per comparison, named by rendering the comparison (e.g. `"now <= dueDate + grace"`), valued by evaluating it.
  - `renderWitnessTable(s: CaseState, ticksPerDay?: number): string` — deterministic markdown table (the ground-truth render, §5.1): one row per entity, `Duration`/`Date`-looking tick fields humanized (`120 ticks → "5 days"` at ticksPerDay 24).
  - `salientKey(f: SalientFact[]): string` — canonical string for don't-re-ask comparisons.

- [ ] **Step 1: Write the failing test**

`lattice/test/engine/salient.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { extractSalient, renderWitnessTable, salientKey } from '../../src/engine/salient.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const uniq: Candidate = { kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] };
const uniqPerPlan: Candidate = { kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p2', fields: { family: 'storage' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};

describe('extractSalient', () => {
  it('captures pairwise equality dims for structural candidates', () => {
    const facts = extractSalient([uniq, uniqPerPlan], dpsf);
    const byDim = Object.fromEntries(facts.map(f => [f.dim, f.value]));
    expect(byDim['customer equal']).toBe(true);
    expect(byDim['plan equal']).toBe(false);
    expect(byDim['plan.family equal']).toBe(true);
  });
  it('captures comparison dims for arithmetic candidates', () => {
    const grace: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'le', left: { kind: 'now' },
        right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } } };
    const s: CaseState = { now: 220, entities: [{ type: 'Subscription', id: 's1', fields: { dueDate: 100, grace: 72 } }] };
    const facts = extractSalient([grace], s);
    expect(facts.find(f => f.dim === 'now le dueDate + grace')!.value).toBe(false);
  });
});

describe('renderWitnessTable', () => {
  it('renders a deterministic markdown table with humanized ticks', () => {
    const s: CaseState = { now: 220, entities: [
      { type: 'Invoice', id: 'i1', fields: { status: 'Unpaid', dueDate: 100 } },
      { type: 'Subscription', id: 's1', fields: { grace: 72, invoice: 'i1', 'Access.state': 'Active' } }
    ]};
    const t = renderWitnessTable(s, 24);
    expect(t).toContain('| Subscription |');
    expect(t).toContain('Access.state: Active');
    expect(t).toContain('grace: 72 ticks (3 days)');
    expect(t).toContain('now = 220 ticks');
  });
});

describe('salientKey', () => {
  it('is order-insensitive', () => {
    expect(salientKey([{ dim: 'a', value: 1 }, { dim: 'b', value: true }]))
      .toBe(salientKey([{ dim: 'b', value: true }, { dim: 'a', value: 1 }]));
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/engine/salient.ts`:
```ts
import type { Candidate, Cmp, Path, Predicate, Term } from '../ast/invariant.js';
import { resolveValue, type CaseState } from './evaluate.js';
import type { SalientFact } from './session.js';
export type { SalientFact } from './session.js';

function pathsOf(c: Candidate): Path[] {
  switch (c.kind) {
    case 'unique': return c.by;
    default: return [];
  }
}
function collectCmps(p: Predicate, out: { op: Cmp; left: Term; right: Term }[]): void {
  switch (p.kind) {
    case 'cmp': if (['lt','le','gt','ge'].includes(p.op) || [p.left, p.right].some(t => t.kind === 'now' || t.kind === 'plus')) out.push(p); break;
    case 'and': case 'or': p.args.forEach(a => collectCmps(a, out)); break;
    case 'not': collectCmps(p.arg, out); break;
    case 'implies': collectCmps(p.left, out); collectCmps(p.right, out); break;
    case 'inState': break;
  }
}
function renderTerm(t: Term): string {
  switch (t.kind) {
    case 'field': return t.path.join('.');
    case 'int': return String(t.value);
    case 'enumval': return t.value;
    case 'now': return 'now';
    case 'plus': return `${renderTerm(t.left)} + ${renderTerm(t.right)}`;
  }
}
function evalTermOn(t: Term, e: any, s: CaseState): number | string | boolean | undefined {
  switch (t.kind) {
    case 'field': return resolveValue(s, e, t.path);
    case 'int': return t.value; case 'enumval': return t.value; case 'now': return s.now;
    case 'plus': { const l = evalTermOn(t.left, e, s), r = evalTermOn(t.right, e, s);
      return typeof l === 'number' && typeof r === 'number' ? l + r : undefined; }
  }
}

export function extractSalient(cands: Candidate[], s: CaseState): SalientFact[] {
  const facts = new Map<string, SalientFact>();
  for (const c of cands) {
    if (c.kind === 'unique') {
      // union of by-paths + their prefixes across all candidates gives the comparison dims
      const subjects = s.entities.filter(e => e.type === c.aggregate &&
        c.whileStates.states.includes(String(e.fields[`${c.whileStates.region}.state`])));
      const dims = new Set<string>();
      for (const cc of cands) for (const p of pathsOf(cc)) {
        for (let i = 1; i <= p.length; i++) dims.add(p.slice(0, i).join('.'));
      }
      for (let i = 0; i < subjects.length; i++) for (let j = i + 1; j < subjects.length; j++) {
        for (const d of dims) {
          const path = d.split('.');
          const a = resolveValue(s, subjects[i]!, path), b = resolveValue(s, subjects[j]!, path);
          if (a !== undefined && b !== undefined) facts.set(`${d} equal`, { dim: `${d} equal`, value: a === b });
        }
      }
      facts.set('inState count', { dim: 'inState count', value: subjects.length });
    }
    if (c.kind === 'statePredicate' || c.kind === 'cardinality') {
      const preds: Predicate[] = c.kind === 'statePredicate' ? [c.body, ...(c.where ? [c.where] : [])] : (c.where ? [c.where] : []);
      const cmps: { op: Cmp; left: Term; right: Term }[] = [];
      preds.forEach(p => collectCmps(p, cmps));
      const subjects = s.entities.filter(e => e.type === c.aggregate);
      for (const cmp of cmps) for (const e of subjects) {
        const l = evalTermOn(cmp.left, e, s), r = evalTermOn(cmp.right, e, s);
        if (l === undefined || r === undefined) continue;
        const dim = `${renderTerm(cmp.left)} ${cmp.op} ${renderTerm(cmp.right)}`;
        const val = cmp.op === 'eq' ? l === r : cmp.op === 'ne' ? l !== r
          : cmp.op === 'lt' ? (l as number) < (r as number) : cmp.op === 'le' ? (l as number) <= (r as number)
          : cmp.op === 'gt' ? (l as number) > (r as number) : (l as number) >= (r as number);
        facts.set(dim, { dim, value: val });
      }
      // enum-valued equality facts (e.g. kind = Correction) so shapes distinguish entry kinds
      for (const p of preds) collectEnumEq(p, subjects, s, facts);
    }
  }
  return [...facts.values()].sort((a, b) => a.dim.localeCompare(b.dim));
}
function collectEnumEq(p: Predicate, subjects: any[], s: CaseState, facts: Map<string, SalientFact>): void {
  if (p.kind === 'cmp' && p.op === 'eq' && p.left.kind === 'field' && p.right.kind === 'enumval') {
    for (const e of subjects) {
      const v = resolveValue(s, e, p.left.path);
      if (v !== undefined) facts.set(`${p.left.path.join('.')} = ${v}`, { dim: `${p.left.path.join('.')} = ${v}`, value: true });
    }
  } else if (p.kind === 'and' || p.kind === 'or') p.args.forEach(a => collectEnumEq(a, subjects, s, facts));
  else if (p.kind === 'not') collectEnumEq(p.arg, subjects, s, facts);
  else if (p.kind === 'implies') { collectEnumEq(p.left, subjects, s, facts); collectEnumEq(p.right, subjects, s, facts); }
}

const TIME_FIELDS = /date|grace|window|at$|deadline/i;
function humanizeTicks(n: number, ticksPerDay: number): string {
  if (n % ticksPerDay === 0) return `${n} ticks (${n / ticksPerDay} days)`;
  return `${n} ticks (${n} hours)`;   // ticksPerDay=24 ⇒ tick = 1 hour
}

export function renderWitnessTable(s: CaseState, ticksPerDay = 24): string {
  const lines = ['| Entity | Id | Facts |', '|---|---|---|'];
  for (const e of [...s.entities].sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id))) {
    const facts = Object.entries(e.fields).map(([k, v]) =>
      typeof v === 'number' && TIME_FIELDS.test(k) ? `${k}: ${humanizeTicks(v, ticksPerDay)}` : `${k}: ${v}`);
    lines.push(`| ${e.type} | ${e.id} | ${facts.join(' · ') || '—'} |`);
  }
  if (s.now !== undefined) lines.push(`| _clock_ | — | now = ${s.now} ticks |`);
  return lines.join('\n');
}

export function salientKey(f: SalientFact[]): string {
  return [...f].sort((a, b) => a.dim.localeCompare(b.dim)).map(x => `${x.dim}=${x.value}`).join(';');
}
```

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/engine/salient.ts lattice/test/engine/salient.test.ts
git commit -m "feat(lattice): salient facts, canonical witness table, shape keys (dual-render ground truth)"
```

---

### Task 8: `astToAlloy` — structural queries

**Files:**
- Create: `lattice/src/emit/alloy.ts`
- Test: `lattice/test/emit/alloy.test.ts`

**Interfaces:**
- Consumes: `DomainModel` (Task 2), `Candidate` (Task 1), `SalientFact` (Task 6), `resolveFieldPath` (Task 1/grammar).
- Produces:

```ts
interface AlloyQuery {
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit';
  hi: Candidate; hj?: Candidate;              // hj only for distinguish
  exclusions: SalientFact[][];                // judged shapes to exclude (semantic don't-re-ask)
  scope: number;                              // default 4
}
function astToAlloy(m: DomainModel, q: AlloyQuery): string
```
Conventions Task 9 relies on: sig names = declaration names; machine state field emitted as `<Region>_state: one <Agg>_<Region>` with `one sig <Agg>_<Region>_<State>`; prim `Int|Money|Date|Duration` fields → `Int`; `Text`/`Id` fields are dropped (the atom is the identity); the single command is named `q`.

- [ ] **Step 1: Write the failing test**

`lattice/test/emit/alloy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { astToAlloy } from '../../src/emit/alloy.js';
import type { Candidate } from '../../src/ast/invariant.js';
import { traceAModel } from '../fixtures.js';

const h1: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] };
const h2: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

describe('astToAlloy', () => {
  it('emits sigs, state sigs, candidate preds, and a distinguish run', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4 });
    expect(als).toContain('sig Subscription');
    expect(als).toContain('one sig Subscription_Access_Active');
    expect(als).toContain('Access_state: one Subscription_Access');
    expect(als).toContain('pred Hi');
    expect(als).toContain('pred Hj');
    expect(als).toContain('run q { (Hi and not Hj) or (not Hi and Hj) } for 4 but 5 Int');
  });
  it('emits exclusion shape predicates conjoined into the run', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: h1, exclusions: [[
      { dim: 'customer equal', value: true }, { dim: 'plan equal', value: false },
      { dim: 'plan.family equal', value: true }, { dim: 'inState count', value: 2 }
    ]], scope: 4 });
    expect(als).toContain('pred shape0');
    expect(als).toContain('a.customer = b.customer');
    expect(als).toContain('a.plan != b.plan');
    expect(als).toContain('a.plan.family = b.plan.family');
    expect(als).toContain('run q { (not Hi) and (not shape0) } for 4 but 5 Int');
  });
  it('probe-permit runs Hi with a non-vacuity witness pattern', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-permit', hi: h1, exclusions: [], scope: 4 });
    expect(als).toContain('pred nonVacuous');
    expect(als).toContain('run q { Hi and nonVacuous } for 4 but 5 Int');
  });
});
```

Create the shared fixture module `lattice/test/fixtures.ts`:
```ts
import type { DomainModel } from '../src/ast/domain.js';

export const traceAModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [],
  entities: [
    { kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] },
    { kind: 'entity', name: 'Family', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] },
    { kind: 'entity', name: 'Plan', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'family', type: { kind: 'ref', target: 'Family' } }] }
  ],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'plan', type: { kind: 'ref', target: 'Plan' } }],
    machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [
      { name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] }
  }],
  events: []
};
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/emit/alloy.ts`:
```ts
import type { DomainModel, AggregateDef, EntityDef } from '../ast/domain.js';
import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';
import type { SalientFact } from '../engine/session.js';

export interface AlloyQuery {
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit';
  hi: Candidate; hj?: Candidate;
  exclusions: SalientFact[][];
  scope: number;
}

const isIntPrim = (p: string) => ['Int', 'Money', 'Date', 'Duration'].includes(p);

function emitOwnerSig(o: AggregateDef | EntityDef): string {
  const fields: string[] = [];
  for (const f of o.fields) {
    if (f.key) continue;
    if (f.type.kind === 'ref') fields.push(`  ${f.name}: one ${f.type.target}`);
    else if (f.type.kind === 'enum') fields.push(`  ${f.name}: one ${f.type.enum}`);
    else if (f.type.kind === 'prim' && isIntPrim(f.type.prim)) fields.push(`  ${f.name}: one Int`);
    // Text/Id dropped — atom identity suffices
  }
  const machine = (o as AggregateDef).machine;
  for (const r of machine?.regions ?? []) fields.push(`  ${r.name}_state: one ${o.name}_${r.name}`);
  return `sig ${o.name} {\n${fields.join(',\n')}\n}`;
}

function emitStateSigs(a: AggregateDef): string {
  return (a.machine?.regions ?? []).map(r =>
    `abstract sig ${a.name}_${r.name} {}\n` +
    r.states.map(s => `one sig ${a.name}_${r.name}_${s.name} extends ${a.name}_${r.name} {}`).join('\n')
  ).join('\n');
}

const alloyPath = (v: string, p: Path) => [v, ...p].join('.');

function inStateExpr(agg: string, v: string, region: string, states: string[]): string {
  return '(' + states.map(s => `${v}.${region}_state = ${agg}_${region}_${s}`).join(' or ') + ')';
}

function termToAlloy(t: Term, v: string): string {
  switch (t.kind) {
    case 'field': return alloyPath(v, t.path);
    case 'int': return String(t.value);
    case 'enumval': return t.value;
    case 'now': throw new Error('now is not expressible structurally — route to quint');
    case 'plus': return `${termToAlloy(t.left, v)}.plus[${termToAlloy(t.right, v)}]`;
  }
}
function predToAlloy(p: Predicate, agg: string, v: string): string {
  switch (p.kind) {
    case 'cmp': {
      const l = termToAlloy(p.left, v), r = termToAlloy(p.right, v);
      const ops: Record<string, string> = { eq: '=', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      return `(${l} ${ops[p.op]} ${r})`;
    }
    case 'inState': return inStateExpr(agg, v, p.region, p.states);
    case 'and': return '(' + p.args.map(a => predToAlloy(a, agg, v)).join(' and ') + ')';
    case 'or': return '(' + p.args.map(a => predToAlloy(a, agg, v)).join(' or ') + ')';
    case 'not': return `(not ${predToAlloy(p.arg, agg, v)})`;
    case 'implies': return `(${predToAlloy(p.left, agg, v)} implies ${predToAlloy(p.right, agg, v)})`;
  }
}

function candidateToPred(c: Candidate, name: string): string {
  switch (c.kind) {
    case 'unique': {
      const inS = (v: string) => inStateExpr(c.aggregate, v, c.whileStates.region, c.whileStates.states);
      const eqs = c.by.map(p => `${alloyPath('a', p)} = ${alloyPath('b', p)}`).join(' and ');
      return `pred ${name} { all disj a, b: ${c.aggregate} | (${inS('a')} and ${inS('b')}) implies not (${eqs}) }`;
    }
    case 'refsResolve': return `pred ${name} { }`;   // refs are total in Alloy sigs by construction — vacuously true
    case 'cardinality': {
      const guard = c.where ? predToAlloy(c.where, c.aggregate, 'x') : 'x = x';
      return `pred ${name} { #{ x: ${c.aggregate} | ${guard} } <= ${c.atMost} }`;
    }
    case 'statePredicate': {
      const guard = c.where ? `${predToAlloy(c.where, c.aggregate, 'x')} implies ` : '';
      return `pred ${name} { all x: ${c.aggregate} | ${guard}${predToAlloy(c.body, c.aggregate, 'x')} }`;
    }
    default: throw new Error(`${c.kind} routes to quint, not alloy`);
  }
}

/** Rebuild a judged shape (salient facts) as an existential pattern to exclude. */
function shapeToPred(facts: SalientFact[], subject: Candidate, name: string): string {
  const agg = subject.aggregate;
  const w = subject.kind === 'unique' ? subject.whileStates : null;
  const conj: string[] = [];
  for (const f of facts) {
    const mEq = f.dim.match(/^(.+) equal$/);
    if (mEq) { const p = mEq[1]!.split('.'); conj.push(`${alloyPath('a', p)} ${f.value ? '=' : '!='} ${alloyPath('b', p)}`); continue; }
    const mVal = f.dim.match(/^(.+) = (.+)$/);
    if (mVal) { conj.push(`${alloyPath('a', mVal[1]!.split('.'))} = ${mVal[2]}`); continue; }
    // 'inState count' and comparison dims don't constrain structural shapes further
  }
  const inS = w ? `${inStateExpr(agg, 'a', w.region, w.states)} and ${inStateExpr(agg, 'b', w.region, w.states)} and ` : '';
  return `pred ${name} { some disj a, b: ${agg} | ${inS}${conj.join(' and ') || 'a != b'} }`;
}

function nonVacuousPred(c: Candidate): string {
  if (c.kind === 'unique') {
    const inS = (v: string) => inStateExpr(c.aggregate, v, c.whileStates.region, c.whileStates.states);
    return `pred nonVacuous { some disj a, b: ${c.aggregate} | ${inS('a')} and ${inS('b')} }`;
  }
  if (c.kind === 'statePredicate' && c.body.kind === 'implies')
    return `pred nonVacuous { some x: ${c.aggregate} | ${predToAlloy(c.body.left, c.aggregate, 'x')} }`;
  return `pred nonVacuous { some ${c.aggregate} }`;
}

export function astToAlloy(m: DomainModel, q: AlloyQuery): string {
  const parts: string[] = [`module lattice_q`];
  for (const e of m.enums) parts.push(`abstract sig ${e.name} {}\n` + e.values.map(v => `one sig ${v} extends ${e.name} {}`).join('\n'));
  for (const e of m.entities) parts.push(emitOwnerSig(e));
  for (const a of m.aggregates) { parts.push(emitStateSigs(a)); parts.push(emitOwnerSig(a)); }
  parts.push(candidateToPred(q.hi, 'Hi'));
  if (q.hj) parts.push(candidateToPred(q.hj, 'Hj'));
  q.exclusions.forEach((facts, i) => parts.push(shapeToPred(facts, q.hi, `shape${i}`)));
  const notShapes = q.exclusions.map((_, i) => `(not shape${i})`).join(' and ');
  const withShapes = (body: string) => notShapes ? `${body} and ${notShapes}` : body;
  if (q.kind === 'distinguish') parts.push(`run q { ${withShapes('(Hi and not Hj) or (not Hi and Hj)')} } for ${q.scope} but 5 Int`);
  else if (q.kind === 'probe-forbid') parts.push(`run q { ${withShapes('(not Hi)')} } for ${q.scope} but 5 Int`);
  else { parts.push(nonVacuousPred(q.hi)); parts.push(`run q { ${withShapes('Hi and nonVacuous')} } for ${q.scope} but 5 Int`); }
  return parts.join('\n\n') + '\n';
}
```

Note the probe-forbid exclusion body in the test expects `(not Hi) and (not shape0)` — the `withShapes` helper produces exactly that.

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/emit/alloy.ts lattice/test/emit/alloy.test.ts lattice/test/fixtures.ts
git commit -m "feat(lattice): astToAlloy — sigs, candidate preds, shape exclusions, three query kinds"
```

---

### Task 9: Alloy adapter — Java shim, XML instance parsing, enumeration

**Files:**
- Create: `lattice/vendor/AlloyRunner.java`, `lattice/src/solvers/alloy-adapter.ts`
- Test: `lattice/test/solvers/alloy-adapter.integration.test.ts`

**Interfaces:**
- Consumes: `findJava`, `ALLOY_JAR`, `VENDOR` (Task 5); `CaseState` (Task 3).
- Produces: `runAlloy(als: string, maxInstances: number): Promise<AlloyResult>` where `AlloyResult = { sat: boolean; instances: CaseState[]; ms: number }`. Instances follow Task 3 conventions (`<Region>.state` field keys; ref fields hold atom ids like `Customer$0`; Int fields hold numbers). The planner (Task 14) uses this signature.

- [ ] **Step 1: Spike — confirm the jar runs under JDK 21 (≤ 30 min, no test)**

```bash
cd lattice && "$( /usr/libexec/java_home -v 17+ )/bin/java" -jar vendor/alloy.jar --help 2>&1 | head -5
```
Whatever the CLI offers, we standardize on the shim (deterministic enumeration + XML output). Record cold-start ms — it feeds the §2.4 latency budget.

- [ ] **Step 2: Write the shim**

`lattice/vendor/AlloyRunner.java`:
```java
import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.parser.CompModule;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;

/** Usage: AlloyRunner <file.als> <maxInstances> <outDir>
 *  Runs the first command; writes inst_<i>.xml per instance; prints "INSTANCES n" or "UNSAT". */
public class AlloyRunner {
  public static void main(String[] args) throws Exception {
    CompModule world = CompUtil.parseEverything_fromFile(A4Reporter.NOP, null, args[0]);
    int max = Integer.parseInt(args[1]);
    String outDir = args[2];
    Command cmd = world.getAllCommands().get(0);
    A4Options opts = new A4Options();
    opts.solver = A4Options.SatSolver.SAT4J;
    A4Solution sol = TranslateAlloyToKodkod.execute_command(A4Reporter.NOP, world.getAllReachableSigs(), cmd, opts);
    int n = 0;
    while (sol.satisfiable() && n < max) {
      sol.writeXML(outDir + "/inst_" + n + ".xml");
      n++;
      sol = sol.next();
    }
    System.out.println(n == 0 ? "UNSAT" : ("INSTANCES " + n));
  }
}
```

Compile once (the adapter auto-compiles if the class is missing):
```bash
cd lattice && "$( /usr/libexec/java_home -v 17+ )/bin/javac" -cp vendor/alloy.jar -d vendor vendor/AlloyRunner.java
```

- [ ] **Step 3: Write the failing integration test**

`lattice/test/solvers/alloy-adapter.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runAlloy } from '../../src/solvers/alloy-adapter.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { ALLOY_JAR } from '../../src/solvers/doctor.js';
import { traceAModel } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const h1: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] };
const h2: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

describe.skipIf(!existsSync(ALLOY_JAR))('alloy adapter (integration)', () => {
  it('finds a distinguishing witness for per-customer vs per-plan', async () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 3);
    expect(r.sat).toBe(true);
    const w = r.instances[0]!;
    const subs = w.entities.filter(e => e.type === 'Subscription' && e.fields['Access.state'] === 'Active');
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(r.ms).toBeLessThan(45_000);
  }, 120_000);

  it('returns UNSAT for a candidate against itself (merge signal)', async () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h1, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat).toBe(false);
  }, 120_000);
});
```

- [ ] **Step 4: Implement the adapter**

`lattice/src/solvers/alloy-adapter.ts`:
```ts
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { ALLOY_JAR, VENDOR, findJava } from './doctor.js';
import type { CaseEntity, CaseState } from '../engine/evaluate.js';

const exec = promisify(execFile);
export interface AlloyResult { sat: boolean; instances: CaseState[]; ms: number }

async function ensureShim(java: string): Promise<void> {
  if (existsSync(join(VENDOR, 'AlloyRunner.class'))) return;
  const javac = java.replace(/java$/, 'javac');
  await exec(javac, ['-cp', ALLOY_JAR, '-d', VENDOR, join(VENDOR, 'AlloyRunner.java')]);
}

export async function runAlloy(als: string, maxInstances: number): Promise<AlloyResult> {
  const t0 = Date.now();
  const java = findJava();
  await ensureShim(java);
  const dir = mkdtempSync(join(tmpdir(), 'alloy-'));
  const file = join(dir, 'q.als');
  writeFileSync(file, als);
  const sep = process.platform === 'win32' ? ';' : ':';
  const { stdout } = await exec(java, ['-cp', `${ALLOY_JAR}${sep}${VENDOR}`, 'AlloyRunner', file, String(maxInstances), dir]);
  if (stdout.includes('UNSAT')) return { sat: false, instances: [], ms: Date.now() - t0 };
  const instances = readdirSync(dir).filter(f => f.endsWith('.xml')).sort()
    .map(f => parseInstanceXML(readFileSync(join(dir, f), 'utf8')));
  return { sat: true, instances, ms: Date.now() - t0 };
}

const asArray = <T>(x: T | T[] | undefined): T[] => x === undefined ? [] : Array.isArray(x) ? x : [x];

export function parseInstanceXML(xml: string): CaseState {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
  const inst = doc.alloy.instance;
  const entities = new Map<string, CaseEntity>();
  const sigOf = new Map<string, string>();       // sig ID -> type name
  const skip = /^(seq\/Int|Int|String|univ|none)$/;

  for (const sig of asArray<any>(inst.sig)) {
    const label: string = (sig.label as string).replace(/^this\//, '');
    sigOf.set(sig.ID, label);
    if (skip.test(label) || sig.builtin === 'yes') continue;
    for (const atom of asArray<any>(sig.atom)) {
      const id: string = atom.label;
      // "one sig" state/enum atoms (Foo$0 of a one-sig) become plain values, not entities:
      if (sig.one === 'yes') continue;
      entities.set(id, { type: label, id, fields: {} });
    }
  }
  const oneSigValue = (atomLabel: string): string => atomLabel.replace(/\$\d+$/, '');

  for (const field of asArray<any>(inst.field)) {
    const rawName: string = field.label;
    const name = rawName.replace(/_state$/, '.state');
    for (const tuple of asArray<any>(field.tuple)) {
      const atoms = asArray<any>(tuple.atom).map(a => a.label as string);
      if (atoms.length !== 2) continue;
      const owner = entities.get(atoms[0]!);
      if (!owner) continue;
      const v = atoms[1]!;
      if (/^-?\d+$/.test(v)) owner.fields[name] = Number(v);
      else if (entities.has(v)) owner.fields[name] = v;
      else owner.fields[name] = deStatePrefix(oneSigValue(v));
    }
  }
  return { entities: [...entities.values()] };
}

// Subscription_Access_Active -> Active ; USD stays USD
function deStatePrefix(v: string): string {
  const parts = v.split('_');
  return parts.length >= 3 ? parts[parts.length - 1]! : v;
}
```

- [ ] **Step 5: Run to verify PASS (real solver)**

Run: `cd lattice && npx vitest run test/solvers/alloy-adapter.integration.test.ts`
Expected: PASS, both tests; note the reported ms (should be seconds; JVM cold start dominates).
If XML attribute names differ from assumptions (e.g. `one` flag absent), open one `inst_0.xml` from the temp dir, adjust `parseInstanceXML`, re-run — this is the budgeted spike work.

- [ ] **Step 6: Commit**

```bash
git add lattice/vendor/AlloyRunner.java lattice/src/solvers/alloy-adapter.ts lattice/test/solvers/alloy-adapter.integration.test.ts
git commit -m "feat(lattice): alloy adapter — shim enumeration + XML instance parsing"
```

---

### Task 10: `astToQuint` — temporal/arithmetic queries

Only two candidate kinds are ever *solver-queried* on the Quint side: `statePredicate` and `conservation`. (`terminal`, `monotonic`, `leadsTo` are template-auto-adopted and never enter a distinguishing query in this slice — the emitter throws on them, documenting the boundary.)

**Files:**
- Create: `lattice/src/emit/quint.ts`
- Modify: `lattice/test/fixtures.ts` (add `traceBModel`)
- Test: `lattice/test/emit/quint.test.ts`

**Interfaces:**
- Consumes: `DomainModel` (Task 2), `Candidate` (Task 1), `SalientFact` (Task 6), `resolveFieldPath` (Task 1).
- Produces:

```ts
interface QuintQuery { kind: 'distinguish' | 'probe-forbid' | 'probe-permit'; hi: Candidate; hj?: Candidate; exclusions: SalientFact[][]; maxSteps: number }
interface QuintEmission { source: string; invariantName: string; varTypes: Record<string, string> }  // varName -> aggregate/entity name
function astToQuint(m: DomainModel, q: QuintQuery): QuintEmission
```
Conventions Task 11 relies on: every aggregate/entity becomes `var <lowerPlural>: str -> { exists: bool, … }`; machine state is record field `<Region>_state: str`; refs are id strings into the target map; `Int|Money|Date|Duration` are `int`; the clock is `var now: int`; the invariant to verify is named `q_inv`; the step action is `step`.

- [ ] **Step 1: Add the trace-B fixture**

Append to `lattice/test/fixtures.ts`:
```ts
export const traceBModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [{ name: 'InvStatus', values: ['Paid', 'Unpaid'] }],
  entities: [],
  aggregates: [
    { kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'status', type: { kind: 'enum', enum: 'InvStatus' } },
      { name: 'dueDate', type: { kind: 'prim', prim: 'Date' } }] },
    { kind: 'aggregate', name: 'Subscription', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'grace', type: { kind: 'prim', prim: 'Duration' } },
      { name: 'invoice', type: { kind: 'ref', target: 'Invoice' } }],
      machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [
        { name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Suspended' }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] } }
  ],
  events: []
};

import type { Candidate } from '../src/ast/invariant.js';
export const graceCandidate = (withGrace: boolean): Candidate => ({
  kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['invoice', 'status'] }, right: { kind: 'enumval', enum: 'InvStatus', value: 'Unpaid' } }]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' },
      right: withGrace
        ? { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } }
        : { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] } } }
});
```

- [ ] **Step 2: Write the failing test**

`lattice/test/emit/quint.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate } from '../fixtures.js';

describe('astToQuint', () => {
  const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(false), hj: graceCandidate(true), exclusions: [], maxSteps: 8 });

  it('emits vars, pools, init, step, and the agreement invariant', () => {
    expect(em.source).toContain('var now: int');
    expect(em.source).toContain('var subscriptions: str ->');
    expect(em.source).toContain('var invoices: str ->');
    expect(em.source).toContain('action step =');
    expect(em.source).toContain('val q_inv = iff(Hi, Hj)');
    expect(em.invariantName).toBe('q_inv');
    expect(em.varTypes).toEqual({ subscriptions: 'Subscription', invoices: 'Invoice' });
  });
  it('resolves cross-entity ref paths through map lookups', () => {
    expect(em.source).toContain('invoices.get(x.invoice).dueDate');
    expect(em.source).toContain('invoices.get(x.invoice).status');
  });
  it('emits a generic region mutator when no transitions are declared', () => {
    expect(em.source).toContain('set_Subscription_Access');
  });
  it('probe-forbid inverts the invariant with shape exclusions ORed in', () => {
    const p = astToQuint(traceBModel, { kind: 'probe-forbid', hi: graceCandidate(true), exclusions: [[
      { dim: 'now le invoice.dueDate + grace', value: false }, { dim: 'invoice.status = Unpaid', value: true }
    ]], maxSteps: 8 });
    expect(p.source).toContain('val q_inv = Hi or shape0');
    expect(p.source).toContain('val shape0 =');
  });
});
```

- [ ] **Step 3: Run to verify FAIL**, then **Step 4: Implement**

`lattice/src/emit/quint.ts`:
```ts
import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import type { Candidate, Cmp, Path, Predicate, Term } from '../ast/invariant.js';
import type { SalientFact } from '../engine/session.js';

export interface QuintQuery { kind: 'distinguish' | 'probe-forbid' | 'probe-permit'; hi: Candidate; hj?: Candidate; exclusions: SalientFact[][]; maxSteps: number }
export interface QuintEmission { source: string; invariantName: string; varTypes: Record<string, string> }

const varName = (n: string) => n.charAt(0).toLowerCase() + n.slice(1) + 's';
const isIntPrim = (p: string) => ['Int', 'Money', 'Date', 'Duration'].includes(p);
const INT_POOL = 'Set(0, 24, 72, 100)';
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];

function fieldQType(m: DomainModel, f: Field): string | null {
  if (f.key) return null;
  if (f.type.kind === 'ref') return 'str';
  if (f.type.kind === 'enum') return 'str';
  if (f.type.kind === 'prim') return isIntPrim(f.type.prim) ? 'int' : null;   // Text/Id dropped
  return null;   // lists unsupported in slice-1 quint emission
}
function initValue(m: DomainModel, f: Field, nondets: string[], tag: string): string | null {
  const t = fieldQType(m, f);
  if (!t) return null;
  const nd = `nd_${tag}_${f.name}`;
  if (f.type.kind === 'enum') {
    const vals = m.enums.find(e => e.name === (f.type as any).enum)!.values.map(v => `"${v}"`).join(', ');
    nondets.push(`nondet ${nd} = oneOf(Set(${vals}))`);
  } else if (f.type.kind === 'ref') {
    nondets.push(`nondet ${nd} = oneOf(${(f.type as any).target.toUpperCase()}_IDS)`);
  } else nondets.push(`nondet ${nd} = oneOf(${INT_POOL})`);
  return nd;
}

function termToQuint(m: DomainModel, t: Term, self: string, ownerName: string): string {
  switch (t.kind) {
    case 'int': return String(t.value);
    case 'enumval': return `"${t.value}"`;
    case 'now': return 'now';
    case 'plus': return `${termToQuint(m, t.left, self, ownerName)} + ${termToQuint(m, t.right, self, ownerName)}`;
    case 'field': return pathToQuint(m, t.path, self, ownerName);
  }
}
function pathToQuint(m: DomainModel, path: Path, self: string, ownerName: string): string {
  let expr = self, owner = ownerName;
  for (let i = 0; i < path.length; i++) {
    const def = owners(m).find(o => o.name === owner)!;
    const f = def.fields.find(x => x.name === path[i])!;
    expr = `${expr}.${path[i]}`;
    if (i < path.length - 1 && f.type.kind === 'ref') {
      owner = f.type.target;
      expr = `${varName(owner)}.get(${expr})`;
    }
  }
  return expr;
}
function predToQuint(m: DomainModel, p: Predicate, self: string, ownerName: string): string {
  switch (p.kind) {
    case 'cmp': {
      const ops: Record<Cmp, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      return `(${termToQuint(m, p.left, self, ownerName)} ${ops[p.op]} ${termToQuint(m, p.right, self, ownerName)})`;
    }
    case 'inState': return '(' + p.states.map(s => `${self}.${p.region}_state == "${s}"`).join(' or ') + ')';
    case 'and': return '(' + p.args.map(a => predToQuint(m, a, self, ownerName)).join(' and ') + ')';
    case 'or': return '(' + p.args.map(a => predToQuint(m, a, self, ownerName)).join(' or ') + ')';
    case 'not': return `(not(${predToQuint(m, p.arg, self, ownerName)}))`;
    case 'implies': return `(${predToQuint(m, p.left, self, ownerName)} implies ${predToQuint(m, p.right, self, ownerName)})`;
  }
}

function candidateToQuint(m: DomainModel, c: Candidate, name: string): string {
  const v = varName(c.aggregate);
  if (c.kind === 'statePredicate') {
    const guard = c.where ? `${predToQuint(m, c.where, 'x', c.aggregate)} implies ` : '';
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) { not(x.exists) or (${guard}${predToQuint(m, c.body, 'x', c.aggregate)}) } })`;
  }
  if (c.kind === 'conservation') {
    const parts = c.parts.map(p => pathToQuint(m, p, 'x', c.aggregate)).join(' + ');
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) { not(x.exists) or (${parts} == ${pathToQuint(m, c.total, 'x', c.aggregate)}) } })`;
  }
  throw new Error(`${c.kind} is never solver-queried on quint in slice-1 (template auto-adopt only)`);
}

/** Rebuild judged shapes: match salient dims against the candidates' comparisons + enum-eq facts. */
function shapeToQuint(m: DomainModel, facts: SalientFact[], cands: Candidate[], name: string): string {
  const agg = cands[0]!.aggregate;
  const v = varName(agg);
  const conj: string[] = [];
  for (const f of facts) {
    const mVal = f.dim.match(/^([\w.]+) = (\w+)$/);
    if (mVal) { conj.push(`${pathToQuint(m, mVal[1]!.split('.'), 'x', agg)} == "${mVal[2]}"`); continue; }
    const mCmp = f.dim.match(/^(.+) (eq|ne|lt|le|gt|ge) (.+)$/);
    if (mCmp) {
      const ops: Record<string, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      const render = (s: string) => s.split(' + ').map(part => part === 'now' || /^\d+$/.test(part) ? part : pathToQuint(m, part.split('.'), 'x', agg)).join(' + ');
      conj.push(`(${render(mCmp[1]!)} ${ops[mCmp[2]!]} ${render(mCmp[3]!)}) == ${f.value}`);
    }
  }
  return `val ${name} = ${v}.keys().exists(k => { val x = ${v}.get(k) { x.exists and ${conj.join(' and ') || 'true'} } })`;
}

export function astToQuint(m: DomainModel, q: QuintQuery): QuintEmission {
  const varTypes: Record<string, string> = {};
  const decls: string[] = ['var now: int'];
  const pools: string[] = [];
  const initNondets: string[] = [];
  const initSets: string[] = [`now' = 0`];
  const allVars = ['now', ...owners(m).map(o => varName(o.name))];
  const frame = (changed: string[]) => allVars.filter(v => !changed.includes(v)).map(v => `${v}' = ${v}`);
  const actions: string[] = [];

  for (const o of owners(m)) {
    const v = varName(o.name);
    varTypes[v] = o.name;
    const fields = o.fields.map(f => { const t = fieldQType(m, f); return t ? `${f.name}: ${t}` : null; }).filter(Boolean) as string[];
    const machine = (o as AggregateDef).machine;
    for (const r of machine?.regions ?? []) fields.push(`${r.name}_state: str`);
    decls.push(`var ${v}: str -> { exists: bool, ${fields.join(', ')} }`);
    pools.push(`val ${o.name.toUpperCase()}_IDS = Set("${o.name.toLowerCase()}1", "${o.name.toLowerCase()}2")`);

    const inits: string[] = [`exists: ${machine ? 'true' : 'false'}`];   // machine-bearing exist from init; plain entities are created
    for (const f of o.fields) {
      const nd = initValue(m, f, initNondets, o.name.toLowerCase());
      if (nd) inits.push(`${f.name}: ${nd}`);
    }
    for (const r of machine?.regions ?? []) inits.push(`${r.name}_state: "${r.initial}"`);
    initSets.push(`${v}' = ${o.name.toUpperCase()}_IDS.mapBy(id => { ${inits.join(', ')} })`);

    // actions: declared transitions; generic region mutator when a region has none; create for non-machine entities; enum mutators
    for (const r of machine?.regions ?? []) {
      const declared = (machine!.transitions ?? []).filter(t => t.region === r.name);
      for (const t of declared) actions.push(
        `action trans_${o.name}_${t.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) all { ${v}.get(id).${r.name}_state == "${t.from}", ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", "${t.to}")), ${frame([v]).join(', ')} } }`);
      if (declared.length === 0) actions.push(
        `action set_${o.name}_${r.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet s = oneOf(Set(${r.states.map(x => `"${x.name}"`).join(', ')})) all { ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", s)), ${frame([v]).join(', ')} } }`);
    }
    if (!machine) {
      const nds: string[] = []; const sets: string[] = ['exists: true'];
      for (const f of o.fields) { const nd = initValue(m, f, nds, `c_${o.name.toLowerCase()}`); if (nd) sets.push(`${f.name}: ${nd}`); }
      actions.push(`action create_${o.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) ${nds.join(' ')} all { ${v}' = ${v}.set(id, { ${sets.join(', ')} }), ${frame([v]).join(', ')} } }`);
    }
    for (const f of o.fields.filter(f => f.type.kind === 'enum')) {
      const vals = m.enums.find(e => e.name === (f.type as any).enum)!.values.map(x => `"${x}"`).join(', ');
      actions.push(`action mut_${o.name}_${f.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet nv = oneOf(Set(${vals})) all { ${v}' = ${v}.set(id, ${v}.get(id).with("${f.name}", nv)), ${frame([v]).join(', ')} } }`);
    }
  }
  actions.push(`action tick = { nondet dt = oneOf(Set(1, 5, 24, 120)) all { now' = now + dt, ${frame(['now']).join(', ')} } }`);

  const preds: string[] = [candidateToQuint(m, q.hi, 'Hi')];
  if (q.hj) preds.push(candidateToQuint(m, q.hj, 'Hj'));
  q.exclusions.forEach((facts, i) => preds.push(shapeToQuint(m, facts, [q.hi, ...(q.hj ? [q.hj] : [])], `shape${i}`)));
  const shapes = q.exclusions.map((_, i) => `shape${i}`);
  const inv = q.kind === 'distinguish' ? ['iff(Hi, Hj)', ...shapes].join(' or ')
    : q.kind === 'probe-forbid' ? ['Hi', ...shapes].join(' or ')
    : `not(${['Hi', ...shapes.map(s => `not(${s})`)].join(' and ')})`;
  preds.push(`val q_inv = ${inv}`);

  const actionNames = actions.map(a => a.split(' ')[1]!);
  const source = `module lattice_q {
${decls.map(d => '  ' + d).join('\n')}

${pools.map(p => '  ' + p).join('\n')}

  action init = { ${initNondets.join(' ')} all { ${initSets.join(', ')} } }

${actions.map(a => '  ' + a).join('\n')}

  action step = any { ${actionNames.join(', ')} }

${preds.map(p => '  ' + p).join('\n')}
}
`;
  return { source, invariantName: 'q_inv', varTypes };
}
```

- [ ] **Step 5: Run to verify PASS**, then sanity-parse the emission with quint itself:

```bash
cd lattice && npx vitest run test/emit/quint.test.ts
npx tsx -e "import{astToQuint}from'./src/emit/quint.js';import{traceBModel,graceCandidate}from'./test/fixtures.js';import{writeFileSync}from'fs';writeFileSync('/tmp/q.qnt',astToQuint(traceBModel,{kind:'distinguish',hi:graceCandidate(false),hj:graceCandidate(true),exclusions:[],maxSteps:8}).source)"
npx quint parse /tmp/q.qnt
```
Expected: vitest PASS; `quint parse` reports no errors (fix emission syntax here if it complains — this is budgeted spike work; common gotchas: record `.with(...)` field-name quoting, `mapBy` signature).

- [ ] **Step 6: Commit**

```bash
git add lattice/src/emit/quint.ts lattice/test/emit/quint.test.ts lattice/test/fixtures.ts
git commit -m "feat(lattice): astToQuint — map-based state, generic mutators, agreement invariants"
```

---

### Task 11: Quint/Apalache adapter — verify, ITF parsing, latency

**Files:**
- Create: `lattice/src/solvers/quint-adapter.ts`
- Test: `lattice/test/solvers/quint-adapter.integration.test.ts`

**Interfaces:**
- Consumes: `QuintEmission` (Task 10), `findJava` (Task 5), `CaseState` (Task 3).
- Produces: `runQuint(em: QuintEmission, maxSteps: number): Promise<QuintResult>` where `QuintResult = { violated: boolean; witness?: CaseState; ms: number }`. `witness.trace` carries prior states (for table context); `witness.now` set from the `now` var; `<Region>_state` record fields become `<Region>.state`; non-existing (`exists: false`) entities are dropped. The planner (Task 14) treats `violated: true` ⇒ witness found, `false` ⇒ merge/exhausted (per query kind).

- [ ] **Step 1: Write the failing integration test**

`lattice/test/solvers/quint-adapter.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { runQuint } from '../../src/solvers/quint-adapter.js';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate } from '../fixtures.js';

describe('quint adapter (integration)', () => {
  it('finds a disagreement witness between grace-0 and grace-window rules', async () => {
    const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(false), hj: graceCandidate(true), exclusions: [], maxSteps: 8 });
    const r = await runQuint(em, 8);
    expect(r.violated).toBe(true);
    const w = r.witness!;
    expect(w.now).toBeTypeOf('number');
    const sub = w.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields['Access.state']).toBeDefined();
    expect(r.ms).toBeLessThan(45_000);
  }, 180_000);

  it('reports no violation for a candidate against itself (merge signal)', async () => {
    const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(true), hj: graceCandidate(true), exclusions: [], maxSteps: 5 });
    const r = await runQuint(em, 5);
    expect(r.violated).toBe(false);
  }, 180_000);
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/solvers/quint-adapter.ts`:
```ts
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { findJava } from './doctor.js';
import type { QuintEmission } from '../emit/quint.js';
import type { CaseEntity, CaseState } from '../engine/evaluate.js';

const exec = promisify(execFile);
export interface QuintResult { violated: boolean; witness?: CaseState; ms: number }

export async function runQuint(em: QuintEmission, maxSteps: number): Promise<QuintResult> {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'quint-'));
  const qnt = join(dir, 'q.qnt');
  const itf = join(dir, 'out.itf.json');
  writeFileSync(qnt, em.source);
  const env = { ...process.env, JAVA_HOME: dirname(dirname(findJava())) };
  try {
    await exec('npx', ['quint', 'verify', '--max-steps', String(maxSteps), '--invariant', em.invariantName, '--out-itf', itf, qnt],
      { env, timeout: 90_000 });
    return { violated: false, ms: Date.now() - t0 };            // exit 0 ⇒ invariant holds to bound
  } catch (e: any) {
    if (existsSync(itf)) {
      const witness = parseITF(JSON.parse(readFileSync(itf, 'utf8')), em.varTypes);
      return { violated: true, witness, ms: Date.now() - t0 };  // exit != 0 + trace ⇒ violation found
    }
    throw new Error(`quint verify failed without a counterexample: ${e.stderr ?? e.message}`);
  }
}

const deBig = (v: any): any => (v && typeof v === 'object' && '#bigint' in v) ? Number(v['#bigint']) : v;

function stateToEntities(st: Record<string, any>, varTypes: Record<string, string>): { now?: number; entities: CaseEntity[] } {
  const entities: CaseEntity[] = [];
  let now: number | undefined;
  for (const [k, raw] of Object.entries(st)) {
    if (k.startsWith('#')) continue;
    if (k === 'now') { now = deBig(raw); continue; }
    const type = varTypes[k];
    if (!type) continue;
    const pairs: [any, any][] = raw && raw['#map'] ? raw['#map'] : [];
    for (const [id, rec] of pairs) {
      if (rec.exists === false) continue;
      const fields: Record<string, string | number | boolean> = {};
      for (const [fk, fv] of Object.entries(rec)) {
        if (fk === 'exists') continue;
        fields[fk.replace(/_state$/, '.state')] = deBig(fv);
      }
      entities.push({ type, id: String(id), fields });
    }
  }
  return { now, entities };
}

export function parseITF(itf: any, varTypes: Record<string, string>): CaseState {
  const states: Record<string, any>[] = itf.states ?? [];
  const last = states[states.length - 1] ?? {};
  const { now, entities } = stateToEntities(last, varTypes);
  const trace = states.slice(0, -1).map(s => stateToEntities(s, varTypes).entities);
  return { now, entities, trace };
}
```

- [ ] **Step 4: Run to verify PASS (real Apalache — first run downloads it)**

Run: `cd lattice && npx vitest run test/solvers/quint-adapter.integration.test.ts`
Expected: PASS. First invocation is slow (Apalache download + JVM); note steady-state ms against the §2.4 budget (p50 ≤ 10s). If steady-state misses the budget, try `--max-steps` reduction first; if still over, this is kill-criterion-4 data — record it in the session notes, don't hide it.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/solvers/quint-adapter.ts lattice/test/solvers/quint-adapter.integration.test.ts
git commit -m "feat(lattice): quint/apalache adapter — verify agreement invariants, parse ITF witnesses"
```

---

### Task 12: Template matcher — the 8 slice templates

Auto-adopting templates make the "invariants come free" moment (§9). Seeds are *proposals* the skill folds into elicitation. Templates #6 and #11 jointly produce one grace-window seed shell (their golden use is trace B, where the seeded set is refined by Claude anyway); this merge is deliberate and documented here.

**Files:**
- Create: `lattice/src/engine/templates.ts`
- Test: `lattice/test/engine/templates.test.ts`

**Interfaces:**
- Consumes: `DomainModel` (Task 2), `CandidateInvariant` (Task 1).
- Produces: `matchTemplates(m: DomainModel): { adopt: CandidateInvariant[]; seeds: CandidateInvariant[] }`. Adopt = verified-shape, no question needed (#1 conservation, #2 non-negative, #3 terminal, #7-cardinality single-open, #8 monotonic, #9 no-orphan). Seeds = parameter-ambiguous proposals (#7-unique per ref, #6+#11 grace shell). Ids are deterministic: `tpl-<n>-<agg>[-<field>]`.

- [ ] **Step 1: Write the failing test**

`lattice/test/engine/templates.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { matchTemplates } from '../../src/engine/templates.js';
import type { DomainModel } from '../../src/ast/domain.js';

const revrecMini: DomainModel = {
  context: 'RevRec', ticksPerDay: 24,
  enums: [{ name: 'EntryKind', values: ['Recognition', 'Correction'] }],
  entities: [
    { kind: 'entity', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'monotonic'] },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] },
    { kind: 'entity', name: 'RevenueEntry', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'obligation', type: { kind: 'ref', target: 'Obligation' } },
      { name: 'kind', type: { kind: 'enum', enum: 'EntryKind' } }] }
  ],
  aggregates: [{ kind: 'aggregate', name: 'AccountingPeriod', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'Lifecycle', initial: 'Open', states: [{ name: 'Open', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }], transitions: [] } }],
  events: []
};

describe('matchTemplates', () => {
  const { adopt, seeds } = matchTemplates(revrecMini);
  const kinds = adopt.map(a => a.candidate.kind);

  it('#1 conservation from @balance/@total tags', () =>
    expect(adopt.some(a => a.candidate.kind === 'conservation' && a.candidate.aggregate === 'Obligation')).toBe(true));
  it('#2 non-negative for every Money field', () =>
    expect(adopt.filter(a => a.name.startsWith('NonNegative')).length).toBe(3));
  it('#3 terminal for @terminal states', () =>
    expect(adopt.some(a => a.candidate.kind === 'terminal' && (a.candidate as any).state === 'Closed')).toBe(true));
  it('#7 cardinality single-active when the tagged aggregate has no refs', () =>
    expect(adopt.some(a => a.candidate.kind === 'cardinality' && a.candidate.aggregate === 'AccountingPeriod' && (a.candidate as any).atMost === 1)).toBe(true));
  it('#8 monotonic from @monotonic tag', () =>
    expect(adopt.some(a => a.candidate.kind === 'monotonic')).toBe(true));
  it('#9 refsResolve for owners with refs', () =>
    expect(adopt.some(a => a.candidate.kind === 'refsResolve' && a.candidate.aggregate === 'RevenueEntry')).toBe(true));
  it('all adopted have template source + deterministic ids', () => {
    expect(adopt.every(a => a.source === 'template')).toBe(true);
    expect(new Set(adopt.map(a => a.id)).size).toBe(adopt.length);
  });
  it('#7-unique seeds fire for @active aggregates WITH refs (trace A model)', async () => {
    const { traceAModel } = await import('../fixtures.js');
    const r = matchTemplates(traceAModel);
    expect(r.seeds.some(s => s.candidate.kind === 'unique')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/engine/templates.ts`:
```ts
import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';

const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];
const mk = (id: string, name: string, candidate: Candidate, prior = 0.9): CandidateInvariant =>
  ({ id, name, prior, source: 'template', candidate });

export function matchTemplates(m: DomainModel): { adopt: CandidateInvariant[]; seeds: CandidateInvariant[] } {
  const adopt: CandidateInvariant[] = [];
  const seeds: CandidateInvariant[] = [];

  for (const o of owners(m)) {
    const refs = o.fields.filter(f => f.type.kind === 'ref');
    const machine = (o as AggregateDef).machine;

    // #1 conservation: >=2 @balance + a @total
    const balances = o.fields.filter(f => f.tags?.includes('balance'));
    const total = o.fields.find(f => f.tags?.includes('total'));
    if (balances.length >= 2 && total)
      adopt.push(mk(`tpl-1-${o.name}`, `Conservation_${o.name}`,
        { kind: 'conservation', aggregate: o.name, parts: balances.map(b => [b.name]), total: [total.name] }));

    // #2 non-negative for Money fields
    for (const f of o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money'))
      adopt.push(mk(`tpl-2-${o.name}-${f.name}`, `NonNegative_${o.name}_${f.name}`,
        { kind: 'statePredicate', aggregate: o.name,
          body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [f.name] }, right: { kind: 'int', value: 0 } } }));

    // #8 monotonic from @monotonic tag
    for (const f of o.fields.filter(f => f.tags?.includes('monotonic')))
      adopt.push(mk(`tpl-8-${o.name}-${f.name}`, `Monotonic_${o.name}_${f.name}`,
        { kind: 'monotonic', aggregate: o.name, field: [f.name] }));

    // #9 no-orphan for owners with refs
    if (refs.length > 0)
      adopt.push(mk(`tpl-9-${o.name}`, `NoOrphan_${o.name}`, { kind: 'refsResolve', aggregate: o.name }));

    for (const r of machine?.regions ?? []) {
      // #3 terminal
      for (const s of r.states.filter(s => s.tags?.includes('terminal')))
        adopt.push(mk(`tpl-3-${o.name}-${s.name}`, `Terminal_${o.name}_${s.name}`,
          { kind: 'terminal', aggregate: o.name, region: r.name, state: s.name }));

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

      // #6+#11 grace-window shell: @active states + a Duration field + a (possibly one-hop) Date path
      const duration = o.fields.find(f => f.type.kind === 'prim' && f.type.prim === 'Duration');
      const datePath = findDatePath(m, o);
      if (actives.length && duration && datePath)
        seeds.push(mk(`tpl-11-${o.name}`, `DeadlineBound_${o.name}`,
          { kind: 'statePredicate', aggregate: o.name,
            body: { kind: 'implies',
              left: { kind: 'inState', owner: 'self', region: r.name, states: actives },
              right: { kind: 'cmp', op: 'le', left: { kind: 'now' },
                right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: datePath }, right: { kind: 'field', owner: 'self', path: [duration.name] } } } } }, 0.5));
    }
  }
  return { adopt, seeds };
}

function findDatePath(m: DomainModel, o: AggregateDef | EntityDef): string[] | null {
  const direct = o.fields.find(f => f.type.kind === 'prim' && f.type.prim === 'Date');
  if (direct) return [direct.name];
  for (const f of o.fields) if (f.type.kind === 'ref') {
    const t = owners(m).find(x => x.name === (f.type as any).target);
    const d = t?.fields.find(x => x.type.kind === 'prim' && x.type.prim === 'Date');
    if (d) return [f.name, d.name];
  }
  return null;
}
```

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/engine/templates.ts lattice/test/engine/templates.test.ts
git commit -m "feat(lattice): 8-template matcher — auto-adopt + elicitation seeds"
```

---

### Task 13: Hypothesis manager — version space over the ledger

**Files:**
- Create: `lattice/src/engine/hypothesis.ts`
- Test: `lattice/test/engine/hypothesis.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `TrackedCandidate`, `LedgerEntry` (Task 6); `evaluateCandidate` (Task 3); `validateCandidate` (Task 1).
- Produces:
  - `registerCandidates(s: SessionState, invs: CandidateInvariant[]): void`
  - `activeCandidates(s: SessionState): TrackedCandidate[]`
  - `pruneOnVerdict(s: SessionState, witness: CaseState, judge: 'permit' | 'forbid'): { pruned: string[]; empty: boolean }` — a candidate is pruned iff `evaluateCandidate(c, witness) !== judge`.
  - `ledgerConflicts(c: Candidate, ledger: LedgerEntry[]): string[]` — witness ids of verdicts the candidate contradicts.
  - `admit(s: SessionState, inv: CandidateInvariant, m: DomainModel, ledger: LedgerEntry[]): { ok: true } | { ok: false; reason: string }` — grammar check + ledger-consistency + caps (`regen` ≤ 3 via `s.regenAttempts`, `alternative` ≤ 2 via `s.alternativeAttempts`; a *rejected* attempt increments the counter, an admitted regen also increments `regenAttempts`).
  - `markMerged(s: SessionState, loserId: string, winnerId: string): void`

- [ ] **Step 1: Write the failing test**

`lattice/test/engine/hypothesis.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { registerCandidates, activeCandidates, pruneOnVerdict, ledgerConflicts, admit, markMerged } from '../../src/engine/hypothesis.js';
import { newSession, type LedgerEntry } from '../../src/engine/session.js';
import { traceAModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const mkUnique = (id: string, by: string[][], prior: number): CandidateInvariant => ({
  id, name: id, prior, source: 'seed',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by }
});
const H1 = mkUnique('H1', [['customer']], 0.35);
const H2 = mkUnique('H2', [['customer'], ['plan']], 0.4);
const H3 = mkUnique('H3', [['customer'], ['plan', 'family']], 0.5);

const dpsf: CaseState = { entities: [
  { type: 'Plan', id: 'p1', fields: { family: 'fam1' } }, { type: 'Plan', id: 'p2', fields: { family: 'fam1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const dpdf: CaseState = { entities: [
  { type: 'Plan', id: 'p1', fields: { family: 'fam1' } }, { type: 'Plan', id: 'p3', fields: { family: 'fam2' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

describe('hypothesis manager', () => {
  it('prunes candidates that disagree with a verdict (trace-A Q1)', () => {
    const s = newSession();
    registerCandidates(s, [H1, H2]);
    const r = pruneOnVerdict(s, dpsf, 'forbid');    // expert forbids DPSF
    expect(r.pruned).toEqual(['H2']);               // H2 (per-plan) permitted it
    expect(activeCandidates(s).map(c => c.inv.id)).toEqual(['H1']);
  });
  it('empties the space when the survivor is refuted (trace-A Q2)', () => {
    const s = newSession();
    registerCandidates(s, [H1]);
    const r = pruneOnVerdict(s, dpdf, 'permit');    // expert permits DPDF; H1 forbids ⇒ refuted
    expect(r.empty).toBe(true);
  });
  it('ledgerConflicts validates a regen against every verdict', () => {
    const ledger: LedgerEntry[] = [
      { kind: 'verdict', at: 't', witnessId: 'w1', witness: dpsf, salient: [], judge: 'forbid', question: '' },
      { kind: 'verdict', at: 't', witnessId: 'w2', witness: dpdf, salient: [], judge: 'permit', question: '' }
    ];
    expect(ledgerConflicts(H3.candidate, ledger)).toEqual([]);       // fits both
    expect(ledgerConflicts(H1.candidate, ledger)).toEqual(['w2']);   // forbids the permitted DPDF
  });
  it('admit enforces the regen cap and ledger consistency', () => {
    const s = newSession();
    const ledger: LedgerEntry[] = [{ kind: 'verdict', at: 't', witnessId: 'w2', witness: dpdf, salient: [], judge: 'permit', question: '' }];
    const bad = { ...H1, id: 'R1', source: 'regen' as const };
    expect(admit(s, bad, traceAModel, ledger).ok).toBe(false);
    expect(s.regenAttempts).toBe(1);
    const good = { ...H3, id: 'R2', source: 'regen' as const };
    expect(admit(s, good, traceAModel, ledger).ok).toBe(true);
    s.regenAttempts = 3;
    expect(admit(s, { ...H3, id: 'R3', source: 'regen' }, traceAModel, ledger)).toEqual({ ok: false, reason: 'regen cap (3) reached — park as open decision' });
  });
  it('markMerged retires the loser', () => {
    const s = newSession();
    registerCandidates(s, [H1, H2]);
    markMerged(s, 'H1', 'H2');
    expect(activeCandidates(s).map(c => c.inv.id)).toEqual(['H2']);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/engine/hypothesis.ts`:
```ts
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import type { DomainModel } from '../ast/domain.js';
import { validateCandidate } from '../ast/grammar.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';
import type { LedgerEntry, SessionState, TrackedCandidate } from './session.js';

export function registerCandidates(s: SessionState, invs: CandidateInvariant[]): void {
  for (const inv of invs) s.candidates.push({ inv, status: 'active' });
}
export const activeCandidates = (s: SessionState): TrackedCandidate[] =>
  s.candidates.filter(c => c.status === 'active');

export function pruneOnVerdict(s: SessionState, witness: CaseState, judge: 'permit' | 'forbid'): { pruned: string[]; empty: boolean } {
  const pruned: string[] = [];
  for (const c of activeCandidates(s)) {
    if (evaluateCandidate(c.inv.candidate, witness) !== judge) { c.status = 'pruned'; pruned.push(c.inv.id); }
  }
  return { pruned, empty: activeCandidates(s).length === 0 };
}

export function ledgerConflicts(c: Candidate, ledger: LedgerEntry[]): string[] {
  return ledger.filter(e => e.kind === 'verdict' && evaluateCandidate(c, e.witness) !== e.judge)
    .map(e => (e as any).witnessId);
}

export function admit(s: SessionState, inv: CandidateInvariant, m: DomainModel, ledger: LedgerEntry[]): { ok: true } | { ok: false; reason: string } {
  if (inv.source === 'regen' && s.regenAttempts >= 3)
    return { ok: false, reason: 'regen cap (3) reached — park as open decision' };
  if (inv.source === 'alternative' && s.alternativeAttempts >= 2)
    return { ok: false, reason: 'alternatives exhausted — converged' };
  const bump = () => { if (inv.source === 'regen') s.regenAttempts++; else if (inv.source === 'alternative') s.alternativeAttempts++; };

  const gram = validateCandidate(inv.candidate, m);
  if (gram.length) { bump(); return { ok: false, reason: `out of grammar: ${gram.map(d => d.code).join(', ')}` }; }
  const conflicts = ledgerConflicts(inv.candidate, ledger);
  if (conflicts.length) { bump(); return { ok: false, reason: `contradicts verdicts: ${conflicts.join(', ')}` }; }
  bump();
  s.candidates.push({ inv, status: 'active' });
  return { ok: true };
}

export function markMerged(s: SessionState, loserId: string, winnerId: string): void {
  const c = s.candidates.find(x => x.inv.id === loserId);
  if (c) { c.status = 'merged'; c.mergedInto = winnerId; }
}
```

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/engine/hypothesis.ts lattice/test/engine/hypothesis.test.ts
git commit -m "feat(lattice): hypothesis manager — prune, ledger-consistency, caps"
```

---

### Task 14: Question planner — the full policy

The policy (pinned; reproduces all three golden traces — see spec §2 and the trace analyses):

1. **≥ 2 active candidates** → distinguish the highest-combined-prior still-separable pair. Route the *pair* to Quint if either candidate routes to Quint. Exclusions = salient shapes of every judged verdict. Witness ⇒ question. No witness ⇒ merge (lower prior into higher), try next pair.
2. **Sole survivor** with `source` `seed`/`template`:
   a. **forbid-side probe** (mandatory, once): find states H forbids, excluding judged shapes. Alloy enumerates ≤ 3 options; Quint returns 1. Claude picks the most-plausibly-permitted option to ask (the skill's job). No such state ⇒ mark probed, continue. (Judged-shape exclusion is what makes trace B's probe UNSAT — no third question.)
   b. **permit-side probe** (once, only if the ledger holds no verdict the survivor permits): find a non-vacuous state H permits, excluding judged shapes.
3. **Sole survivor** with `source` `regen`/`alternative` → skip probes (it was fitted to the ledger; over-fit is checked by alternatives).
4. **Alternatives phase**: Claude must submit alternatives (`admit` with `source: 'alternative'`); each is also checked for *distinctness* (a distinguish query vs. the survivor: no witness ⇒ equivalent ⇒ rejected without burning the loop). Two failed attempts ⇒ **converged**.
5. **Empty space** → `regenerate` (cap 3, then `parked`).

**Files:**
- Create: `lattice/src/engine/planner.ts`
- Test: `lattice/test/engine/planner.test.ts` (fake solvers — this test IS trace A's logic; Task 17 reruns it with real Alloy)

**Interfaces:**
- Consumes: everything above (hypothesis, salient, session, emitters' query types).
- Produces:

```ts
interface SolverDeps {
  alloy(m: DomainModel, q: AlloyQuery, max: number): Promise<{ sat: boolean; instances: CaseState[]; ms: number }>;
  quint(m: DomainModel, q: QuintQuery): Promise<{ violated: boolean; witness?: CaseState; ms: number }>;
}
type PlannerOutput =
  | { type: 'question'; witnessId: string; purpose: 'distinguish' | 'probe-forbid' | 'probe-permit'; pair?: [string, string]; witness: CaseState; table: string; salient: SalientFact[]; ms: number }
  | { type: 'probe-options'; purpose: 'probe-forbid' | 'probe-permit'; options: { witnessId: string; witness: CaseState; table: string; salient: SalientFact[] }[]; ms: number }
  | { type: 'merged'; loser: string; winner: string }
  | { type: 'need-alternatives'; attemptsLeft: number }
  | { type: 'regenerate'; attemptsLeft: number }
  | { type: 'parked'; reason: string }
  | { type: 'converged' };
function nextQuestion(s: SessionState, ledger: LedgerEntry[], m: DomainModel, deps: SolverDeps): Promise<PlannerOutput>
function checkDistinct(survivor: Candidate, alt: Candidate, m: DomainModel, deps: SolverDeps): Promise<boolean>
```
Witness ids: `w<n>` where n = ledger verdict count + pendingWitnesses count + 1 (+ option index).

- [ ] **Step 1: Write the failing test (trace-A logic against fake solvers)**

`lattice/test/engine/planner.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { nextQuestion, checkDistinct } from '../../src/engine/planner.js';
import { registerCandidates, pruneOnVerdict, admit } from '../../src/engine/hypothesis.js';
import { newSession, type LedgerEntry, type SessionState } from '../../src/engine/session.js';
import { extractSalient } from '../../src/engine/salient.js';
import { traceAModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const mkU = (id: string, by: string[][], prior: number): CandidateInvariant => ({
  id, name: id, prior, source: 'seed',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by }
});
const H1 = mkU('H1', [['customer']], 0.35);
const H2 = mkU('H2', [['customer'], ['plan']], 0.40);
const H4: CandidateInvariant = { id: 'H4', name: 'H4', prior: 0.25, source: 'seed',
  candidate: { kind: 'cardinality', aggregate: 'Subscription', where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] }, atMost: 99 } };

const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p2', fields: { family: 'f1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const dpdf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} }, { type: 'Family', id: 'f2', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p3', fields: { family: 'f2' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

// Fake solver: scripted by call order for the distinguish/probe queries trace A makes.
function fakeDeps(script: CaseState[][]): any {
  let call = 0;
  return {
    alloy: async () => {
      const instances = script[call++] ?? [];
      return { sat: instances.length > 0, instances, ms: 5 };
    },
    quint: async () => { throw new Error('trace A never routes to quint'); }
  };
}

async function judge(s: SessionState, ledger: LedgerEntry[], out: any, judgeAs: 'permit' | 'forbid', witness: CaseState, cands: CandidateInvariant[]) {
  const salient = extractSalient(cands.map(c => c.candidate), witness);
  ledger.push({ kind: 'verdict', at: 't', witnessId: out.witnessId ?? out.options[0].witnessId, witness, salient, judge: judgeAs, question: 'q' });
  return pruneOnVerdict(s, witness, judgeAs);
}

describe('planner — trace A logic with fake solvers', () => {
  it('runs Q1 distinguish → prune → forbid-probe → refute → regenerate → alternatives → converged', async () => {
    const s = newSession(); s.phase = 'distinguish';
    const ledger: LedgerEntry[] = [];
    registerCandidates(s, [H1, H2, H4]);
    const deps = fakeDeps([[dpsf], [dpdf]]);   // Q1 witness, then probe options

    // Q1: top pair by combined prior = (H2, H1) → DPSF
    const q1 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q1.type).toBe('question');
    const r1 = await judge(s, ledger, q1, 'forbid', dpsf, [H1, H2, H4]);
    expect(r1.pruned.sort()).toEqual(['H2', 'H4']);          // both permitted DPSF

    // Sole survivor H1 (seed) → mandatory forbid-side probe → DPDF among options
    const q2 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q2.type).toBe('probe-options');
    const r2 = await judge(s, ledger, { witnessId: (q2 as any).options[0].witnessId }, 'permit', dpdf, [H1]);
    expect(r2.empty).toBe(true);                              // H1 refuted

    // Empty → regenerate
    const q3 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q3).toEqual({ type: 'regenerate', attemptsLeft: 3 });

    // Claude regenerates H3 = per (customer, family) — fits ledger
    const H3: CandidateInvariant = { id: 'H3', name: 'H3', prior: 0.9, source: 'regen',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] } };
    expect(admit(s, H3, traceAModel, ledger).ok).toBe(true);

    // Sole survivor with source=regen → NO probes → alternatives phase
    const q4 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q4).toEqual({ type: 'need-alternatives', attemptsLeft: 2 });

    // Two failed alternative attempts (one ledger-inconsistent, one equivalent) → converged
    expect(admit(s, { ...H1, id: 'A1', source: 'alternative' }, traceAModel, ledger).ok).toBe(false); // contradicts w2
    s.alternativeAttempts = 2;   // second attempt: checkDistinct returned false (equivalent) — counted by CLI
    const q5 = await nextQuestion(s, ledger, traceAModel, deps);
    expect(q5).toEqual({ type: 'converged' });
  });

  it('checkDistinct: UNSAT distinguish ⇒ equivalent ⇒ false', async () => {
    const deps = fakeDeps([[]]);
    expect(await checkDistinct(H1.candidate, H1.candidate, traceAModel, deps)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/engine/planner.ts`:
```ts
import type { Candidate } from '../ast/invariant.js';
import type { DomainModel } from '../ast/domain.js';
import { routeCandidate } from '../ast/grammar.js';
import type { AlloyQuery } from '../emit/alloy.js';
import type { QuintQuery } from '../emit/quint.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';
import { activeCandidates } from './hypothesis.js';
import { extractSalient, renderWitnessTable, salientKey } from './salient.js';
import type { LedgerEntry, SalientFact, SessionState } from './session.js';

export interface SolverDeps {
  alloy(m: DomainModel, q: AlloyQuery, max: number): Promise<{ sat: boolean; instances: CaseState[]; ms: number }>;
  quint(m: DomainModel, q: QuintQuery): Promise<{ violated: boolean; witness?: CaseState; ms: number }>;
}
export type PlannerOutput =
  | { type: 'question'; witnessId: string; purpose: 'distinguish' | 'probe-forbid' | 'probe-permit'; pair?: [string, string]; witness: CaseState; table: string; salient: SalientFact[]; ms: number }
  | { type: 'probe-options'; purpose: 'probe-forbid' | 'probe-permit'; options: { witnessId: string; witness: CaseState; table: string; salient: SalientFact[] }[]; ms: number }
  | { type: 'merged'; loser: string; winner: string }
  | { type: 'need-alternatives'; attemptsLeft: number }
  | { type: 'regenerate'; attemptsLeft: number }
  | { type: 'parked'; reason: string }
  | { type: 'converged' };

const verdicts = (ledger: LedgerEntry[]) => ledger.filter(e => e.kind === 'verdict') as Extract<LedgerEntry, { kind: 'verdict' }>[];
const exclusionsFrom = (ledger: LedgerEntry[]): SalientFact[][] => verdicts(ledger).map(v => v.salient).filter(s => s.length > 0);
const wid = (s: SessionState, ledger: LedgerEntry[], extra = 0) =>
  `w${verdicts(ledger).length + Object.keys(s.pendingWitnesses).length + 1 + extra}`;

async function solve(m: DomainModel, hi: Candidate, hj: Candidate | undefined,
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit', exclusions: SalientFact[][], deps: SolverDeps, max: number,
): Promise<{ witnesses: CaseState[]; ms: number }> {
  const engine = hj && routeCandidate(hj) === 'quint' ? 'quint' : routeCandidate(hi);
  if (engine === 'alloy') {
    const r = await deps.alloy(m, { kind, hi, hj, exclusions, scope: 4 }, max);
    return { witnesses: r.sat ? r.instances : [], ms: r.ms };
  }
  const r = await deps.quint(m, { kind, hi, hj, exclusions, maxSteps: 10 });
  return { witnesses: r.violated && r.witness ? [r.witness] : [], ms: r.ms };
}

export async function checkDistinct(survivor: Candidate, alt: Candidate, m: DomainModel, deps: SolverDeps): Promise<boolean> {
  const { witnesses } = await solve(m, survivor, alt, 'distinguish', [], deps, 1);
  return witnesses.length > 0;
}

export async function nextQuestion(s: SessionState, ledger: LedgerEntry[], m: DomainModel, deps: SolverDeps): Promise<PlannerOutput> {
  const exclusions = exclusionsFrom(ledger);
  const active = () => activeCandidates(s);

  // 1. Distinguish highest-combined-prior separable pair
  while (active().length >= 2) {
    const sorted = [...active()].sort((a, b) => b.inv.prior - a.inv.prior);
    let advanced = false;
    for (let i = 0; i < sorted.length && !advanced; i++) for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i]!, sorted[j]!];
      const { witnesses, ms } = await solve(m, a.inv.candidate, b.inv.candidate, 'distinguish', exclusions, deps, 1);
      if (witnesses.length === 0) {                          // equivalent over scope ⇒ merge, never ask
        const [win, lose] = a.inv.prior >= b.inv.prior ? [a, b] : [b, a];
        lose.status = 'merged'; lose.mergedInto = win.inv.id;
        return { type: 'merged', loser: lose.inv.id, winner: win.inv.id };
      }
      const witness = witnesses[0]!;
      const salient = extractSalient(active().map(c => c.inv.candidate), witness);
      const witnessId = wid(s, ledger);
      s.pendingWitnesses[witnessId] = { witness, purpose: 'distinguish', pair: [a.inv.id, b.inv.id], salient };
      s.phase = 'distinguish';
      return { type: 'question', witnessId, purpose: 'distinguish', pair: [a.inv.id, b.inv.id], witness, salient,
        table: renderWitnessTable(witness, m.ticksPerDay), ms };
    }
    if (!advanced) break;
  }

  // 5. Empty space → regenerate (capped)
  if (active().length === 0) {
    if (s.regenAttempts >= 3) return { type: 'parked', reason: 'regen cap reached — record an open decision' };
    s.phase = 'regenerate';
    return { type: 'regenerate', attemptsLeft: 3 - s.regenAttempts };
  }

  // 2–3. Sole survivor: probes for a-priori candidates only
  const H = active()[0]!;
  const apriori = H.inv.source === 'seed' || H.inv.source === 'template';
  if (apriori && !s.probesAsked.forbid) {
    const { witnesses, ms } = await solve(m, H.inv.candidate, undefined, 'probe-forbid', exclusions, deps, 3);
    s.probesAsked.forbid = true;
    if (witnesses.length > 0) {
      s.phase = 'probe-forbid';
      const options = witnesses.map((w, i) => {
        const salient = extractSalient([H.inv.candidate], w);
        const witnessId = wid(s, ledger, i);
        s.pendingWitnesses[witnessId] = { witness: w, purpose: 'probe-forbid', salient };
        return { witnessId, witness: w, table: renderWitnessTable(w, m.ticksPerDay), salient };
      });
      return { type: 'probe-options', purpose: 'probe-forbid', options, ms };
    }
  }
  const hasPermitEvidence = verdicts(ledger).some(v => v.judge === 'permit' && evaluateCandidate(H.inv.candidate, v.witness) === 'permit');
  if (apriori && !s.probesAsked.permit && !hasPermitEvidence) {
    const { witnesses, ms } = await solve(m, H.inv.candidate, undefined, 'probe-permit', exclusions, deps, 3);
    s.probesAsked.permit = true;
    if (witnesses.length > 0) {
      s.phase = 'probe-permit';
      const options = witnesses.map((w, i) => {
        const salient = extractSalient([H.inv.candidate], w);
        const witnessId = wid(s, ledger, i);
        s.pendingWitnesses[witnessId] = { witness: w, purpose: 'probe-permit', salient };
        return { witnessId, witness: w, table: renderWitnessTable(w, m.ticksPerDay), salient };
      });
      return { type: 'probe-options', purpose: 'probe-permit', options, ms };
    }
  }

  // 4. Alternatives phase → converged after 2 failed attempts
  if (s.alternativeAttempts >= 2) { s.phase = 'converged'; return { type: 'converged' }; }
  s.phase = 'alternatives';
  return { type: 'need-alternatives', attemptsLeft: 2 - s.alternativeAttempts };
}
```

(The `advanced` flag is vestigial-looking but correct: the inner loop always returns; `break` guards the impossible fall-through. Keep the structure simple — if your implementation differs, the test is the contract.)

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/engine/planner.ts lattice/test/engine/planner.test.ts
git commit -m "feat(lattice): question planner — distinguish/merge, two-sided probes, alternatives convergence"
```

---

### Task 15: Projections — `astToProse` + `astToCode`

**Files:**
- Create: `lattice/src/emit/prose.ts`, `lattice/src/emit/code.ts`
- Test: `lattice/test/emit/projections.test.ts`

**Interfaces:**
- Consumes: `DomainModel`, `CandidateInvariant`, `LedgerEntry`.
- Produces: `astToProse(m: DomainModel, adopted: CandidateInvariant[], ledger: LedgerEntry[]): string` (spec plan §17 shape: lifecycle, "Always true" with ledger anchors, "Eventually", "⚠️ Open decisions"); `astToCode(m: DomainModel, adopted: CandidateInvariant[]): string` (`.lat` pretty-print, spec plan §5.2 shape); `renderCandidateEnglish(c: Candidate): string` (deterministic — also used by the skill's dual-render narration).

- [ ] **Step 1: Write the failing test**

`lattice/test/emit/projections.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { astToProse, renderCandidateEnglish } from '../../src/emit/prose.js';
import { astToCode } from '../../src/emit/code.js';
import { traceAModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const H3: CandidateInvariant = { id: 'H3', name: 'SingleActivePerFamily', prior: 0.9, source: 'regen',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] } };
const ledger: LedgerEntry[] = [
  { kind: 'verdict', at: 't1', witnessId: 'w1', witness: { entities: [] }, salient: [], judge: 'forbid', question: 'Two active, same family?' },
  { kind: 'adopted', at: 't3', invariant: H3, provenance: 'elicited w1–w2' },
  { kind: 'open-decision', at: 't4', topic: 'dunning_exhausted', note: 'Unpaid or Canceled? undecided' }
];

describe('astToProse', () => {
  const prose = astToProse(traceAModel, [H3], ledger);
  it('renders lifecycle, invariants with anchors, and open decisions', () => {
    expect(prose).toContain('# Billing');
    expect(prose).toContain('Trialing');
    expect(prose).toContain('Only one Subscription may be Active per (customer, plan.family)');
    expect(prose).toContain('(elicited w1–w2)');
    expect(prose).toContain('## ⚠️ Open decisions');
    expect(prose).toContain('dunning_exhausted');
  });
});

describe('astToCode', () => {
  const code = astToCode(traceAModel, [H3]);
  it('pretty-prints the .lat projection', () => {
    expect(code).toContain('context Billing {');
    expect(code).toContain('aggregate Subscription {');
    expect(code).toContain('customer  : ref Customer');
    expect(code).toContain('region Access { states { Trialing, Active @active, Ended @terminal } }');
    expect(code).toContain('unique while Active by (customer, plan.family)');
  });
});

describe('renderCandidateEnglish', () => {
  it('covers every candidate kind', () => {
    expect(renderCandidateEnglish(H3.candidate)).toContain('Only one Subscription');
    expect(renderCandidateEnglish({ kind: 'terminal', aggregate: 'S', region: 'R', state: 'Closed' })).toBe('Once S is Closed, it stays Closed.');
    expect(renderCandidateEnglish({ kind: 'monotonic', aggregate: 'O', field: ['recognized'] })).toBe('O.recognized never decreases.');
    expect(renderCandidateEnglish({ kind: 'conservation', aggregate: 'O', parts: [['recognized'], ['deferred']], total: ['allocated'] }))
      .toBe('On every O, recognized + deferred always equals allocated.');
    expect(renderCandidateEnglish({ kind: 'refsResolve', aggregate: 'E' })).toBe('Every reference on E resolves to an existing record.');
    expect(renderCandidateEnglish({ kind: 'cardinality', aggregate: 'P', where: null, atMost: 1 })).toBe('At most 1 P may exist.');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/emit/prose.ts`:
```ts
import type { DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';

function termEn(t: Term): string {
  switch (t.kind) {
    case 'field': return t.path.join('.');
    case 'int': return String(t.value);
    case 'enumval': return t.value;
    case 'now': return 'now';
    case 'plus': return `${termEn(t.left)} + ${termEn(t.right)}`;
  }
}
function predEn(p: Predicate): string {
  switch (p.kind) {
    case 'cmp': { const ops = { eq: 'is', ne: 'is not', lt: '<', le: '≤', gt: '>', ge: '≥' }; return `${termEn(p.left)} ${ops[p.op]} ${termEn(p.right)}`; }
    case 'inState': return `it is ${p.states.join(' or ')}`;
    case 'and': return p.args.map(predEn).join(' and ');
    case 'or': return p.args.map(predEn).join(' or ');
    case 'not': return `not (${predEn(p.arg)})`;
    case 'implies': return `if ${predEn(p.left)}, then ${predEn(p.right)}`;
  }
}
export function renderCandidateEnglish(c: Candidate): string {
  switch (c.kind) {
    case 'unique': return `Only one ${c.aggregate} may be ${c.whileStates.states.join('/')} per (${c.by.map(p => p.join('.')).join(', ')}).`;
    case 'statePredicate': return `On every ${c.aggregate}: ${c.where ? `where ${predEn(c.where)}, ` : ''}${predEn(c.body)}.`;
    case 'refsResolve': return `Every reference on ${c.aggregate} resolves to an existing record.`;
    case 'cardinality': return `At most ${c.atMost} ${c.aggregate}${c.where ? ` where ${predEn(c.where)}` : ''} may exist.`;
    case 'terminal': return `Once ${c.aggregate} is ${c.state}, it stays ${c.state}.`;
    case 'monotonic': return `${c.aggregate}.${c.field.join('.')} never decreases.`;
    case 'conservation': return `On every ${c.aggregate}, ${c.parts.map(p => p.join('.')).join(' + ')} always equals ${c.total.join('.')}.`;
    case 'leadsTo': return `${c.aggregate}: ${predEn(c.from)} eventually leads to ${predEn(c.to)} (under fairness: ${c.fairness}).`;
  }
}

export function astToProse(m: DomainModel, adopted: CandidateInvariant[], ledger: LedgerEntry[]): string {
  const lines: string[] = [`# ${m.context}`, ''];
  for (const a of m.aggregates) {
    lines.push(`## ${a.name}`, '');
    if (a.doc) lines.push(a.doc, '');
    for (const r of a.machine?.regions ?? []) {
      lines.push(`**${r.name} lifecycle:** ${r.states.map(s =>
        s.tags?.includes('terminal') ? `${s.name} (terminal)` : s.name).join(' → ')}`, '');
    }
  }
  lines.push('## Always true', '');
  const provenance = new Map(ledger.filter(e => e.kind === 'adopted').map(e => [(e as any).invariant.id, (e as any).provenance]));
  for (const inv of adopted.filter(i => i.candidate.kind !== 'leadsTo'))
    lines.push(`- ${renderCandidateEnglish(inv.candidate)}  (${provenance.get(inv.id) ?? inv.source}: ${inv.name})`);
  const live = adopted.filter(i => i.candidate.kind === 'leadsTo');
  if (live.length) { lines.push('', '## Eventually', ''); live.forEach(i => lines.push(`- ${renderCandidateEnglish(i.candidate)}`)); }
  const open = ledger.filter(e => e.kind === 'open-decision');
  if (open.length) {
    lines.push('', '## ⚠️ Open decisions', '');
    open.forEach(e => lines.push(`- **${(e as any).topic}** — ${(e as any).note}`));
  }
  return lines.join('\n') + '\n';
}
```

`lattice/src/emit/code.ts`:
```ts
import type { DomainModel, Field } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import { renderCandidateEnglish } from './prose.js';

const typeStr = (f: Field): string =>
  f.type.kind === 'prim' ? f.type.prim : f.type.kind === 'enum' ? f.type.enum
  : f.type.kind === 'ref' ? `ref ${f.type.target}` : `List<${typeStr({ ...f, type: f.type.of })}>`;

export function astToCode(m: DomainModel, adopted: CandidateInvariant[]): string {
  const pad = (n: string, w: number) => n + ' '.repeat(Math.max(1, w - n.length));
  const out: string[] = [`context ${m.context} {`, ''];
  for (const e of m.enums) out.push(`  enum ${e.name} { ${e.values.join(', ')} }`);
  if (m.enums.length) out.push('');
  for (const ent of m.entities) {
    out.push(`  entity ${ent.name} {`);
    const w = Math.max(...ent.fields.map(f => f.name.length)) + 1;
    for (const f of ent.fields) out.push(`    ${pad(f.name, w)}: ${typeStr(f)}${f.key ? ' key' : ''}${f.tags?.length ? '  @' + f.tags.join(' @') : ''}`);
    out.push('  }', '');
  }
  for (const a of m.aggregates) {
    out.push(`  aggregate ${a.name} {`);
    const w = Math.max(...a.fields.map(f => f.name.length)) + 1;
    for (const f of a.fields) out.push(`    ${pad(f.name, w)}: ${typeStr(f)}${f.key ? ' key' : ''}${f.tags?.length ? '  @' + f.tags.join(' @') : ''}`);
    if (a.machine) {
      out.push('    machine {');
      for (const r of a.machine.regions) {
        const states = r.states.map(s => s.name + (s.tags?.length ? ' @' + s.tags.join(' @') : '')).join(', ');
        out.push(`      region ${r.name} { states { ${states} } }`);
      }
      for (const t of a.machine.transitions)
        out.push(`      transition ${t.name} { region ${t.region}; from ${t.from} to ${t.to}${t.when ? `; when ${t.when}` : ''} }`);
      out.push('    }');
    }
    for (const inv of adopted.filter(i => i.candidate.aggregate === a.name)) {
      const c = inv.candidate;
      if (c.kind === 'unique') out.push(`    unique while ${c.whileStates.states.join('/')} by (${c.by.map(p => p.join('.')).join(', ')})`);
      else out.push(`    invariant ${inv.name} {}  // ${renderCandidateEnglish(c)}`);
    }
    out.push('  }', '');
  }
  // context-level invariants on entities
  for (const inv of adopted.filter(i => !m.aggregates.some(a => a.name === i.candidate.aggregate)))
    out.push(`  invariant ${inv.name} {}  // ${renderCandidateEnglish(inv.candidate)}`);
  out.push('}');
  return out.join('\n') + '\n';
}
```

- [ ] **Step 4: Run to verify PASS** (adjust exact-string expectations to the emitted formatting if whitespace differs — the *content* assertions are the contract), then **Step 5: Commit**

```bash
git add lattice/src/emit/prose.ts lattice/src/emit/code.ts lattice/test/emit/projections.test.ts
git commit -m "feat(lattice): prose + .lat code projections with ledger anchors"
```

---

### Task 16: The engine CLI

**Files:**
- Create: `lattice/src/cli.ts`
- Test: `lattice/test/cli.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `runCommand(argv: string[], deps: SolverDeps): Promise<object>` (exported for tests; prints JSON in `main`). Commands (all take `--session <dir>`; `--model`/`--candidates`/`--candidate` accept a JSON file path *or* inline JSON starting with `{`/`[`):

| Command | Behavior |
|---|---|
| `init --model <json>` | `validateModel`; reject on diagnostics; store model; `matchTemplates` → adopted invariants recorded (`status: 'adopted'`, ledger `adopted` entries with provenance `template`), seeds returned in the output for Claude to fold into `propose`; phase → `distinguish` |
| `propose --candidates <json>` | `validateCandidate` each (reject-all with diagnostics on any failure); `registerCandidates` |
| `next-question` | planner with real solvers; persists state; returns PlannerOutput (incl. `table`) |
| `verdict --witness <id> --judge permit\|forbid\|undecided` | `undecided` → ledger `open-decision`, drop pending, return `{parked: true}`. Else ledger `verdict` (salient from pending), `pruneOnVerdict`, clear other pending options of the same purpose, return `{pruned, empty}` |
| `regenerate --candidate <json>` | phase `regenerate` → `source:'regen'`; phase `alternatives` → `source:'alternative'` **with a `checkDistinct` pre-check** (equivalent ⇒ `alternativeAttempts++`, rejected without admitting); returns admit result + attempts left |
| `status` | `{phase, candidates: [{id, status, prior}], regenAttempts, alternativeAttempts, ledgerCount}` |
| `witness-show --witness <id>` | the canonical table for a pending witness |
| `emit --out <dir>` | adopted = template-adopted + converged survivor (marked `adopted` on convergence); writes `spec.prose.md` + `spec.lat` |

- [ ] **Step 1: Write the failing test**

`lattice/test/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { traceAModel } from './fixtures.js';

const dpsf = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p2', fields: { family: 'f1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const fakeDeps: any = { alloy: async () => ({ sat: true, instances: [dpsf], ms: 3 }), quint: async () => ({ violated: false, ms: 3 }) };

describe('engine CLI', () => {
  it('drives init → propose → next-question → verdict end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const modelFile = join(dir, 'model.json');
    writeFileSync(modelFile, JSON.stringify(traceAModel));

    const init: any = await runCommand(['init', '--session', dir, '--model', modelFile], fakeDeps);
    expect(init.adopted.length).toBeGreaterThan(0);          // templates fired (NoOrphan at least)
    expect(init.seeds.length).toBeGreaterThan(0);            // unique-per-ref seeds

    const cands = [
      { id: 'H1', name: 'perCustomer', prior: 0.35, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'perPlan', prior: 0.4, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] } }
    ];
    const prop: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(cands)], fakeDeps);
    expect(prop.registered).toBe(2);

    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    expect(q.type).toBe('question');
    expect(q.table).toContain('| Subscription |');

    const v: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'forbid'], fakeDeps);
    expect(v.pruned).toContain('H2');

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.find((c: any) => c.id === 'H1').status).toBe('active');
  });

  it('rejects out-of-grammar proposals with diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = [{ id: 'X', name: 'x', prior: 0.5, source: 'seed',
      candidate: { kind: 'unique', aggregate: 'Nope', whileStates: { region: 'R', states: ['S'] }, by: [['f']] } }];
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('out-of-grammar');
    expect(r.diagnostics[0].code).toBe('unknown-aggregate');
  });

  it('undecided verdicts park an open decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'h2', prior: 0.4, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['plan']] } }
    ])], fakeDeps);
    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    const r: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'undecided', '--topic', 'family-policy', '--note', 'experts disagree'], fakeDeps);
    expect(r.parked).toBe(true);
    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.openDecisions).toBe(1);
  });

  it('emit writes prose + code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const out: any = await runCommand(['emit', '--session', dir, '--out', dir], fakeDeps);
    expect(existsSync(join(dir, 'spec.prose.md'))).toBe(true);
    expect(readFileSync(join(dir, 'spec.lat'), 'utf8')).toContain('context Billing {');
    expect(out.written.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: Implement**

`lattice/src/cli.ts`:
```ts
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainModel } from './ast/domain.js';
import { validateModel } from './ast/validate.js';
import { validateCandidate } from './ast/grammar.js';
import type { CandidateInvariant } from './ast/invariant.js';
import { loadState, saveState, appendLedger, readLedger, type SessionState } from './engine/session.js';
import { matchTemplates } from './engine/templates.js';
import { registerCandidates, pruneOnVerdict, admit } from './engine/hypothesis.js';
import { nextQuestion, checkDistinct, type SolverDeps } from './engine/planner.js';
import { renderWitnessTable } from './engine/salient.js';
import { astToAlloy } from './emit/alloy.js';
import { astToQuint } from './emit/quint.js';
import { runAlloy } from './solvers/alloy-adapter.js';
import { runQuint } from './solvers/quint-adapter.js';
import { astToProse } from './emit/prose.js';
import { astToCode } from './emit/code.js';

export const realDeps: SolverDeps = {
  alloy: async (m, q, max) => runAlloy(astToAlloy(m, q), max),
  quint: async (m, q) => runQuint(astToQuint(m, q), q.maxSteps)
};

const readJson = (v: string): any => JSON.parse(v.trim().startsWith('{') || v.trim().startsWith('[') ? v : readFileSync(v, 'utf8'));
const now = () => new Date().toISOString();

export async function runCommand(argv: string[], deps: SolverDeps): Promise<object> {
  const cmd = argv[0]!;
  const { values } = parseArgs({ args: argv.slice(1), options: {
    session: { type: 'string' }, model: { type: 'string' }, candidates: { type: 'string' }, candidate: { type: 'string' },
    witness: { type: 'string' }, judge: { type: 'string' }, out: { type: 'string' }, topic: { type: 'string' }, note: { type: 'string' }
  }});
  const dir = values.session!;
  const s = loadState(dir);
  const model = () => s.model as DomainModel;
  const done = (out: object) => { saveState(dir, s); return out; };

  switch (cmd) {
    case 'init': {
      const m: DomainModel = readJson(values.model!);
      const diags = validateModel(m);
      if (diags.length) return { error: 'ill-formed-model', diagnostics: diags };
      s.model = m;
      const { adopt, seeds } = matchTemplates(m);
      for (const inv of adopt) {
        s.candidates.push({ inv, status: 'adopted' });
        appendLedger(dir, { kind: 'adopted', at: now(), invariant: inv, provenance: `template ${inv.id}` });
      }
      s.phase = 'distinguish';
      return done({ ok: true, adopted: adopt.map(a => ({ id: a.id, name: a.name })), seeds });
    }
    case 'propose': {
      const invs: CandidateInvariant[] = readJson(values.candidates!);
      const diags = invs.flatMap(i => validateCandidate(i.candidate, model()).map(d => ({ ...d, candidate: i.id })));
      if (diags.length) return { error: 'out-of-grammar', diagnostics: diags };
      registerCandidates(s, invs);
      return done({ registered: invs.length });
    }
    case 'next-question': {
      const out = await nextQuestion(s, readLedger(dir), model(), deps);
      if (out.type === 'converged') {
        const survivor = s.candidates.find(c => c.status === 'active');
        if (survivor) {
          survivor.status = 'adopted';
          const wids = readLedger(dir).filter(e => e.kind === 'verdict').map(e => (e as any).witnessId).join(', ');
          appendLedger(dir, { kind: 'adopted', at: now(), invariant: survivor.inv, provenance: `elicited (${wids})` });
        }
      }
      return done(out);
    }
    case 'verdict': {
      const id = values.witness!;
      const pending = s.pendingWitnesses[id];
      if (!pending) return { error: 'unknown-witness', id };
      if (values.judge === 'undecided') {
        appendLedger(dir, { kind: 'open-decision', at: now(), topic: values.topic ?? 'unnamed', note: values.note ?? '', witnessId: id });
        delete s.pendingWitnesses[id];
        return done({ parked: true });
      }
      const judge = values.judge as 'permit' | 'forbid';
      appendLedger(dir, { kind: 'verdict', at: now(), witnessId: id, witness: pending.witness, salient: pending.salient, judge, question: '' });
      const r = pruneOnVerdict(s, pending.witness, judge);
      for (const [k, v] of Object.entries(s.pendingWitnesses)) if (v.purpose === pending.purpose) delete s.pendingWitnesses[k];
      return done(r);
    }
    case 'regenerate': {
      const raw = readJson(values.candidate!);
      const source = s.phase === 'alternatives' ? 'alternative' : 'regen';
      const inv: CandidateInvariant = { ...raw, source };
      if (source === 'alternative') {
        const survivor = s.candidates.find(c => c.status === 'active');
        if (survivor && !(await checkDistinct(survivor.inv.candidate, inv.candidate, model(), deps))) {
          s.alternativeAttempts++;
          return done({ ok: false, reason: 'equivalent to survivor over scope', attemptsLeft: 2 - s.alternativeAttempts });
        }
      }
      const r = admit(s, inv, model(), readLedger(dir));
      const attemptsLeft = source === 'regen' ? 3 - s.regenAttempts : 2 - s.alternativeAttempts;
      if (r.ok && source === 'alternative') s.phase = 'distinguish';   // a live alternative reopens the loop
      return done({ ...r, attemptsLeft });
    }
    case 'status':
      return { phase: s.phase, regenAttempts: s.regenAttempts, alternativeAttempts: s.alternativeAttempts,
        candidates: s.candidates.map(c => ({ id: c.inv.id, name: c.inv.name, prior: c.inv.prior, status: c.status })),
        openDecisions: readLedger(dir).filter(e => e.kind === 'open-decision').length,
        ledgerCount: readLedger(dir).length };
    case 'witness-show': {
      const p = s.pendingWitnesses[values.witness!];
      return p ? { table: renderWitnessTable(p.witness, model()?.ticksPerDay) } : { error: 'unknown-witness' };
    }
    case 'emit': {
      const adopted = s.candidates.filter(c => c.status === 'adopted').map(c => c.inv);
      const ledger = readLedger(dir);
      mkdirSync(values.out!, { recursive: true });
      const prose = join(values.out!, 'spec.prose.md'), lat = join(values.out!, 'spec.lat');
      writeFileSync(prose, astToProse(model(), adopted, ledger));
      writeFileSync(lat, astToCode(model(), adopted));
      return { written: [prose, lat] };
    }
    default: return { error: 'unknown-command', cmd };
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) runCommand(process.argv.slice(2), realDeps).then(o => console.log(JSON.stringify(o, null, 2)));
```

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Commit**

```bash
git add lattice/src/cli.ts lattice/test/cli.test.ts
git commit -m "feat(lattice): session-backed engine CLI — init/propose/next-question/verdict/regenerate/status/emit"
```

---

### Task 17: Golden trace A — structural, real Alloy (spec §2.1)

**Files:**
- Create: `lattice/fixtures/domains/trace-a.json` (the `traceAModel` object from `test/fixtures.ts`, serialized)
- Test: `lattice/golden/trace-a.test.ts`

**Interfaces:** consumes `runCommand` + `realDeps` (Task 16). Verdicts are **derived from the hidden ground truth** (`H3 = unique per (customer, plan.family)`) via `evaluateCandidate` — the script never hand-scripts a judgment, so solver nondeterminism can't break it.

- [ ] **Step 1: Write the golden script**

`lattice/golden/trace-a.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { checkDistinct } from '../src/engine/planner.js';
import { ALLOY_JAR } from '../src/solvers/doctor.js';
import { traceAModel } from '../test/fixtures.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';

const groundTruth: Candidate = { kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] };
const mkU = (id: string, by: string[][], prior: number): CandidateInvariant => ({ id, name: id, prior, source: 'seed',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by } });
const seeds = [mkU('H1', [['customer']], 0.35), mkU('H2', [['customer'], ['plan']], 0.40),
  { id: 'H4', name: 'H4', prior: 0.25, source: 'seed' as const,
    candidate: { kind: 'cardinality', aggregate: 'Subscription', where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] }, atMost: 99 } as Candidate }];

describe.skipIf(!existsSync(ALLOY_JAR))('GOLDEN TRACE A', () => {
  it('converges to per-(customer,family) in ≤ 4 judgments with a regeneration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-a-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], realDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(seeds)], realDeps);

    let judgments = 0, regenerated = false, latencies: number[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const q: any = await runCommand(['next-question', '--session', dir], realDeps);
      if (q.ms) latencies.push(q.ms);
      if (q.type === 'converged') break;
      if (q.type === 'merged') continue;
      if (q.type === 'question' || q.type === 'probe-options') {
        const opt = q.type === 'question' ? q : q.options[0];        // fixture pick: first option
        const judge = evaluateCandidate(groundTruth, opt.witness);    // ground truth judges
        judgments++;
        await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge', judge], realDeps);
        continue;
      }
      if (q.type === 'regenerate') {
        regenerated = true;
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'H3', name: 'perCustomerFamily', prior: 0.9, candidate: groundTruth })], realDeps);
        continue;
      }
      if (q.type === 'need-alternatives') {                           // two failing alternatives → converge
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A1', name: 'perCustomer', prior: 0.3, candidate: seeds[0]!.candidate })], realDeps);      // ledger-inconsistent
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A2', name: 'sameThing', prior: 0.3, candidate: groundTruth })], realDeps);                // equivalent
        continue;
      }
      throw new Error(`unexpected planner output ${q.type}`);
    }

    // Hard path exercised + convergence quality
    expect(regenerated).toBe(true);                                   // spec §2.1: must regenerate
    expect(judgments).toBeLessThanOrEqual(4);                         // kill criterion 2 (spec expectation: 2)
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    const adopted = st.candidates.find((c: any) => c.id === 'H3');
    expect(adopted.status).toBe('adopted');
    // survivor ≡ ground truth over scope
    expect(await checkDistinct(groundTruth, groundTruth, traceAModel, realDeps)).toBe(false);
    // latency budget (§2.4)
    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length / 2)]!).toBeLessThanOrEqual(10_000);
    expect(Math.max(...latencies)).toBeLessThanOrEqual(45_000);

    const e: any = await runCommand(['emit', '--session', dir, '--out', dir], realDeps);
    expect(readFileSync(join(dir, 'spec.prose.md'), 'utf8')).toContain('Only one Subscription may be Active per (customer, plan.family)');
  }, 300_000);
});
```

- [ ] **Step 2: Create the fixture file**

```bash
cd lattice && npx tsx -e "import{traceAModel}from'./test/fixtures.js';import{writeFileSync,mkdirSync}from'fs';mkdirSync('fixtures/domains',{recursive:true});writeFileSync('fixtures/domains/trace-a.json',JSON.stringify(traceAModel,null,2))"
```

- [ ] **Step 3: Run the golden trace**

Run: `cd lattice && npx vitest run golden/trace-a.test.ts`
Expected: PASS. If judgments exceed 4 or a probe never fires, debug against the planner policy (Task 14's fake-solver test isolates policy from solver issues).

- [ ] **Step 4: Commit**

```bash
git add lattice/golden/trace-a.test.ts lattice/fixtures/domains/trace-a.json
git commit -m "test(lattice): golden trace A — structural elicitation with regeneration, real Alloy"
```

---

### Task 18: Golden trace B — temporal/arithmetic, real Quint/Apalache (spec §2.2)

**Files:**
- Create: `lattice/fixtures/domains/trace-b.json`, `lattice/golden/trace-b.test.ts`

**Interfaces:** consumes `runCommand`, `realDeps`, `graceCandidate` (Task 10 fixture). Ground truth = grace-window rule.

- [ ] **Step 1: Write the golden script**

`lattice/golden/trace-b.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { traceBModel, graceCandidate } from '../test/fixtures.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';

const groundTruth = graceCandidate(true);           // active-while-unpaid only within grace
const seeds: CandidateInvariant[] = [
  { id: 'H2', name: 'graceWindow', prior: 0.40, source: 'seed', candidate: graceCandidate(true) },
  { id: 'H3', name: 'unconstrained', prior: 0.35, source: 'seed',
    candidate: { kind: 'cardinality', aggregate: 'Subscription', where: null, atMost: 99 } as Candidate },
  { id: 'H1', name: 'noGrace', prior: 0.25, source: 'seed', candidate: graceCandidate(false) }
];

describe('GOLDEN TRACE B', () => {
  it('converges on the grace rule in exactly 2 judgments, routed to quint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-b-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceBModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], realDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(seeds)], realDeps);

    let judgments = 0; const latencies: number[] = []; const tables: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const q: any = await runCommand(['next-question', '--session', dir], realDeps);
      if (q.ms) latencies.push(q.ms);
      if (q.type === 'converged') break;
      if (q.type === 'merged') continue;
      if (q.type === 'question' || q.type === 'probe-options') {
        const opt = q.type === 'question' ? q : q.options[0];
        tables.push(opt.table);
        judgments++;
        await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge',
          evaluateCandidate(groundTruth, opt.witness)], realDeps);
        continue;
      }
      if (q.type === 'need-alternatives') {
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A1', name: 'noGraceAgain', prior: 0.2, candidate: graceCandidate(false) })], realDeps);  // contradicts ledger
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(
          { id: 'A2', name: 'sameGrace', prior: 0.2, candidate: graceCandidate(true) })], realDeps);      // equivalent
        continue;
      }
      throw new Error(`unexpected ${q.type}`);
    }

    expect(judgments).toBe(2);                                        // spec §2.2 / §16: exactly two
    expect(tables.some(t => t.includes('ticks'))).toBe(true);         // units rendering present
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    expect(st.candidates.find((c: any) => c.id === 'H2').status).toBe('adopted');
    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length / 2)]!).toBeLessThanOrEqual(10_000);   // §2.4 p50 (steady-state; run once to warm Apalache)
    expect(Math.max(...latencies)).toBeLessThanOrEqual(45_000);

    await runCommand(['emit', '--session', dir, '--out', dir], realDeps);
    expect(readFileSync(join(dir, 'spec.prose.md'), 'utf8')).toContain('now ≤ invoice.dueDate + grace');
  }, 600_000);
});
```

- [ ] **Step 2: Fixture + run**

```bash
cd lattice && npx tsx -e "import{traceBModel}from'./test/fixtures.js';import{writeFileSync}from'fs';writeFileSync('fixtures/domains/trace-b.json',JSON.stringify(traceBModel,null,2))"
npx quint verify --help > /dev/null   # warm Apalache download before timing
npx vitest run golden/trace-b.test.ts
```
Expected: PASS with exactly 2 judgments (the probe-forbid query is UNSAT because Q1's judged shape excludes the whole beyond-grace region — that's the design, not luck). If the p50 assertion fails on a cold JVM, re-run once warmed; if it fails warm, that is kill-criterion-4 evidence — record it in the session notes and surface it to the user rather than raising the threshold.

- [ ] **Step 3: Commit**

```bash
git add lattice/golden/trace-b.test.ts lattice/fixtures/domains/trace-b.json
git commit -m "test(lattice): golden trace B — grace-window elicitation in 2 judgments, real Apalache"
```

---

### Task 19: Golden trace C — revenue recognition, both engines, open decision (spec §2.3)

Two deliberate engine extensions land here (they exist *for* trace C, so they're built with it):
1. **Ref-hop state paths**: candidates over `RevenueEntry` must read the referenced period's machine state (`['period', 'Lifecycle.state']`). Extend `resolveFieldPath` (grammar) to accept a final `<Region>.state` segment when the resolved owner declares that region; extend `pathToQuint` to map it to `.Lifecycle_state`. The evaluator already handles it (state is just a field key).
2. **Undecided exclusions**: an `undecided` verdict must not cause the same witness to be re-asked. Add `salient?: SalientFact[]` to the `open-decision` ledger entry, record it in the CLI, and include open-decision salients in the planner's `exclusionsFrom`.

**Files:**
- Modify: `lattice/src/ast/grammar.ts` (resolveFieldPath), `lattice/src/emit/quint.ts` (pathToQuint), `lattice/src/engine/session.ts` (open-decision salient), `lattice/src/engine/planner.ts` (exclusionsFrom), `lattice/src/cli.ts` (verdict undecided records salient)
- Create: `lattice/fixtures/domains/revrec.json`, `lattice/golden/trace-c.test.ts`, `lattice/golden/trace-c-interactive.md`
- Test: extend `lattice/test/ast/grammar.test.ts` with a ref-hop state-path case

- [ ] **Step 1: Write the failing ref-hop test**

Append to `lattice/test/ast/grammar.test.ts` (uses the revrec fixture defined below; import it):
```ts
it('accepts a ref-hop machine-state path (period → Lifecycle.state)', async () => {
  const { revrecModel } = await import('../fixtures.js');
  const c: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
    body: { kind: 'implies',
      left: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['period', 'Lifecycle.state'] }, right: { kind: 'enumval', enum: 'PeriodState', value: 'Closed' } },
      right: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['postedAt'] }, right: { kind: 'field', owner: 'self', path: ['period', 'closedAt'] } } } };
  expect(validateCandidate(c, revrecModel)).toEqual([]);
});
```

Append to `lattice/test/fixtures.ts`:
```ts
export const revrecModel: DomainModel = {
  context: 'RevRec', ticksPerDay: 24,
  enums: [{ name: 'EntryKind', values: ['Recognition', 'Correction'] }, { name: 'PeriodState', values: ['Open', 'Closed'] }],
  entities: [
    { kind: 'entity', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'monotonic'] },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] },
    { kind: 'entity', name: 'RevenueEntry', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'obligation', type: { kind: 'ref', target: 'Obligation' } },
      { name: 'period', type: { kind: 'ref', target: 'AccountingPeriod' } },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'kind', type: { kind: 'enum', enum: 'EntryKind' } },
      { name: 'postedAt', type: { kind: 'prim', prim: 'Date' } }] }
  ],
  aggregates: [{ kind: 'aggregate', name: 'AccountingPeriod', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'closedAt', type: { kind: 'prim', prim: 'Date' } },
      { name: 'lockWindow', type: { kind: 'prim', prim: 'Duration' } }],
    machine: { regions: [{ name: 'Lifecycle', initial: 'Open', states: [
      { name: 'Open', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }], transitions: [] } }],
  events: []
};
```

- [ ] **Step 2: Implement the two extensions**

In `grammar.ts` `resolveFieldPath`, before the field lookup:
```ts
const seg = path[i]!;
const stateMatch = seg.match(/^(\w+)\.state$/);
if (stateMatch && i === path.length - 1) {
  const machine = (def as any).machine;
  return machine?.regions.some((r: any) => r.name === stateMatch[1]) ? { name: seg, type: { kind: 'prim', prim: 'Text' } } : null;
}
```
In `quint.ts` `pathToQuint`, render a `X.state` segment as `.X_state` (and skip the map-hop logic for it). In `session.ts`, add `salient?: SalientFact[]` to the open-decision entry. In `planner.ts` `exclusionsFrom`, include `open-decision` entries carrying salient. In `cli.ts` verdict-undecided, pass `salient: pending.salient`.

Run: `cd lattice && npx vitest run` — full suite still green (the extension must not break earlier tasks).

- [ ] **Step 3: Write the golden script**

`lattice/golden/trace-c.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { ALLOY_JAR } from '../src/solvers/doctor.js';
import { revrecModel } from '../test/fixtures.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';

// Hidden ground truth H*: nothing ever posts into a Closed period (corrections post to an Open one).
const stateEq = (v: string) => ({ kind: 'cmp', op: 'eq',
  left: { kind: 'field', owner: 'self', path: ['period', 'Lifecycle.state'] },
  right: { kind: 'enumval', enum: 'PeriodState', value: v } } as const);
const posted = { kind: 'field', owner: 'self', path: ['postedAt'] } as const;
const closedAt = { kind: 'field', owner: 'self', path: ['period', 'closedAt'] } as const;

const H1: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
  body: { kind: 'implies', left: stateEq('Closed'), right: { kind: 'cmp', op: 'le', left: posted, right: closedAt } } };
const H2: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
  body: { kind: 'implies',
    left: { kind: 'and', args: [stateEq('Closed'),
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['kind'] }, right: { kind: 'enumval', enum: 'EntryKind', value: 'Recognition' } }] },
    right: { kind: 'cmp', op: 'le', left: posted, right: closedAt } } };
const H3: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
  body: { kind: 'implies', left: stateEq('Closed'),
    right: { kind: 'cmp', op: 'le', left: posted, right: { kind: 'plus', left: closedAt, right: { kind: 'field', owner: 'self', path: ['period', 'lockWindow'] } } } } };
const seeds: CandidateInvariant[] = [
  { id: 'H1', name: 'noPostToClosed', prior: 0.5, source: 'seed', candidate: H1 },
  { id: 'H2', name: 'correctionsMayRestate', prior: 0.3, source: 'seed', candidate: H2 },
  { id: 'H3', name: 'lockWindow', prior: 0.2, source: 'seed', candidate: H3 }
];

describe.skipIf(!existsSync(ALLOY_JAR))('GOLDEN TRACE C — revenue recognition', () => {
  it('templates auto-adopt; residual converges to H1; open decision parks; ≤ 8 judgments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-c-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(revrecModel));
    const init: any = await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], realDeps);
    const adoptedIds = init.adopted.map((a: any) => a.id);
    for (const id of ['tpl-1-Obligation', 'tpl-8-Obligation-recognized', 'tpl-3-AccountingPeriod-Closed', 'tpl-7-AccountingPeriod', 'tpl-9-RevenueEntry'])
      expect(adoptedIds).toContain(id);                              // the "comes free" moment (§2.3)

    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(seeds)], realDeps);

    let judgments = 0, parkedOnce = false;
    for (let turn = 0; turn < 30; turn++) {
      const q: any = await runCommand(['next-question', '--session', dir], realDeps);
      if (q.type === 'converged') break;
      if (q.type === 'merged') continue;
      if (q.type === 'question' || q.type === 'probe-options') {
        const opt = q.type === 'question' ? q : q.options[0];
        // The pre-registered open decision: park the FIRST permit-side probe as usage-after-close.
        if (!parkedOnce && (q.purpose === 'probe-permit' || opt.purpose === 'probe-permit' || q.type === 'probe-options' && q.purpose === 'probe-permit')) {
          parkedOnce = true;
          await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge', 'undecided',
            '--topic', 'usage-after-close', '--note', 'catch-up in open period vs restate — founder undecided'], realDeps);
          continue;
        }
        judgments++;
        await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge',
          evaluateCandidate(H1, opt.witness)], realDeps);            // ground truth judges
        continue;
      }
      if (q.type === 'need-alternatives') {
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify({ id: 'A1', name: 'restate', prior: 0.2, candidate: H2 })], realDeps);
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify({ id: 'A2', name: 'same', prior: 0.2, candidate: H1 })], realDeps);
        continue;
      }
      if (q.type === 'regenerate') {   // acceptable path if probes refute an over-pruned survivor
        await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify({ id: 'R1', name: 'gt', prior: 0.9, candidate: H1 })], realDeps);
        continue;
      }
      throw new Error(`unexpected ${q.type}`);
    }

    expect(judgments).toBeLessThanOrEqual(8);                        // §2.4 kill criterion for trace C
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    const survivor = st.candidates.find((c: any) => ['H1', 'R1'].includes(c.id) && c.status === 'adopted');
    expect(survivor).toBeDefined();
    expect(st.openDecisions).toBe(1);                                // the parked policy fork
    await runCommand(['emit', '--session', dir, '--out', dir], realDeps);
    const prose = readFileSync(join(dir, 'spec.prose.md'), 'utf8');
    expect(prose).toContain('## ⚠️ Open decisions');
    expect(prose).toContain('usage-after-close');
    expect(prose).toContain('recognized + deferred always equals allocated');
  }, 900_000);
});
```

- [ ] **Step 4: Write the interactive protocol** (the live half of trace C — spec §2.3's pre-registered artifacts)

`lattice/golden/trace-c-interactive.md`:
```markdown
# Trace C — Interactive Run Protocol (spec §2.3)

Run AFTER the scripted golden trace passes. You (founder role) + the elicit-spec skill, live.

**Pre-registered founder description** (paste as your first message): the §2.3 paragraph
("We're building an AI-native revenue recognition product (like Rillet)…").

**Pre-registered targets** (do not show Claude during the run):
- Structure: Contract{lines: Obligation{allocated, method}}, RevenueEntry{obligation, period, amount, kind, postedAt},
  AccountingPeriod{Open @active → Closed @terminal}. Budget: ≤ 10 structure questions.
- Residual ground truth: H* = nothing posts to a Closed period; corrections post to an Open period. Budget: ≤ 8 judgments.
- Open decision: usage reported after its period closed → answer "we haven't decided" when the boundary case appears.

**Verdict policy:** judge each witness table against H* mechanically; do not volunteer the rule in prose.

**Measure and record** (in this file, after the run): structure questions asked, judgments asked,
per-question wall-clock (p50/max vs the 10s/45s budget), whether the emitted prose matched the targets,
and any witness table you could not judge without analysis (kill criterion 1).
```

- [ ] **Step 5: Run everything, commit**

```bash
cd lattice && npx tsx -e "import{revrecModel}from'./test/fixtures.js';import{writeFileSync}from'fs';writeFileSync('fixtures/domains/revrec.json',JSON.stringify(revrecModel,null,2))"
npx vitest run
git add lattice/golden/trace-c.test.ts lattice/golden/trace-c-interactive.md lattice/fixtures/domains/revrec.json lattice/src lattice/test
git commit -m "test(lattice): golden trace C — rev-rec templates, residual convergence, parked open decision"
```

---

### Task 20: The `elicit-spec` skill + parse-back protocol

**Files:**
- Create: `.claude/skills/elicit-spec/SKILL.md`, `lattice/golden/parseback/PROTOCOL.md`, `lattice/golden/parseback/diff.ts`

**Interfaces:** consumes the CLI surface (Task 16) and `salientKey` (Task 7). Nothing consumes these — they're the human-facing layer.

- [ ] **Step 1: Write the skill**

`.claude/skills/elicit-spec/SKILL.md`:
```markdown
---
name: elicit-spec
description: Elicit a Lattice domain spec through recognition-over-recall — structure first, then solver-backed invariant elicitation. Use when the user wants to build a domain spec by chatting.
---

You are the NL Translator for the Lattice elicitation engine (spec: docs/plan.md §7/§8).
The engine is rigorous; you are not. NEVER simulate the engine's answers — always call it.

Engine: `cd lattice && npx tsx src/cli.ts <command> --session <dir>` (JSON in, JSON out).
Session dir: `.lattice-session-<slug>/` in the repo root. Commands: init, propose, next-question,
verdict, regenerate, status, witness-show, emit (see lattice/src/cli.ts for flags).

## Phase 0 — structure elicitation (you, no solver)
From the user's domain description, PROPOSE a concrete structure and let them correct it:
aggregates, entities, enums, machine regions/states (tag @active/@terminal), refs, field tags
(@balance/@total/@monotonic on money-flow fields — these power auto-invariants). One question
per message; multiple-choice when possible; the user judges, never authors. Budget ~10 questions.
When stable: `engine init --model <file>`. Fix any diagnostics by asking, not guessing.
Present the auto-adopted template invariants as a list ("these come free — object to any?").

## Phase 1 — seeding
Fold the engine's returned seeds with your own domain knowledge into 3–5 candidate invariants
per open question, each with a prior (sum ≈ 1). Every candidate MUST be inside the closed grammar
(lattice/src/ast/invariant.ts — statePredicate / unique / refsResolve / cardinality / terminal /
monotonic / conservation). `engine propose`. If rejected: fix to the diagnostics, don't argue.

## Phase 2 — the loop
Repeat `engine next-question`:
- `question` → present the engine's `table` VERBATIM (it is ground truth), then add one plain-English
  sentence framing it as a yes/no domain case. Never replace the table with prose. Ask: is this state
  valid (permit) or invalid (forbid)? "We haven't decided" is a legal answer → verdict --judge undecided
  with --topic/--note.
- `probe-options` → pick the option a domain expert is MOST LIKELY TO PERMIT (that's the informative
  boundary); present only that one (table verbatim + one sentence).
- `merged` → continue silently.
- `regenerate` → synthesize ONE candidate consistent with every ledger verdict (read them via status),
  inside the grammar; `engine regenerate`. If rejected, use the stated reason. Max 3 — then tell the
  user it's parked as an open decision.
- `need-alternatives` → try up to 2 genuinely different rules that also fit the ledger. Submitting
  none that survive = convergence, which is the goal, not a failure.
- `converged` → `engine emit --out specs/<slug>/`, show the prose spec, note open decisions.

## Rules
- Verdicts are the source of truth; formulas are derived. Never overrule a verdict.
- Never author freeform prose the engine must parse — everything to the engine is structured JSON.
- Report solver latency honestly if a question takes > 45s (that's a budget violation worth logging).
```

- [ ] **Step 2: Parse-back harness**

`lattice/golden/parseback/diff.ts`:
```ts
// Usage: npx tsx golden/parseback/diff.ts <session-dir> <witnessId> <parsedBack.json>
// parsedBack.json = a CaseState reconstructed by a FRESH model from Claude's prose question alone.
import { readFileSync } from 'node:fs';
import { loadState } from '../../src/engine/session.js';
import { extractSalient, salientKey } from '../../src/engine/salient.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const [dir, wid, parsedFile] = process.argv.slice(2);
const s = loadState(dir!);
const pending = s.pendingWitnesses[wid!];
if (!pending) { console.error('unknown witness'); process.exit(2); }
const parsed: CaseState = JSON.parse(readFileSync(parsedFile!, 'utf8'));
const cands = s.candidates.filter(c => c.status === 'active').map(c => c.inv.candidate);
const a = salientKey(pending.salient);
const b = salientKey(extractSalient(cands, parsed));
console.log(JSON.stringify({ match: a === b, original: a, parsedBack: b }, null, 2));
process.exit(a === b ? 0 : 1);
```

`lattice/golden/parseback/PROTOCOL.md`:
```markdown
# Decorrelated parse-back (spec §5.1) — golden-run instrumentation, not a per-turn cost

For each question asked during a golden/interactive run:
1. Copy ONLY Claude's prose narration (not the table) into a FRESH Claude conversation with the
   domain model JSON, asking it to reconstruct the concrete case as CaseState JSON.
2. Run: npx tsx golden/parseback/diff.ts <session-dir> <witnessId> <parsed.json>
3. `match: false` = a rendering-fidelity failure — count it toward kill criterion 3 (§2.4)
   and record it in trace-c-interactive.md.
```

- [ ] **Step 3: Verify + commit**

Run: `cd lattice && npx tsx golden/parseback/diff.ts /nonexistent w1 /dev/null 2>&1; echo "exit=$?"` — Expected: `unknown witness`, exit=2 (arg wiring works).

```bash
git add .claude/skills/elicit-spec lattice/golden/parseback
git commit -m "feat(lattice): elicit-spec skill + decorrelated parse-back harness"
```

---

## Final verification

- [ ] `cd lattice && npx vitest run` — full suite green (unit + integration + 3 golden traces).
- [ ] `npm run tally` — fidelity gate results still recorded and in the proceed band.
- [ ] Latency numbers from traces A–C recorded against §2.4 (p50 ≤ 10s, max ≤ 45s) in `golden/trace-c-interactive.md`.
- [ ] Run the interactive trace C protocol with the user (this is a session, not code).
- [ ] Then: superpowers:finishing-a-development-branch.

## Plan self-review notes (already applied)

- **Quint query direction**: everywhere `iff(Hi, Hj)` is the *invariant*; its counterexample is the witness (spec D15).
- **Trace-B two-judgment guarantee** rests on judged-shape exclusions making the forbid-probe UNSAT — that's why salient extraction (Task 7) captures comparison dims, and why exclusions flow through every query.
- **Known in-plan fix-ups flagged where they occur**: Task 15 whitespace-sensitive assertions; Task 9/10 spike steps own the "XML/ITF shape differs from assumption" risk.
- **Undecided-verdict re-ask loop** is closed in Task 19 step 2 (open-decision salients join the exclusion set).
```






