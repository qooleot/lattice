// The impl's fork-3 driver map (design §3, adversarial-generation, Task 6): each entry wraps a
// real service call from src/{subscription-service,billing-service,dunning}.ts so drive mode's
// walk executor (lattice/src/conform/drive/walk.ts) exercises the ACTUAL business logic, not a
// mirror of it — rejection = the service functions throw, already the impl's convention.
//
// SIGNATURE DRIFT (fixed honestly, per Task 6 brief): the design's fork-3 sketch imports
// `defineDrivers`/`DriveGen`/`SubscriptionSpecState`/`InvoiceSpecState` from ./spec-state.ts and
// writes drivers as `(db, row: SubscriptionSpecState, gen: DriveGen) => void` with a rich
// `gen.int/gen.pick/gen.id`. That's not what the real executor calls: lattice's walk.ts
// (Task 4, landed) defines the ACTUAL contract as `(db, id: string, gen: DriveGenImpl) => void`
// with `DriveGenImpl = { seed, clock(), rand() }` — the bare row id, not a full spec-state row,
// and no int/pick/id helpers. This file targets that real contract: every entry that needs more
// than the id (periodEnd, latestInvoice, totalDue, amountPaid, ...) queries the live db directly
// (same as the design's own `recover` sketch already did), and `int`/`pick`/a fresh id are built
// locally from `rand()`/`clock()` below. implementations/subscriptions has no build dependency on
// lattice's TS project (see conform/crosschecks.ts's locally-defined `Finding`), so this file
// doesn't import lattice's `DriverModule`/`Fn` types either — it just satisfies that shape
// structurally, exactly like crosschecks.ts does for `CrosscheckModule`.
//
// `expireTrial` and `dunningExhausted` are induced via bulk JOBS (expireTrials/runDunning act on
// every eligible row, not just the targeted one) — each converts a no-effect-on-THIS-row call into
// a throw so the walk's oracle gets a real accept/reject signal, checked against the target row's
// own before/after state (a bulk return count > 0 can come from unrelated rows, so it's not a safe
// no-op signal on its own).
import type Database from 'better-sqlite3';
import {
  createSubscription, activate, cancelSubscription, expireTrials, recordUsage, changeSeats,
  changePlan, rolloverPeriod, getSubscription,
} from '../src/subscription-service.js';
import { finalizeInvoice, recordPayment, voidInvoice, writeOffInvoice } from '../src/billing-service.js';
import { recordPaymentFailure, runDunning } from '../src/dunning.js';

const DB = (db: unknown) => db as Database.Database;

/** Matches lattice's walk.ts `DriveGenImpl` exactly — NOT spec-state.ts's generated `DriveGen`
 *  (which carries int/pick/id; see file header). */
interface DriveGenImpl { seed: number; clock: () => number; rand: () => number }

const int = (gen: DriveGenImpl, min: number, max: number): number => min + Math.floor(gen.rand() * (max - min + 1));
const pick = <T,>(gen: DriveGenImpl, xs: T[]): T => xs[Math.floor(gen.rand() * xs.length)]!;
// clock() is fixed for the whole step (walk.ts's monotonic counter), so pairing it with a fresh
// rand() draw is enough for cross-step uniqueness — both are pure functions of the walk's own
// state, so replay from a seed stays exact.
const genId = (gen: DriveGenImpl): string => `d-gen-${gen.clock()}-${Math.floor(gen.rand() * 1e6)}`;

function paidAmount(db: Database.Database, invoiceId: string): number {
  return (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM invoice_payments WHERE invoice_id = ?')
    .get(invoiceId) as { s: number }).s;
}

type Fn = (db: unknown, id: string, gen: DriveGenImpl) => void;

