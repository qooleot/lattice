# Adversarial Generation Plan 1: Walk, Drivers, Clean-Impl Validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `lattice conform --drive` — a seeded fast-check walk that drives a target implementation through generated command sequences, evaluates spec guards on real pre-states (legal ⇒ must accept, illegal probe ⇒ must reject), interleaves superset ops, and pushes every reached state through the unchanged slice-2 check path — validated by a clean run on `implementations/subscriptions`.

**Architecture (design §2–3):** Commands are generated as INTENTIONS (`try transition T on the k-th row of aggregate A`); legality is decided at execution time against a SCOPED real read (target row + ref hops through the existing binder/observe machinery — no mirror). Post-states are checked by a `checkDb` helper factored out of `runConform`'s per-snapshot loop. fast-check supplies seeds, replay, and array shrinking; on failure the shrunk sequence re-executes with per-step full checks.

**Tech Stack:** TypeScript strict ESM in `lattice/`; fast-check ^3 (already a dependency); better-sqlite3. Target-side: one hand-written `conform/drive.ts` (~20 lines, typed against the generated contract).

## Global Constraints

- No solver in the driving/checking path; no mirror — every legality decision reads the real DB through the existing projection (design fork 4).
- Determinism: all randomness flows from the campaign seed; drivers receive a monotonic `clock()` — `Date.now()` must not appear anywhere in `drive/` or `conform/drive.ts` (design §6).
- Oracle semantics (design §3, as amended by the 2026-07-16 human ruling): legal command rejected ⇒ violation `driver: impl rejected a spec-legal command`; illegal probe accepted ⇒ violation ONLY after post-accept re-attribution fails (no legal sibling transition explains the observed pre→post step — Tier 2's single-step rule; a sibling match is recorded as a narrative re-attribution, and the shared-entry-point masking limitation is reported); superset ops — either outcome acceptable; guard evaluation = `evaluateCandidate` with the transition's `requires` wrapped as a `statePredicate` candidate over the scoped entities (`'permit'` = guard holds; `evalPred` is not exported — do not export it, wrap instead).
- Diagnostics: driver violations carry `specElement` (`transition <name>` / `machine <Agg>.<region>`), the transition's `anchors` from `GenPlan`, `witnessIds` = [row id], and a `detail` containing the human-readable intention (`settle inv-3 (illegal: guard amountPaid == totalDue does not hold) → ACCEPTED`).
- Gates before every commit: `cd lattice && npx vitest run src/conform && npx tsc --noEmit`; impl gates when its files change. No full-suite runs by implementers (controller runs it once at plan end).
- Never `git add -A`; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Repo shape facts: `PlanAggregate { name; fields; regions; transitions; invariants }` / `PlanTransition { name; region; from; to; requires?; emits?; anchors }` from `src/generate/plan.ts`; `bindSchema`/`observeEntities` in `src/conform/{bind,observe}.ts`; observed region state key `'<region>.state'`; `ConformViolation` in `src/conform/types.ts`; the conform CLI block in `src/cli.ts` is session-less and handles `--target/--report/--enforce/--contract`.

---

## File Structure

- Modify `lattice/src/conform/contract.ts` — emit driver typing into the generated contract (Task 1).
- Modify `lattice/src/conform/observe.ts` — add `observeScoped` (Task 2).
- Modify `lattice/src/conform/report.ts` — extract `checkDb` (Task 3); drive wiring + ledger metadata (Task 6).
- Create `lattice/src/conform/drive/intent.ts` — intention types + arbitraries (Task 4).
- Create `lattice/src/conform/drive/walk.ts` — sequence executor + oracle (Task 4).
- Create `lattice/src/conform/drive/campaign.ts` — seeded fc campaign + shrink/replay formatting (Task 5).
- Create `implementations/subscriptions/conform/drive.ts` — the hand-written driver map (Task 6).
- Modify `lattice/src/cli.ts` — `--drive --sequences --length --seed --check-every --probe-rate` (Task 6).
- Tests co-located: `drive/intent.test.ts`, `drive/walk.test.ts`, `drive/campaign.test.ts`, plus contract/observe/report test extensions.

---

### Task 1: Generated driver typing in the contract

**Files:**
- Modify: `lattice/src/conform/contract.ts`
- Modify: `lattice/src/conform/contract.test.ts`
- Regenerate: `implementations/subscriptions/conform/spec-state.ts` (via `lattice conform --target ../implementations/subscriptions --contract`)

**Interfaces:**
- Consumes: `renderContract(model)` and the existing per-aggregate `<Name>SpecState` emission.
- Produces (appended to the generated, self-contained contract):
  ```ts
  export interface DriveGen { int(min: number, max: number): number; id(): string; pick<T>(xs: T[]): T; clock(): number }
  export type DriveOutcome = { accepted: true } | { accepted: false; rejected: string };
  export interface SpecDrivers {
    transitions: {
      // one REQUIRED member per transition of each aggregate's machine, e.g.:
      activate(db: unknown, row: SubscriptionSpecState, gen: DriveGen): void;
      // ... every transition name, param row typed by its OWNING aggregate's SpecState
    };
    superset?: Record<string, (db: unknown, row: SubscriptionSpecState | InvoiceSpecState, gen: DriveGen) => void>;
    create: {
      // one REQUIRED member per aggregate:
      Subscription(db: unknown, id: string, gen: DriveGen): void;
      Invoice?(db: unknown, id: string, gen: DriveGen): void; // aggregates whose rows are created BY other drivers may be optional — see note
    };
  }
  export function defineDrivers(d: SpecDrivers): SpecDrivers { return d }
  ```
  Emission rules: `transitions` members are generated from every aggregate's machine (name → `(db: unknown, row: <Agg>SpecState, gen: DriveGen) => void`); drivers signal rejection by THROWING (the walk normalizes to `DriveOutcome`); `create` members are all OPTIONAL except aggregates that no other aggregate's create path produces — to keep the generator simple and honest, emit ALL create members as optional (`Subscription?(...)`) and let the WALK error loudly at startup if it has no way to create any aggregate (checked in Task 4). Adjust the interface above accordingly: all `create` members optional.

- [ ] **Step 1: Extend the contract test**

Add to `lattice/src/conform/contract.test.ts` (the existing `src` constant):

```ts
  it('emits driver typing: one transitions member per machine transition, DriveGen, defineDrivers', () => {
    expect(src).toContain('export interface SpecDrivers');
    expect(src).toContain('activate(db: unknown, row: SubscriptionSpecState, gen: DriveGen): void;');
    expect(src).toContain('settle(db: unknown, row: InvoiceSpecState, gen: DriveGen): void;');
    expect(src).toContain('export function defineDrivers(d: SpecDrivers): SpecDrivers { return d }');
    expect(src).toContain('export interface DriveGen');
    expect(src).toContain(`Subscription?(db: unknown, id: string, gen: DriveGen): void;`);
  });
```

- [ ] **Step 2: Run to verify failure** — `cd lattice && npx vitest run src/conform/contract.test.ts` → FAIL on the new assertions.

- [ ] **Step 3: Implement the emission**

In `contract.ts`, after the `SpecOverrides` block, append generation of: `DriveGen` + `DriveOutcome` (verbatim literals), `SpecDrivers` with a `transitions` member per `model.aggregates.flatMap(a => (a.machine?.transitions ?? []).map(t => ({ t, a })))` (`  ${t.name}(db: unknown, row: ${a.name}SpecState, gen: DriveGen): void;`), an optional `superset?: Record<string, (db: unknown, row: ${union of all SpecState names}, gen: DriveGen) => void>`, `create` with one optional member per aggregate, and `defineDrivers`. Keep the file self-contained (no imports).

- [ ] **Step 4: Regenerate the committed contract + gates**

```bash
cd lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --contract
npx vitest run src/conform && npx tsc --noEmit
cd ../implementations/subscriptions && npx tsc --noEmit
```
Expected: contract file diff shows only the appended driver block; all green.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/contract.ts lattice/src/conform/contract.test.ts implementations/subscriptions/conform/spec-state.ts
git commit -m "feat(conform): generated contract emits typed driver surface (SpecDrivers, DriveGen)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `observeScoped` — the per-step real read

**Files:**
- Modify: `lattice/src/conform/observe.ts`
- Test: `lattice/src/conform/observe.test.ts` (extend)

**Interfaces:**
- Consumes: `bindSchema` manifest, existing `observeEntities` internals (share the per-row projection logic — extract a private `projectRow(db, model, agg, row, overrides)` used by both; do NOT duplicate the null/override/region-key logic).
- Produces:
  ```ts
  /** Project ONE row (by key value) plus the transitive closure of its ref fields.
   *  Returns entities in closure order (target row first). Throws if the id is absent. */
  export function observeScoped(db: Database.Database, model: DomainModel,
    manifest: BindingManifest, overrides: OverridesModule,
    aggregate: string, id: string): CaseEntity[];
  ```
  Semantics: query the aggregate's table `WHERE <keyColumn> = ?`; project it; for each ref field present in `fields`, look up the referenced row (the ref's target aggregate comes from the model's field `TypeRef { kind:'ref', target }`) and project it too (one hop is sufficient for guard evaluation — the spec's guards traverse at most one ref; recurse one level only and document that bound).

