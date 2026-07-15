# Slice 2 Plan 4: The 13 Pre-Registered Drift Experiments

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the design's §6 drift catalog for real — 13 deliberate maintenance accidents, each a real edit on a real branch, each caught (or honestly missed) by `lattice conform` — plus the class-13 read-model cross-check the harness still lacks, the ×3 negative control, and the final slice verdict against the §7 pre-registered criteria.

**Architecture:** One small harness addition (typed cross-check modules). Then: a pre-registered results table committed BEFORE any experiment runs; experiments executed on `drift/cNN-*` branches forked from the work branch (so they carry the full harness), with outcomes appended to the results doc on the work branch; a synthesis task renders the slice verdict. Drift branches are kept as evidence, never merged.

**Tech Stack:** Existing harness (`lattice conform`), `implementations/subscriptions/`, git branches.

## Global Constraints

- **Zero tuning inside experiments.** If a pre-registered catch does not fire, the outcome is recorded as MISSED with the actual output — a finding for the human (design §7.1), never a quiet checker tweak or a re-scoped expectation. If the CLEAN work branch shows any violation, STOP (BLOCKED) — the negative control is a hard criterion.
- **Catch signal taxonomy (pre-registered):** `caught-violation` = the report names the pre-registered spec element with exit 1 under `--enforce` (we run `--report`; violations>0 in output suffices); `caught-loud` = the harness fails loudly (exit 2) naming the pre-registered field/element — this is the DESIGNED behavior for adapter drift (classes 6, 10, 11): loud, never wrong. A silent pass on any class = MISSED.
- **The experiment protocol (verbatim, every class):**
  1. From the work branch: `git checkout -b drift/cNN-<slug>` (forks the work branch — drift must attack the CURRENT harness).
  2. Apply exactly the specified edit (and the specified exercising fixture, where one is pre-registered — drift edits may include the drifting engineer's own happy-path test; that is realistic). Commit ON the drift branch (conventional message `drift(cNN): <slug>` + Co-Authored-By trailer).
  3. `cd implementations/subscriptions && rm -rf .conform && npx vitest run > /tmp/drift-cNN-impl.log 2>&1; echo "impl-exit=$?"` — test failures here are DATA (pre-registered below), not blockers; snapshots are still captured by afterEach.
  4. `cd ../lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --report > /tmp/drift-cNN-conform.log 2>&1; echo "conform-exit=$?"` (stderr lands in the log too — adapter classes fail loud there).
  5. `grep` the log for the pre-registered signal substrings; copy the relevant output lines.
  6. `git checkout <work-branch>` (drift branch stays, unmerged, as evidence) and `rm -rf implementations/subscriptions/.conform`.
  7. Append the outcome (CAUGHT-VIOLATION / CAUGHT-LOUD / MISSED, with the actual output lines, impl-exit, conform-exit) to the class's row/section in the results doc; commit the results-doc change on the work branch immediately (doc edits commit immediately — repo rule).
- The conformance ledger gains one entry per conform run (write-back) — drift-branch runs append to the drift branch's OWN ledger copy (committed there as part of the evidence); work-branch ledger only records work-branch runs.
- Impl gates on the WORK branch stay green throughout; never commit drift to the work branch or main.
- Engine discipline unchanged: `cd lattice && npx vitest run src/conform && npx tsc --noEmit` before every work-branch commit. No full-suite runs by implementers.
- Never `git add -A`; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

- Create `lattice/src/conform/crosscheck.ts` + wire into `report.ts` (+2 report lines) — Task 1.
- Create `implementations/subscriptions/conform/crosschecks.ts` — Task 1.
- Create `docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md` — Task 2 (pre-registration), appended by Tasks 3–7, verdict by Task 8.
- Drift branches `drift/c01-skipped-emit` … `drift/c13-stale-read-model` — Tasks 3–7.

---

### Task 1: Read-model cross-checks (the class-13 instrument)

**Files:**
- Create: `lattice/src/conform/crosscheck.ts`
- Modify: `lattice/src/conform/report.ts` (load + run + report line)
- Modify: `lattice/src/conform/types.ts` (`ConformReport.crosschecks: number`)
- Create: `implementations/subscriptions/conform/crosschecks.ts`
- Test: `lattice/src/conform/crosscheck.test.ts`

**Interfaces:**
- Consumes: the snapshot `Database` handle inside `runConform`'s per-snapshot loop; `ConformViolation`.
- Produces:
  ```ts
  // lattice/src/conform/crosscheck.ts
  export interface CrosscheckFinding { check: string; witnessIds: string[]; detail: string }
  export type Crosscheck = (db: unknown /* better-sqlite3 Database */) => CrosscheckFinding[];
  export interface CrosscheckModule { crosschecks: Record<string, Crosscheck> }
  export function loadCrosschecks(targetDir: string): Promise<CrosscheckModule | null>; // null when the file doesn't exist
  export function runCrosschecks(db: unknown, mod: CrosscheckModule, source: string): ConformViolation[];
  // violation mapping: { invariant: '', specElement: `crosscheck ${name}`,
  //   anchors: ['target crosscheck (out-of-spec read model, design §6 class 13)'],
  //   witnessIds, source, detail }
  ```
  Report line (after the tier-2 line): `` `crosschecks: ${names.join(', ')}` `` or `` `crosschecks: none declared` `` — absence is stated, never silent. `ConformReport.crosschecks` = number of check functions run (0 when none declared).
- The impl's cross-check module recomputes the summary INDEPENDENTLY (deliberate duplication of the derivation — the whole point is a second opinion):
  ```ts
  // implementations/subscriptions/conform/crosschecks.ts
  // Class-13 instrument: recompute account_summary's spec-covered fields from base tables and
  // compare. The derivation is DELIBERATELY duplicated from src/read-model.ts — an independent
  // recomputation is the point; sharing code would let one bug hide in both.
  import type Database from 'better-sqlite3';

  interface Finding { check: string; witnessIds: string[]; detail: string }

  function accountSummary(db: Database.Database): Finding[] {
    const out: Finding[] = [];
    const rows = db.prepare('SELECT * FROM account_summary').all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = row.subscription_id as string;
      const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!sub) { out.push({ check: 'account_summary', witnessIds: [id], detail: `summary row for nonexistent subscription '${id}'` }); continue; }
      const open = (db.prepare(`
        SELECT COALESCE(SUM(i.total_due), 0) -
               COALESCE((SELECT SUM(p.amount) FROM invoice_payments p JOIN invoices i2 ON i2.id = p.invoice_id
                         WHERE i2.subscription_id = ? AND i2.settlement_state = 'open'), 0) AS bal
        FROM invoices i WHERE i.subscription_id = ? AND i.settlement_state = 'open'`).get(id, id) as { bal: number }).bal;
      const lifetime = (db.prepare(`
        SELECT COALESCE(SUM(p.amount), 0) AS s FROM invoice_payments p
        JOIN invoices i ON i.id = p.invoice_id WHERE i.subscription_id = ?`).get(id) as { s: number }).s;
      const mismatches: string[] = [];
      if (row.status !== sub.lifecycle_state) mismatches.push(`status '${row.status}' != lifecycle_state '${sub.lifecycle_state}'`);
      if (row.open_balance !== open) mismatches.push(`open_balance ${row.open_balance} != recomputed ${open}`);
      if (row.lifetime_paid !== lifetime) mismatches.push(`lifetime_paid ${row.lifetime_paid} != recomputed ${lifetime}`);
      if (mismatches.length) out.push({ check: 'account_summary', witnessIds: [id], detail: mismatches.join('; ') });
    }
    return out;
  }

  export const crosschecks = { account_summary: accountSummary };
  ```

- [ ] **Step 1: Write the failing test**

```ts
// lattice/src/conform/crosscheck.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runCrosschecks, type CrosscheckModule } from './crosscheck.js';

const mod: CrosscheckModule = {
  crosschecks: {
    positiveBalance: (db) => {
      const bad = ((db as Database.Database).prepare('SELECT id FROM t WHERE v < 0').all() as { id: string }[]);
      return bad.map(b => ({ check: 'positiveBalance', witnessIds: [b.id], detail: `v negative for ${b.id}` }));
    },
  },
};

describe('runCrosschecks', () => {
  const mk = () => { const db = new Database(':memory:'); db.exec('CREATE TABLE t (id TEXT, v INTEGER)'); return db; };

  it('maps findings to conform violations with the crosscheck specElement', () => {
    const db = mk();
    db.prepare(`INSERT INTO t VALUES ('a', -1), ('b', 2)`).run();
    const v = runCrosschecks(db, mod, 'src1');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ specElement: 'crosscheck positiveBalance', witnessIds: ['a'], source: 'src1' });
  });

  it('clean state yields no violations', () => {
    const db = mk();
    db.prepare(`INSERT INTO t VALUES ('b', 2)`).run();
    expect(runCrosschecks(db, mod, 'src1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd lattice && npx vitest run src/conform/crosscheck.test.ts`
Expected: FAIL — `Cannot find module './crosscheck.js'`.

- [ ] **Step 3: Implement**

```ts
// lattice/src/conform/crosscheck.ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConformViolation } from './types.js';

export interface CrosscheckFinding { check: string; witnessIds: string[]; detail: string }
export type Crosscheck = (db: unknown) => CrosscheckFinding[];
export interface CrosscheckModule { crosschecks: Record<string, Crosscheck> }

export async function loadCrosschecks(targetDir: string): Promise<CrosscheckModule | null> {
  const path = resolve(targetDir, 'conform', 'crosschecks.ts');
  if (!existsSync(path)) return null;
  const mod = await import(path) as Partial<CrosscheckModule>;
  if (!mod || typeof mod.crosschecks !== 'object' || mod.crosschecks === null) {
    throw new Error(`conform: ${path} must export 'crosschecks' (a name→function map)`);
  }
  return mod as CrosscheckModule;
}

export function runCrosschecks(db: unknown, mod: CrosscheckModule, source: string): ConformViolation[] {
  const out: ConformViolation[] = [];
  for (const [name, fn] of Object.entries(mod.crosschecks)) {
    for (const f of fn(db)) {
      out.push({
        invariant: '', specElement: `crosscheck ${name}`,
        anchors: ['target crosscheck (out-of-spec read model, design §6 class 13)'],
        witnessIds: f.witnessIds, source, detail: f.detail,
      });
    }
  }
  return out;
}
```

Wire into `report.ts`: `const cc = await loadCrosschecks(targetDir);` once before the snapshot loop; inside the loop (same db handle the tiers use): `if (cc) violations.push(...runCrosschecks(db, cc, meta.source));`. Report member `crosschecks: cc ? Object.keys(cc.crosschecks).length : 0` and the formatReport line after the tier-2 line: names joined, or `crosschecks: none declared`. Extend existing report-literal tests with `crosschecks: 0` and add the two format assertions (named + none-declared cases).

- [ ] **Step 4: Create the impl cross-check module (code in Interfaces above, verbatim) and run the REAL baseline**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit && cd ../implementations/subscriptions && rm -rf .conform && npx vitest run 2>&1 | tail -2 && npx tsc --noEmit && cd ../lattice && npx tsx src/cli.ts conform --target ../implementations/subscriptions --report`
Expected: all green; the report shows `crosschecks: account_summary` and STILL `0 violations` — the clean impl's summary agrees with base tables. **A violation here = STOP/BLOCKED** (either the T1 code or a real impl staleness — report verbatim).

- [ ] **Step 5: Commit**

```bash
git add lattice/src/conform/crosscheck.ts lattice/src/conform/crosscheck.test.ts lattice/src/conform/report.ts \
  lattice/src/conform/types.ts lattice/src/conform/report.test.ts implementations/subscriptions/conform/crosschecks.ts
git commit -m "feat(conform): typed target cross-checks — the class-13 read-model instrument

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Pre-registration — results doc + the ×3 negative control

**Files:**
- Create: `docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md`

**Interfaces:** none. This commits the full pre-registered expectations table BEFORE any experiment runs (that is what makes them pre-registered), then records the ×3 negative control.

- [ ] **Step 1: Write the results doc**

The doc must contain, verbatim structure:
1. Header: date, work-branch commit hash the experiments fork from, harness version note (Tiers 1+2 + crosschecks), the §7 criteria being tested.
2. **The pre-registered table** — one row per class with EXACTLY these columns: `#`, `slug`, `edit (one line)`, `exercising fixture`, `expected impl-suite failures`, `pre-registered catch signal (tier + element + substring)`. Copy the 13 rows from Tasks 3–7's "Pre-registered" blocks below — every substring in the table must match the plan text exactly (the plan is the registration; the doc restates it in one place).
3. **Negative control section**: three fresh work-branch runs (each: `rm -rf .conform && npx vitest run` in the impl, then conform `--report`), recording for each: violations count (must be 0), snapshots, tier-2 row-traces, crosschecks line, duration. Then the criterion line: `false positives: 0/3 runs ✅` (or ❌ STOP).
4. Empty `## Outcomes` section with 13 stub headings (`### c01 — skipped emit` … `### c13 — stale read model`), each containing only `PENDING`.

- [ ] **Step 2: Run the ×3 negative control and fill section 3**

Run the triplet three times; paste real numbers. Expected: 0 violations each; duration well under 60s.

- [ ] **Step 3: Commit (pre-registration is a commit BEFORE experiments)**

```bash
git add docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md
git commit -m "docs(conform): pre-registered drift-experiment expectations + 3x negative control

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Event-layer drift — c01, c02, c03

Follow the Global-Constraints protocol per class. Each class below gives the exact edit, fixture, expected impl failures, and pre-registered catch.

**c01 — skipped emit** (`drift/c01-skipped-emit`)
- Edit: `implementations/subscriptions/src/subscription-service.ts`, `activate`: delete the `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` line (a refactor casualty).
- Exercising fixture: existing corpus (lifecycle activate test, journey).
- Expected impl failures: lifecycle `activate requires a paid invoice and emits SubscriptionActivated` (eventTypes assertion), journey eventLog assertion.
- Pre-registered catch: **caught-violation, Tier 2** — output contains `machine Subscription.status` and a detail matching `do not include observed final 'active'` (active is reachable ONLY via the evented activate edge — plan-3 review verified).

**c02 — wrong event type** (`drift/c02-wrong-event`)
- Edit: `cancelSubscription`: `appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });` (copy-paste error — was `SUBSCRIPTION_CANCELED`).
- Exercising fixture: existing corpus — the lifecycle cancel-after-activate test yields events `[SubscriptionActivated, SubscriptionActivated]` with final `canceled` (the pinned evented-only placement from the plan-3 review; a cancel-from-trialing placement would be silently explainable and is NOT used).
- Expected impl failures: lifecycle cancel test (`eventTypes` contains-Canceled assertion), journey eventLog.
- Pre-registered catch: **caught-violation, Tier 2** — detail matching `stuck at event #2 (SubscriptionActivated` with witness the canceled subscription.

