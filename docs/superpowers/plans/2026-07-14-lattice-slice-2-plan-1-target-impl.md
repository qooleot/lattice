# Slice 2 Plan 1: Engineer-Shaped Target Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `implementations/subscriptions/` — a hand-maintained, engineer-shaped TypeScript service implementing the Subscriptions spec's behavior as a SUPERSET (payments ledger, dunning, rollover, proration, plan supersession, account read model), with an outbox and its own ordinary test suite, and with **no anchored invariant checks of its own**.

**Architecture:** Plain service modules over better-sqlite3, one real SQL transaction per public mutator, domain events appended to an `outbox` table inside the transaction. Schema is deliberately engineer-shaped (snake_case, derived-not-stored values: `amountPaid` = SUM of payments, `retryCount` = COUNT of dunning attempts). This package is the conformance target of design `docs/superpowers/specs/2026-07-14-lattice-slice-2-conformance-design.md` §3 — the harness (plan 2) watches it from outside.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, vitest. **No dependency on `lattice/` — this package never imports engine code and never cites anchors.**

## Global Constraints

- Package root: `implementations/subscriptions/` (repo-root sibling of `generated/` and `specs/`), own `package.json` + gates: `npx tsc --noEmit && npx vitest run` inside the package must pass before every commit.
- Money = integer cents (`INTEGER`); dates/timestamps = unix seconds (`INTEGER`). Never floats.
- Every public mutator wraps its work in `db.transaction(...)()`; the outbox append happens INSIDE that transaction.
- Spec-covered behavior must be genuinely conformant (the negative control depends on it): the 11 transitions' from-states and guards respected; only the 4 declared events emitted (`SubscriptionActivated`, `SubscriptionCanceled`, `InvoiceFinalized`, `InvoicePaid`); silent transitions emit nothing.
- No hand-rolled invariant enforcement: ordinary input validation only (`throw new Error(...)` with plain messages, no spec/ledger references).
- `plan` is `const` in the spec — never mutate `plan_code` on an existing row; plan change = supersession (cancel + create new, §Task 5).
- Never `git add -A`; stage explicit paths; conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Worktree bootstrap once: `bash lattice/scripts/ensure-ready.sh`. Run `cd implementations/subscriptions && npm install` after Task 1 creates the package.

---

## File Structure