- [ ] **Step 1: Write the failing test**

```ts
// extend lattice/src/conform/observe.test.ts
  it('observeScoped projects one row plus its ref closure (one hop)', () => {
    const db = seeded(); // existing helper: account a1 with entries + parent_id column
    db.prepare(`INSERT INTO accounts (id, owner_name, state, parent_id) VALUES ('a2','Bob','openState','a1')`).run();
    const manifest = bindSchema(db, tinyModel, overrides);
    const scoped = observeScoped(db, tinyModel, manifest, overrides, 'Account', 'a2');
    expect(scoped.map(e => e.id)).toEqual(['a2', 'a1']);       // target first, then ref target
    expect(scoped[0]!.fields.parent).toBe('a1');
    expect(() => observeScoped(db, tinyModel, manifest, overrides, 'Account', 'ghost')).toThrow(/ghost/);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/conform/observe.test.ts` → FAIL (`observeScoped` not exported).

- [ ] **Step 3: Implement** — extract `projectRow` from `observeEntities`'s inner loop (behavior-identical; existing tests must stay green), then implement `observeScoped` per the semantics above (ref target resolution: `model.aggregates.find(a => a.name === (field.type as any).target)`; skip refs whose target row's aggregate has no binding).

- [ ] **Step 4: Gates** — `npx vitest run src/conform && npx tsc --noEmit` → all green (including the pre-existing observe tests, proving the extraction changed nothing).