const transitions: Record<string, Fn> = {
  activate: (db, id) => activate(DB(db), id),
  cancel: (db, id) => cancelSubscription(DB(db), id),

  // expireTrials is a bulk job: fire it just past THIS row's periodEnd, then check THIS row's own
  // state actually changed (a bulk return count > 0 can come from unrelated trialing rows whose
  // periodEnd is even earlier — a false accept signal a raw count check would miss).
  expireTrial: (db, id) => {
    const d = DB(db);
    const before = d.prepare('SELECT period_end, lifecycle_state FROM subscriptions WHERE id = ?')
      .get(id) as { period_end: number; lifecycle_state: string } | undefined;
    if (!before) throw new Error(`expireTrial: subscription '${id}' not found`);
    expireTrials(d, before.period_end + 1);
    const after = d.prepare('SELECT lifecycle_state FROM subscriptions WHERE id = ?')
      .get(id) as { lifecycle_state: string };
    if (after.lifecycle_state === before.lifecycle_state) throw new Error('expireTrial: no-op (not expired)');
  },

  // Induced via recordPaymentFailure's side effect on the subscription. The impl silently
  // no-ops the lifecycle flip unless the sub is 'active' (dunning.ts: `if (sub.lifecycle_state
  // === 'active')`), so a driver that only forwarded the call would report false accepts for
  // probes from trialing/past_due — the same silent-no-op class as expireTrial: check the target
  // row's own lifecycle actually moved, throw when it didn't.
  paymentFailed: (db, id, gen) => {
    const d = DB(db);
    const sub = d.prepare('SELECT current_invoice_id, lifecycle_state FROM subscriptions WHERE id = ?')
      .get(id) as { current_invoice_id: string | null; lifecycle_state: string } | undefined;
    if (!sub || !sub.current_invoice_id) throw new Error(`paymentFailed: subscription '${id}' has no current invoice`);
    recordPaymentFailure(d, sub.current_invoice_id, gen.clock());
    const after = (d.prepare('SELECT lifecycle_state FROM subscriptions WHERE id = ?')
      .get(id) as { lifecycle_state: string }).lifecycle_state;
    if (after === sub.lifecycle_state) throw new Error('paymentFailed: no-op (lifecycle unchanged)');
  },

  // Induced via settling the open invoice (billing-service.ts's settle() flips past_due ->
  // active as a side effect). Paying off an invoice of a NON-past_due sub succeeds in the impl
  // but is not a 'recover' — pre-check the target row so the oracle gets its reject signal
  // instead of a false accept (silent-no-op class, mirrors the dunningExhausted recipe).
  recover: (db, id, gen) => {
    const d = DB(db);
    if (getSubscription(d, id).lifecycle_state !== 'past_due') throw new Error('recover: not past_due');
    const inv = d.prepare(`SELECT id, total_due FROM invoices WHERE subscription_id = ? AND settlement_state = 'open'`)
      .get(id) as { id: string; total_due: number } | undefined;
    if (!inv) throw new Error('recover: no open invoice');
    const paid = paidAmount(d, inv.id);
    recordPayment(d, inv.id, inv.total_due - paid, gen.clock());
  },

  // Induced via dunning sweeps that always decline: keep sweeping (bounded) until this row leaves
  // past_due (exhausted -> canceled) or the bound is hit; a row that was never past_due to begin
  // with is the no-op signal the walk's oracle needs.
  dunningExhausted: (db, id, gen) => {
    const d = DB(db);
    for (let i = 0; i < 10; i++) {
      const s = getSubscription(d, id).lifecycle_state;
      if (s !== 'past_due') {
        if (i === 0) throw new Error('dunningExhausted: not past_due');
        return;
      }
      runDunning(d, gen.clock(), () => false);
    }
    // Bound hit with the row still past_due (e.g. its open invoice was voided out from under the
    // dunning sweep, which only targets open invoices): a bounded-out no-op, not an accept.
    throw new Error('dunningExhausted: still past_due after sweep bound (no-op)');
  },

  finalize: (db, id) => finalizeInvoice(DB(db), id),

  settle: (db, id, gen) => {
    const d = DB(db);
    const inv = d.prepare('SELECT total_due FROM invoices WHERE id = ?').get(id) as { total_due: number } | undefined;
    if (!inv) throw new Error(`settle: invoice '${id}' not found`);
    recordPayment(d, id, inv.total_due - paidAmount(d, id), gen.clock());
  },

  voidDraft: (db, id) => voidInvoice(DB(db), id),
  voidOpen: (db, id) => voidInvoice(DB(db), id),
  writeOff: (db, id) => writeOffInvoice(DB(db), id),
};

const superset: Record<string, Fn> = {
  recordUsage: (db, id, gen) => recordUsage(DB(db), id, int(gen, 1, 50), int(gen, 0, 200)),
  changeSeats: (db, id, gen) => changeSeats(DB(db), id, int(gen, 1, 20), int(gen, -500, 2000)),
  partialPayment: (db, id, gen) => recordPayment(DB(db), id, int(gen, 1, 100), gen.clock()),
  dunningSweep: (db, _id, gen) => { runDunning(DB(db), gen.clock(), () => int(gen, 0, 1) === 1); },
  rollover: (db, id, gen) => rolloverPeriod(DB(db), id, {
    nextInvoiceId: genId(gen), licenseFeeAmount: int(gen, 100, 9000), nextPeriodEnd: gen.clock() + 10_000,
    now: gen.clock(), charge: () => int(gen, 0, 1) === 1,
  }),
  changePlanOp: (db, id, gen) => changePlan(DB(db), id, {
    newId: genId(gen), planCode: pick(gen, ['basic', 'pro']), licenseFeeAmount: int(gen, 100, 9000),
    now: gen.clock(), periodEnd: gen.clock() + 20_000,
  }),
};

const create: Record<string, Fn> = {
  // Creates the first Invoice internally (createSubscription's own transaction) — real and
  // reachable: drive mode discovers rows live from the db, not from executor-side bookkeeping.
  Subscription: (db, id, gen) => createSubscription(DB(db), {
    id, planCode: pick(gen, ['basic', 'pro']), seats: int(gen, 1, 9),
    periodStart: gen.clock(), periodEnd: gen.clock() + 10_000,
    licenseFeeAmount: int(gen, 100, 9000), maxRetries: int(gen, 1, 3),
  }),
};

export const drivers = { transitions, superset, create };