- `implementations/subscriptions/package.json`, `tsconfig.json`, `vitest.config.ts` — package scaffold.
- `src/schema.sql` — all tables (single source for DDL).
- `src/db.ts` — `openDb()` (connection + schema bootstrap).
- `src/events.ts` — event-type string constants.
- `src/outbox.ts` — `appendEvent()`.
- `src/subscription-service.ts` — create/activate/expire/cancel/seats/usage/rollover/plan-supersession.
- `src/billing-service.ts` — invoice finalize/payments/void/write-off (+ `amountPaid` derivation).
- `src/dunning.ts` — payment failure, retry loop, exhaustion.
- `src/read-model.ts` — `refreshAccountSummary()`.
- `test/support.ts` — `makeDb()` helper that tracks open handles (plan 2's capture hook attaches here — keep the exported `openDbs` array).
- `test/*.test.ts` — the ordinary suite (one file per service module + one end-to-end journey).

---

### Task 1: Package scaffold, schema, `openDb`

**Files:**
- Create: `implementations/subscriptions/package.json`
- Create: `implementations/subscriptions/tsconfig.json`
- Create: `implementations/subscriptions/vitest.config.ts`
- Create: `implementations/subscriptions/src/schema.sql`
- Create: `implementations/subscriptions/src/db.ts`
- Create: `implementations/subscriptions/test/support.ts`
- Test: `implementations/subscriptions/test/db.test.ts`

**Interfaces:**
- Consumes: nothing (greenfield package).
- Produces: `openDb(file?: string): Database.Database` (foreign keys ON, schema applied); `makeDb(): Database.Database` and `openDbs: Database.Database[]` from `test/support.ts`.

- [ ] **Step 1: Mirror dependency versions from the generated package**

Run: `cat generated/subscriptions/package.json generated/subscriptions/tsconfig.json generated/subscriptions/vitest.config.ts`
Copy the exact `better-sqlite3`, `@types/better-sqlite3`, `typescript`, `vitest` versions and compilerOptions into the files below (the literals shown are fallbacks — the generated package's pins win).

- [ ] **Step 2: Write the scaffold files**

```json
// implementations/subscriptions/package.json
{
  "name": "subscriptions-impl",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "better-sqlite3": "^11.3.0" },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

```json
// implementations/subscriptions/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "conform/**/*.ts"]
}
```

```ts
// implementations/subscriptions/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

(`conform/**/*.ts` in `include` is forward provisioning for plan 2's contract + overrides — harmless while the directory is absent.)

- [ ] **Step 3: Write the failing test**

```ts
// implementations/subscriptions/test/db.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';

describe('openDb', () => {
  it('creates every table with foreign keys enforced', () => {
    const db = makeDb();
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all() as { name: string }[]).map(r => r.name);
    expect(names).toEqual([
      'account_summary', 'dunning_attempts', 'invoice_payments', 'invoices', 'outbox', 'subscriptions',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd implementations/subscriptions && npm install && npx vitest run test/db.test.ts`
Expected: FAIL — `Cannot find module './support.js'`.

- [ ] **Step 5: Write schema, db, support**

```sql
-- implementations/subscriptions/src/schema.sql
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  plan_code          TEXT NOT NULL,
  seats              INTEGER NOT NULL,
  period_start       INTEGER NOT NULL,
  period_end         INTEGER NOT NULL,
  accrued_units      INTEGER NOT NULL DEFAULT 0,
  paid_invoice_count INTEGER NOT NULL DEFAULT 0,
  max_retries        INTEGER NOT NULL DEFAULT 3,
  current_invoice_id TEXT,
  lifecycle_state    TEXT NOT NULL DEFAULT 'trialing',  -- trialing|active|past_due|canceled|expired
  superseded_by      TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id                 TEXT PRIMARY KEY,
  subscription_id    TEXT NOT NULL REFERENCES subscriptions(id),
  license_fee_amount INTEGER NOT NULL,
  usage_amount       INTEGER NOT NULL DEFAULT 0,
  total_due          INTEGER NOT NULL DEFAULT 0,
  settlement_state   TEXT NOT NULL DEFAULT 'draft'      -- draft|open|paid|void|uncollectible
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount     INTEGER NOT NULL,
  paid_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dunning_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id),
  attempted_at INTEGER NOT NULL,
  outcome      TEXT NOT NULL                             -- 'failed'
);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_summary (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
  plan_code       TEXT NOT NULL,
  status          TEXT NOT NULL,
  open_balance    INTEGER NOT NULL,
  lifetime_paid   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

```ts
// implementations/subscriptions/src/db.ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function openDb(file = ':memory:'): Database.Database {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}
```

```ts
// implementations/subscriptions/test/support.ts
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';

/** Open handles for the current test file. Plan 2's conformance capture hook drains this
 *  array in afterEach — keep the export stable. */
export const openDbs: Database.Database[] = [];

export function makeDb(): Database.Database {
  const db = openDb();
  openDbs.push(db);
  return db;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd implementations/subscriptions && npx vitest run test/db.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add implementations/subscriptions/package.json implementations/subscriptions/package-lock.json \
  implementations/subscriptions/tsconfig.json implementations/subscriptions/vitest.config.ts \
  implementations/subscriptions/src/schema.sql implementations/subscriptions/src/db.ts \
  implementations/subscriptions/test/support.ts implementations/subscriptions/test/db.test.ts
git commit -m "feat(impl): subscriptions-impl scaffold — engineer-shaped schema + openDb

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Outbox, events, subscription creation

**Files:**
- Create: `implementations/subscriptions/src/events.ts`
- Create: `implementations/subscriptions/src/outbox.ts`
- Create: `implementations/subscriptions/src/subscription-service.ts`
- Test: `implementations/subscriptions/test/subscription-service.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 1).
- Produces:
  ```ts
  // events.ts
  export const SUBSCRIPTION_ACTIVATED = 'SubscriptionActivated';
  export const SUBSCRIPTION_CANCELED = 'SubscriptionCanceled';
  export const INVOICE_FINALIZED = 'InvoiceFinalized';
  export const INVOICE_PAID = 'InvoicePaid';
  // outbox.ts
  export function appendEvent(db: Database.Database, eventType: string, aggregateId: string, payload: unknown): void;
  // subscription-service.ts
  export interface SubscriptionRow { id: string; plan_code: string; seats: number; period_start: number;
    period_end: number; accrued_units: number; paid_invoice_count: number; max_retries: number;
    current_invoice_id: string | null; lifecycle_state: string; superseded_by: string | null }
  export interface CreateSubscriptionArgs { id: string; planCode: string; seats: number;
    periodStart: number; periodEnd: number; licenseFeeAmount: number; maxRetries?: number }
  export function getSubscription(db: Database.Database, id: string): SubscriptionRow; // throws if missing
  export function createSubscription(db: Database.Database, a: CreateSubscriptionArgs): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// implementations/subscriptions/test/subscription-service.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { createSubscription, getSubscription } from '../src/subscription-service.js';

const baseArgs = { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 };

describe('createSubscription', () => {
  it('creates a trialing subscription with a draft first invoice as current', () => {
    const db = makeDb();
    createSubscription(db, baseArgs);
    const sub = getSubscription(db, 'sub-1');
    expect(sub.lifecycle_state).toBe('trialing');
    expect(sub.paid_invoice_count).toBe(0);
    expect(sub.current_invoice_id).toBe('sub-1-inv-1');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get('sub-1-inv-1') as any;
    expect(inv.settlement_state).toBe('draft');
    expect(inv.license_fee_amount).toBe(5_000);
    expect(inv.total_due).toBe(0); // totals are computed at finalize, not at creation
    // creation is not a spec event — nothing on the outbox
    expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c).toBe(0);
  });

  it('rejects a duplicate id', () => {
    const db = makeDb();
    createSubscription(db, baseArgs);
    expect(() => createSubscription(db, baseArgs)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/subscription-service.test.ts`
Expected: FAIL — `Cannot find module '../src/subscription-service.js'`.

- [ ] **Step 3: Write events, outbox, and creation**

```ts
// implementations/subscriptions/src/events.ts
export const SUBSCRIPTION_ACTIVATED = 'SubscriptionActivated';
export const SUBSCRIPTION_CANCELED = 'SubscriptionCanceled';
export const INVOICE_FINALIZED = 'InvoiceFinalized';
export const INVOICE_PAID = 'InvoicePaid';
```

```ts
// implementations/subscriptions/src/outbox.ts
import type Database from 'better-sqlite3';

export function appendEvent(db: Database.Database, eventType: string, aggregateId: string, payload: unknown): void {
  db.prepare(`INSERT INTO outbox (event_type, aggregate_id, payload, created_at) VALUES (?,?,?,unixepoch())`)
    .run(eventType, aggregateId, JSON.stringify(payload));
}
```

```ts
// implementations/subscriptions/src/subscription-service.ts
import type Database from 'better-sqlite3';

export interface SubscriptionRow {
  id: string; plan_code: string; seats: number; period_start: number; period_end: number;
  accrued_units: number; paid_invoice_count: number; max_retries: number;
  current_invoice_id: string | null; lifecycle_state: string; superseded_by: string | null;
}

export interface CreateSubscriptionArgs {
  id: string; planCode: string; seats: number;
  periodStart: number; periodEnd: number; licenseFeeAmount: number; maxRetries?: number;
}

export function getSubscription(db: Database.Database, id: string): SubscriptionRow {
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined;
  if (!row) throw new Error(`subscription not found: ${id}`);
  return row;
}

export function createSubscription(db: Database.Database, a: CreateSubscriptionArgs): void {
  db.transaction(() => {
    if (a.seats <= 0) throw new Error('seats must be positive');
    if (a.periodEnd <= a.periodStart) throw new Error('period must be well-ordered');
    db.prepare(`INSERT INTO subscriptions
        (id, plan_code, seats, period_start, period_end, max_retries)
        VALUES (?,?,?,?,?,?)`)
      .run(a.id, a.planCode, a.seats, a.periodStart, a.periodEnd, a.maxRetries ?? 3);
    const invoiceId = `${a.id}-inv-1`;
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES (?,?,?)`)
      .run(invoiceId, a.id, a.licenseFeeAmount);
    db.prepare('UPDATE subscriptions SET current_invoice_id = ? WHERE id = ?').run(invoiceId, a.id);
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd implementations/subscriptions && npx vitest run test/subscription-service.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add implementations/subscriptions/src/events.ts implementations/subscriptions/src/outbox.ts \
  implementations/subscriptions/src/subscription-service.ts implementations/subscriptions/test/subscription-service.test.ts
git commit -m "feat(impl): outbox + subscription creation with first draft invoice

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Billing service — finalize, payments ledger, settle, void, write-off

**Files:**
- Create: `implementations/subscriptions/src/billing-service.ts`
- Test: `implementations/subscriptions/test/billing-service.test.ts`

**Interfaces:**
- Consumes: `getSubscription` (Task 2), `appendEvent`, `INVOICE_FINALIZED`, `INVOICE_PAID`.
- Produces:
  ```ts
  export interface InvoiceRow { id: string; subscription_id: string; license_fee_amount: number;
    usage_amount: number; total_due: number; settlement_state: string }
  export function getInvoice(db: Database.Database, id: string): InvoiceRow; // throws if missing
  export function amountPaid(db: Database.Database, invoiceId: string): number; // SUM over invoice_payments
  export function finalizeInvoice(db: Database.Database, invoiceId: string): void;
  export function recordPayment(db: Database.Database, invoiceId: string, amount: number, now: number): void;
  export function voidInvoice(db: Database.Database, invoiceId: string): void;    // draft or open → void
  export function writeOffInvoice(db: Database.Database, invoiceId: string): void; // open → uncollectible
  ```
- Spec-behavior notes (implement as ordinary logic, no anchors): `finalizeInvoice` computes `total_due = license_fee_amount + usage_amount` (the spec's `finalize` guard holds by construction). Settlement happens automatically inside `recordPayment` when the payments SUM reaches `total_due` exactly; overpayment is rejected. Settling increments the owning subscription's `paid_invoice_count` and, if the subscription is `past_due`, returns it to `active` (the spec's silent `recover` transition — emit nothing for it).

- [ ] **Step 1: Write the failing test**

```ts
// implementations/subscriptions/test/billing-service.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { createSubscription, getSubscription } from '../src/subscription-service.js';
import { amountPaid, finalizeInvoice, getInvoice, recordPayment, voidInvoice, writeOffInvoice } from '../src/billing-service.js';

function seeded() {
  const db = makeDb();
  createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 });
  return db;
}
const events = (db: any) => (db.prepare('SELECT event_type, aggregate_id FROM outbox ORDER BY id').all() as any[]);

describe('billing-service', () => {
  it('finalize computes total and emits InvoiceFinalized', () => {
    const db = seeded();
    finalizeInvoice(db, 'sub-1-inv-1');
    const inv = getInvoice(db, 'sub-1-inv-1');
    expect(inv.settlement_state).toBe('open');
    expect(inv.total_due).toBe(5_000);
    expect(events(db)).toEqual([{ event_type: 'InvoiceFinalized', aggregate_id: 'sub-1-inv-1' }]);
  });

  it('partial payments accrue; exact-full payment settles, emits InvoicePaid, bumps paid_invoice_count', () => {
    const db = seeded();
    finalizeInvoice(db, 'sub-1-inv-1');
    recordPayment(db, 'sub-1-inv-1', 2_000, 1_100);
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('open');
    expect(amountPaid(db, 'sub-1-inv-1')).toBe(2_000);
    recordPayment(db, 'sub-1-inv-1', 3_000, 1_200);
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('paid');
    expect(getSubscription(db, 'sub-1').paid_invoice_count).toBe(1);
    expect(events(db).map(e => e.event_type)).toEqual(['InvoiceFinalized', 'InvoicePaid']);
  });

  it('rejects overpayment and payments on non-open invoices', () => {
    const db = seeded();
    expect(() => recordPayment(db, 'sub-1-inv-1', 1, 1_100)).toThrow(/open/);
    finalizeInvoice(db, 'sub-1-inv-1');
    expect(() => recordPayment(db, 'sub-1-inv-1', 5_001, 1_100)).toThrow(/overpayment/);
  });

  it('void covers draft and open; write-off only open; neither emits', () => {
    const db = seeded();
    voidInvoice(db, 'sub-1-inv-1');
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('void');
    expect(() => writeOffInvoice(db, 'sub-1-inv-1')).toThrow();
    expect(events(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/billing-service.test.ts`
Expected: FAIL — `Cannot find module '../src/billing-service.js'`.

- [ ] **Step 3: Write the billing service**

```ts
// implementations/subscriptions/src/billing-service.ts
import type Database from 'better-sqlite3';
import { appendEvent } from './outbox.js';
import { INVOICE_FINALIZED, INVOICE_PAID } from './events.js';
import { getSubscription } from './subscription-service.js';

export interface InvoiceRow {
  id: string; subscription_id: string; license_fee_amount: number;
  usage_amount: number; total_due: number; settlement_state: string;
}

export function getInvoice(db: Database.Database, id: string): InvoiceRow {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
  if (!row) throw new Error(`invoice not found: ${id}`);
  return row;
}

export function amountPaid(db: Database.Database, invoiceId: string): number {
  return (db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM invoice_payments WHERE invoice_id = ?')
    .get(invoiceId) as { s: number }).s;
}

export function finalizeInvoice(db: Database.Database, invoiceId: string): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'draft') throw new Error(`finalize: ${invoiceId} is ${inv.settlement_state}`);
    const total = inv.license_fee_amount + inv.usage_amount;
    db.prepare(`UPDATE invoices SET total_due = ?, settlement_state = 'open' WHERE id = ?`).run(total, invoiceId);
    appendEvent(db, INVOICE_FINALIZED, invoiceId, { invoiceId });
  })();
}

export function recordPayment(db: Database.Database, invoiceId: string, amount: number, now: number): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'open') throw new Error(`payments only accepted on open invoices (${invoiceId} is ${inv.settlement_state})`);
    if (amount <= 0) throw new Error('payment amount must be positive');
    const paid = amountPaid(db, invoiceId);
    if (paid + amount > inv.total_due) throw new Error(`overpayment rejected: ${paid} + ${amount} > ${inv.total_due}`);
    db.prepare('INSERT INTO invoice_payments (invoice_id, amount, paid_at) VALUES (?,?,?)').run(invoiceId, amount, now);
    if (paid + amount === inv.total_due) settle(db, inv);
  })();
}

function settle(db: Database.Database, inv: InvoiceRow): void {
  db.prepare(`UPDATE invoices SET settlement_state = 'paid' WHERE id = ?`).run(inv.id);
  appendEvent(db, INVOICE_PAID, inv.id, { invoiceId: inv.id });
  const sub = getSubscription(db, inv.subscription_id);
  db.prepare('UPDATE subscriptions SET paid_invoice_count = paid_invoice_count + 1 WHERE id = ?').run(sub.id);
  if (sub.lifecycle_state === 'past_due') {
    // payment restored the account — silent recovery, no event
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(sub.id);
  }
}

export function voidInvoice(db: Database.Database, invoiceId: string): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'draft' && inv.settlement_state !== 'open')
      throw new Error(`void: ${invoiceId} is ${inv.settlement_state}`);
    db.prepare(`UPDATE invoices SET settlement_state = 'void' WHERE id = ?`).run(invoiceId);
  })();
}

export function writeOffInvoice(db: Database.Database, invoiceId: string): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'open') throw new Error(`write-off: ${invoiceId} is ${inv.settlement_state}`);
    db.prepare(`UPDATE invoices SET settlement_state = 'uncollectible' WHERE id = ?`).run(invoiceId);
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd implementations/subscriptions && npx vitest run test/billing-service.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add implementations/subscriptions/src/billing-service.ts implementations/subscriptions/test/billing-service.test.ts
git commit -m "feat(impl): billing service — finalize, payments ledger with auto-settle, void/write-off

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Lifecycle — activate, expire, cancel; dunning — failure, retries, exhaustion

**Files:**
- Modify: `implementations/subscriptions/src/subscription-service.ts` (add `activate`, `expireTrials`, `cancelSubscription`)
- Create: `implementations/subscriptions/src/dunning.ts`
- Test: `implementations/subscriptions/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 exports.
- Produces:
  ```ts
  // subscription-service.ts (additions)
  export function activate(db: Database.Database, subId: string): void;            // trialing + ≥1 paid invoice → active, emits SubscriptionActivated
  export function expireTrials(db: Database.Database, now: number): number;        // trialing past period_end → expired (silent); returns count
  export function cancelSubscription(db: Database.Database, subId: string): void;  // trialing|active|past_due → canceled, emits SubscriptionCanceled
  // dunning.ts
  export function recordPaymentFailure(db: Database.Database, invoiceId: string, now: number): void; // logs failed attempt; active owner → past_due (silent)
  export function runDunning(db: Database.Database, now: number,
    charge: (invoiceId: string, amountDue: number) => boolean): { attempted: number; exhausted: number };
  ```
- Behavior notes: `runDunning` sweeps open invoices whose owning subscription is `past_due`. If the invoice's failed-attempt count has reached the subscription's `max_retries`, it exhausts: cancel the subscription (via `cancelSubscription` — the observable event is the legal `cancel` from `past_due`) and write off the invoice. Otherwise it calls `charge(invoiceId, remaining)`; success → `recordPayment` (auto-settles → silent recovery), failure → one more failed attempt row. Each swept invoice is its own transaction.

- [ ] **Step 1: Write the failing test**

```ts
// implementations/subscriptions/test/lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { activate, cancelSubscription, createSubscription, expireTrials, getSubscription } from '../src/subscription-service.js';
import { finalizeInvoice, getInvoice, recordPayment } from '../src/billing-service.js';
import { recordPaymentFailure, runDunning } from '../src/dunning.js';

function paidTrial() {
  const db = makeDb();
  createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000, maxRetries: 2 });
  finalizeInvoice(db, 'sub-1-inv-1');
  recordPayment(db, 'sub-1-inv-1', 5_000, 1_100);
  return db;
}
const eventTypes = (db: any) => (db.prepare('SELECT event_type FROM outbox ORDER BY id').all() as any[]).map(r => r.event_type);

