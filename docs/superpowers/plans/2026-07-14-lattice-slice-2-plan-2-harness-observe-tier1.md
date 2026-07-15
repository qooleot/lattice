# Slice 2 Plan 2: Conformance Harness — Contract, Binder, observe(), Tier 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `lattice/src/conform/` — the target-agnostic conformance harness's observation half: the generated spec-state contract, the convention auto-binder with typed overrides, the `observe()` projection, Tier 1 invariant evaluation with ledger-anchored diagnostics, the impl-side capture hook, and the `lattice conform` CLI in report/enforce modes. Exit state: `lattice conform --target implementations/subscriptions --report` runs the clean impl's captured states through every adopted invariant and reports **zero violations** plus the measured residual surface.

**Architecture (design §4, §8.1):** The impl's test suite dumps raw SQLite snapshots per test (thin hook, zero lattice imports). Engine-side, per snapshot: the **binder** introspects the schema and auto-binds spec fields by convention (validated against live rows, unbound = hard failure), **observe()** runs bindings + typed overrides to produce `CaseEntity[]`, and **Tier 1** evaluates every adopted invariant via `evaluateCandidate` with anchors from `buildPlan`. The checker consumes data (snapshots), never live services — that is the recorded polyglot seam.

**Tech Stack:** TypeScript (strict, ESM) in `lattice/` (better-sqlite3 is already a lattice dependency — verify with `grep better-sqlite3 lattice/package.json`; if absent, add the same version the generated package pins).

## Global Constraints