- [ ] **Step 5: Commit** — `git add lattice/src/conform/observe.ts lattice/src/conform/observe.test.ts` + `git commit -m "feat(conform): observeScoped — single-row + ref-closure projection for per-step driving` (with trailer).

---

### Task 3: Extract `checkDb` from `runConform`

**Files:**
- Modify: `lattice/src/conform/report.ts`
- Test: existing `report.test.ts` (must stay green unchanged — this is a pure extraction)

**Interfaces:**
- Produces:
  ```ts
  export interface CheckContext { input: GenInput; plan: GenPlan; overrides: OverridesModule;
    crosschecks: CrosscheckModule | null; optOuts: OptOut[] }
  export interface CheckDbResult { violations: ConformViolation[]; traceRowsChecked: number;
    manifest: BindingManifest }
  export function checkDb(db: Database.Database, ctx: CheckContext, source: string): CheckDbResult;
  ```
  `runConform`'s per-snapshot loop body becomes exactly: open db → `checkDb(db, ctx, meta.source)` → accumulate. Behavior identical: same bind/observe/tier1/trace/crosscheck order, same violation aggregation.

- [ ] **Step 1: Extract** — move the loop body into `checkDb`; `runConform` builds `ctx` once (it already loads input/plan/overrides/crosschecks/optOuts before the loop).

- [ ] **Step 2: Gates prove no behavior change** — `npx vitest run src/conform && npx tsc --noEmit` → all pre-existing tests green, untouched. Then re-verify the real negative control:
```bash
cd ../implementations/subscriptions && rm -rf .conform && npx vitest run 2>&1 | tail -2 && cd ../lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --report | head -3
```
Expected: `0 violations across 23 snapshots (10 invariants checked)`.

- [ ] **Step 3: Commit** — `git add lattice/src/conform/report.ts` + `git commit -m "refactor(conform): extract checkDb — shared post-state check path for passive and drive modes"` (with trailer).

---

### Task 4: Intentions + the walk executor

**Files:**
- Create: `lattice/src/conform/drive/intent.ts`
- Create: `lattice/src/conform/drive/walk.ts`
- Create: `lattice/src/conform/drive/fixtures.ts`
- Test: `lattice/src/conform/drive/walk.test.ts`