describe('lifecycle', () => {
  it('activate requires a paid invoice and emits SubscriptionActivated', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 5, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 5_000 });
    expect(() => activate(db, 'sub-1')).toThrow(/paid/);
    finalizeInvoice(db, 'sub-1-inv-1');
    recordPayment(db, 'sub-1-inv-1', 5_000, 1_100);
    activate(db, 'sub-1');
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
    expect(eventTypes(db)).toEqual(['InvoiceFinalized', 'InvoicePaid', 'SubscriptionActivated']);
  });

  it('expireTrials expires only overdue trials, silently', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 1, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 100 });
    createSubscription(db, { id: 'sub-2', planCode: 'pro', seats: 1, periodStart: 1_000, periodEnd: 9_000, licenseFeeAmount: 100 });
    expect(expireTrials(db, 5_000)).toBe(1);
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('expired');
    expect(getSubscription(db, 'sub-2').lifecycle_state).toBe('trialing');
    expect(eventTypes(db)).toEqual([]);
  });

  it('cancel is legal from trialing/active/past_due only', () => {
    const db = paidTrial();
    activate(db, 'sub-1');
    cancelSubscription(db, 'sub-1');
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('canceled');
    expect(() => cancelSubscription(db, 'sub-1')).toThrow();
    expect(eventTypes(db)).toContain('SubscriptionCanceled');
  });

  it('payment failure marks past_due; successful retry recovers silently', () => {
    const db = paidTrial();
    activate(db, 'sub-1');
    // second billing cycle: a fresh open invoice that fails
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount, usage_amount, total_due, settlement_state)
                VALUES ('sub-1-inv-2','sub-1',5000,0,5000,'open')`).run();
    recordPaymentFailure(db, 'sub-1-inv-2', 2_100);
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('past_due');
    const r = runDunning(db, 2_200, () => true);
    expect(r).toEqual({ attempted: 1, exhausted: 0 });
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('active');
    expect(getInvoice(db, 'sub-1-inv-2').settlement_state).toBe('paid');
  });

  it('exhaustion after max_retries cancels the subscription and writes off the invoice', () => {
    const db = paidTrial(); // maxRetries: 2
    activate(db, 'sub-1');
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount, usage_amount, total_due, settlement_state)
                VALUES ('sub-1-inv-2','sub-1',5000,0,5000,'open')`).run();
    recordPaymentFailure(db, 'sub-1-inv-2', 2_100);       // attempt 1
    expect(runDunning(db, 2_200, () => false)).toEqual({ attempted: 1, exhausted: 0 }); // attempt 2
    expect(runDunning(db, 2_300, () => false)).toEqual({ attempted: 0, exhausted: 1 }); // cap reached
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('canceled');
    expect(getInvoice(db, 'sub-1-inv-2').settlement_state).toBe('uncollectible');
    expect(eventTypes(db)).toContain('SubscriptionCanceled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/lifecycle.test.ts`
Expected: FAIL — `Cannot find module '../src/dunning.js'` (and missing exports).

- [ ] **Step 3: Add lifecycle functions and the dunning module**

Append to `implementations/subscriptions/src/subscription-service.ts`:

```ts
import { appendEvent } from './outbox.js';
import { SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_CANCELED } from './events.js';

export function activate(db: Database.Database, subId: string): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (sub.lifecycle_state !== 'trialing') throw new Error(`activate: ${subId} is ${sub.lifecycle_state}`);
    if (sub.paid_invoice_count < 1) throw new Error(`activate: ${subId} has no paid invoice yet`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'active' WHERE id = ?`).run(subId);
    appendEvent(db, SUBSCRIPTION_ACTIVATED, subId, { subId });
  })();
}

