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
// COMPILE TRIPWIRE (F2 fix, D1 final review): the design also claimed this hand-written map stays
// "typed against the generated contract → compile-breaks on spec regen" (design §2, fork 3). A
// literal `defineDrivers({ transitions, superset, create })` wrap can't do that honestly: EVERY
// entry in the generated `SpecDrivers` (transitions/superset/create alike) types `gen` as the rich
// `DriveGen` (`int`/`pick`/`id`/`clock`), never the real `DriveGenImpl` (`seed`/`clock`/`rand`)
// this file and walk.ts actually agree on — the two `gen` shapes share only `clock()` and are
// assignable in neither direction, so wrapping the whole map would mean casting every driver body
// to lie about its own parameter type, exactly the "forcing casts everywhere" the review asked to
// avoid instead of a real tripwire. What IS real and worth keeping: `transitions`' KEY SET must
// match `SpecDrivers.transitions` — that's the part a spec regen (a transition renamed/removed)
// actually changes, and `Record<keyof SpecDrivers['transitions'], Fn>` below checks exactly that,
// with `Fn` staying the real, working signature (no cast). Same move for `create` (its `row` param
// in the generated contract is ALREADY `id: string` — only `gen` differs — but `Partial<...>`
// since not every aggregate needs a create driver here; see `create`'s own comment). `superset`
// gets neither: `SpecDrivers.superset` is an open `Record<string, ...>` with no named keys to pin
// (superset ops are impl-specific extras beyond the spec's named transitions, deliberately
// ungenerated — design §3 fork 3), so there is nothing honest to check there; left as plain `Fn`,
// residual gap reported here rather than hidden behind a cast to a type that checks nothing.
import type Database from 'better-sqlite3';
import {
  createSubscription, activate, cancelSubscription, expireTrials, recordUsage, changeSeats,
  changePlan, rolloverPeriod, getSubscription,
} from '../src/subscription-service.js';
import { finalizeInvoice, recordPayment, voidInvoice, writeOffInvoice } from '../src/billing-service.js';
import { recordPaymentFailure, runDunning } from '../src/dunning.js';
import type { SpecDrivers } from './spec-state.js';

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

// Key-set tripwire (see file header): every name `SpecDrivers.transitions` requires must be
// present here, and no stale name may linger — rename or remove a spec transition and this line
// fails `tsc`, not just walk.ts's runtime "no transition driver for '<name>'" throw.
const transitions: Record<keyof SpecDrivers['transitions'], Fn> = {
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
  //
  // drive-skip (pre-registered impl-strictness finding, campaign #2; d2-coverage-investigation.md
  // §4a): the spec declares `paymentFailed` unconditionally legal from `active` — no `requires`
  // clause, single-aggregate machine. But `recordPaymentFailure` (../src/dunning.ts) throws unless
  // the subscription's CURRENT invoice is still `open` (`settlement_state !== 'open'`), an implicit
  // cross-aggregate precondition the spec's Subscription-only state machine can't express and the
  // walk's oracle can't see (it only scoped-observes the targeted aggregate). Reaching `active` at
  // all already requires `paid_invoice_count >= 1` — i.e. the current invoice was already settled
  // to `paid` — and nothing in this impl auto-rolls the subscription onto a fresh invoice on
  // activation, so a legally-generated `paymentFailed` on an `active` row can genuinely have
  // nothing open to fail. That is an impl-strictness fact, not a spec violation: `drive-skip:`
  // reports it as audited-and-explained rather than surfacing the driver's throw as a false
  // "impl rejected a spec-legal command" violation.
  paymentFailed: (db, id, gen) => {
    const d = DB(db);
    const sub = d.prepare('SELECT current_invoice_id, lifecycle_state FROM subscriptions WHERE id = ?')
      .get(id) as { current_invoice_id: string | null; lifecycle_state: string } | undefined;
    if (!sub) throw new Error(`paymentFailed: subscription '${id}' not found`);
    const openInvoice = sub.current_invoice_id
      ? d.prepare(`SELECT id FROM invoices WHERE id = ? AND settlement_state = 'open'`).get(sub.current_invoice_id)
      : undefined;
    if (!openInvoice) {
      throw new Error('drive-skip: no open invoice — a payment cannot fail when nothing is owed ' +
        '(pre-registered impl-strictness finding, campaign #2)');
    }
    recordPaymentFailure(d, sub.current_invoice_id!, gen.clock());
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

// No tripwire possible here (residual mismatch, reported honestly — see file header):
// `SpecDrivers.superset` is an open `Record<string, ...>` with no fixed key set to check against,
// so there's nothing for `keyof` to pin. Plain local `Fn` map.
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

// Same key-set tripwire as `transitions` (see file header): `SpecDrivers.create`'s `row` param is
// ALREADY `id: string` for both aggregates (only `gen` differs, same mismatch as everywhere else),
// but `Partial<...>` because its members are optional — not every aggregate needs a create driver
// (Invoice rows are created internally by `createSubscription`'s own transaction, not by a direct
// driver entry point).
const create: Partial<Record<keyof SpecDrivers['create'], Fn>> = {
  // Creates the first Invoice internally (createSubscription's own transaction) — real and
  // reachable: drive mode discovers rows live from the db, not from executor-side bookkeeping.
  Subscription: (db, id, gen) => createSubscription(DB(db), {
    id, planCode: pick(gen, ['basic', 'pro']), seats: int(gen, 1, 9),
    periodStart: gen.clock(), periodEnd: gen.clock() + 10_000,
    licenseFeeAmount: int(gen, 100, 9000), maxRetries: int(gen, 1, 3),
  }),
};

export const drivers = { transitions, superset, create };

// Superset aggregate/name binding (measured, d2-coverage-investigation.md §2 F3): each of these
// six superset ops is hard-wired (traced from source above, not guessed) to operate on exactly
// one aggregate's row id — `recordUsage`/`changeSeats`/`rollover`/`changePlanOp` all read/write a
// `subscriptions` row by `id`; `partialPayment` (`recordPayment`) reads/writes an `invoices` row by
// `id`; `dunningSweep` ignores its `id` argument entirely (a global sweep) but is bound to
// Subscription here since that's the aggregate its effects land on. Declaring this lets
// lattice's `intentionArb` pair `name` with the RIGHT aggregate instead of drawing them
// independently and uniformly (previously ~33-59%, pooled ~50%, of superset attempts were wasted
// on a mismatched aggregate whose row id gets fed into the wrong table's lookup and immediately
// rejected).
export const supersetAggregates: Record<string, string> = {
  recordUsage: 'Subscription',
  changeSeats: 'Subscription',
  rollover: 'Subscription',
  changePlanOp: 'Subscription',
  partialPayment: 'Invoice',
  dunningSweep: 'Subscription',
};
