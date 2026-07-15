# Slice 2 Plan 3: Tier 2 Event-Trace Conformance + Ledger Write-Back

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design's primary anti-drift check (design §4.4): a pure-TS trace checker that decides, per aggregate row, whether the observed outbox event sequence plus observed final state corresponds to a path the spec machine allows — with declared-emit transitions forced to align with events and silent transitions free — plus orphan/undeclared-event checks, honest guard-coverage reporting, runtime-budget measurement, and conformance-run write-back to the session ledger. Also clears the four follow-ups recorded by the final review of plans 1–2.

**Architecture:** New `lattice/src/conform/trace.ts` runs a BFS over `(regionState, eventIndex)` per (observed row × machine region), consuming `PlanTransition`s from the existing `GenPlan` and events from the snapshot's own `outbox` table. `runConform` gains a Tier 2 pass per snapshot, duration measurement, and a `conformance` ledger append. No solver anywhere; the checker is deterministic and fast.

**Tech Stack:** TypeScript (strict, ESM) in `lattice/`; better-sqlite3 (already a dependency); the target package `implementations/subscriptions/` for cleanups + the real negative control.

## Global Constraints

- Engine discipline: before every commit `cd lattice && npx vitest run src/conform && npx tsc --noEmit`; the impl package's gates (`cd implementations/subscriptions && npx vitest run && npx tsc --noEmit`) must stay green when touched. Full engine suite is run ONCE by the controller at the end — implementers must not run it (known load-flaky tests; 13 min).
- Diagnostics cite spec elements AND ledger anchors (`PlanTransition.anchors` / `PlanInvariant.anchors`); never claim coverage beyond what was checked. Guard (`requires`) evaluation at event time needs pre-state we do NOT observe in passive mode — this is REPORTED explicitly (a guard-coverage line), never silently skipped.
- Zero-false-positive rule: the negative control (`lattice conform --target ../implementations/subscriptions --report` after a fresh impl suite run) must stay at 0 violations INCLUDING Tier 2. A violation on the clean impl = STOP, report verbatim, never tune or opt-out.
- The trace checker semantics (design §4.4, verbatim): *declared-emit transitions must align exactly with their events; silent transitions are free moves.* Terminal states have no outgoing moves unless the machine says so.
- Runtime budget (design §7.3): a full `lattice conform` run must complete in ≤ 60s; the report prints the measured duration and the budget verdict. Measurement, not gate — exit codes unchanged.
- Never `git add -A`; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Repo shape facts (authoritative over any older sketch): `PlanTransition { name; region; from: string[]; to: string; requires?: Predicate; emits?: string; anchors: Anchors }` and `PlanAggregate { name; fields; regions: Region[]; transitions: PlanTransition[]; invariants; doc? }` in `lattice/src/generate/plan.ts`; `Region { name; initial; states: StateDef[] }` in `src/ast/domain.ts`; observed entities carry region state under the key `'<region>.state'` (e.g. `fields['status.state'] === 'pastDue'`); `LedgerEntry` union + `appendLedger(dir, e)` in `src/engine/session.ts`, every entry `{ kind; at: string (ISO); ... }`.

---

## File Structure

**Engine-side:**
- Create `lattice/src/conform/trace.ts` — the Tier 2 checker (`checkTraces`).
- Modify `lattice/src/conform/types.ts` — `ConformReport` gains `trace` + `durationMs` + `guardCoverage` members.
- Modify `lattice/src/conform/report.ts` — Tier 2 pass, duration, budget line, ledger append, errors→stderr (F6).
- Modify `lattice/src/conform/contract.ts` — nullable-ref types (F7).
- Modify `lattice/src/engine/session.ts` — `conformance` ledger entry kind + `readConformance`.
- Tests co-located: `trace.test.ts`, extensions to `report.test.ts`, `contract.test.ts`.

**Impl-side (cleanups + regenerated contract):**
- Modify `implementations/subscriptions/src/billing-service.ts` — partial-payment summary refresh.
- Modify `implementations/subscriptions/test/conform-capture.ts` + `vitest.config.ts` — stale-snapshot wipe + collision-proof names (F5).
- Regenerate `implementations/subscriptions/conform/spec-state.ts`; drop the now-unneeded cast in `conform/overrides.ts` (F7).
- Test extensions: `test/read-model.test.ts`.

---

### Task 1: Impl cleanups — partial-payment refresh (class-13 exposure) + capture hardening (F5)

**Files:**
- Modify: `implementations/subscriptions/src/billing-service.ts` (recordPayment)
- Modify: `implementations/subscriptions/test/conform-capture.ts`
- Modify: `implementations/subscriptions/vitest.config.ts`
- Create: `implementations/subscriptions/test/conform-global-setup.ts`
- Test: `implementations/subscriptions/test/read-model.test.ts` (extend)

**Interfaces:**
- Consumes: existing `recordPayment(db, invoiceId, amount, now)`, `refreshAccountSummary(db, subId, now)`, `openDbs` in `test/support.ts`.
- Produces: no new exports; behavior only. Snapshot filenames become `<pid>-<seq>-<slug>.sqlite`; the snapshots dir is wiped once per suite run via vitest `globalSetup`.