export function expireTrials(db: Database.Database, now: number): number {
  return db.transaction(() =>
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'expired'
                WHERE lifecycle_state = 'trialing' AND period_end < ?`).run(now).changes
  )();
}

export function cancelSubscription(db: Database.Database, subId: string): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active', 'past_due'].includes(sub.lifecycle_state))
      throw new Error(`cancel: ${subId} is ${sub.lifecycle_state}`);
    db.prepare(`UPDATE subscriptions SET lifecycle_state = 'canceled' WHERE id = ?`).run(subId);
    appendEvent(db, SUBSCRIPTION_CANCELED, subId, { subId });
  })();
}
```

(Place the two import lines with the existing imports at the top of the file.)

```ts
// implementations/subscriptions/src/dunning.ts
import type Database from 'better-sqlite3';
import { getSubscription, cancelSubscription } from './subscription-service.js';
import { amountPaid, getInvoice, recordPayment, writeOffInvoice } from './billing-service.js';

function failedAttempts(db: Database.Database, invoiceId: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM dunning_attempts WHERE invoice_id = ? AND outcome = 'failed'`)
    .get(invoiceId) as { c: number }).c;
}

export function recordPaymentFailure(db: Database.Database, invoiceId: string, now: number): void {
  db.transaction(() => {
    const inv = getInvoice(db, invoiceId);
    if (inv.settlement_state !== 'open') throw new Error(`payment failure on non-open invoice ${invoiceId}`);
    db.prepare(`INSERT INTO dunning_attempts (invoice_id, attempted_at, outcome) VALUES (?,?,'failed')`)
      .run(invoiceId, now);
    const sub = getSubscription(db, inv.subscription_id);
    if (sub.lifecycle_state === 'active') {
      db.prepare(`UPDATE subscriptions SET lifecycle_state = 'past_due' WHERE id = ?`).run(sub.id);
    }
  })();
}