**c03 — emit outside the transaction** (`drift/c03-emit-outside-tx`)
- Edit: `activate`: move the `appendEvent(...)` call to BEFORE `db.transaction(() => { ... })()` (the "log the event first" refactor accident — the event now survives a rejected activation).
- Exercising fixture: existing corpus — the lifecycle rejection case (`expect(() => activate(db,'sub-1')).toThrow(/paid/)`) leaves a `SubscriptionActivated` event with the row still `trialing`.
- Expected impl failures: outbox-count assertions in lifecycle/journey (an extra early event also lands on success paths — event order shifts).
- Pre-registered catch: **caught-violation, Tier 2** — detail matching `reachable state(s) {active} do not include observed final 'trialing'` (event consumed → active; observed trialing) OR `all 1 event(s) consumed` with final `trialing`; witness `sub-1`.

For each class: complete protocol steps 1–7, appending the outcome section (actual output lines from `/tmp/drift-cNN-conform.log`, impl-exit, conform-exit, verdict) to the results doc and committing it.

- [ ] c01 executed, outcome recorded + committed
- [ ] c02 executed, outcome recorded + committed
- [ ] c03 executed, outcome recorded + committed

---

### Task 4: Transition/guard drift — c04, c05, c06

**c04 — weakened guard** (`drift/c04-weakened-guard`)
- Edit: `activate`: delete the `if (sub.paid_invoice_count < 1) throw ...` line. AND (the drifting engineer "fixes" the now-red test — realistic): in `test/lifecycle.test.ts`, replace the rejection case with the engineer's version:
  ```ts
  it('activate works immediately after invoicing (v2 flow)', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 });
    finalizeInvoice(db, 'sub-1-inv-1');   // invoice now OPEN and unpaid
    activate(db, 'sub-1');                 // guard gone — succeeds
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
  });
  ```
  (This is the pre-registered exercising fixture: it quiesces with an ACTIVE subscription whose latest invoice is finalized-unpaid. Without it, the guard removal only produces a draft-invoice activation, which `activePaidInFull` vacuously permits — pinned per the plan-3 review.)