**Interfaces:**
- Consumes: `observeScoped` (T2), `checkDb` + `CheckContext` (T3), `evaluateCandidate`, `PlanAggregate`/`PlanTransition`.
- Produces:
  ```ts
  // intent.ts
  export type Intention =
    | { kind: 'create'; aggregate: string; seed: number }
    | { kind: 'transition'; name: string; aggregate: string; rowPick: number; seed: number }
    | { kind: 'probe'; name: string; aggregate: string; rowPick: number; seed: number }   // deliberately fire when ILLEGAL
    | { kind: 'superset'; name: string; aggregate: string; rowPick: number; seed: number };
  export function intentionArb(plan: GenPlan, supersetNames: string[], probeRate: number): fc.Arbitrary<Intention>;
  export function describeIntention(i: Intention, rowId: string | null, legality: string, outcome: string): string;

  // walk.ts
  export interface DriveOpts { checkEvery: number; clockStep: number }
  export interface DriveStats { commands: number; accepted: number; rejected: number;
    probesAttempted: number; probesRejected: number; supersetOps: number;
    guardedTransitionsProbed: string[] }
  export interface DriveResult { violations: ConformViolation[]; stats: DriveStats;
    narrative: string[] /* one describeIntention line per executed step */ }
  export type DriverModule = { drivers: { transitions: Record<string, Fn>; superset?: Record<string, Fn>;
    create: Record<string, (db: unknown, id: string, gen: DriveGenImpl) => void> } };
  export function executeSequence(mkDb: () => Database.Database, drivers: DriverModule,
    ctx: CheckContext, seq: Intention[], opts: DriveOpts): DriveResult;
  ```
  Executor semantics (design §3, implement exactly):
  1. `create`: if no create driver exists for the aggregate, skip (count nothing) — but `executeSequence` THROWS at startup if `drivers.create` is empty (a walk that can create nothing is a config error, loud). Id = `d-${aggregate.toLowerCase()}-${n}` (deterministic counter).
  2. `transition`/`probe`: resolve the row via `rowPick % knownIds[aggregate].length` (skip the step if no rows exist). `observeScoped` the row; compute from-state ok (`fields['<region>.state']` ∈ `t.from`) and guard ok (`requires` wrapped as `{kind:'statePredicate', aggregate, body: requires}` via `evaluateCandidate` over the scoped entities → `'permit'`; a transition with no `requires` has guard ok = true). Legality = both.
     - `transition` intention + legal → call driver; driver THROW ⇒ **violation** (`impl rejected a spec-legal command`, anchors = the transition's). No throw ⇒ accepted.
     - `transition` intention + illegal → downgrade to a probe (fire it, expect rejection) — this keeps generated sequences useful without a legality oracle at generation time.
     - `probe` intention + illegal → call driver; NO throw ⇒ **violation** (`impl accepted a spec-illegal command`). Throw ⇒ correctly rejected (count `probesRejected`; add transition name to `guardedTransitionsProbed` when the illegality came from the guard, not the from-state).
     - `probe` intention + legal → execute as a normal legal command (a probe that turns out legal is just a command).
  3. `superset`: call the driver; either outcome fine; count it.
  4. Every `opts.checkEvery` accepted commands AND at sequence end: `checkDb(db, ctx, source)` with source = `drive:<step>`; violations accumulate (with the narrative attached to the first violation's detail context by the campaign layer, Task 5).
  5. `clock()` = a monotonic counter starting at 1_000_000, advancing `opts.clockStep` per executed step; passed to drivers via the `gen` object (`gen.clock()`).
  `DriveGenImpl`: deterministic from the intention's `seed` (mulberry32 or similar tiny PRNG — write it inline, ~6 lines; fast-check is NOT used inside the executor).
- **Fixture (`drive/fixtures.ts`):** an in-memory driveable tiny target: reuse `tinyModel`/`tinyDb` from `../fixtures.js` (Account machine: `close` emits AccountClosed from openState, plus add — in this drive fixture only, do NOT touch conform/fixtures.ts — a `tinyPlanForWalk: GenPlan` hand-built from tinyModel with a guarded transition: `close` requires `balance == 0` — this exact export name is consumed by BOTH walk.test.ts (via tinyCtx) and campaign.test.ts), a `tinyDrivers: DriverModule` (create inserts an account row + entries; `close` sets `state='closedState'` + inserts outbox row, THROWS when balance ≠ 0 — the CONFORMANT version), and `buggyDrivers` (close never checks balance — accepts illegal probes).

- [ ] **Step 1: Write the failing tests**

```ts
// lattice/src/conform/drive/walk.test.ts
import { describe, it, expect } from 'vitest';
import { executeSequence } from './walk.js';
import { tinyCtx, tinyDrivers, buggyDrivers, mkTinyDb } from './fixtures.js';
import type { Intention } from './intent.js';

const seq = (...xs: Intention[]) => xs;
const create = (seed = 1): Intention => ({ kind: 'create', aggregate: 'Account', seed });
const close = (rowPick = 0, seed = 2): Intention => ({ kind: 'transition', name: 'close', aggregate: 'Account', rowPick, seed });
const probeClose = (rowPick = 0, seed = 3): Intention => ({ kind: 'probe', name: 'close', aggregate: 'Account', rowPick, seed });
const OPTS = { checkEvery: 100, clockStep: 60 };

describe('executeSequence', () => {
  it('conformant target: legal close accepted, illegal probe rejected, zero violations', () => {
    // tinyDrivers.create seeds balance 0 for even seeds, balance 500 for odd seeds (documented in fixtures)
    const r = executeSequence(mkTinyDb, tinyDrivers, tinyCtx(), seq(create(2), close(0)), OPTS);
    expect(r.violations).toEqual([]);
    expect(r.stats).toMatchObject({ accepted: 2, rejected: 0 });   // create + close

    const r2 = executeSequence(mkTinyDb, tinyDrivers, tinyCtx(), seq(create(1), probeClose(0)), OPTS);
    expect(r2.violations).toEqual([]);
    expect(r2.stats.probesAttempted).toBe(1);
    expect(r2.stats.probesRejected).toBe(1);
    expect(r2.stats.guardedTransitionsProbed).toEqual(['close']);
  });

  it('weakened-guard target: illegal probe ACCEPTED is a violation with the transition anchors', () => {
    const r = executeSequence(mkTinyDb, buggyDrivers, tinyCtx(), seq(create(1), probeClose(0)), OPTS);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ specElement: 'transition close' });
    expect(r.violations[0]!.detail).toMatch(/accepted a spec-illegal command/);
  });

  it('over-strict target: rejecting a legal command is a violation', () => {
    // strictDrivers (fixtures): close throws unconditionally
    const { strictDrivers } = await import('./fixtures.js');
    const r = executeSequence(mkTinyDb, strictDrivers, tinyCtx(), seq(create(2), close(0)), OPTS);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/rejected a spec-legal command/);
  });

  it('a transition intention that lands illegal is downgraded to a probe, not a violation', () => {
    const r = executeSequence(mkTinyDb, tinyDrivers, tinyCtx(), seq(create(1), close(0)), OPTS);
    expect(r.violations).toEqual([]);           // balance 500 → close illegal → probed → rejected ✓
    expect(r.stats.probesAttempted).toBe(1);
  });

  it('throws at startup when no create driver exists', () => {
    expect(() => executeSequence(mkTinyDb, { drivers: { transitions: {}, create: {} } } as any,
      tinyCtx(), seq(create()), OPTS)).toThrow(/create/);
  });
});
```

(Convert the file to an async test or top-level import for `strictDrivers` — no `await import` inside a sync `it`; import all three driver modules at the top.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/conform/drive` → FAIL (modules missing).

- [ ] **Step 3: Implement** `intent.ts`, `fixtures.ts`, `walk.ts` per the Produces block. Keep `walk.ts` under ~150 lines; the oracle branch structure mirrors the semantics list 1–5 exactly. `intentionArb` uses `fc.oneof` weighted by `probeRate` (`fc.record` over the intention fields; `rowPick: fc.nat(31)`, `seed: fc.nat(2**31 - 1)`).

- [ ] **Step 4: Gates** — `npx vitest run src/conform && npx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — the four new files + `git commit -m "feat(conform): drive walk — intention executor with real-pre-state oracle and guard probing"` (with trailer).

---

### Task 5: Seeded campaign + shrinking

**Files:**
- Create: `lattice/src/conform/drive/campaign.ts`
- Test: `lattice/src/conform/drive/campaign.test.ts`

**Interfaces:**
- Consumes: `executeSequence`, `intentionArb`, fast-check.
- Produces:
  ```ts
  export interface CampaignOpts { sequences: number; length: number; seed: number;
    checkEvery: number; probeRate: number; clockStep: number }
  export interface CampaignResult {
    clean: boolean; sequencesRun: number; stats: DriveStats /* aggregated */;
    failure?: { seed: number; shrunk: Intention[]; narrative: string[];
      violations: ConformViolation[] };
    durationMs: number }
  export function runCampaign(mkDb: () => Database.Database, drivers: DriverModule,
    ctx: CheckContext, plan: GenPlan, supersetNames: string[], opts: CampaignOpts): CampaignResult;
  export function formatCampaign(r: CampaignResult): string;
  ```
  Implementation: `fc.check(fc.property(fc.array(intentionArb(...), { maxLength: opts.length }), seq => executeSequence(...).violations.length === 0), { seed: opts.seed, numRuns: opts.sequences })`. On failure (`checkResult.failed`), fast-check's counterexample IS the shrunk sequence (fc shrinks arrays + record fields natively); re-execute it once with `checkEvery: 1` to produce the precise narrative + violations for the report. `formatCampaign` prints: `drive: N sequences × ≤L commands, seed S — CLEAN` + stats lines (`guards probed at event time: N attempts across M guarded transitions`), or the failure block: seed, `replay: lattice conform --target … --drive --seed S`, the narrative (one `describeIntention` line per step), and the standard violation lines.
  Aggregated stats accumulate across ALL runs fast-check executes (thread a mutable collector through the property).

- [ ] **Step 1: Write the failing tests**

```ts
// lattice/src/conform/drive/campaign.test.ts
import { describe, it, expect } from 'vitest';
import { runCampaign, formatCampaign } from './campaign.js';
import { tinyCtx, tinyDrivers, buggyDrivers, mkTinyDb, tinyPlanForWalk } from './fixtures.js';

const OPTS = { sequences: 50, length: 12, seed: 42, checkEvery: 5, probeRate: 0.3, clockStep: 60 };

describe('runCampaign', () => {
  it('clean target: campaign is clean, deterministic, and reports probe coverage', () => {
    const a = runCampaign(mkTinyDb, tinyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    const b = runCampaign(mkTinyDb, tinyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(true);
    expect(a.stats.probesAttempted).toBeGreaterThan(0);
    expect(b.stats).toEqual(a.stats);                      // seeded determinism
    expect(formatCampaign(a)).toContain('guards probed at event time:');
  });

  it('buggy target: campaign fails, shrinks to a minimal repro, and replays identically', () => {
    const a = runCampaign(mkTinyDb, buggyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(a.clean).toBe(false);
    expect(a.failure!.shrunk.length).toBeLessThanOrEqual(3); // create + probe (+ slack)
    expect(a.failure!.violations[0]!.detail).toMatch(/accepted a spec-illegal command/);
    const b = runCampaign(mkTinyDb, buggyDrivers, tinyCtx(), tinyPlanForWalk, [], OPTS);
    expect(b.failure!.shrunk).toEqual(a.failure!.shrunk);   // same seed ⇒ same shrunk repro
    expect(formatCampaign(a)).toContain(`--seed ${OPTS.seed}`);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/conform/drive/campaign.test.ts` → FAIL.

- [ ] **Step 3: Implement** per Produces. (`tinyPlanForWalk` = the fixture's GenPlan export — add it to `drive/fixtures.ts` if Task 4 named it differently; keep ONE name across both test files.)

- [ ] **Step 4: Gates** — `npx vitest run src/conform && npx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — both files + `git commit -m "feat(conform): seeded drive campaigns with fast-check shrinking and deterministic replay"` (with trailer).

---

### Task 6: The impl driver map, CLI wiring, ledger metadata — and the clean-impl validation

**Files:**
- Create: `implementations/subscriptions/conform/drive.ts`
- Modify: `lattice/src/conform/report.ts` (drive entry point `runDrive(targetDir, opts)`)
- Modify: `lattice/src/conform/types.ts` (`ConformReport` untouched; new `DriveReport` lives in campaign types — only the ledger union grows)
- Modify: `lattice/src/engine/session.ts` (conformance entry gains optional drive metadata)
- Modify: `lattice/src/cli.ts` (flags)
- Test: `lattice/src/conform/report.test.ts` (extend)

**Interfaces:**
- `implementations/subscriptions/conform/drive.ts` — the design's fork-3 map, verbatim shape (adjusted to the real generated types; rejection = the service functions throw, which is already the impl's convention):
  ```ts
  import type Database from 'better-sqlite3';
  import { defineDrivers, type DriveGen, type SubscriptionSpecState, type InvoiceSpecState } from './spec-state.js';
  import { createSubscription, activate, cancelSubscription, expireTrials, recordUsage, changeSeats, changePlan, rolloverPeriod, getSubscription } from '../src/subscription-service.js';
  import { finalizeInvoice, recordPayment, voidInvoice, writeOffInvoice } from '../src/billing-service.js';
  import { recordPaymentFailure, runDunning } from '../src/dunning.js';

  const DB = (db: unknown) => db as Database.Database;
  export const drivers = defineDrivers({
    transitions: {
      activate:      (db, row: SubscriptionSpecState, gen) => activate(DB(db), row.subId),
      cancel:        (db, row: SubscriptionSpecState, gen) => cancelSubscription(DB(db), row.subId),
      expireTrial:   (db, row: SubscriptionSpecState, gen) => {
        if (expireTrials(DB(db), row.periodEnd + 1) === 0) throw new Error('expireTrial: no-op (not expired)');
      },
      paymentFailed: (db, row: SubscriptionSpecState, gen) => recordPaymentFailure(DB(db), row.latestInvoice!, gen.clock()),
      recover:       (db, row: SubscriptionSpecState, gen) => { /* side effect of settling the open invoice */
        const inv = DB(db).prepare(`SELECT id, total_due FROM invoices WHERE subscription_id = ? AND settlement_state='open'`).get(row.subId) as any;
        if (!inv) throw new Error('recover: no open invoice');
        const paid = (DB(db).prepare(`SELECT COALESCE(SUM(amount),0) s FROM invoice_payments WHERE invoice_id = ?`).get(inv.id) as any).s;
        recordPayment(DB(db), inv.id, inv.total_due - paid, gen.clock());
      },
      dunningExhausted: (db, row: SubscriptionSpecState, gen) => {
        for (let i = 0; i < 10; i++) {
          const s = getSubscription(DB(db), row.subId).lifecycle_state;
          if (s !== 'past_due') { if (i === 0) throw new Error('dunningExhausted: not past_due'); return; }
          runDunning(DB(db), gen.clock(), () => false);
        }
      },
      finalize:  (db, row: InvoiceSpecState, gen) => finalizeInvoice(DB(db), row.invoiceId),
      settle:    (db, row: InvoiceSpecState, gen) => recordPayment(DB(db), row.invoiceId, row.totalDue - row.amountPaid, gen.clock()),
      voidDraft: (db, row: InvoiceSpecState, gen) => voidInvoice(DB(db), row.invoiceId),
      voidOpen:  (db, row: InvoiceSpecState, gen) => voidInvoice(DB(db), row.invoiceId),
      writeOff:  (db, row: InvoiceSpecState, gen) => writeOffInvoice(DB(db), row.invoiceId),
    },
    superset: {
      recordUsage:  (db, row, gen) => recordUsage(DB(db), (row as SubscriptionSpecState).subId, gen.int(1, 50), gen.int(0, 200)),
      changeSeats:  (db, row, gen) => changeSeats(DB(db), (row as SubscriptionSpecState).subId, gen.int(1, 20), gen.int(-500, 2000)),
      partialPayment: (db, row, gen) => recordPayment(DB(db), (row as InvoiceSpecState).invoiceId, gen.int(1, 100), gen.clock()),
      dunningSweep: (db, _row, gen) => { runDunning(DB(db), gen.clock(), () => gen.int(0, 1) === 1); },
      rollover: (db, row, gen) => rolloverPeriod(DB(db), (row as SubscriptionSpecState).subId,
        { nextInvoiceId: gen.id(), licenseFeeAmount: gen.int(100, 9000), nextPeriodEnd: gen.clock() + 10_000,
          now: gen.clock(), charge: () => gen.int(0, 1) === 1 }),
      changePlanOp: (db, row, gen) => changePlan(DB(db), (row as SubscriptionSpecState).subId,
        { newId: gen.id(), planCode: gen.pick(['basic', 'pro']), licenseFeeAmount: gen.int(100, 9000),
          now: gen.clock(), periodEnd: gen.clock() + 20_000 }),
    },
    create: {
      Subscription: (db, id, gen) => createSubscription(DB(db), { id, planCode: gen.pick(['basic', 'pro']), seats: gen.int(1, 9),
        periodStart: gen.clock(), periodEnd: gen.clock() + 10_000, licenseFeeAmount: gen.int(100, 9000), maxRetries: gen.int(1, 3) }),
    },
  });
  ```
  NOTE ON `expireTrial` and `dunningExhausted`: both are induced via JOBS, so their drivers must convert silent no-ops into throws (the walk's oracle needs accept/reject signal). NOTE ON `recover`/`settle` superset arg shapes: the `superset` record's row union means casts — acceptable in the hand-written file. NOTE ON `DriveGen.clock`: Task 4's `gen` object carries `clock()`; the generated `DriveGen` interface from Task 1 must include `clock(): number` — add it there (and its contract test assertion) if Task 1 landed without it.
- `runDrive(targetDir, opts)` in `report.ts`: load config/input/plan/overrides/crosschecks exactly as `runConform` does; dynamic-import `<target>/conform/drive.ts` (shape-validated like overrides: must export `drivers` with non-empty `transitions` and `create`); `mkDb` = open the impl's schema fresh in memory — the target config gains an optional `driveDb` module path... NO: keep it simple and honest — `mkDb` opens `:memory:` and executes the target's `src/schema.sql`, whose path comes from a new optional `conform.config.json` key `"schema": "src/schema.sql"` (error loudly if `--drive` is used without it). Superset names = `Object.keys(drivers.superset ?? {})`. Run the campaign; print `formatCampaign`; append the ledger `conformance` entry with `mode: 'drive'` plus `drive: { sequences, seed, probesAttempted, probesRejected, guardedTransitionsProbed, shrunk?: string[] }` (extend the session.ts union member with this optional field, inline). Exit 0 clean / 1 failure / 2 harness error.
- CLI: `--drive` (boolean) + `--sequences`, `--length`, `--seed`, `--check-every`, `--probe-rate` (strings, parsed with the defaults 200/30/1/10/0.2) — route to `runDrive` inside the existing session-less conform block.

- [ ] **Step 1: Failing test for the drive-module validation + ledger shape** (extend `report.test.ts`): a tmp target with config+overrides+spec-state but NO drive.ts → `runDrive` rejects with /must export 'drivers'/; (reuse the established mkdtemp scaffolding; also assert the missing-`schema`-key error when drive.ts exists but config lacks `schema` — write a stub drive.ts exporting empty maps and expect the non-empty-transitions validation error instead; two assertions, whichever fires first is fine — pin the actual order).

- [ ] **Step 2: Run to verify failure**, then **Step 3: implement** `runDrive` + CLI + session union + `conform.config.json` gains `"schema": "src/schema.sql"` in the impl target, and the impl's `drive.ts` (code above; fix real signature drift against the actual service functions — the repo is authoritative; keep every entry).

- [ ] **Step 4: THE CLEAN-IMPL VALIDATION (criteria 3-partial, 4, 5)**

```bash
cd lattice && npx vitest run src/conform && npx tsc --noEmit && cd ../implementations/subscriptions && npx tsc --noEmit && cd ../lattice
npx tsx src/cli.ts conform --target ../implementations/subscriptions --drive --sequences 200 --length 30 --seed 1
```
Expected: exit 0; `drive: 200 sequences × ≤30 commands, seed 1 — CLEAN`; `guards probed at event time: N attempts across M guarded transitions` with N > 0 and M ≥ 3 (activate, finalize, settle); duration ≤ 60s. Then determinism: run twice with `--seed 7`, diff the two stats outputs — identical. **If violations appear: STOP.** Each is a checker bug, a driver-map bug, or a REAL impl/spec finding — investigate honestly (the driver map is this task's code — fixing IT is in scope; touching the walk/oracle to make violations disappear is NOT), and if it's a genuine finding, report BLOCKED with the shrunk narrative verbatim.

- [ ] **Step 5: Commit** — all files + ledger evidence + `git commit -m "feat(conform): lattice conform --drive — seeded adversarial campaigns against the real impl (clean-impl validation green)"` (with trailer).

---

### Task 7: README + design status

**Files:** `README.md`, `docs/superpowers/specs/2026-07-15-lattice-adversarial-generation-design.md`

- [ ] **Step 1:** README status: add `adversarial driving (lattice conform --drive: seeded command campaigns with guard probing and shrinking)` to the built list; design doc Status line gains `Plan 1 (walk+drivers) landed; rediscovery campaign = plan 2.`
- [ ] **Step 2:** Gates (`npx vitest run src/conform && npx tsc --noEmit`) + commit `docs(conform): drive plan-1 status` (with trailer).

---

## Self-review checklist (controller, after Task 7)

1. Design §2–4 fully implemented; §5 criteria 3 (one-seed partial), 4, 5 evidenced by Task 6's validation; criteria 1, 2, full 3 → plan 2.
2. No `Date.now()` in `drive/` or the impl driver map (`grep -rn "Date.now" lattice/src/conform/drive implementations/subscriptions/conform/drive.ts` → only campaign duration measurement in campaign.ts is allowed — pin: duration uses Date.now at campaign START/END only, outside the deterministic path).
3. Full engine suite once (controller), flake triage per memory protocol.