export function runDunning(
  db: Database.Database, now: number,
  charge: (invoiceId: string, amountDue: number) => boolean,
): { attempted: number; exhausted: number } {
  const targets = db.prepare(`
    SELECT i.id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
    WHERE i.settlement_state = 'open' AND s.lifecycle_state = 'past_due' ORDER BY i.id
  `).all() as { id: string }[];
  let attempted = 0, exhausted = 0;
  for (const { id } of targets) {
    db.transaction(() => {
      const inv = getInvoice(db, id);
      const sub = getSubscription(db, inv.subscription_id);
      if (failedAttempts(db, id) >= sub.max_retries) {
        cancelSubscription(db, sub.id);
        writeOffInvoice(db, id);
        exhausted++;
        return;
      }
      const due = inv.total_due - amountPaid(db, id);
      attempted++;
      if (charge(id, due)) recordPayment(db, id, due, now);
      else db.prepare(`INSERT INTO dunning_attempts (invoice_id, attempted_at, outcome) VALUES (?,?,'failed')`).run(id, now);
    })();
  }
  return { attempted, exhausted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd implementations/subscriptions && npx vitest run && npx tsc --noEmit`
Expected: all test files PASS, clean typecheck. (Run the whole suite — Tasks 2–3 tests must stay green.)

- [ ] **Step 5: Commit**

```bash
git add implementations/subscriptions/src/subscription-service.ts implementations/subscriptions/src/dunning.ts \
  implementations/subscriptions/test/lifecycle.test.ts
git commit -m "feat(impl): lifecycle transitions + dunning retries with exhaustion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Usage, rollover, seat proration, plan supersession

**Files:**
- Modify: `implementations/subscriptions/src/subscription-service.ts` (add `recordUsage`, `rolloverPeriod`, `changeSeats`, `changePlan`)
- Test: `implementations/subscriptions/test/growth.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 exports (`finalizeInvoice`, `recordPayment`, `recordPaymentFailure` are imported into `subscription-service.ts` — a deliberate module cycle is avoided because `billing-service.ts` only imports `getSubscription`, never these new functions).
- Produces:
  ```ts
  export function recordUsage(db: Database.Database, subId: string, units: number, centsPerUnit: number): void;
  export interface RolloverArgs { nextInvoiceId: string; licenseFeeAmount: number; nextPeriodEnd: number; now: number;
    charge: (invoiceId: string, amountDue: number) => boolean }
  export function rolloverPeriod(db: Database.Database, subId: string, a: RolloverArgs): void;
  export function changeSeats(db: Database.Database, subId: string, newSeats: number, prorationAmount: number): void;
  export interface ChangePlanArgs { newId: string; planCode: string; licenseFeeAmount: number; now: number; periodEnd: number }
  export function changePlan(db: Database.Database, subId: string, a: ChangePlanArgs): void;
  ```
- Behavior notes (all superset — the spec knows none of these; they must still leave spec-covered state legal):
  - `recordUsage`: `accrued_units += units`; the current **draft** invoice's `usage_amount += units * centsPerUnit`. Rejected when the current invoice isn't draft.
  - `rolloverPeriod` (one transaction): requires `active`; if the current invoice is still `draft`, finalizes it (emits `InvoiceFinalized`) and attempts the charge — success → `recordPayment` (settles, emits `InvoicePaid`), failure → `recordPaymentFailure` (→ `past_due`); if the customer settled ahead (current invoice already `paid`), skip finalize and charge entirely. Either way: create the next period's draft invoice and make it current, advance `period_start/period_end`, reset `accrued_units`. Net observable outcome is always spec-legal at quiescence.
  - `changeSeats`: requires `trialing` or `active`, current invoice draft; `seats = newSeats`, draft `usage_amount += prorationAmount` (clamped: resulting `usage_amount` must stay ≥ 0 — reject otherwise).
  - `changePlan`: **supersession, because `plan` is const in the spec** — cancel the old subscription (legal `cancel`, emits `SubscriptionCanceled`), create a new one on the new plan carrying over `seats`/`max_retries`, and stamp `superseded_by` on the old row.

- [ ] **Step 1: Write the failing test**

```ts
// implementations/subscriptions/test/growth.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import {
  activate, changePlan, changeSeats, createSubscription, getSubscription, recordUsage, rolloverPeriod,
} from '../src/subscription-service.js';
import { finalizeInvoice, getInvoice, recordPayment } from '../src/billing-service.js';

function activeSub() {
  const db = makeDb();
  createSubscription(db, { id: 'sub-1', planCode: 'basic', seats: 4, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 4_000 });
  finalizeInvoice(db, 'sub-1-inv-1');
  recordPayment(db, 'sub-1-inv-1', 4_000, 1_100);
  activate(db, 'sub-1');
  // open the second billing period so there is a current draft to accrue into
  rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-2', licenseFeeAmount: 4_000, nextPeriodEnd: 3_000, now: 2_000, charge: () => true });
  return db;
}

describe('growth features (superset)', () => {
  it('recordUsage accrues units onto the current draft invoice', () => {
    const db = activeSub();
    recordUsage(db, 'sub-1', 10, 25);
    expect(getSubscription(db, 'sub-1').accrued_units).toBe(10);
    expect(getInvoice(db, 'sub-1-inv-2').usage_amount).toBe(250);
  });

  it('rollover advances the period and opens the next draft; settled-ahead invoices skip billing', () => {
    const db = activeSub();
    const sub = getSubscription(db, 'sub-1');
    expect(sub.current_invoice_id).toBe('sub-1-inv-2');
    expect(sub.period_start).toBe(2_000);
    expect(sub.period_end).toBe(3_000);
    expect(sub.accrued_units).toBe(0);
    expect(getInvoice(db, 'sub-1-inv-1').settlement_state).toBe('paid'); // paid before rollover — no re-billing
    expect(getInvoice(db, 'sub-1-inv-2').settlement_state).toBe('draft');
    // settled-ahead path emits nothing beyond the pre-rollover history
    const types = (db.prepare('SELECT event_type FROM outbox ORDER BY id').all() as any[]).map(r => r.event_type);
    expect(types).toEqual(['InvoiceFinalized', 'InvoicePaid', 'SubscriptionActivated']);
  });

  it('failed rollover charge leaves the sub past_due with the old invoice open', () => {
    const db = activeSub();
    recordUsage(db, 'sub-1', 4, 100);
    rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-3', licenseFeeAmount: 4_000, nextPeriodEnd: 4_000, now: 3_000, charge: () => false });
    expect(getSubscription(db, 'sub-1').lifecycle_state).toBe('past_due');
    const inv2 = getInvoice(db, 'sub-1-inv-2');
    expect(inv2.settlement_state).toBe('open');
    expect(inv2.total_due).toBe(4_400); // fee + accrued usage
  });

  it('changeSeats prorates onto the draft and clamps below zero', () => {
    const db = activeSub();
    changeSeats(db, 'sub-1', 6, 1_500);
    expect(getSubscription(db, 'sub-1').seats).toBe(6);
    expect(getInvoice(db, 'sub-1-inv-2').usage_amount).toBe(1_500);
    expect(() => changeSeats(db, 'sub-1', 2, -9_999)).toThrow(/negative/);
  });

  it('changePlan supersedes: cancels old (event), creates new on the new plan, never mutates plan_code', () => {
    const db = activeSub();
    changePlan(db, 'sub-1', { newId: 'sub-2', planCode: 'pro', licenseFeeAmount: 9_000, now: 2_500, periodEnd: 3_500 });
    const oldSub = getSubscription(db, 'sub-1');
    expect(oldSub.lifecycle_state).toBe('canceled');
    expect(oldSub.plan_code).toBe('basic');
    expect(oldSub.superseded_by).toBe('sub-2');
    const newSub = getSubscription(db, 'sub-2');
    expect(newSub.plan_code).toBe('pro');
    expect(newSub.seats).toBe(4); // carried over from the superseded row
    expect(newSub.lifecycle_state).toBe('trialing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/growth.test.ts`
Expected: FAIL — missing exports `recordUsage`, `rolloverPeriod`, `changeSeats`, `changePlan`.

- [ ] **Step 3: Add the growth functions**

Append to `implementations/subscriptions/src/subscription-service.ts` (add the billing/dunning imports to the top of the file):

```ts
import { finalizeInvoice, getInvoice, recordPayment } from './billing-service.js';
import { recordPaymentFailure } from './dunning.js';

export function recordUsage(db: Database.Database, subId: string, units: number, centsPerUnit: number): void {
  db.transaction(() => {
    if (units <= 0 || centsPerUnit < 0) throw new Error('usage must be positive');
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active'].includes(sub.lifecycle_state)) throw new Error(`recordUsage: ${subId} is ${sub.lifecycle_state}`);
    if (!sub.current_invoice_id) throw new Error(`recordUsage: ${subId} has no current invoice`);
    const inv = getInvoice(db, sub.current_invoice_id);
    if (inv.settlement_state !== 'draft') throw new Error('usage accrues only onto a draft invoice');
    db.prepare('UPDATE subscriptions SET accrued_units = accrued_units + ? WHERE id = ?').run(units, subId);
    db.prepare('UPDATE invoices SET usage_amount = usage_amount + ? WHERE id = ?').run(units * centsPerUnit, inv.id);
  })();
}

export interface RolloverArgs {
  nextInvoiceId: string; licenseFeeAmount: number; nextPeriodEnd: number; now: number;
  charge: (invoiceId: string, amountDue: number) => boolean;
}

export function rolloverPeriod(db: Database.Database, subId: string, a: RolloverArgs): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    if (sub.lifecycle_state !== 'active') throw new Error(`rollover: ${subId} is ${sub.lifecycle_state}`);
    if (!sub.current_invoice_id) throw new Error(`rollover: ${subId} has no current invoice`);
    const closingId = sub.current_invoice_id;
    const closingBefore = getInvoice(db, closingId);
    const needsBilling = closingBefore.settlement_state === 'draft'; // settled-ahead invoices skip billing
    if (needsBilling) finalizeInvoice(db, closingId);
    db.prepare(`INSERT INTO invoices (id, subscription_id, license_fee_amount) VALUES (?,?,?)`)
      .run(a.nextInvoiceId, subId, a.licenseFeeAmount);
    db.prepare(`UPDATE subscriptions SET period_start = period_end, period_end = ?, accrued_units = 0,
                current_invoice_id = ? WHERE id = ?`).run(a.nextPeriodEnd, a.nextInvoiceId, subId);
    if (needsBilling) {
      const closing = getInvoice(db, closingId);
      if (a.charge(closingId, closing.total_due)) recordPayment(db, closingId, closing.total_due, a.now);
      else recordPaymentFailure(db, closingId, a.now);
    }
  })();
}

export function changeSeats(db: Database.Database, subId: string, newSeats: number, prorationAmount: number): void {
  db.transaction(() => {
    if (newSeats <= 0) throw new Error('seats must be positive');
    const sub = getSubscription(db, subId);
    if (!['trialing', 'active'].includes(sub.lifecycle_state)) throw new Error(`changeSeats: ${subId} is ${sub.lifecycle_state}`);
    if (!sub.current_invoice_id) throw new Error(`changeSeats: ${subId} has no current invoice`);
    const inv = getInvoice(db, sub.current_invoice_id);
    if (inv.settlement_state !== 'draft') throw new Error('seat changes only while the current invoice is draft');
    if (inv.usage_amount + prorationAmount < 0) throw new Error('proration would drive usage negative');
    db.prepare('UPDATE invoices SET usage_amount = usage_amount + ? WHERE id = ?').run(prorationAmount, inv.id);
    db.prepare('UPDATE subscriptions SET seats = ? WHERE id = ?').run(newSeats, subId);
  })();
}

export interface ChangePlanArgs { newId: string; planCode: string; licenseFeeAmount: number; now: number; periodEnd: number }

export function changePlan(db: Database.Database, subId: string, a: ChangePlanArgs): void {
  db.transaction(() => {
    const sub = getSubscription(db, subId);
    cancelSubscription(db, subId);
    createSubscription(db, {
      id: a.newId, planCode: a.planCode, seats: sub.seats,
      periodStart: a.now, periodEnd: a.periodEnd,
      licenseFeeAmount: a.licenseFeeAmount, maxRetries: sub.max_retries,
    });
    db.prepare('UPDATE subscriptions SET superseded_by = ? WHERE id = ?').run(a.newId, subId);
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd implementations/subscriptions && npx vitest run && npx tsc --noEmit`
Expected: all test files PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add implementations/subscriptions/src/subscription-service.ts implementations/subscriptions/test/growth.test.ts
git commit -m "feat(impl): usage accrual, period rollover, seat proration, plan supersession

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Account-summary read model

**Files:**
- Create: `implementations/subscriptions/src/read-model.ts`
- Modify: `implementations/subscriptions/src/subscription-service.ts` (call `refreshAccountSummary` from `createSubscription`, `activate`, `cancelSubscription`, `rolloverPeriod`)
- Modify: `implementations/subscriptions/src/billing-service.ts` (call it from `settle`)
- Modify: `implementations/subscriptions/src/dunning.ts` (call it from `recordPaymentFailure`)
- Test: `implementations/subscriptions/test/read-model.test.ts`

**Interfaces:**
- Consumes: `getSubscription` (Task 2).
- Produces:
  ```ts
  export function refreshAccountSummary(db: Database.Database, subId: string, now: number): void;
  // row shape: { subscription_id, plan_code, status /* impl-speak lifecycle_state copy */,
  //              open_balance /* Σ(total_due − paid) over open invoices */,
  //              lifetime_paid /* Σ payments across all this sub's invoices */, updated_at }
  ```
- This is the deliberately denormalized §11.5 layer-5 stressor: it duplicates `status` and derives balances. Every mutating path listed above must refresh it (drift class 13 is precisely "someone forgets" or "the derivation diverges").

- [ ] **Step 1: Write the failing test**

```ts
// implementations/subscriptions/test/read-model.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import { activate, createSubscription, rolloverPeriod } from '../src/subscription-service.js';
import { finalizeInvoice, recordPayment } from '../src/billing-service.js';

const summary = (db: any, id: string) => db.prepare('SELECT * FROM account_summary WHERE subscription_id = ?').get(id) as any;

describe('account summary read model', () => {
  it('tracks status and balances through the lifecycle', () => {
    const db = makeDb();
    createSubscription(db, { id: 'sub-1', planCode: 'pro', seats: 2, periodStart: 1_000, periodEnd: 2_000, licenseFeeAmount: 3_000 });
    expect(summary(db, 'sub-1')).toMatchObject({ status: 'trialing', open_balance: 0, lifetime_paid: 0 });
    finalizeInvoice(db, 'sub-1-inv-1');
    recordPayment(db, 'sub-1-inv-1', 3_000, 1_100);
    activate(db, 'sub-1');
    expect(summary(db, 'sub-1')).toMatchObject({ status: 'active', open_balance: 0, lifetime_paid: 3_000 });
    rolloverPeriod(db, 'sub-1', { nextInvoiceId: 'sub-1-inv-2', licenseFeeAmount: 3_000, nextPeriodEnd: 3_000, now: 2_000, charge: () => false });
    expect(summary(db, 'sub-1')).toMatchObject({ status: 'past_due', open_balance: 3_000, lifetime_paid: 3_000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd implementations/subscriptions && npx vitest run test/read-model.test.ts`
Expected: FAIL — `Cannot find module '../src/read-model.js'` (once wired) / summary row undefined.

- [ ] **Step 3: Write the read model and wire the refresh calls**

```ts
// implementations/subscriptions/src/read-model.ts
import type Database from 'better-sqlite3';
import { getSubscription } from './subscription-service.js';

export function refreshAccountSummary(db: Database.Database, subId: string, now: number): void {
  const sub = getSubscription(db, subId);
  const open = (db.prepare(`
    SELECT COALESCE(SUM(i.total_due), 0) -
           COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                     JOIN invoices i2 ON i2.id = p.invoice_id
                     WHERE i2.subscription_id = ? AND i2.settlement_state = 'open'), 0) AS bal
    FROM invoices i WHERE i.subscription_id = ? AND i.settlement_state = 'open'
  `).get(subId, subId) as { bal: number }).bal;
  const lifetime = (db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS s FROM invoice_payments p
    JOIN invoices i ON i.id = p.invoice_id WHERE i.subscription_id = ?
  `).get(subId) as { s: number }).s;
  db.prepare(`
    INSERT INTO account_summary (subscription_id, plan_code, status, open_balance, lifetime_paid, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      plan_code = excluded.plan_code, status = excluded.status, open_balance = excluded.open_balance,
      lifetime_paid = excluded.lifetime_paid, updated_at = excluded.updated_at
  `).run(subId, sub.plan_code, sub.lifecycle_state, open, lifetime, now);
}
```

Wire the refresh calls (each is the LAST statement inside the existing transaction, using the timestamp already in scope, or `0` where the function takes no `now` — `createSubscription`, `activate`, `cancelSubscription`):

- `subscription-service.ts` `createSubscription`: after setting `current_invoice_id`, add `refreshAccountSummary(db, a.id, 0);`
- `subscription-service.ts` `activate`: after `appendEvent(...)`, add `refreshAccountSummary(db, subId, 0);`
- `subscription-service.ts` `cancelSubscription`: after `appendEvent(...)`, add `refreshAccountSummary(db, subId, 0);`
- `subscription-service.ts` `rolloverPeriod`: as the final statement, add `refreshAccountSummary(db, subId, a.now);`
- `billing-service.ts` `settle`: as the final statement, add `refreshAccountSummary(db, inv.subscription_id, 0);` (import from `./read-model.js`)
- `dunning.ts` `recordPaymentFailure`: as the final statement, add `refreshAccountSummary(db, inv.subscription_id, now);` (import from `./read-model.js`)

Import in `subscription-service.ts`: `import { refreshAccountSummary } from './read-model.js';`

> Module-cycle note: `read-model.ts` imports `getSubscription` from `subscription-service.ts`, which imports `refreshAccountSummary` back. ESM handles this cycle because both are function declarations used at call time, not module-init time. If `tsc` or vitest complains, move `getSubscription`/`SubscriptionRow` into a new `src/rows.ts` and import from there in both — do NOT suppress the error.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd implementations/subscriptions && npx vitest run && npx tsc --noEmit`
Expected: all test files PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add implementations/subscriptions/src/read-model.ts implementations/subscriptions/src/subscription-service.ts \
  implementations/subscriptions/src/billing-service.ts implementations/subscriptions/src/dunning.ts \
  implementations/subscriptions/test/read-model.test.ts
git commit -m "feat(impl): denormalized account-summary read model refreshed from every mutating path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end journey test + package gates

**Files:**
- Test: `implementations/subscriptions/test/journey.test.ts`

**Interfaces:** consumes everything above; produces nothing new — this is the suite the conformance wedge (plan 2) evaluates over, so it must drive a rich, realistic state space.

- [ ] **Step 1: Write the journey test**

Sequencing wrinkle this test pins down (already handled by Task 5's settled-ahead guard): after
activation the current invoice is `acme-inv-1`, which is already `paid`, so `recordUsage` must be
REJECTED until the first rollover opens a draft — and that first rollover must skip billing.

```ts
// implementations/subscriptions/test/journey.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './support.js';
import {
  activate, cancelSubscription, changePlan, changeSeats, createSubscription, expireTrials,
  getSubscription, recordUsage, rolloverPeriod,
} from '../src/subscription-service.js';
import { finalizeInvoice, getInvoice, recordPayment, voidInvoice } from '../src/billing-service.js';
import { runDunning } from '../src/dunning.js';

const eventLog = (db: any) =>
  (db.prepare('SELECT event_type, aggregate_id FROM outbox ORDER BY id').all() as any[])
    .map(e => `${e.event_type}:${e.aggregate_id}`);

describe('full customer journey', () => {
  it('trial → activate → usage/rollover → failed charge → dunning exhaustion', () => {
    const db = makeDb();
    createSubscription(db, { id: 'acme', planCode: 'basic', seats: 3, periodStart: 0, periodEnd: 100, licenseFeeAmount: 3_000, maxRetries: 1 });
    finalizeInvoice(db, 'acme-inv-1');
    recordPayment(db, 'acme-inv-1', 1_000, 10);
    recordPayment(db, 'acme-inv-1', 2_000, 20);
    activate(db, 'acme');
    expect(() => recordUsage(db, 'acme', 5, 100)).toThrow(/draft/); // current invoice already paid
    rolloverPeriod(db, 'acme', { nextInvoiceId: 'acme-inv-2', licenseFeeAmount: 3_000, nextPeriodEnd: 200, now: 100, charge: () => true });
    recordUsage(db, 'acme', 5, 100);
    changeSeats(db, 'acme', 4, 500);
    rolloverPeriod(db, 'acme', { nextInvoiceId: 'acme-inv-3', licenseFeeAmount: 3_000, nextPeriodEnd: 300, now: 200, charge: () => false });
    expect(getSubscription(db, 'acme').lifecycle_state).toBe('past_due');
    expect(getInvoice(db, 'acme-inv-2').total_due).toBe(4_000); // 3000 fee + 500 usage + 500 proration
    expect(runDunning(db, 210, () => false)).toEqual({ attempted: 1, exhausted: 0 });
    expect(runDunning(db, 220, () => false)).toEqual({ attempted: 0, exhausted: 1 });
    const done = getSubscription(db, 'acme');
    expect(done.lifecycle_state).toBe('canceled');
    expect(getInvoice(db, 'acme-inv-2').settlement_state).toBe('uncollectible');
    expect(getInvoice(db, 'acme-inv-3').settlement_state).toBe('draft');
    // hand-verified against the spec machine: finalize(inv-1 draft→open), settle(inv-1 open→paid),
    // activate(trialing→active), finalize(inv-2 draft→open) at rollover 2; rollover 1 skipped
    // billing (inv-1 settled ahead); dunning failures, write-off, and past_due were silent;
    // exhaustion cancels via the legal cancel(past_due→canceled).
    expect(eventLog(db)).toEqual([
      'InvoiceFinalized:acme-inv-1', 'InvoicePaid:acme-inv-1', 'SubscriptionActivated:acme',
      'InvoiceFinalized:acme-inv-2', 'SubscriptionCanceled:acme',
    ]);
  });

  it('trial expiry and mid-trial cancel and plan supersession', () => {
    const db = makeDb();
    createSubscription(db, { id: 'a', planCode: 'basic', seats: 1, periodStart: 0, periodEnd: 50, licenseFeeAmount: 100 });
    createSubscription(db, { id: 'b', planCode: 'basic', seats: 1, periodStart: 0, periodEnd: 500, licenseFeeAmount: 100 });
    createSubscription(db, { id: 'c', planCode: 'basic', seats: 2, periodStart: 0, periodEnd: 500, licenseFeeAmount: 100 });
    expect(expireTrials(db, 60)).toBe(1);
    cancelSubscription(db, 'b');
    voidInvoice(db, 'c-inv-1');
    changePlan(db, 'c', { newId: 'c2', planCode: 'pro', licenseFeeAmount: 900, now: 60, periodEnd: 600 });
    expect(getSubscription(db, 'a').lifecycle_state).toBe('expired');
    expect(getSubscription(db, 'b').lifecycle_state).toBe('canceled');
    expect(getSubscription(db, 'c').superseded_by).toBe('c2');
    expect(getSubscription(db, 'c2').plan_code).toBe('pro');
  });
});
```

- [ ] **Step 2: Run to green**

Run: `cd implementations/subscriptions && npx vitest run`
Expected: all tests PASS. Any failure here means a real sequencing bug — fix the service, never weaken an assertion to pass.

- [ ] **Step 3: Full gates**

Run: `cd implementations/subscriptions && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests PASS.
Also confirm the engine is untouched: `cd ../../lattice && npx tsc --noEmit` — PASS with no changes (this plan never edits `lattice/`).

- [ ] **Step 4: Commit**

```bash
git add implementations/subscriptions/test/journey.test.ts
git commit -m "test(impl): end-to-end customer-journey suite with hand-verified outbox history

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review checklist (run after Task 7)

1. **Superset inventory vs design §3:** payments ledger ✓ (Task 3), dunning scheduler ✓ (4), rollover ✓ (5), proration ✓ (5), plan change ✓ (5), read model ✓ (6).
2. **Spec-covered conformance spot-check (the negative control depends on this):** grep the impl for every `lifecycle_state`/`settlement_state` write and confirm each corresponds to a legal spec transition with its from-states respected; confirm only the 4 event constants are ever passed to `appendEvent`; confirm `plan_code` is never UPDATEd.
3. **No lattice imports:** `grep -rn "lattice" implementations/subscriptions/src implementations/subscriptions/test` → only comments allowed, no imports.
4. **Derived-not-stored:** confirm no `amount_paid` or `retry_count` column snuck into the schema.