- Expected impl failures: journey (`recordUsage` reject expectation may shift) — record whatever actually fails; the replaced test passes by design.
- Pre-registered catch: **caught-violation, Tier 1** — output contains `activePaidInFull` with witness `sub-1` (active sub, `amountPaid 0 != totalDue 5000` on the latest invoice).

**c05 — terminal resurrection** (`drift/c05-win-back`)
- Edit: `billing-service.ts` `settle()`: change the recovery condition to `if (sub.lifecycle_state === 'past_due' || sub.lifecycle_state === 'canceled')` (the "customer paid after cancellation — win them back" accident). AND the engineer's happy test in `test/billing-service.test.ts`:
  ```ts
  it('win-back: a canceled customer who settles is reactivated (v2 flow)', () => {
    const db = seeded();
    finalizeInvoice(db, 'sub-1-inv-1');
    cancelSubscription(db, 'sub-1');                    // canceled with an open invoice
    recordPayment(db, 'sub-1-inv-1', 5_000, 1_200);     // pays in full → drifted settle revives
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
  });
  ```
  (import `cancelSubscription`/`getSubscription` as needed.)
- Expected impl failures: none pre-registered (the drift only ADDS a path) — record any that appear.
- Pre-registered catch: **caught-violation, Tier 2** — the win-back row's events end `... SubscriptionCanceled, InvoicePaid` with observed final `active`; detail matching `do not include observed final 'active'` after all Subscription-region events consumed (state canceled, terminal), witness `sub-1`.