- [ ] **Step 1: Write the failing test (partial payment refreshes the summary)**

Add to `implementations/subscriptions/test/read-model.test.ts` inside the existing describe:

```ts
  it('a partial payment refreshes open_balance without settling', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-p', planCode: 'pro', seats: 1, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 3_000 });
    finalizeInvoice(db, 'sub-p-inv-1');
    expect(summary(db, 'sub-p').open_balance).toBe(3_000);
    recordPayment(db, 'sub-p-inv-1', 1_000, 1_100); // partial — invoice stays open
    expect(summary(db, 'sub-p')).toMatchObject({ status: 'trialing', open_balance: 2_000 });
  });
```

(`recordPayment` is already imported in this file; if not, add it to the existing import from `../src/billing-service.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/read-model.test.ts`
Expected: FAIL — `open_balance` still 3000 after the partial payment (no refresh on the non-settling path).

- [ ] **Step 3: Fix `recordPayment`**

In `implementations/subscriptions/src/billing-service.ts`, `recordPayment`'s transaction currently ends with `if (paid + amount === inv.total_due) settle(db, inv);`. Change the tail so the summary refreshes on BOTH paths (settle already refreshes internally; the non-settling path must too):

```ts
    db.prepare('INSERT INTO invoice_payments (invoice_id, amount, paid_at) VALUES (?,?,?)').run(invoiceId, amount, now);
    if (paid + amount === inv.total_due) settle(db, inv);
    else refreshAccountSummary(db, inv.subscription_id, now);
```

(`refreshAccountSummary` is already imported in this file for `settle`.)

- [ ] **Step 4: Harden the capture hook (F5)**

Replace `implementations/subscriptions/test/conform-capture.ts`'s naming and add a global wipe:

```ts
// implementations/subscriptions/test/conform-capture.ts — replace the seq/name logic only;
// keep the afterEach structure, splice(0), db.close(), and JSON meta exactly as they are.
// Old name:  `${String(++seq).padStart(4, '0')}-${slug}`
// New name:  `${process.pid}-${String(++seq).padStart(4, '0')}-${slug}`
// Rationale: vitest runs test files in parallel worker processes; each worker loads this setup
// file with its own module state, so a bare seq counter collides across workers. The pid prefix
// makes names collision-free; stale-file cleanup happens once per run in globalSetup (below).
```

```ts
// implementations/subscriptions/test/conform-global-setup.ts
// Runs ONCE per vitest invocation (not per worker): wipe stale snapshots so a run's
// .conform/snapshots contains only artifacts of THIS run — mixed-run corpora made the
// conformance report's "N snapshots" claim dishonest (final-review F5).
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.conform', 'snapshots'),
    { recursive: true, force: true });
}
```

```ts
// implementations/subscriptions/vitest.config.ts  (replace)
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/conform-capture.ts'],
    globalSetup: ['test/conform-global-setup.ts'],
  },
});
```

- [ ] **Step 5: Run the whole impl suite twice; verify gates and no stale mixing**

Run: `cd implementations/subscriptions && npx vitest run && npx vitest run && npx tsc --noEmit && ls .conform/snapshots | wc -l`
Expected: both runs PASS (24 tests: 23 prior + the new partial-payment case); the snapshot count after the second run equals one run's worth (wipe worked — compare against the count printed mid-way if unsure: `npx vitest run && ls .conform/snapshots | wc -l` should print the same number both times); filenames start with a pid.

- [ ] **Step 6: Commit**

```bash
git add implementations/subscriptions/src/billing-service.ts implementations/subscriptions/test/read-model.test.ts \
  implementations/subscriptions/test/conform-capture.ts implementations/subscriptions/test/conform-global-setup.ts \
  implementations/subscriptions/vitest.config.ts
git commit -m "fix(impl): partial payments refresh the summary; snapshot capture is per-run and collision-free

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Engine cleanups — nullable-ref contract types (F7) + conform errors to stderr (F6)

**Files:**
- Modify: `lattice/src/conform/contract.ts`
- Modify: `lattice/src/conform/contract.test.ts`
- Modify: `lattice/src/cli.ts` (conform block's catch)
- Regenerate: `implementations/subscriptions/conform/spec-state.ts` (via the CLI)
- Modify: `implementations/subscriptions/conform/overrides.ts` (drop the cast)

**Interfaces:**
- Consumes: `renderContract(model)`, the conform CLI block in `cli.ts`.
- Produces: ref-typed fields render as `string | null` in `<Agg>SpecState` and in the `SpecOverrides` mapped type (which derives from it automatically); `lattice conform` prints harness errors with `console.error` (stdout stays report-only).

- [ ] **Step 1: Update the contract test**

In `lattice/src/conform/contract.test.ts`, change the ref-field assertion:

```ts
    expect(src).toContain('latestInvoice: string | null;');
```

(replacing the current `'latestInvoice: string;'` expectation; leave every other assertion untouched).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/contract.test.ts`
Expected: FAIL on the new assertion.

- [ ] **Step 3: Make refs nullable in the renderer**

In `lattice/src/conform/contract.ts`'s `tsType`, the ref branch currently returns `'string'`. Change it to `'string | null'`. (Observed semantics already match: `observe()` omits SQL-NULL refs and accepts null-returning ref overrides — the contract type was lying about that; final-review F7.)

- [ ] **Step 4: Regenerate the committed contract and drop the impl cast**

```bash
cd lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --contract
```
Expected: prints the spec-state.ts path; `git diff implementations/subscriptions/conform/spec-state.ts` shows exactly the `latestInvoice: string;` → `latestInvoice: string | null;` line (and any other ref fields).

Then in `implementations/subscriptions/conform/overrides.ts`, change the `latestInvoice` override to return the value without the lying cast:

```ts
    latestInvoice: (_db, row) => row.current_invoice_id as string | null,
```

- [ ] **Step 5: Route conform CLI errors to stderr (F6)**

In `lattice/src/cli.ts`, the conform block's catch currently does `console.log(err instanceof Error ? err.message : String(err))`. Change `console.log` → `console.error` in that catch ONLY (the report itself stays on stdout; machine consumers parse stdout).

- [ ] **Step 6: Gates**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit && cd ../implementations/subscriptions && npx tsc --noEmit && npx vitest run 2>&1 | tail -3`
Expected: all PASS, both typechecks clean.
Also verify stderr routing: `cd ../lattice && npx tsx src/cli.ts conform --target /nonexistent --report 2>/dev/null; echo "exit=$?"` → prints NOTHING on stdout, exit=2; and `... 2>&1 | head -1` shows the ENOENT message.

- [ ] **Step 7: Commit**

```bash
git add lattice/src/conform/contract.ts lattice/src/conform/contract.test.ts lattice/src/cli.ts \
  implementations/subscriptions/conform/spec-state.ts implementations/subscriptions/conform/overrides.ts
git commit -m "fix(conform): ref fields are nullable in the generated contract; CLI errors go to stderr

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The trace checker core (`checkTraces`)

**Files:**
- Create: `lattice/src/conform/trace.ts`
- Test: `lattice/src/conform/trace.test.ts`

**Interfaces:**
- Consumes: `PlanAggregate`, `PlanTransition`, `Anchors` from `../generate/plan.js`; `Region` from `../ast/domain.js`; `CaseEntity` from `../engine/evaluate.js`; `ConformViolation` from `./types.js`.
- Produces:
  ```ts
  export interface ObservedEvent { seq: number; eventType: string; aggregateId: string }
  export interface TraceResult { violations: ConformViolation[]; rowsChecked: number;
    guardedTransitions: string[] /* names of transitions with `requires` — NOT evaluated (reported, §4.4 honesty) */ }
  export function checkTraces(entities: CaseEntity[], events: ObservedEvent[],
    aggregates: PlanAggregate[], source: string): TraceResult;
  ```
- **Semantics (design §4.4, implement exactly):** For each observed entity and each region of its aggregate's machine: collect that row's events (aggregateId === entity.id) restricted to event types some transition OF THAT REGION declares via `emits`, in seq order. BFS over `(state, eventIndex)` from `(region.initial, 0)`:
  - a transition `t` with `t.from.includes(state)` and NO `emits` → move to `(t.to, i)` (silent, free);
  - a transition `t` with `t.from.includes(state)` and `t.emits === events[i].eventType` → move to `(t.to, i+1)`;
  - a declared-emit transition can NEVER be taken silently (that is the skipped-emit catch).
  Accept iff `(observedFinalState, events.length)` is reachable, where observedFinalState = `entity.fields['<region>.state']`. Visited-set on `(state, i)` (silent cycles like recover/paymentFailed terminate).
  - **Orphan events:** an event whose `aggregateId` matches no observed entity → violation (`specElement: 'outbox'`) — this catches emit-outside-transaction where the row's insert rolled back.
  - **Undeclared events:** a row's event whose type NO transition of ANY region of its aggregate declares → violation naming the aggregate and event type.
  - Violation `anchors`: for no-path violations use the union of the region's transitions' `anchors.provenance` entries that mention the involved event's transition when identifiable, else `[ 'spec:machine ' + agg + '.' + region.name ]`; ALWAYS set `specElement` to `machine <Agg>.<region>` (or `transition <name>` when a single transition is implicated, e.g. undeclared/orphan cases use `'outbox'`/`'event <type>'`). Keep `witnessIds: [entity.id]`, `source`, and a `detail` that names the first stuck event index + the reachable state set at that point, or the unreachable final state — a developer must locate the drift from the message alone.

- [ ] **Step 1: Write the failing tests**

```ts
// lattice/src/conform/trace.test.ts
import { describe, it, expect } from 'vitest';
import type { CaseEntity } from '../engine/evaluate.js';
import type { PlanAggregate } from '../generate/plan.js';
import { checkTraces, type ObservedEvent } from './trace.js';

const anchors = (el: string) => ({ specElement: el, provenance: [`spec:${el}`], witnessIds: [] });

// A Subscription-shaped machine: trialing→active (activate, EMITS Activated, guarded),
// trialing→expired (expireTrial, silent), active→pastDue (paymentFailed, silent),
// pastDue→active (recover, silent), {trialing,active,pastDue}→canceled (cancel, EMITS Canceled),
// pastDue→canceled (dunningExhausted, silent).
const SUB: PlanAggregate = {
  name: 'Subscription', fields: [], invariants: [], doc: undefined,
  regions: [{ name: 'status', initial: 'trialing', states: [
    { name: 'trialing' }, { name: 'active' }, { name: 'pastDue' },
    { name: 'canceled', tags: ['terminal'] }, { name: 'expired', tags: ['terminal'] }] }],
  transitions: [
    { name: 'activate', region: 'status', from: ['trialing'], to: 'active', emits: 'Activated',
      requires: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] }, right: { kind: 'int', value: 1 } } as any,
      anchors: anchors('transition activate') },
    { name: 'expireTrial', region: 'status', from: ['trialing'], to: 'expired', anchors: anchors('transition expireTrial') },
    { name: 'paymentFailed', region: 'status', from: ['active'], to: 'pastDue', anchors: anchors('transition paymentFailed') },
    { name: 'recover', region: 'status', from: ['pastDue'], to: 'active', anchors: anchors('transition recover') },
    { name: 'cancel', region: 'status', from: ['trialing', 'active', 'pastDue'], to: 'canceled', emits: 'Canceled', anchors: anchors('transition cancel') },
    { name: 'dunningExhausted', region: 'status', from: ['pastDue'], to: 'canceled', anchors: anchors('transition dunningExhausted') },
  ],
};

const sub = (id: string, state: string): CaseEntity =>
  ({ type: 'Subscription', id, fields: { subId: id, 'status.state': state } });
const ev = (seq: number, eventType: string, aggregateId: string): ObservedEvent => ({ seq, eventType, aggregateId });

describe('checkTraces', () => {
  it('accepts legal histories: activation, silent churn, evented cancel, silent exhaustion', () => {
    const r = checkTraces(
      [sub('a', 'active'), sub('b', 'expired'), sub('c', 'canceled'), sub('d', 'canceled')],
      [ev(1, 'Activated', 'a'),                       // a: trialing →(Activated) active
        ev(2, 'Activated', 'c'), ev(3, 'Canceled', 'c'), // c: activate then cancel
        ev(4, 'Activated', 'd')],                        // d: activate, fail, exhaust silently
      [SUB], 't');
    expect(r.violations).toEqual([]);
    expect(r.rowsChecked).toBe(4);
    expect(r.guardedTransitions).toEqual(['activate']); // reported, not evaluated
  });

  it('catches a skipped emit: final state active with no Activated event (drift class 1)', () => {
    const r = checkTraces([sub('a', 'active')], [], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ witnessIds: ['a'], specElement: 'machine Subscription.status' });
    expect(r.violations[0]!.detail).toMatch(/active/);
  });

  it('catches a wrong event type: Canceled emitted by an activation (drift class 2)', () => {
    // history: row ends active but the only event is Canceled — no path consumes it into active
    const r = checkTraces([sub('a', 'active')], [ev(1, 'Canceled', 'a')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/Canceled/);
  });

  it('catches emit-outside-transaction: event exists for a row that was never created (class 3)', () => {
    const r = checkTraces([], [ev(1, 'Activated', 'ghost')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ specElement: 'outbox', witnessIds: ['ghost'] });
  });

  it('catches terminal resurrection: canceled row observed active after its Canceled event (class 5)', () => {
    const r = checkTraces([sub('a', 'active')], [ev(1, 'Activated', 'a'), ev(2, 'Canceled', 'a')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/canceled|final/i);
  });

  it('catches an undeclared event type for the aggregate', () => {
    const r = checkTraces([sub('a', 'trialing')], [ev(1, 'InvoicePaid', 'a')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/InvoicePaid/);
  });

  it('silent cycles terminate: repeated fail/recover churn is legal and finite', () => {
    // a: Activated, then any number of silent paymentFailed/recover loops, end pastDue
    const r = checkTraces([sub('a', 'pastDue')], [ev(1, 'Activated', 'a')], [SUB], 't');
    expect(r.violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lattice && npx vitest run src/conform/trace.test.ts`
Expected: FAIL — `Cannot find module './trace.js'`.

- [ ] **Step 3: Implement `trace.ts`**

```ts
// lattice/src/conform/trace.ts
// Tier 2 (design §4.4): per observed row × machine region, decide whether the row's outbox
// events + observed final state correspond to a path the machine allows. Declared-emit
// transitions must align exactly with their events; silent transitions are free moves; a
// declared-emit transition can never fire silently. Guards (`requires`) need pre-state at event
// time, which passive mode does not observe — they are REPORTED as unevaluated, never silently
// claimed (no-silent-caps).
import type { CaseEntity } from '../engine/evaluate.js';
import type { PlanAggregate, PlanTransition } from '../generate/plan.js';
import type { Region } from '../ast/domain.js';
import type { ConformViolation } from './types.js';

export interface ObservedEvent { seq: number; eventType: string; aggregateId: string }
export interface TraceResult {
  violations: ConformViolation[];
  rowsChecked: number;
  guardedTransitions: string[];
}

interface Stuck { index: number; states: string[] } // furthest event index reached + states there

/** BFS over (state, consumedEvents). Returns null on acceptance, else the furthest-stuck frontier. */
function admits(region: Region, transitions: PlanTransition[], rowEvents: ObservedEvent[],
  finalState: string): Stuck | null {
  const n = rowEvents.length;
  const seen = new Set<string>();
  let frontier: [string, number][] = [[region.initial, 0]];
  seen.add(`${region.initial}|0`);
  let best: Stuck = { index: 0, states: [region.initial] };
  while (frontier.length > 0) {
    const next: [string, number][] = [];
    for (const [state, i] of frontier) {
      if (i === n && state === finalState) return null;
      if (i > best.index) best = { index: i, states: [state] };
      else if (i === best.index && !best.states.includes(state)) best.states.push(state);
      for (const t of transitions) {
        if (!t.from.includes(state)) continue;
        const move: [string, number] | null =
          t.emits === undefined ? [t.to, i]
          : (i < n && rowEvents[i]!.eventType === t.emits) ? [t.to, i + 1]
          : null;
        if (!move) continue;
        const key = `${move[0]}|${move[1]}`;
        if (!seen.has(key)) { seen.add(key); next.push(move); }
      }
    }
    frontier = next;
  }
  return best;
}

export function checkTraces(entities: CaseEntity[], events: ObservedEvent[],
  aggregates: PlanAggregate[], source: string): TraceResult {
  const violations: ConformViolation[] = [];
  const byId = new Map(entities.map(e => [e.id, e]));
  const aggByName = new Map(aggregates.map(a => [a.name, a]));

  // Orphan events: an outbox row whose aggregate never made it into observed state — the
  // canonical emit-outside-transaction symptom (the insert rolled back, the event survived).
  for (const e of events) {
    if (!byId.has(e.aggregateId)) {
      violations.push({
        invariant: '', specElement: 'outbox', anchors: ['spec:outbox (design §13: events commit atomically with state)'],
        witnessIds: [e.aggregateId], source,
        detail: `orphan event: ${e.eventType} (outbox seq ${e.seq}) references aggregate '${e.aggregateId}' which is not present in observed state`,
      });
    }
  }

  let rowsChecked = 0;
  const guarded = new Set<string>();
  for (const entity of entities) {
    const agg = aggByName.get(entity.type);
    if (!agg || agg.regions.length === 0) continue;
    rowsChecked++;
    const rowEvents = events.filter(e => e.aggregateId === entity.id).sort((a, b) => a.seq - b.seq);

    // Undeclared events: type not declared by any transition of any region of this aggregate.
    const declared = new Set(agg.transitions.map(t => t.emits).filter((x): x is string => !!x));
    for (const e of rowEvents) {
      if (!declared.has(e.eventType)) {
        violations.push({
          invariant: '', specElement: `event ${e.eventType}`,
          anchors: [`spec:machine ${agg.name}`], witnessIds: [entity.id], source,
          detail: `undeclared event: ${agg.name} '${entity.id}' emitted ${e.eventType} (outbox seq ${e.seq}), which no transition of ${agg.name} declares`,
        });
      }
    }

    for (const region of agg.regions) {
      const regionTransitions = agg.transitions.filter(t => t.region === region.name);
      for (const t of regionTransitions) if (t.requires) guarded.add(t.name);
      const regionEmits = new Set(regionTransitions.map(t => t.emits).filter((x): x is string => !!x));
      const regionEvents = rowEvents.filter(e => regionEmits.has(e.eventType));
      const finalState = entity.fields[`${region.name}.state`];
      if (typeof finalState !== 'string') {
        violations.push({
          invariant: '', specElement: `machine ${agg.name}.${region.name}`,
          anchors: [`spec:machine ${agg.name}.${region.name}`], witnessIds: [entity.id], source,
          detail: `observed state missing: field '${region.name}.state' absent on ${agg.name} '${entity.id}'`,
        });
        continue;
      }
      const stuck = admits(region, regionTransitions, regionEvents, finalState);
      if (stuck !== null) {
        const atEvent = stuck.index < regionEvents.length
          ? `stuck at event #${stuck.index + 1} (${regionEvents[stuck.index]!.eventType}, outbox seq ${regionEvents[stuck.index]!.seq}) from state(s) {${stuck.states.join(', ')}}`
          : `all ${regionEvents.length} event(s) consumed, reachable state(s) {${stuck.states.join(', ')}} do not include observed final '${finalState}'`;
        violations.push({
          invariant: '', specElement: `machine ${agg.name}.${region.name}`,
          anchors: regionTransitions.flatMap(t => t.anchors.provenance.length ? t.anchors.provenance : [t.anchors.specElement]),
          witnessIds: [entity.id], source,
          detail: `no legal path: ${agg.name} '${entity.id}' region '${region.name}' — ${atEvent}; events=[${regionEvents.map(e => e.eventType).join(', ')}]`,
        });
      }
    }
  }
  return { violations, rowsChecked, guardedTransitions: [...guarded].sort() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lattice && npx vitest run src/conform/trace.test.ts && npx tsc --noEmit`
Expected: 7/7 PASS, clean typecheck. If the `requires` Predicate literal in the test doesn't typecheck, fix the LITERAL against `src/ast/invariant.ts` (the `as any` fallback shown is acceptable in the test only because `requires` content is never evaluated here — only its presence).

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/trace.ts lattice/src/conform/trace.test.ts
git commit -m "feat(conform): tier-2 trace checker — declared-emit/silent reachability with orphan and undeclared-event checks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire Tier 2 into `runConform` — report shape, duration, budget line

**Files:**
- Modify: `lattice/src/conform/types.ts` (`ConformReport`)
- Modify: `lattice/src/conform/report.ts` (`runConform`, `formatReport`)
- Test: `lattice/src/conform/report.test.ts` (extend)

**Interfaces:**
- Consumes: `checkTraces`, `ObservedEvent` (Task 3).
- Produces (`types.ts` — extend `ConformReport` with):
  ```ts
  export interface ConformReport {
    // ...existing members unchanged...
    traceRowsChecked: number;
    guardedTransitions: string[];   // reported-unevaluated (design §4.4 honesty line)
    durationMs: number;
  }
  ```
  Tier 2 violations join the SAME `violations` array (they carry `specElement`/`detail` shapes from Task 3; `invariant: ''`).
- `runConform` additions: record `Date.now()` at entry; per snapshot, read the outbox (`SELECT id as seq, event_type as eventType, aggregate_id as aggregateId FROM outbox ORDER BY id`) and run `checkTraces(entities, events, plan.aggregates, meta.source)`; merge violations; accumulate `traceRowsChecked`; union `guardedTransitions`; set `durationMs` at the end.
- `formatReport` additions (exact lines the tests assert):
  - after the residual line: `` `tier 2: ${r.traceRowsChecked} row-traces checked against the machine` ``
  - if `r.guardedTransitions.length`: `` `guards NOT evaluated at event time (pre-state unobserved in passive mode): ${r.guardedTransitions.join(', ')}` ``
  - last line: `` `duration ${(r.durationMs / 1000).toFixed(1)}s — budget 60s ${r.durationMs <= 60_000 ? 'OK' : 'EXCEEDED'}` ``

- [ ] **Step 1: Extend the formatReport test**

Add to `lattice/src/conform/report.test.ts` (in the existing formatReport describe; extend BOTH existing report literals with the three new members so they typecheck):

```ts
  it('prints tier-2 coverage, unevaluated guards, and the duration budget verdict', () => {
    const text = formatReport({
      target: 't', snapshots: 3, invariantsChecked: 6, optOuts: [], violations: [],
      residual: { autoBound: 14, overridden: 4, total: 18 },
      traceRowsChecked: 57, guardedTransitions: ['activate', 'finalize', 'settle'],
      durationMs: 4_210,
    });
    expect(text).toContain('tier 2: 57 row-traces checked against the machine');
    expect(text).toContain('guards NOT evaluated at event time (pre-state unobserved in passive mode): activate, finalize, settle');
    expect(text).toContain('duration 4.2s — budget 60s OK');
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd lattice && npx vitest run src/conform/report.test.ts`
Expected: FAIL — new members missing from `ConformReport` / lines missing from `formatReport` (existing literals also fail to typecheck until extended — extend them with `traceRowsChecked: 0, guardedTransitions: [], durationMs: 0`).

- [ ] **Step 3: Implement**

In `types.ts` add the three members to `ConformReport`. In `report.ts`:

```ts
// at the top of runConform:
const startedAt = Date.now();
// inside the per-snapshot loop, after observeEntities/checkInvariants:
const events = db.prepare(
  'SELECT id as seq, event_type as eventType, aggregate_id as aggregateId FROM outbox ORDER BY id'
).all() as ObservedEvent[];
const trace = checkTraces(entitiesArr, events, plan.aggregates, meta.source);
violations.push(...trace.violations);
traceRows += trace.rowsChecked;
for (const g of trace.guardedTransitions) guardedSet.add(g);
// (declare `let traceRows = 0; const guardedSet = new Set<string>();` beside the existing accumulators,
// and name the observeEntities result so both tier passes share it)
// in the report literal:
traceRowsChecked: traceRows, guardedTransitions: [...guardedSet].sort(), durationMs: Date.now() - startedAt,
```

In `formatReport`, add exactly the three lines from the Produces block (tier-2 line after the residual line; the guards line only when non-empty; the duration line last).

- [ ] **Step 4: Run the conform suite + the REAL negative control with Tier 2 live**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit`
Expected: all PASS.

Then the negative control (Tier 1 + Tier 2 together — a pre-registered criterion):
```bash
cd ../implementations/subscriptions && npx vitest run 2>&1 | tail -2
cd ../lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --report; echo "exit=$?"
```
Expected: `0 violations across N snapshots (...)`, a `tier 2: M row-traces checked` line with M > 0, the guards line naming the spec's guarded transitions (activate, finalize, settle), `duration ...s — budget 60s OK`, exit=0.
**If Tier 2 reports violations on the clean impl: STOP.** Write them verbatim into your report and return BLOCKED — each is either a checker bug, an impl bug, or a genuine semantic mismatch for the human. Never tune.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/types.ts lattice/src/conform/report.ts lattice/src/conform/report.test.ts
git commit -m "feat(conform): tier-2 wired into runConform — trace coverage, guard honesty line, duration budget

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Conformance ledger write-back

**Files:**
- Modify: `lattice/src/engine/session.ts` (LedgerEntry union + reader)
- Modify: `lattice/src/conform/report.ts` (append after a run)
- Test: `lattice/src/conform/report.test.ts` (extend the existing runConform temp-dir test pattern)

**Interfaces:**
- Consumes: `appendLedger`, `readLedger` (`src/engine/session.ts`).
- Produces (`session.ts` — new union member; structural violation shape inline, engine must NOT import from conform):
  ```ts
  | { kind: 'conformance'; at: string; target: string; mode: 'report' | 'enforce';
      snapshots: number; invariantsChecked: number; traceRowsChecked: number;
      violationCount: number;
      violations: { specElement: string; anchors: string[]; witnessIds: string[]; source: string; detail: string }[];
      residual: { autoBound: number; overridden: number; total: number };
      optOuts: { invariant: string; reason: string }[]; durationMs: number }
  ```
  and `export function readConformance(dir: string): Extract<LedgerEntry, { kind: 'conformance' }>[]` (mirror the existing `readClassifications` one-liner pattern at `session.ts:79`).
- `runConform` appends exactly ONE entry per completed run (both modes), to the session dir it already resolved from the target's config, with `at: new Date().toISOString()`. Violations are mapped structurally (drop the `invariant` member via destructuring or map to the inline shape). A ledger append failure must NOT mask the report (wrap in try/catch; on failure add a `ledger-append-failed: <msg>` note — surface it by pushing onto the report's optOuts? NO — add nothing silent: rethrow as a harness error AFTER printing is not possible inside runConform, so: catch, and attach the message to the returned object as `ledgerError?: string`; the CLI prints it to stderr and still exits by violation status).
  Concretely: `runConform` returns `{ report, exitCode, ledgerError?: string }`; the CLI does `if (res.ledgerError) console.error('ledger append failed: ' + res.ledgerError);`.

- [ ] **Step 1: Write the failing test**

Extend `lattice/src/conform/report.test.ts` — inside the existing temp-dir runConform test infrastructure (the F3 opt-out test shows the pattern: copy overrides/spec-state/snapshot into a mkdtemp target). Add:

```ts
  it('appends one conformance ledger entry per run (write-back, design §4.6)', async () => {
    const implDir = resolve(__dirname, '../../..', 'implementations/subscriptions');
    const realSessionPath = resolve(__dirname, '../../..', '.lattice-session-subscriptions');
    const snapDir = join(implDir, '.conform/snapshots');
    if (!existsSync(snapDir)) return; // no snapshots in this checkout — nothing to assert
    const snapSqlite = readdirSync(snapDir).find(f => f.endsWith('.sqlite'));
    if (!snapSqlite) return;
    const snapJson = snapSqlite.replace(/\.sqlite$/, '.json');

    const tmpDir = mkdtempSync(join(tmpdir(), 'conform-ledger-test-'));
    try {
      // own session COPY so the append never mutates the real committed ledger
      mkdirSync(join(tmpDir, 'session'), { recursive: true });
      for (const f of ['state.json', 'model.json', 'ledger.jsonl']) {
        copyFileSync(join(realSessionPath, f), join(tmpDir, 'session', f));
      }
      mkdirSync(join(tmpDir, 'conform'), { recursive: true });
      mkdirSync(join(tmpDir, '.conform', 'snapshots'), { recursive: true });
      copyFileSync(join(implDir, 'conform', 'overrides.ts'), join(tmpDir, 'conform', 'overrides.ts'));
      copyFileSync(join(implDir, 'conform', 'spec-state.ts'), join(tmpDir, 'conform', 'spec-state.ts'));
      copyFileSync(join(snapDir, snapSqlite), join(tmpDir, '.conform', 'snapshots', snapSqlite));
      copyFileSync(join(snapDir, snapJson), join(tmpDir, '.conform', 'snapshots', snapJson));
      writeFileSync(join(tmpDir, 'conform', 'conform.config.json'), JSON.stringify({
        session: join(tmpDir, 'session'), snapshots: '.conform/snapshots', optOuts: [],
      }));

      const { readConformance } = await import('../engine/session.js');
      await runConform(tmpDir, 'report');
      const entries = readConformance(join(tmpDir, 'session'));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'conformance', mode: 'report', target: tmpDir });
      expect(entries[0]!.snapshots).toBeGreaterThan(0);
      expect(typeof entries[0]!.durationMs).toBe('number');

      await runConform(tmpDir, 'report');
      expect(readConformance(join(tmpDir, 'session'))).toHaveLength(2); // append-only, one per run
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
```

(The imports this needs — `mkdtempSync`, `copyFileSync`, `mkdirSync`, `writeFileSync`, `rmSync`, `existsSync`, `readdirSync`, `resolve`, `join`, `tmpdir` — already exist in this test file from the F3 test.)

- [ ] **Step 2: Run to verify failure**

Run: `cd lattice && npx vitest run src/conform/report.test.ts`
Expected: FAIL — `readConformance` not exported / no entry appended.

- [ ] **Step 3: Implement**

In `session.ts`: add the union member exactly as in Produces; add
```ts
export function readConformance(dir: string): Extract<LedgerEntry, { kind: 'conformance' }>[] {
  return readLedger(dir).filter((e): e is Extract<LedgerEntry, { kind: 'conformance' }> => e.kind === 'conformance');
}
```
In `report.ts`'s `runConform`, after assembling `report` and `exitCode`:
```ts
let ledgerError: string | undefined;
try {
  appendLedger(sessionDir, {
    kind: 'conformance', at: new Date().toISOString(), target: targetDir, mode,
    snapshots: report.snapshots, invariantsChecked: report.invariantsChecked,
    traceRowsChecked: report.traceRowsChecked, violationCount: report.violations.length,
    violations: report.violations.map(v => ({ specElement: v.specElement, anchors: v.anchors,
      witnessIds: v.witnessIds, source: v.source, detail: v.detail })),
    residual: report.residual, optOuts: report.optOuts, durationMs: report.durationMs,
  });
} catch (e) { ledgerError = e instanceof Error ? e.message : String(e); }
return { report, exitCode, ledgerError };
```
(`sessionDir` is the already-resolved `resolve(targetDir, cfg.session)` — reuse the existing variable.) Update the CLI's conform block to print `ledgerError` to stderr when present (one line), without changing exit codes.

- [ ] **Step 4: Gates + real-run ledger check**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit`
Expected: PASS.
Then confirm the REAL run appends (and that this is wanted: the committed session ledger is the spec's evidence stream — conformance runs are evidence by design §4.6):
```bash
npx tsx src/cli.ts conform --target ../implementations/subscriptions --report >/dev/null
tail -1 ../.lattice-session-subscriptions/ledger.jsonl | head -c 120; echo
```
Expected: a `{"kind":"conformance",...}` line. `git status` will show the ledger modified — COMMIT that change as part of this task (it is real evidence of a real run), with the code.

- [ ] **Step 5: Commit**

```bash
git add lattice/src/engine/session.ts lattice/src/conform/report.ts lattice/src/conform/report.test.ts \
  lattice/src/cli.ts .lattice-session-subscriptions/ledger.jsonl
git commit -m "feat(conform): conformance runs write back to the session ledger as evidence entries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Round-trip test retirement note + docs freshness

**Files:**
- Modify: `lattice/src/conform/roundtrip.test.ts` (header comment only)
- Modify: `README.md` (status line)

**Interfaces:** none — documentation truthfulness. Plan 2's round-trip guardrail was explicitly interim ("Plan 3's trace checker replaces it with full reachability semantics; this test stays as the fast guardrail"). It STAYS (it is fast and catches projection lies without a full conform run), but its comment must stop implying it is the only event↔state check.

- [ ] **Step 1: Update the comment and README**

In `roundtrip.test.ts`, replace the header comment's last sentence with:

```
// Tier 2 (src/conform/trace.ts) now does full reachability checking in every conform run; this
// test remains as the fast in-suite guardrail that the projection cannot contradict recorded
// events even when no conform run happens.
```

In `README.md`, update the status sentence from "conformance Tier 1 (...) landed; Tier 2 trace checker + drift experiments in progress" (or current wording) to:

```
conformance Tiers 1+2 (auto-bound `observe()` + machine-reachability trace checking over captured
suite states via `lattice conform`, runs recorded to the ledger; negative control clean). Not yet
run: the pre-registered drift experiments (plan 4) — briefs in `docs/superpowers/specs/`.
```

(Splice into the existing status paragraph, keeping its voice; exact surrounding words may differ since main moves — preserve them.)

- [ ] **Step 2: Gates + commit**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit`
Expected: PASS.

```bash
git add lattice/src/conform/roundtrip.test.ts README.md
git commit -m "docs(conform): tier-2 status — README + round-trip guardrail role note

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review checklist (controller, after Task 6)

1. **Design coverage:** §4.4 trace semantics ✓ (T3), honest guard reporting ✓ (T3/T4), §4.6 ledger write-back ✓ (T5), §7.3 runtime budget measured ✓ (T4), final-review follow-ups F5/F6/F7 + partial-payment ✓ (T1/T2). NOT here (plan 4): the 13 drift experiments, opt-out registry surfacing in `lattice status`.
2. **Negative control including Tier 2** ran clean in T4 — record the tier-2 row count and duration in the ledger notes for plan 4's baseline.
3. **Full engine suite once at the end** (controller): expect the two documented load-flaky integration tests to need isolation re-runs; goldens must be green.