- Engine discipline: before every commit `cd lattice && npx tsc --noEmit && npx vitest run` (real solvers, serialized). Golden traces stay green; assertions never weakened. The impl package's gates (`cd implementations/subscriptions && npx tsc --noEmit && npx vitest run`) must also stay green.
- Diagnostics cite spec elements AND ledger anchors (via `buildPlan`'s `Anchors`); never claim coverage beyond what was checked — unbound fields and skipped invariants are reported, not silenced.
- The impl package gains NO lattice import (the capture hook writes raw bytes only). The overrides/contract files live in `implementations/subscriptions/conform/` and are covered by the impl's own `tsc` (its tsconfig already includes `conform/**/*.ts`).
- No solver in any conformance path — pure TS end to end.
- Consume the AST via the existing loader seam (`loadGenInput`) — never parse `.lat` here and never read `spec.json` shapes directly.
- Never `git add -A`; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Prerequisite: plan 1 fully landed (`implementations/subscriptions/` green). Environment quirks: `ensure-ready.sh` won't refresh stale `node_modules`; orphan JVMs may linger from other suites — unrelated here but check before timing anything.

---

## File Structure

**Engine-side (new, `lattice/src/conform/`):**
- `types.ts` — `SnapshotMeta`, `BindingManifest`, `AggregateBinding`, `FieldBinding`, `ConformViolation`, `ConformReport`, `OverridesModule`.
- `contract.ts` — `renderContract(model) → string` (the generated `spec-state.ts` for the target).
- `bind.ts` — `bindSchema(db, model, overrides) → BindingManifest` (introspection + conventions + live-row validation).
- `observe.ts` — `observeEntities(db, model, manifest, overrides) → CaseEntity[]`.
- `tier1.ts` — `checkInvariants(entities, genPlan, optOuts) → ConformViolation[]`.
- `report.ts` — `formatReport(report) → string`, exit-code logic.
- Tests co-located: `lattice/src/conform/*.test.ts` with a shared fixture `lattice/src/conform/fixtures.ts`.

**Engine-side (modified):**
- `lattice/src/cli.ts` — add the `conform` command (`--target`, `--session`, `--report|--enforce`, `--contract`).

**Impl-side (new, thin):**
- `implementations/subscriptions/conform/conform.config.json` — session dir, snapshot dir, opt-outs.
- `implementations/subscriptions/conform/spec-state.ts` — GENERATED contract (committed; refreshed by `lattice conform --contract`).
- `implementations/subscriptions/conform/overrides.ts` — the hand-written residual (typed against the contract).
- `implementations/subscriptions/test/conform-capture.ts` — the raw-snapshot dump hook.
- Modify: `implementations/subscriptions/vitest.config.ts` (register the hook as a setup file), `.gitignore` entry for `.conform/`.

---

### Task 1: Conform types + spec-state contract renderer

**Files:**
- Create: `lattice/src/conform/types.ts`
- Create: `lattice/src/conform/contract.ts`
- Create: `lattice/src/conform/fixtures.ts`
- Test: `lattice/src/conform/contract.test.ts`

**Interfaces:**
- Consumes: `DomainModel`, `AggregateDef`, `Field`, `Region` (`src/ast/domain.ts`); the session store via `loadGenInput` (`src/generate/load.ts`) in tests. **First action:** read `src/ast/domain.ts` lines 1–70 to confirm the `TypeRef` shape before writing the type-mapping function — map prim `Id`/`Str` → `string`, `Int`/`Money`/`Date` → `number`, `Bool` → `boolean`, refs → `string`, enums → their value union; a region contributes a field named after the region typed as the union of its state names.
- Produces:
  ```ts
  // types.ts
  export interface FieldBinding { field: string; kind: 'auto' | 'override'; column?: string; note?: string }
  export interface AggregateBinding { aggregate: string; table: string; keyColumn: string;
    fields: FieldBinding[]; unbound: string[] }
  export interface BindingManifest { aggregates: AggregateBinding[] }
  export interface ConformViolation { invariant: string; specElement: string; anchors: string[];
    witnessIds: string[]; source: string; detail: string }
  export interface ConformReport { target: string; snapshots: number; invariantsChecked: number;
    optOuts: { invariant: string; reason: string }[]; violations: ConformViolation[];
    residual: { autoBound: number; overridden: number; total: number } }
  export type OverrideFn = (db: unknown, row: Record<string, unknown>) => string | number | boolean;
  export type OverridesModule = Record<string, Record<string, OverrideFn>>; // aggregate → field → fn
  // contract.ts
  export function renderContract(model: DomainModel): string;
  ```
- The rendered contract is SELF-CONTAINED (no imports) so the impl package compiles it alone. For the Subscriptions model it must contain, verbatim-checkable: `export interface SubscriptionSpecState`, a `status: 'trialing' | 'active' | 'pastDue' | 'canceled' | 'expired'` member, `export interface InvoiceSpecState`, `export interface SpecOverrides` (per-aggregate optional maps of per-field functions `(db: unknown, row: Record<string, unknown>) => <FieldType>`), and `export function defineOverrides(o: SpecOverrides): SpecOverrides { return o }`. A header comment must name the generator and warn against hand-editing.

- [ ] **Step 1: Write the failing test**

```ts
// lattice/src/conform/contract.test.ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderContract } from './contract.js';
import { loadGenInput } from '../generate/load.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('renderContract', () => {
  const src = renderContract(loadGenInput(join(repoRoot, '.lattice-session-subscriptions')).model);

  it('emits per-aggregate spec-state interfaces with region unions and ref fields as string', () => {
    expect(src).toContain('export interface SubscriptionSpecState');
    expect(src).toContain(`status: 'trialing' | 'active' | 'pastDue' | 'canceled' | 'expired';`);
    expect(src).toContain(`settlement: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';`);
    expect(src).toContain('latestInvoice: string;');
    expect(src).toContain('amountPaid: number;');
  });

  it('emits the typed override surface', () => {
    expect(src).toContain('export interface SpecOverrides');
    expect(src).toContain('export function defineOverrides(o: SpecOverrides): SpecOverrides { return o }');
    expect(src).not.toContain('import '); // self-contained
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/contract.test.ts`
Expected: FAIL — `Cannot find module './contract.js'`.

- [ ] **Step 3: Write `types.ts`, `contract.ts`, `fixtures.ts`**

```ts
// lattice/src/conform/types.ts — exactly the Produces block above, as real code.
```

```ts
// lattice/src/conform/contract.ts
import type { AggregateDef, DomainModel, Field } from '../ast/domain.js';

// Confirm TypeRef's actual discriminants against src/ast/domain.ts before finalizing tsType —
// the fallbacks below assume { kind:'prim', name } | { kind:'ref', ... } | { kind:'enum'-ish }.
function tsType(model: DomainModel, f: Field): string {
  const t = f.type as any;
  if (t.kind === 'ref') return 'string';
  const en = model.enums.find(e => e.name === (t.name ?? t.enum));
  if (en) return en.values.map(v => `'${v}'`).join(' | ');
  switch (t.name) {
    case 'Int': case 'Money': case 'Date': return 'number';
    case 'Bool': return 'boolean';
    default: return 'string'; // Id, Str
  }
}

function aggregateInterface(model: DomainModel, a: AggregateDef): string {
  const lines = a.fields.map(f => `  ${f.name}: ${tsType(model, f)};`);
  for (const r of a.machine?.regions ?? []) {
    lines.push(`  ${r.name}: ${r.states.map(s => `'${s.name}'`).join(' | ')};`);
  }
  return `export interface ${a.name}SpecState {\n${lines.join('\n')}\n}`;
}

export function renderContract(model: DomainModel): string {
  const aggs = model.aggregates.map(a => aggregateInterface(model, a));
  const overrideMembers = model.aggregates.map(a =>
    `  ${a.name}?: { [K in keyof ${a.name}SpecState]?: (db: unknown, row: Record<string, unknown>) => ${a.name}SpecState[K] };`);
  return [
    `// GENERATED by lattice conform --contract from context ${model.context} — DO NOT EDIT.`,
    `// Regenerating the spec regenerates this file; stale overrides then FAIL TO COMPILE (design §4.2).`,
    '',
    ...aggs,
    '',
    `export interface SpecOverrides {`,
    ...overrideMembers,
    `}`,
    '',
    `export function defineOverrides(o: SpecOverrides): SpecOverrides { return o }`,
    '',
  ].join('\n');
}
```

```ts
// lattice/src/conform/fixtures.ts — a tiny DomainModel + matching sqlite DDL used by bind/observe tests.
import Database from 'better-sqlite3';
import type { DomainModel } from '../ast/domain.js';

/** One aggregate, engineer-shaped storage: key 'id', snake_case, a region behind a
 *  divergently-named column, and one field materialized nowhere (needs an override). */
export const tinyModel: DomainModel = {
  context: 'Tiny', enums: [], values: [], entities: [], events: [
    { name: 'AccountClosed', fields: [{ name: 'accountId', type: { kind: 'prim', name: 'Id' } as any }] },
  ],
  aggregates: [{
    kind: 'aggregate', name: 'Account',
    fields: [
      { name: 'accountId', type: { kind: 'prim', name: 'Id' } as any, key: true },
      { name: 'balance', type: { kind: 'prim', name: 'Money' } as any },
      { name: 'ownerName', type: { kind: 'prim', name: 'Str' } as any },
    ],
    machine: {
      regions: [{ name: 'status', initial: 'openState',
        states: [{ name: 'openState' }, { name: 'closedState', tags: ['terminal'] }] }],
      transitions: [
        { name: 'close', region: 'status', from: ['openState'], to: 'closedState', emits: 'AccountClosed' },
      ],
    },
  }],
};

export function tinyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'openState'   -- region column with a non-convention name
    );
    CREATE TABLE account_entries (               -- balance = SUM(amount): materialized nowhere
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount INTEGER NOT NULL
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  return db;
}
```

> Fixture caveat: if `DomainModel`/`Field` literal shapes don't typecheck exactly as written
> (e.g. `TypeRef` uses different discriminants), fix the FIXTURE to match `src/ast/domain.ts` —
> never widen engine types. The `as any` on `type` is acceptable in fixtures only if the real
> literal shape is awkward; prefer the real shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lattice && npx vitest run src/conform/contract.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/types.ts lattice/src/conform/contract.ts lattice/src/conform/fixtures.ts lattice/src/conform/contract.test.ts
git commit -m "feat(conform): spec-state contract renderer + conform type model

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The auto-binder

**Files:**
- Create: `lattice/src/conform/bind.ts`
- Test: `lattice/src/conform/bind.test.ts`

**Interfaces:**
- Consumes: `tinyModel`/`tinyDb` (Task 1), `BindingManifest`/`OverridesModule` (Task 1), better-sqlite3.
- Produces:
  ```ts
  export function bindSchema(db: Database.Database, model: DomainModel, overrides: OverridesModule): BindingManifest;
  // throws ConformBindError (exported, carries manifest) when any field is neither bound nor overridden
  export class ConformBindError extends Error { manifest: BindingManifest }
  ```
- **Conventions (exhaustive, in priority order).** Table for aggregate `Foo`: exact `Foo`, lowercase `foo`, snake `foo_bar` for camel, plus-plural `foos` / snake-plural. Column for field `f`:
  1. key field → the table's primary-key column (from `PRAGMA table_info`, `pk > 0`);
  2. exact name `f`;
  3. snake_case of `f` (`paidInvoiceCount` → `paid_invoice_count`);
  4. ref fields additionally: `${snake}_id`, `${snake}_code`;
  5. region `r` additionally: `${r}_state`.
- **Validation (bindings are verified, not trusted).** For every candidate binding, sample up to 100 rows: numeric spec types (`Int`/`Money`/`Date`) require `typeof === 'number'`; `Bool` requires 0/1; region columns require every sampled value ∈ the region's state names — any mismatch REJECTS the binding (falls through to unbound, with the rejection reason in `FieldBinding.note` via a `kind: 'auto'`-rejected record kept out of `fields` but reported in `unbound` notes). Empty tables validate vacuously (note: `'unvalidated: no rows'`).
- Fields with an override entry are recorded `kind: 'override'` and skip convention search. Unbound-and-not-overridden → `ConformBindError` listing every gap (loud, never partial-silent).

- [ ] **Step 1: Write the failing test**

```ts
// lattice/src/conform/bind.test.ts
import { describe, it, expect } from 'vitest';
import { bindSchema, ConformBindError } from './bind.js';
import { tinyDb, tinyModel } from './fixtures.js';

const overrides = {
  Account: {
    balance: (_db: unknown, row: Record<string, unknown>) => 0, // real derivation comes in observe tests
    status: (_db: unknown, row: Record<string, unknown>) => 'openState',
  },
};

describe('bindSchema', () => {
  it('auto-binds by convention, routes overridden fields, and records the key column', () => {
    const db = tinyDb();
    db.prepare(`INSERT INTO accounts (id, owner_name) VALUES ('a1','Ada')`).run();
    const m = bindSchema(db, tinyModel, overrides);
    const acc = m.aggregates.find(a => a.aggregate === 'Account')!;
    expect(acc.table).toBe('accounts');
    expect(acc.keyColumn).toBe('id');
    expect(acc.fields).toContainEqual({ field: 'accountId', kind: 'auto', column: 'id' });
    expect(acc.fields).toContainEqual({ field: 'ownerName', kind: 'auto', column: 'owner_name' });
    expect(acc.fields.find(f => f.field === 'balance')).toMatchObject({ kind: 'override' });
    expect(acc.fields.find(f => f.field === 'status')).toMatchObject({ kind: 'override' });
    expect(acc.unbound).toEqual([]);
  });

  it('throws loudly, listing every unbound field, when overrides are missing', () => {
    const db = tinyDb();
    try {
      bindSchema(db, tinyModel, {});
      expect.unreachable('bindSchema must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConformBindError);
      const acc = (e as ConformBindError).manifest.aggregates.find(a => a.aggregate === 'Account')!;
      expect(acc.unbound).toContain('balance'); // no such column anywhere
      expect(acc.unbound).toContain('status');  // region column is named 'state', not 'status'/'status_state'
    }
  });

  it('rejects a name-matching column whose live values fall outside the region domain', () => {
    const db = tinyDb();
    db.exec(`ALTER TABLE accounts RENAME COLUMN state TO status`); // name now matches…
    db.prepare(`INSERT INTO accounts (id, owner_name, status) VALUES ('a1','Ada','gold')`).run(); // …values don't
    try {
      bindSchema(db, tinyModel, { Account: { balance: () => 0 } });
      expect.unreachable('bindSchema must throw');
    } catch (e) {
      const acc = (e as ConformBindError).manifest.aggregates.find(a => a.aggregate === 'Account')!;
      expect(acc.unbound).toContain('status'); // bound-by-name but refuted-by-data
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/bind.test.ts`
Expected: FAIL — `Cannot find module './bind.js'`.

- [ ] **Step 3: Implement the binder**

```ts
// lattice/src/conform/bind.ts
import type Database from 'better-sqlite3';
import type { AggregateDef, DomainModel, Field, Region } from '../ast/domain.js';
import type { AggregateBinding, BindingManifest, FieldBinding, OverridesModule } from './types.js';

export class ConformBindError extends Error {
  constructor(public manifest: BindingManifest) {
    super('conform: unbound spec fields — add typed overrides or fix naming:\n' +
      manifest.aggregates.filter(a => a.unbound.length)
        .map(a => `  ${a.aggregate} (table ${a.table || 'NOT FOUND'}): ${a.unbound.join(', ')}`).join('\n'));
  }
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

interface Col { name: string; pk: number }

function tableFor(db: Database.Database, agg: string): { table: string; cols: Col[] } | undefined {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map(t => t.name);
  const want = [agg, agg.toLowerCase(), snake(agg), `${agg.toLowerCase()}s`, `${snake(agg)}s`];
  const table = want.find(w => tables.includes(w));
  if (!table) return undefined;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
  return { table, cols };
}

function sample(db: Database.Database, table: string, column: string): unknown[] {
  return (db.prepare(`SELECT ${column} v FROM ${table} LIMIT 100`).all() as { v: unknown }[]).map(r => r.v);
}

function validates(vals: unknown[], f: Field | undefined, region: Region | undefined): string | null {
  if (vals.length === 0) return null; // vacuous — noted by caller
  if (region) {
    const domain = new Set(region.states.map(s => s.name));
    return vals.every(v => typeof v === 'string' && domain.has(v)) ? null : 'live values outside region domain';
  }
  const t = (f!.type as any);
  if (t.kind !== 'ref' && ['Int', 'Money', 'Date'].includes(t.name)) {
    return vals.every(v => typeof v === 'number') ? null : 'non-numeric live values for numeric spec type';
  }
  if (t.kind !== 'ref' && t.name === 'Bool') {
    return vals.every(v => v === 0 || v === 1) ? null : 'non-boolean live values';
  }
  return null;
}

function candidateColumns(f: Field | undefined, region: Region | undefined, cols: Col[]): string[] {
  const names = cols.map(c => c.name);
  const out: string[] = [];
  if (f?.key) { const pk = cols.find(c => c.pk > 0); if (pk) out.push(pk.name); }
  const base = f ? f.name : region!.name;
  for (const cand of [base, snake(base)]) if (names.includes(cand) && !out.includes(cand)) out.push(cand);
  if (f && (f.type as any).kind === 'ref') {
    for (const cand of [`${snake(base)}_id`, `${snake(base)}_code`])
      if (names.includes(cand) && !out.includes(cand)) out.push(cand);
  }
  if (region) {
    const cand = `${region.name}_state`;
    if (names.includes(cand) && !out.includes(cand)) out.push(cand);
  }
  return out;
}

function bindAggregate(db: Database.Database, model: DomainModel, a: AggregateDef,
  overrides: OverridesModule): AggregateBinding {
  const found = tableFor(db, a.name);
  const ov = overrides[a.name] ?? {};
  const fields: FieldBinding[] = [];
  const unbound: string[] = [];
  const members: { name: string; field?: Field; region?: Region }[] = [
    ...a.fields.map(f => ({ name: f.name, field: f })),
    ...(a.machine?.regions ?? []).map(r => ({ name: r.name, region: r })),
  ];
  for (const m of members) {
    if (ov[m.name]) { fields.push({ field: m.name, kind: 'override' }); continue; }
    if (!found) { unbound.push(m.name); continue; }
    let bound = false;
    for (const col of candidateColumns(m.field, m.region, found.cols)) {
      const vals = sample(db, found.table, col);
      const reject = validates(vals, m.field, m.region);
      if (!reject) {
        fields.push({ field: m.name, kind: 'auto', column: col,
          ...(vals.length === 0 ? { note: 'unvalidated: no rows' } : {}) });
        bound = true; break;
      }
    }
    if (!bound) unbound.push(m.name);
  }
  const pk = found?.cols.find(c => c.pk > 0);
  return { aggregate: a.name, table: found?.table ?? '', keyColumn: pk?.name ?? '', fields, unbound };
}

export function bindSchema(db: Database.Database, model: DomainModel, overrides: OverridesModule): BindingManifest {
  const manifest: BindingManifest = { aggregates: model.aggregates.map(a => bindAggregate(db, model, a, overrides)) };
  if (manifest.aggregates.some(a => a.unbound.length > 0)) throw new ConformBindError(manifest);
  return manifest;
}
```

Note on the exact `toContainEqual` assertion in Step 1: `FieldBinding` for a validated auto bind with rows present has no `note` key — keep the object literal exactly `{ field, kind, column }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lattice && npx vitest run src/conform/bind.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/bind.ts lattice/src/conform/bind.test.ts
git commit -m "feat(conform): convention auto-binder with live-row validation and loud unbound failure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: observe() — bindings + overrides → CaseEntity[]

**Files:**
- Create: `lattice/src/conform/observe.ts`
- Test: `lattice/src/conform/observe.test.ts`

**Interfaces:**
- Consumes: `bindSchema` (Task 2), `CaseEntity` (`src/engine/evaluate.ts`), fixtures.
- Produces:
  ```ts
  export function observeEntities(db: Database.Database, model: DomainModel,
    manifest: BindingManifest, overrides: OverridesModule): CaseEntity[];
  ```
- Semantics: one `CaseEntity` per row per bound aggregate — `type` = aggregate name, `id` = key column value, `fields[f]` = column value (auto) or override return (override). Ref fields carry the referenced row's key value so `evaluateCandidate`'s ref-hop (`entities.find(x => x.id === v)`) works. SQL `NULL` in a nullable ref → omit the field key entirely. Any other `NULL`, or an override returning `undefined`/`null`, is a **hard error naming aggregate/field/row id** — a lying projection must fail, not coerce (design drift class 6/11 depends on this).

- [ ] **Step 1: Write the failing test**

```ts
// lattice/src/conform/observe.test.ts
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';
import { tinyDb, tinyModel } from './fixtures.js';

const overrides = {
  Account: {
    balance: (db: unknown, row: Record<string, unknown>) =>
      ((db as Database.Database).prepare('SELECT COALESCE(SUM(amount),0) s FROM account_entries WHERE account_id = ?')
        .get(row.id) as { s: number }).s,
    status: (_db: unknown, row: Record<string, unknown>) => row.state as string,
  },
};

function seeded() {
  const db = tinyDb();
  db.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES ('a1','Ada','openState')`).run();
  db.prepare(`INSERT INTO account_entries (account_id, amount) VALUES ('a1', 700), ('a1', -200)`).run();
  return db;
}

describe('observeEntities', () => {
  it('projects rows into spec-shaped CaseEntities via bindings and overrides', () => {
    const db = seeded();
    const manifest = bindSchema(db, tinyModel, overrides);
    const entities = observeEntities(db, tinyModel, manifest, overrides);
    expect(entities).toEqual([
      { type: 'Account', id: 'a1', fields: { accountId: 'a1', ownerName: 'Ada', balance: 500, status: 'openState' } },
    ]);
  });

  it('fails hard when an override returns undefined (a lying projection must not coerce)', () => {
    const db = seeded();
    const lying = { Account: { ...overrides.Account, status: () => undefined as unknown as string } };
    const manifest = bindSchema(db, tinyModel, lying);
    expect(() => observeEntities(db, tinyModel, manifest, lying)).toThrow(/Account\.status.*a1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/observe.test.ts`
Expected: FAIL — `Cannot find module './observe.js'`.

- [ ] **Step 3: Implement observe**

```ts
// lattice/src/conform/observe.ts
import type Database from 'better-sqlite3';
import type { DomainModel } from '../ast/domain.js';
import type { CaseEntity } from '../engine/evaluate.js';
import type { BindingManifest, OverridesModule } from './types.js';

export function observeEntities(db: Database.Database, model: DomainModel,
  manifest: BindingManifest, overrides: OverridesModule): CaseEntity[] {
  const out: CaseEntity[] = [];
  for (const agg of manifest.aggregates) {
    const spec = model.aggregates.find(a => a.name === agg.aggregate)!;
    const nullableRefs = new Set(spec.fields.filter(f => (f.type as any).kind === 'ref').map(f => f.name));
    const rows = db.prepare(`SELECT * FROM ${agg.table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row[agg.keyColumn]);
      const fields: CaseEntity['fields'] = {};
      for (const fb of agg.fields) {
        const v = fb.kind === 'auto'
          ? row[fb.column!]
          : overrides[agg.aggregate]![fb.field]!(db, row);
        if (v === null || v === undefined) {
          if (fb.kind === 'auto' && nullableRefs.has(fb.field)) continue; // absent optional ref
          throw new Error(`conform observe: ${agg.aggregate}.${fb.field} is null/undefined for row ${id} — projection must be total or the field overridden`);
        }
        fields[fb.field] = v as string | number | boolean;
      }
      out.push({ type: agg.aggregate, id, fields });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lattice && npx vitest run src/conform/observe.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/observe.ts lattice/src/conform/observe.test.ts
git commit -m "feat(conform): observe() projection — bindings + overrides to CaseEntities, total or loud

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tier 1 — invariant evaluation with anchored violations

**Files:**
- Create: `lattice/src/conform/tier1.ts`
- Test: `lattice/src/conform/tier1.test.ts`

**Interfaces:**
- Consumes: `evaluateCandidate`, `CaseEntity`, `CaseState` (`src/engine/evaluate.ts`); `buildPlan`, `GenPlan`, `PlanInvariant` (`src/generate/plan.ts`, `src/generate/types.ts`) — **read `src/generate/types.ts` first** for the exact `Anchors` member names (`specElement`, `provenance`, `witnessIds` per `plan.ts:33`; confirm).
- Produces:
  ```ts
  export interface OptOut { invariant: string; reason: string }
  export function checkInvariants(entities: CaseEntity[], plan: GenPlan, optOuts: OptOut[],
    source: string): ConformViolation[];
  ```
- Semantics: for each `PlanInvariant` not opted out, evaluate over `{ entities }`. On `'forbid'`, pin the witnesses: re-evaluate against single-subject slices (`entities` filtered to one aggregate row at a time, keeping all other-aggregate entities for ref-hops) to collect offending ids — for kinds where slicing is unsound (`unique`, `cardinality`, whole-set kinds), report all ids of that aggregate as the witness set with `detail` saying `'set-level violation'`. `anchors` = `provenance` strings + `witnessIds` from the plan node. An opt-out with an empty `reason` is a config error → throw.

- [ ] **Step 1: Write the failing test**

```ts
// lattice/src/conform/tier1.test.ts
import { describe, it, expect } from 'vitest';
import type { CaseEntity } from '../engine/evaluate.js';
import type { GenPlan } from '../generate/types.js';
import { checkInvariants } from './tier1.js';

// Minimal hand-built GenPlan slice: one statePredicate invariant (balance >= 0) with anchors.
// Consult src/generate/types.ts for the exact GenPlan shape; only the members used here matter —
// build the literal to satisfy the real type, adding required-but-irrelevant members as needed.
const plan = {
  invariants: [{
    name: 'nonNegativeBalance', aggregate: 'Account',
    candidate: { kind: 'statePredicate', aggregate: 'Account',
      body: { kind: 'cmp', op: '>=', left: { kind: 'field', path: ['balance'] }, right: { kind: 'int', value: 0 } } },
    anchors: { specElement: 'invariant nonNegativeBalance', provenance: ['elicited (w1, w2)'], witnessIds: ['w1', 'w2'] },
  }],
} as unknown as GenPlan;

const acct = (id: string, balance: number): CaseEntity => ({ type: 'Account', id, fields: { accountId: id, balance } });

describe('checkInvariants', () => {
  it('passes clean state', () => {
    expect(checkInvariants([acct('a1', 10)], plan, [], 'test:clean')).toEqual([]);
  });

  it('reports a violation with spec element, anchors, and the offending row id', () => {
    const v = checkInvariants([acct('a1', 10), acct('a2', -5)], plan, [], 'test:dirty');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      invariant: 'nonNegativeBalance',
      specElement: 'invariant nonNegativeBalance',
      source: 'test:dirty',
      witnessIds: ['a2'],
    });
    expect(v[0]!.anchors).toContain('elicited (w1, w2)');
  });

  it('honors opt-outs with reasons and rejects reasonless ones', () => {
    expect(checkInvariants([acct('a2', -5)], plan, [{ invariant: 'nonNegativeBalance', reason: 'fixture builds pre-migration accounts' }], 's')).toEqual([]);
    expect(() => checkInvariants([], plan, [{ invariant: 'nonNegativeBalance', reason: '' }], 's')).toThrow(/reason/);
  });
});
```

> The `Predicate` literal above must match `src/ast/invariant.ts`'s real `Predicate`/`Term` shapes
> (`cmp`/`field`/`int` discriminants are the expected ones — verify and adjust the literal, not the engine).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/tier1.test.ts`
Expected: FAIL — `Cannot find module './tier1.js'`.

- [ ] **Step 3: Implement tier1**

```ts
// lattice/src/conform/tier1.ts
import { evaluateCandidate, type CaseEntity } from '../engine/evaluate.js';
import type { GenPlan, PlanInvariant } from '../generate/types.js';
import type { ConformViolation } from './types.js';

export interface OptOut { invariant: string; reason: string }

const SET_LEVEL_KINDS = new Set(['unique', 'cardinality', 'sumOverCollection']);

function witnesses(inv: PlanInvariant, entities: CaseEntity[]): { ids: string[]; detail: string } {
  const subjects = entities.filter(e => e.type === inv.aggregate);
  if (SET_LEVEL_KINDS.has(inv.candidate.kind)) {
    return { ids: subjects.map(s => s.id), detail: 'set-level violation' };
  }
  const others = entities.filter(e => e.type !== inv.aggregate);
  const bad = subjects.filter(s =>
    evaluateCandidate(inv.candidate, { entities: [s, ...others] }) === 'forbid');
  return { ids: bad.map(b => b.id), detail: `violated by ${bad.length}/${subjects.length} ${inv.aggregate} row(s)` };
}

export function checkInvariants(entities: CaseEntity[], plan: GenPlan, optOuts: OptOut[],
  source: string): ConformViolation[] {
  for (const o of optOuts) if (!o.reason.trim()) throw new Error(`conform: opt-out for '${o.invariant}' requires a reason`);
  const skipped = new Set(optOuts.map(o => o.invariant));
  const out: ConformViolation[] = [];
  for (const inv of plan.invariants) {
    if (skipped.has(inv.name)) continue;
    // Adopted guard-kind candidates are transition-enablement conditions evaluated on PRE-state
    // (engine §8.1 loud-exclusion rule) — never always-properties. Tier 2 owns them; skipping here
    // is not a silent cap because the report counts only always-property invariants as checked.
    if (inv.candidate.kind === 'guard') continue;
    if (evaluateCandidate(inv.candidate, { entities }) === 'forbid') {
      const w = witnesses(inv, entities);
      out.push({
        invariant: inv.name, specElement: inv.anchors.specElement,
        anchors: [...inv.anchors.provenance, ...inv.anchors.witnessIds],
        witnessIds: w.ids, source, detail: w.detail,
      });
    }
  }
  return out;
}
```

> If `GenPlan.invariants` is named differently (check `src/generate/types.ts`), follow the real
> name everywhere — including the Task 6 CLI wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lattice && npx vitest run src/conform/tier1.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/tier1.ts lattice/src/conform/tier1.test.ts
git commit -m "feat(conform): tier-1 invariant evaluation with anchored, witness-pinned violations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Impl-side capture hook + conform config + overrides

**Files:**
- Create: `implementations/subscriptions/test/conform-capture.ts`
- Create: `implementations/subscriptions/conform/conform.config.json`
- Create: `implementations/subscriptions/conform/overrides.ts`
- Modify: `implementations/subscriptions/vitest.config.ts` (setup file)
- Modify: `implementations/subscriptions/test/support.ts` (export a per-test label setter if needed — see hook)
- Create: `implementations/subscriptions/.gitignore` (ignore `.conform/`)
- Test: `implementations/subscriptions/test/conform-capture.test.ts`

**Interfaces:**
- Consumes: `openDbs` (`test/support.ts`, plan 1); better-sqlite3 `db.serialize()`.
- Produces: after any `vitest run`, `implementations/subscriptions/.conform/snapshots/<seq>-<slug>.sqlite` — one raw DB image per test that opened a DB, plus `<same>.json` `{ source: string }` metadata. **Zero lattice imports.** Also the first REAL contract+overrides: `conform/spec-state.ts` is generated in Task 6 (`--contract`); this task creates `overrides.ts` importing from it — so this task and Task 6 land as ONE commit at the end of Task 6 if `tsc` would otherwise fail on the missing generated file; alternatively generate the contract by hand-running the Task 1 renderer via a one-off `npx tsx -e` (shown below) so this task stands alone. Use the one-off.
- The four overrides (design §4.3 — this IS the measured residual surface):
  ```ts
  status: r => ({ trialing:'trialing', active:'active', past_due:'pastDue', canceled:'canceled', expired:'expired' })[r.lifecycle_state]
  latestInvoice: r => r.current_invoice_id       // semantic rename, nullable ref
  amountPaid: (db, r) => SUM(invoice_payments)
  retryCount: (db, r) => COUNT(dunning_attempts WHERE outcome='failed')
  ```

- [ ] **Step 1: Generate the contract file (one-off; Task 6 makes this a CLI verb)**

```bash
cd lattice && npx tsx -e "
import { renderContract } from './src/conform/contract.js';
import { loadGenInput } from './src/generate/load.js';
import { writeFileSync } from 'node:fs';
const model = loadGenInput('../.lattice-session-subscriptions').model;
writeFileSync('../implementations/subscriptions/conform/spec-state.ts', renderContract(model));
console.log('contract written');
"
```
Expected: `contract written`; the file contains `SubscriptionSpecState`, `InvoiceSpecState`, `SpecOverrides`, `defineOverrides`. (Create the `conform/` directory first if `writeFileSync` complains: `mkdir -p implementations/subscriptions/conform`.)

- [ ] **Step 2: Write the failing capture test**

```ts
// implementations/subscriptions/test/conform-capture.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from './support.js';
import { createSubscription } from '../src/subscription-service.js';

const snapDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.conform', 'snapshots');

describe('conform capture', () => {
  it('a test that opens a db leaves a raw snapshot behind after teardown', () => {
    const db = makeDb();
    createSubscription(db, { id: 's', planCode: 'p', seats: 1, periodStart: 1, periodEnd: 2, licenseFeeAmount: 100 });
    // capture happens in afterEach — assert on artifacts from PREVIOUS tests instead:
    // this file runs two cases; the second sees the first's snapshot.
    expect(true).toBe(true);
  });

  it('previous test produced a .sqlite snapshot + .json meta', () => {
    expect(existsSync(snapDir)).toBe(true);
    const files = readdirSync(snapDir);
    expect(files.some(f => f.endsWith('.sqlite'))).toBe(true);
    expect(files.some(f => f.endsWith('.json'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/conform-capture.test.ts`
Expected: second case FAILs (`.conform/snapshots` does not exist).

- [ ] **Step 4: Write the hook, config, overrides; wire vitest**

```ts
// implementations/subscriptions/test/conform-capture.ts
// Conformance capture: after each test, dump every DB the test opened as a raw SQLite image.
// Deliberately has ZERO imports from lattice/ — the harness reads these bytes offline.
import { afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbs } from './support.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.conform', 'snapshots');
let seq = 0;

afterEach(ctx => {
  if (openDbs.length === 0) return;
  mkdirSync(outDir, { recursive: true });
  const slug = ctx.task.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  for (const db of openDbs.splice(0)) {
    const base = join(outDir, `${String(++seq).padStart(4, '0')}-${slug}`);
    writeFileSync(`${base}.sqlite`, db.serialize());
    writeFileSync(`${base}.json`, JSON.stringify({ source: ctx.task.name }));
    db.close();
  }
});
```

```ts
// implementations/subscriptions/vitest.config.ts  (replace)
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/conform-capture.ts'] },
});
```

```json
// implementations/subscriptions/conform/conform.config.json
{
  "session": "../../.lattice-session-subscriptions",
  "snapshots": ".conform/snapshots",
  "optOuts": []
}
```

```ts
// implementations/subscriptions/conform/overrides.ts
// The residual hand-written adapter (design §4.3). Its size is the slice's measured number.
import type Database from 'better-sqlite3';
import { defineOverrides } from './spec-state.js';

const STATE_MAP: Record<string, 'trialing' | 'active' | 'pastDue' | 'canceled' | 'expired'> = {
  trialing: 'trialing', active: 'active', past_due: 'pastDue', canceled: 'canceled', expired: 'expired',
};

export const overrides = defineOverrides({
  Subscription: {
    status: (_db, row) => STATE_MAP[row.lifecycle_state as string]!,
    latestInvoice: (_db, row) => row.current_invoice_id as string,
  },
  Invoice: {
    amountPaid: (db, row) =>
      ((db as Database.Database).prepare('SELECT COALESCE(SUM(amount),0) s FROM invoice_payments WHERE invoice_id = ?')
        .get(row.id) as { s: number }).s,
    retryCount: (db, row) =>
      ((db as Database.Database).prepare(`SELECT COUNT(*) c FROM dunning_attempts WHERE invoice_id = ? AND outcome = 'failed'`)
        .get(row.id) as { c: number }).c,
  },
});
```

```gitignore
# implementations/subscriptions/.gitignore
.conform/
node_modules/
```

> `latestInvoice` returns `row.current_invoice_id as string` which is `null` for a fresh row —
> observe() (Task 3) hard-errors on a null OVERRIDE return even for refs. Two acceptable fixes;
> pick the first: (a) make observe() treat null/undefined override returns for nullable-ref
> fields the same as auto bindings (omit the key) — extend Task 3's `nullableRefs` check to the
> override branch and add a test; (b) have the override throw on null. Option (a) matches the
> spec's optional-ref semantics. Implement (a) in this task (Modify `lattice/src/conform/observe.ts`,
> extend `observe.test.ts` with a null-ref-override case).

- [ ] **Step 5: Run to green (both packages)**

Run: `cd implementations/subscriptions && rm -rf .conform && npx vitest run && npx tsc --noEmit && cd ../../lattice && npx vitest run src/conform && npx tsc --noEmit`
Expected: impl suite PASS with `.conform/snapshots/` populated (one pair per DB-opening test); conform engine tests (including the new null-ref-override case) PASS.

- [ ] **Step 6: Commit**

```bash
git add implementations/subscriptions/test/conform-capture.ts implementations/subscriptions/test/conform-capture.test.ts \
  implementations/subscriptions/vitest.config.ts implementations/subscriptions/conform/conform.config.json \
  implementations/subscriptions/conform/spec-state.ts implementations/subscriptions/conform/overrides.ts \
  implementations/subscriptions/.gitignore lattice/src/conform/observe.ts lattice/src/conform/observe.test.ts
git commit -m "feat(conform): impl capture hook (raw snapshots, zero lattice deps) + generated contract + 4-field residual overrides

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `lattice conform` CLI — report/enforce over captured snapshots

**Files:**
- Create: `lattice/src/conform/report.ts`
- Modify: `lattice/src/cli.ts` (add `conform` command — mirror the `generate` command's arg wiring at `cli.ts:340` and `cli.ts:518`)
- Test: `lattice/src/conform/report.test.ts` (formatting) and CLI integration below.

**Interfaces:**
- Consumes: everything above; `loadGenInput` + `buildPlan`; dynamic `import()` of the target's `overrides.ts` (the CLI runs under `tsx`, so TS imports resolve).
- Produces:
  ```ts
  // report.ts
  export function runConform(targetDir: string, mode: 'report' | 'enforce'): Promise<{ report: ConformReport; exitCode: number }>;
  export function formatReport(r: ConformReport): string;
  export function writeContract(targetDir: string): Promise<string>; // returns written path
  ```
  CLI: `lattice conform --target <dir> [--report|--enforce] [--contract]` — `--contract` writes `conform/spec-state.ts` and exits; default mode `--report`.
- `runConform` flow: read `<target>/conform/conform.config.json`; `loadGenInput(config.session)`; `buildPlan`; `import(<target>/conform/overrides.ts)`; for each `*.sqlite` in `config.snapshots` (with its `.json` source): open read-only, `bindSchema` (first snapshot also fixes the manifest reported), `observeEntities`, `checkInvariants`. Aggregate a `ConformReport`: violations across all snapshots, `residual` counted from the manifest (auto vs override vs total bindable members), opt-outs echoed. `formatReport` prints: header (target, snapshot count, invariants checked), the residual line (`auto-bound 14/18 fields (78%), 4 overridden, 0 unbound`), each opt-out with reason, then each violation as `VIOLATION <invariant> (<specElement>) — witnesses [ids] — anchors [...] — source <test name>`. Exit codes: `report` → 0 unless harness error; `enforce` → 1 if violations > 0.
- **No silent caps:** if the snapshots directory is empty or missing, that is a harness ERROR (exit 2, message says to run the impl suite first) — never a clean pass.

- [ ] **Step 1: Write the failing formatting test**

```ts
// lattice/src/conform/report.test.ts
import { describe, it, expect } from 'vitest';
import { formatReport } from './report.js';

describe('formatReport', () => {
  it('prints residual surface, opt-outs, and anchored violations', () => {
    const text = formatReport({
      target: 'implementations/subscriptions', snapshots: 12, invariantsChecked: 6,
      optOuts: [{ invariant: 'retryCapWhilePastDue', reason: 'fixture X predates dunning' }],
      violations: [{ invariant: 'activePaidInFull', specElement: 'invariant activePaidInFull',
        anchors: ['hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5'],
        witnessIds: ['sub-1'], source: 'journey: trial → activate', detail: 'violated by 1/3 Subscription row(s)' }],
      residual: { autoBound: 14, overridden: 4, total: 18 },
    });
    expect(text).toContain('auto-bound 14/18');
    expect(text).toContain('4 overridden');
    expect(text).toContain('OPT-OUT retryCapWhilePastDue — fixture X predates dunning');
    expect(text).toContain('VIOLATION activePaidInFull');
    expect(text).toContain('witnesses [sub-1]');
    expect(text).toContain('hand-edited 2026-07-08');
    expect(text).toContain('source journey: trial → activate');
  });

  it('reports a clean run explicitly, never silently', () => {
    const text = formatReport({ target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [],
      violations: [], residual: { autoBound: 14, overridden: 4, total: 18 } });
    expect(text).toContain('0 violations across 3 snapshots (6 invariants checked)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/report.test.ts`
Expected: FAIL — `Cannot find module './report.js'`.

- [ ] **Step 3: Implement report.ts and the CLI verb**

```ts
// lattice/src/conform/report.ts
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadGenInput } from '../generate/load.js';
import { buildPlan } from '../generate/plan.js';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';
import { checkInvariants, type OptOut } from './tier1.js';
import { renderContract } from './contract.js';
import type { BindingManifest, ConformReport, ConformViolation, OverridesModule } from './types.js';

interface ConformConfig { session: string; snapshots: string; optOuts: OptOut[] }

function readConfig(targetDir: string): ConformConfig {
  return JSON.parse(readFileSync(join(targetDir, 'conform', 'conform.config.json'), 'utf8')) as ConformConfig;
}

export async function writeContract(targetDir: string): Promise<string> {
  const cfg = readConfig(targetDir);
  const { model } = loadGenInput(resolve(targetDir, cfg.session));
  const path = join(targetDir, 'conform', 'spec-state.ts');
  writeFileSync(path, renderContract(model));
  return path;
}

function residual(manifest: BindingManifest): ConformReport['residual'] {
  const all = manifest.aggregates.flatMap(a => a.fields);
  return {
    autoBound: all.filter(f => f.kind === 'auto').length,
    overridden: all.filter(f => f.kind === 'override').length,
    total: all.length + manifest.aggregates.reduce((n, a) => n + a.unbound.length, 0),
  };
}

export async function runConform(targetDir: string, mode: 'report' | 'enforce'):
  Promise<{ report: ConformReport; exitCode: number }> {
  const cfg = readConfig(targetDir);
  const input = loadGenInput(resolve(targetDir, cfg.session));
  const plan = buildPlan(input);
  const ovModule = await import(resolve(targetDir, 'conform', 'overrides.ts')) as { overrides: OverridesModule };
  const snapDir = resolve(targetDir, cfg.snapshots);
  if (!existsSync(snapDir)) throw new Error(`conform: no snapshots at ${snapDir} — run the target's test suite first`);
  const snaps = readdirSync(snapDir).filter(f => f.endsWith('.sqlite')).sort();
  if (snaps.length === 0) throw new Error(`conform: snapshot directory ${snapDir} is empty — run the target's test suite first`);
  const violations: ConformViolation[] = [];
  let manifest: BindingManifest | undefined;
  for (const snap of snaps) {
    const db = new Database(join(snapDir, snap), { readonly: true });
    try {
      const meta = JSON.parse(readFileSync(join(snapDir, snap.replace(/\.sqlite$/, '.json')), 'utf8')) as { source: string };
      const m = bindSchema(db, input.model, ovModule.overrides);
      manifest ??= m;
      const entities = observeEntities(db, input.model, m, ovModule.overrides);
      violations.push(...checkInvariants(entities, plan, cfg.optOuts, meta.source));
    } finally { db.close(); }
  }
  const report: ConformReport = {
    target: targetDir, snapshots: snaps.length,
    invariantsChecked: plan.invariants.filter(i => i.candidate.kind !== 'guard').length,
    optOuts: cfg.optOuts, violations, residual: residual(manifest!),
  };
  const exitCode = mode === 'enforce' && violations.length > 0 ? 1 : 0;
  return { report, exitCode };
}

export function formatReport(r: ConformReport): string {
  const lines = [
    `conform ${r.target}`,
    `${r.violations.length} violations across ${r.snapshots} snapshots (${r.invariantsChecked} invariants checked)`,
    `residual surface: auto-bound ${r.residual.autoBound}/${r.residual.total} fields ` +
      `(${Math.round((100 * r.residual.autoBound) / r.residual.total)}%), ${r.residual.overridden} overridden`,
    ...r.optOuts.map(o => `OPT-OUT ${o.invariant} — ${o.reason}`),
    ...r.violations.map(v =>
      `VIOLATION ${v.invariant} (${v.specElement}) — witnesses [${v.witnessIds.join(', ')}] — ` +
      `${v.detail} — anchors [${v.anchors.join('; ')}] — source ${v.source}`),
  ];
  return lines.join('\n');
}
```

CLI wiring in `lattice/src/cli.ts` — follow the `generate` verb's existing pattern exactly (arg validation near line 340, execution near line 518):
- args: `--target` (required), `--enforce` / `--report` (flags, default report), `--contract` (flag).
- execution: `--contract` → `await writeContract(target)`, print the path, exit 0. Otherwise `const { report, exitCode } = await runConform(target, enforce ? 'enforce' : 'report'); console.log(formatReport(report)); process.exit(exitCode)`. Harness errors (thrown) → print message, exit 2.

- [ ] **Step 4: Run unit tests, then the real integration**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit`
Expected: PASS.

Integration (the negative-control plumbing — design §7.2's first data point):
```bash
cd implementations/subscriptions && rm -rf .conform && npx vitest run
cd ../../lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --report
```
Expected: exit 0 and a report whose first two lines are `conform ../implementations/subscriptions` and `0 violations across N snapshots (6 invariants checked)` (N = number of DB-opening tests, ≥ 15), and a residual line of `auto-bound 14/18 fields (78%), 4 overridden`.

**If violations appear here, STOP and diagnose — do not add opt-outs to get to zero.** Each line is either (a) a harness bug (fix in conform/), (b) an impl bug (the impl genuinely violates the spec — fix the impl; plan 1's self-review missed it), or (c) a genuine spec–impl semantic mismatch — bring (c) to the human before any change. Zero false positives is a pre-registered criterion, not a tuning target.

Then re-run the contract path end-to-end: `npx tsx src/cli.ts conform --target ../implementations/subscriptions --contract && git diff --stat ../implementations/subscriptions/conform/spec-state.ts`
Expected: empty diff (regeneration is idempotent).

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/report.ts lattice/src/conform/report.test.ts lattice/src/cli.ts
git commit -m "feat(cli): lattice conform — report/enforce over captured snapshots + --contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Round-trip self-check + docs freshness

**Files:**
- Create: `lattice/src/conform/roundtrip.test.ts`
- Modify: `README.md` (status line: conformance Tier 1 landed; Tier 2 + drift experiments pending)

**Interfaces:** consumes the full harness + the real impl package. This is the §11.5.5 guardrail test: write via the impl → read via observe() → equals the impl's own semantics.

- [ ] **Step 1: Write the round-trip test**

```ts
// lattice/src/conform/roundtrip.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadGenInput } from '../generate/load.js';
import { bindSchema } from './bind.js';
import { observeEntities } from './observe.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const implDir = join(repoRoot, 'implementations/subscriptions');
const snapDir = join(implDir, '.conform/snapshots');

// Round-trip guardrail (design §4.3): the projection must agree with the impl's own outbox facts.
// For every snapshot: a SubscriptionActivated event implies the aggregate observes status ∈
// {active, pastDue, canceled} (activated then possibly failed/canceled later) and NEVER
// trialing/expired; an InvoicePaid event implies that invoice observes amountPaid == totalDue.
describe('observe() round-trip against the event stream', () => {
  it.skipIf(!existsSync(snapDir))('projection never contradicts recorded events', async () => {
    const { model } = loadGenInput(join(repoRoot, '.lattice-session-subscriptions'));
    const { overrides } = await import(join(implDir, 'conform/overrides.ts'));
    for (const snap of readdirSync(snapDir).filter(f => f.endsWith('.sqlite'))) {
      const db = new Database(join(snapDir, snap), { readonly: true });
      try {
        const entities = observeEntities(db, model, bindSchema(db, model, overrides), overrides);
        const events = db.prepare('SELECT event_type, aggregate_id FROM outbox ORDER BY id').all() as
          { event_type: string; aggregate_id: string }[];
        for (const e of events) {
          if (e.event_type === 'SubscriptionActivated') {
            const s = entities.find(x => x.type === 'Subscription' && x.id === e.aggregate_id)!;
            expect(['active', 'pastDue', 'canceled'], `${snap}: ${e.aggregate_id}`).toContain(s.fields.status);
          }
          if (e.event_type === 'InvoicePaid') {
            const i = entities.find(x => x.type === 'Invoice' && x.id === e.aggregate_id)!;
            expect(i.fields.amountPaid, `${snap}: ${e.aggregate_id}`).toBe(i.fields.totalDue);
          }
        }
      } finally { db.close(); }
    }
  });
});
```

> This cross-check is deliberately conservative (post-activation states include later legal
> moves). Plan 3's trace checker replaces it with full reachability semantics; this test stays as
> the fast guardrail. If `it.skipIf` reports the suite skipped, run the impl suite first — a
> SKIPPED round-trip must be treated as a failure in CI contexts (note it in the report when
> wiring CI later; for this slice, just don't skip: generate snapshots first).

- [ ] **Step 2: Run everything**

Run:
```bash
cd implementations/subscriptions && rm -rf .conform && npx vitest run && npx tsc --noEmit
cd ../../lattice && npx vitest run && npx tsc --noEmit
```
Expected: both packages fully green, including `roundtrip.test.ts` (not skipped — snapshots exist from the first command). Full engine suite (~679+ tests) passes with golden traces green; avoid heavy parallel work during the run (trace B latency sensitivity).

- [ ] **Step 3: Update README status + commit**

Edit the README status paragraph: move conformance from "Not yet built" to built-in-part — `conformance Tier 1 (CI wedge: auto-bound observe(), anchored invariant reports over captured suite states — lattice conform) landed; Tier 2 trace checker + drift experiments in progress`.

```bash
git add lattice/src/conform/roundtrip.test.ts README.md
git commit -m "test(conform): event↔state round-trip guardrail over real impl snapshots; README status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review checklist (run after Task 7)

1. **Design §4 coverage:** binder ✓ (T2), contract+compile-tripwire ✓ (T1/T5), observe ✓ (T3), Tier 1 ✓ (T4), capture at quiescence ✓ (T5), CLI report/enforce + no-silent-caps ✓ (T6), round-trip guardrail ✓ (T7). Ledger write-back + Tier 2 + runtime budget → plan 3 (deliberate).
2. **Residual measured:** the report prints auto-bound/overridden/total — record the real numbers in the plan-3 kickoff notes.
3. **Type consistency:** `OverridesModule` (engine, untyped) vs `SpecOverrides` (generated, typed) — the impl's `overrides.ts` satisfies both (structural). Verify `tsc` in BOTH packages.
4. **Zero-false-positive status:** Task 6's integration ran clean, or the discrepancy was escalated to the human — never opt-outed away.