**c06 — state-name drift** (`drift/c06-state-rename`)
- Edit: rename the past-due state in CODE only: in `src/schema.sql` comment and all `src/*.ts` occurrences, `'past_due'` → `'delinquent'` (states written and compared as `'delinquent'`; the spec still says `pastDue`; `conform/overrides.ts` STATE_MAP is NOT touched — that's the drift).
- Exercising fixture: existing corpus (any past-due test — rollover failure path).
- Expected impl failures: none (internally consistent rename) — record any that appear.
- Pre-registered catch: **caught-loud** — conform exit 2 with stderr matching `Subscription.status is null/undefined for row` (STATE_MAP has no `delinquent` key; the projection fails hard rather than mapping garbage — design §4.3's loud-never-wrong guarantee).

- [ ] c04 executed, outcome recorded + committed
- [ ] c05 executed, outcome recorded + committed
- [ ] c06 executed, outcome recorded + committed

---

### Task 5: Invariant drift — c07, c08, c09

**c07 — partial write on settle** (`drift/c07-partial-write`)
- Edit: `billing-service.ts` `recordPayment`: move the `INSERT INTO invoice_payments ...` so it only runs on the NON-settling branch (a botched refactor that "moved recording into settle" and lost it):
  ```ts
  if (paid + amount === inv.total_due) settle(db, inv);
  else {
    db.prepare('INSERT INTO invoice_payments (invoice_id, amount, paid_at) VALUES (?,?,?)').run(invoiceId, amount, now);
    refreshAccountSummary(db, inv.subscription_id, now);
  }
  ```
- Exercising fixture: existing corpus (the partial→settle billing test: final payment never recorded; invoice `paid` with SUM = 2000 of 5000).
- Expected impl failures: billing settle test (`amountPaid` assertions), possibly journey.
- Pre-registered catch: **caught-violation, Tier 1** — output contains `neverOverpaidAndPaidExact` (a `paid` invoice with `amountPaid != totalDue`), witness the settled invoice id.

**c08 — widened uniqueness** (`drift/c08-two-drafts`)
- Edit: `subscription-service.ts` `rolloverPeriod`: delete the `if (needsBilling) finalizeInvoice(db, closingId);` line and the whole `if (needsBilling) { ...charge... }` block (the "simplify rollover — billing runs nightly anyway" accident: the old draft is left open as draft, the next draft still opens).
- Exercising fixture: existing corpus (growth rollover tests roll active subs whose current invoice is a draft → two drafts per subscription).
- Expected impl failures: growth rollover tests (finalize/charge expectations), journey.
- Pre-registered catch: **caught-violation, Tier 1** — output contains `oneDraftInvoicePerSubscription` with `set-level violation` detail (unique-kind), witnesses include the affected invoice ids.

**c09 — cross-aggregate activation** (`drift/c09-upgrade-activates`)
- Edit: `subscription-service.ts` `changePlan`: after `createSubscription(...)`, add the "carry the customer's active status over, and bill the new fee immediately" accident:
  ```ts
  if (sub.lifecycle_state === 'active' || sub.lifecycle_state === 'past_due') {
    finalizeInvoice(db, `${a.newId}-inv-1`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(a.newId);
    appendEvent(db, SUBSCRIPTION_ACTIVATED, a.newId, { subId: a.newId });
  }
  ```
  (imports: `finalizeInvoice` already imported; `SUBSCRIPTION_ACTIVATED` already imported.) Note it EMITS the event — the trace is well-formed; the drift is the unpaid activation.
- Exercising fixture: existing corpus — the growth `changePlan` test runs on an `activeSub()`; the successor `sub-2` quiesces active with a finalized-unpaid `sub-2-inv-1`.
- Expected impl failures: growth changePlan test (`lifecycle_state 'trialing'` expectation on the successor).
- Pre-registered catch: **caught-violation, Tier 1** — `activePaidInFull` with witness `sub-2` (guards are unevaluated in passive mode — pre-registered NOT to rely on the guard; the cross-aggregate invariant is the catcher. This is drift class 9's exact design intent: the flagship "two systems disagree" class).

- [ ] c07 executed, outcome recorded + committed
- [ ] c08 executed, outcome recorded + committed
- [ ] c09 executed, outcome recorded + committed

---

### Task 6: Adapter drift — c10, c11

**c10 — schema rename breaks auto-binding** (`drift/c10-column-rename`)
- Edit: migration-style rename, code kept consistent: in `src/schema.sql` `seats INTEGER NOT NULL` → `seat_qty INTEGER NOT NULL`; in `src/subscription-service.ts` update the INSERT column list and the `UPDATE ... SET seats = ?` to `seat_qty`, and `SubscriptionRow.seats` → `seat_qty` (with the few read sites `sub.seats` → `sub.seat_qty`). `conform/overrides.ts` NOT touched (spec field `seats` no longer auto-binds and has no override).
- Exercising fixture: existing corpus.
- Expected impl failures: none (internally consistent rename; if `tsc` or tests surface stragglers, fix them ON THE DRIFT BRANCH until the impl suite is green — the drifted service must be a working service, that's what makes the adapter failure honest).
- Pre-registered catch: **caught-loud** — conform exit 2, stderr matching `unbound spec fields` and `Subscription` … `seats` (ConformBindError lists the gap; the binder fails LOUD, never maps garbage — design §7.1 drift class 10).

**c11 — stale override** (`drift/c11-stale-override`)
- Edit: rename `invoice_payments.amount` → `amount_cents` in `src/schema.sql`, `src/billing-service.ts` (`amountPaid` SUM, INSERT), `src/read-model.ts` (both SUM sites), and `conform/crosschecks.ts`?? NO — leave `conform/overrides.ts` AND `conform/crosschecks.ts` untouched (both are conformance-side artifacts; the engineer forgot them — that is the rot).
- Exercising fixture: existing corpus.
- Expected impl failures: none (consistent within src/).
- Pre-registered catch: **caught-loud** — conform exit 2, stderr containing `no such column: amount` (the override's SQL fails hard at first evaluation; a stale adapter breaks loudly instead of lying — design §4.3 guardrail).

- [ ] c10 executed, outcome recorded + committed
- [ ] c11 executed, outcome recorded + committed

---

### Task 7: Superset + read-model drift — c12, c13

**c12 — out-of-spec feature corrupts covered state** (`drift/c12-proration-total`)
- Edit: `subscription-service.ts` `changeSeats`: support mid-cycle seat changes on OPEN invoices by adjusting the total directly (the "finance asked for immediate proration" accident) — replace the draft-only guard:
  ```ts
  const inv = getInvoice(db, sub.current_invoice_id);
  if (inv.settlement_state === 'draft') {
    if (inv.usage_amount + prorationAmount < 0) throw new Error('proration would drive usage negative');
    db.prepare('UPDATE invoices SET usage_amount = usage_amount + ? WHERE id = ?').run(prorationAmount, inv.id);
  } else if (inv.settlement_state === 'open') {
    db.prepare('UPDATE invoices SET total_due = total_due + ? WHERE id = ?').run(prorationAmount, inv.id);
  } else throw new Error('seat changes only on draft or open invoices');
  ```
  Plus the engineer's happy test in `test/growth.test.ts` (the pre-registered exercising fixture — it must hit the OPEN path, so the current invoice is finalized first):
  ```ts
  it('mid-cycle seat change prorates an open invoice immediately (v2 flow)', () => {
    const db = activeSub();
    finalizeInvoice(db, 'sub-1-inv-2');        // current draft → open (fee 4000, usage 0)
    changeSeats(db, 'sub-1', 6, 1_000);        // drifted open-path: total_due += 1000
    expect(getInvoice(db, 'sub-1-inv-2').total_due).toBe(5_000);
  });
  ```
  (import `finalizeInvoice`/`getInvoice` from `../src/billing-service.js` if not present.)
- Expected impl failures: none new beyond the drift's own test passing.
- Pre-registered catch: **caught-violation, Tier 1** — `totalDueAtMostParts` (an open invoice with `total_due > license_fee_amount + usage_amount`), witness `sub-1-inv-2`. **Pre-registered collateral (also expected, not a surprise):** the same fixture quiesces an ACTIVE sub with an open unpaid latest invoice, so `activePaidInFull` fires too — record both; the class-12 verdict keys on `totalDueAtMostParts`.

**c13 — stale read model** (`drift/c13-stale-read-model`)
- Edit: `billing-service.ts` `settle()`: delete its `refreshAccountSummary(db, inv.subscription_id, 0);` line (the "batch summary refreshes nightly for performance" accident).
- Exercising fixture: existing corpus (any settle path — the summary's `open_balance`/`lifetime_paid` go stale the moment an invoice settles).
- Expected impl failures: read-model tests (lifetime_paid assertions).
- Pre-registered catch: **caught-violation, crosscheck** — output contains `crosscheck account_summary` with detail matching `lifetime_paid` and/or `open_balance` mismatches (the class-13 instrument built in Task 1).

- [ ] c12 executed, outcome recorded + committed
- [ ] c13 executed, outcome recorded + committed

---

### Task 8: Synthesis — the slice verdict

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md` (verdict section)
- Modify: `README.md` (status: drift experiments run, N/13)
- Modify: `docs/superpowers/specs/2026-07-14-lattice-slice-2-conformance-design.md` (status header: add a one-line results pointer)

- [ ] **Step 1: Write the verdict section**

Against §7's pre-registered criteria, with real numbers:
1. Catch rate: `N/13` with the per-class table (caught-violation / caught-loud / missed). ANY miss: quote it and mark the criterion ❌ — the design says a structurally uncatchable class is a stop-and-redesign finding for the human, not a re-scope.
2. False positives: `0/3` negative-control runs (from Task 2) ✅/❌.
3. Runtime: max observed conform duration vs the 60s budget.
4. Residual surface: the report's measured line (fields auto-bound/overridden %, override line count) — the §21-step-2 number, stated plainly.
5. One paragraph: what the drift experiments actually demonstrated about H-conformance (can non-generated code stay provably synced?) — claims strictly limited to what was measured.

- [ ] **Step 2: Update README + design status lines** (one sentence each: experiments run, results doc linked).

- [ ] **Step 3: Gates + commit**

Run: `cd lattice && npx vitest run src/conform && npx tsc --noEmit` and `cd implementations/subscriptions && npx vitest run && npx tsc --noEmit` (work branch must be clean/green — no drift leaked).

```bash
git add docs/superpowers/specs/2026-07-15-lattice-slice-2-drift-experiment-results.md README.md \
  docs/superpowers/specs/2026-07-14-lattice-slice-2-conformance-design.md
git commit -m "docs(conform): drift-experiment results + slice-2 verdict against pre-registered criteria

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review checklist (controller, after Task 8)

1. All 13 design-§6 classes have an outcome; the negative control ran ×3; every MISSED class (if any) is escalated to the human verbatim, never re-scoped.
2. Drift branches exist as evidence (`git branch --list 'drift/*'` = 13), none merged.
3. The full engine suite runs ONCE at the end (controller) on the work branch.
4. The §7 criteria table in the results doc has real numbers in every row.
