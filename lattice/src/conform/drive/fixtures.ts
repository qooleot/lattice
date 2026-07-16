// Drive-only test fixtures. Reuses tinyModel/tinyDb from ../fixtures.js (do NOT touch that file
// — it's shared with the passive-mode tests) and adds the drive-specific plan + drivers: a
// GenPlan with a GUARDED transition (passive-mode's tinyModel has none) so the walk executor's
// pre-state oracle has something real to evaluate, plus three driver maps exercising all three
// oracle outcomes (conformant, weakened-guard, over-strict).
import Database from 'better-sqlite3';
import { tinyDb, tinyModel } from '../fixtures.js';
import type { GenInput } from '../../generate/types.js';
import type { GenPlan, PlanAggregate, PlanInvariant, PlanTransition } from '../../generate/plan.js';
import type { Predicate } from '../../ast/invariant.js';
import type { AggregateDef, DomainModel } from '../../ast/domain.js';
import type { OverridesModule } from '../types.js';
import type { CheckContext } from '../report.js';
import type { DriveGenImpl, DriverModule } from './walk.js';

export const mkTinyDb = (): Database.Database => tinyDb();

// close requires balance == 0 — a guard tinyModel's own machine doesn't carry (passive mode has
// no pre-state oracle to exercise it), hand-built here per the brief.
const closeRequires: Predicate = {
  kind: 'cmp', op: 'eq',
  left: { kind: 'field', owner: 'self', path: ['balance'] },
  right: { kind: 'int', value: 0 },
};

const closeTransition: PlanTransition = {
  name: 'close', region: 'status', from: ['openState'], to: 'closedState',
  requires: closeRequires, emits: 'AccountClosed',
  anchors: { specElement: 'transition close', provenance: [], witnessIds: [] },
};

const accountAgg: PlanAggregate = {
  name: 'Account',
  fields: tinyModel.aggregates[0]!.fields,
  regions: tinyModel.aggregates[0]!.machine!.regions,
  transitions: [closeTransition],
  invariants: [],
};

/** Consumed by BOTH walk.test.ts (via tinyCtx) and campaign.test.ts (Task 5). */
export const tinyPlanForWalk: GenPlan = { context: 'Tiny', aggregates: [accountAgg], events: tinyModel.events };

// Sibling transition for the post-accept re-attribution amendment (design §2 Oracle, human
// ruling 2026-07-16): same region ('status'), same from-state (openState) and same to-state
// (closedState) as `close`, but NO requires and NO emits — the shape of a genuinely different
// spec transition that happens to share `close`'s driver entry point (voidInvoice ← voidDraft +
// voidOpen is the real-world case this amendment fixes). Kept in a SEPARATE plan
// (tinyPlanWithSibling) so tinyPlanForWalk — and every existing test built on the assumption
// that `close` is the ONLY transition on Account — stays untouched.
const discardTransition: PlanTransition = {
  name: 'discard', region: 'status', from: ['openState'], to: 'closedState',
  anchors: { specElement: 'transition discard', provenance: [], witnessIds: [] },
};

const accountAggWithSibling: PlanAggregate = {
  name: 'Account',
  fields: tinyModel.aggregates[0]!.fields,
  regions: tinyModel.aggregates[0]!.machine!.regions,
  transitions: [closeTransition, discardTransition],
  invariants: [],
};

/** Consumed ONLY by the new re-attribution tests in walk.test.ts — never by tinyPlanForWalk's
 *  consumers, so the buggy-target "probe close acceptance is a violation" tests keep their
 *  original semantics (no sibling to re-attribute to). */
export const tinyPlanWithSibling: GenPlan =
  { context: 'Tiny', aggregates: [accountAggWithSibling], events: tinyModel.events };

const overrides: OverridesModule = {
  Account: {
    balance: (db, row) => ((db as Database.Database)
      .prepare('SELECT COALESCE(SUM(amount),0) s FROM account_entries WHERE account_id = ?')
      .get(row.id) as { s: number }).s,
    status: (_db, row) => row.state as string,
  },
};

export function tinyCtx(): CheckContext {
  const input: GenInput = { model: tinyModel, adopted: [], ledger: [] };
  return { input, plan: tinyPlanForWalk, overrides, crosschecks: null, optOuts: [] };
}

// tinyDrivers.create seeds balance 0 for even seeds, balance 500 for odd seeds — deterministic
// from the intention's seed via gen.seed, no randomness needed for this fixture. On seed % 4 ===
// 0 it ALSO inserts a bonus second account (id suffix '-b', balance 0 — deliberately 0 so it
// never disturbs the balance-parity expectations existing tests rely on): this is the fixture's
// proof that rows created INSIDE a driver (not returned to nor tracked by the walk executor) are
// still real, live rows the executor's row-discovery must be able to reach.
const create: DriverModule['drivers']['create'] = {
  Account: (db, id, gen: DriveGenImpl) => {
    const d = db as Database.Database;
    d.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES (?, ?, 'openState')`).run(id, `Owner-${id}`);
    const balance = gen.seed % 2 === 0 ? 0 : 500;
    if (balance !== 0) d.prepare(`INSERT INTO account_entries (account_id, amount) VALUES (?, ?)`).run(id, balance);
    if (gen.seed % 4 === 0) {
      const bonusId = `${id}-b`;
      d.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES (?, ?, 'openState')`).run(bonusId, `Owner-${bonusId}`);
    }
  },
};

function closeOutbox(db: Database.Database, id: string, gen: DriveGenImpl): void {
  db.prepare(`UPDATE accounts SET state = 'closedState' WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO outbox (event_type, aggregate_id, payload, created_at) VALUES ('AccountClosed', ?, '{}', ?)`)
    .run(id, gen.clock());
}

/** CONFORMANT: close checks both halves of the transition itself — the from-state (mirrors the
 *  spec's `from: ['openState']`) and the guard (mirrors the spec's balance == 0 requirement) —
 *  and throws when either is violated. The from-state check matters for walk sequences that
 *  fixed hand-written cases (walk.test.ts) never exercise: a second 'close' picked against an
 *  already-closed row. Without it, this driver silently accepted a repeat close (idempotent
 *  UPDATE, no SQL constraint stops it) — a real spec-illegal-command-accepted violation that only
 *  a random seeded walk surfaces, exactly what campaign.ts's property-based coverage is for. */
export const tinyDrivers: DriverModule = {
  drivers: {
    create,
    transitions: {
      close: (db, id, gen) => {
        const d = db as Database.Database;
        const row = d.prepare('SELECT state FROM accounts WHERE id = ?').get(id) as { state: string } | undefined;
        if (!row || row.state !== 'openState') {
          throw new Error(`tinyDrivers.close: account '${id}' is not in openState (state=${row?.state ?? 'missing'})`);
        }
        const bal = (d.prepare('SELECT COALESCE(SUM(amount),0) s FROM account_entries WHERE account_id = ?')
          .get(id) as { s: number }).s;
        if (bal !== 0) throw new Error(`tinyDrivers.close: balance ${bal} !== 0 for account '${id}'`);
        closeOutbox(d, id, gen as DriveGenImpl);
      },
    },
  },
};

/** Weakened guard: close never checks balance — accepts illegal probes. */
export const buggyDrivers: DriverModule = {
  drivers: {
    create,
    transitions: { close: (db, id, gen) => closeOutbox(db as Database.Database, id, gen as DriveGenImpl) },
  },
};

/** Over-strict: close rejects every attempt, including spec-legal ones. */
export const strictDrivers: DriverModule = {
  drivers: {
    create,
    transitions: { close: (_db, id) => { throw new Error(`strictDrivers.close: unconditional reject for '${id}'`); } },
  },
};

/** Driver-skip signal fixture (human ruling 2026-07-16, walk.ts): `close` ALWAYS throws the
 *  `drive-skip:` signal, regardless of whether the pre-state made the intention spec-legal or
 *  spec-illegal. This is deliberate: it proves the walk only ever HONORS the skip signal from the
 *  legal branch — an intention that lands illegal (a probe) must still be counted as an ordinary
 *  rejected probe when its driver throws the identical message, never as a skip. A skip must
 *  never be able to mask a weakened-guard catch. */
export const skipDrivers: DriverModule = {
  drivers: {
    create,
    transitions: {
      close: () => {
        throw new Error('drive-skip: no open invoice — a payment cannot fail when nothing is owed (fixture)');
      },
    },
  },
};

// --- c09 regression fixture (human ruling 2026-07-16, per-step scoped invariant check) ---------
//
// Reproduces the c09 root-cause pattern (docs/superpowers/specs/
// 2026-07-15-lattice-drive-rediscovery-results.md §7) minimally: two new self-loop transitions on
// Account ('debit'/'credit', both openState -> openState, no requires — data mutations, not
// lifecycle moves) plus a `nonNegativeBalance` invariant. 'debit' (op A) drives the balance
// negative — a genuine Tier-1 violation the instant it lands. 'credit' (op B) is itself a plain
// spec-legal transition (no guard forbids it) that zeroes the balance back out. A sequence
// [create, debit, credit] with checkEvery set high enough that the in-loop cadence never fires
// means the ONLY full sweep is the unconditional end-of-sequence one — which runs AFTER credit
// has already erased the violation, so it sees clean state and reports nothing. This is exactly
// the c09 mechanism: "a violating state created by one command, legally erased by the next, before
// any checkpoint ran." The per-step scoped check (walk.ts's stepCheck) closes the gap by
// evaluating Account's own invariants immediately after 'debit' accepts, before 'credit' ever
// runs.

const debitTransition: PlanTransition = {
  name: 'debit', region: 'status', from: ['openState'], to: 'openState',
  anchors: { specElement: 'transition debit', provenance: [], witnessIds: [] },
};
const creditTransition: PlanTransition = {
  name: 'credit', region: 'status', from: ['openState'], to: 'openState',
  anchors: { specElement: 'transition credit', provenance: [], witnessIds: [] },
};

const nonNegativeBalance: PlanInvariant = {
  name: 'nonNegativeBalance', aggregate: 'Account',
  candidate: {
    kind: 'statePredicate', aggregate: 'Account',
    body: {
      kind: 'cmp', op: 'ge',
      left: { kind: 'field', owner: 'self', path: ['balance'] },
      right: { kind: 'int', value: 0 },
    },
  },
  anchors: { specElement: 'invariant nonNegativeBalance', provenance: [], witnessIds: [] },
};

const accountAggWithBalanceInvariant: PlanAggregate = {
  name: 'Account',
  fields: tinyModel.aggregates[0]!.fields,
  regions: tinyModel.aggregates[0]!.machine!.regions,
  transitions: [closeTransition, debitTransition, creditTransition],
  invariants: [nonNegativeBalance],
};

/** Consumed ONLY by the c09-regression test in walk.test.ts. Kept in its own plan (not folded
 *  into tinyPlanForWalk) so no existing test's invariant-free assumption changes. */
export const tinyPlanWithBalanceInvariant: GenPlan =
  { context: 'Tiny', aggregates: [accountAggWithBalanceInvariant], events: tinyModel.events };

/** op A: an unconditional data mutation (no guard, self-loop transition) that drives the account's
 *  balance negative — spec-legal (from openState, no requires) but data-violating. */
function debit(db: Database.Database, id: string, amount: number): void {
  db.prepare(`INSERT INTO account_entries (account_id, amount) VALUES (?, ?)`).run(id, -amount);
}

/** op B: the compensating, itself spec-legal mutation that zeroes the balance back out — this is
 *  the "legally erased by the next command" half of the c09 pattern. */
function credit(db: Database.Database, id: string, amount: number): void {
  db.prepare(`INSERT INTO account_entries (account_id, amount) VALUES (?, ?)`).run(id, amount);
}

export const c09PatternDrivers: DriverModule = {
  drivers: {
    create,
    transitions: {
      debit: (db, id) => debit(db as Database.Database, id, 100),
      credit: (db, id) => credit(db as Database.Database, id, 100),
    },
  },
};

export function c09Ctx(): CheckContext {
  const input: GenInput = { model: tinyModel, adopted: [], ledger: [] };
  return { input, plan: tinyPlanWithBalanceInvariant, overrides, crosschecks: null, optOuts: [] };
}

// --- Cross-aggregate regression fixture (human ruling 2026-07-16, per-step scope widening) ------
//
// Proves the SECOND c09-class gap (docs/superpowers/specs/2026-07-15-lattice-adversarial-
// generation-design.md fork-4 amendment, same date): the first per-step-check fix scoped itself to
// the intention's nominally touched aggregate, which is exactly wrong for a driver that mutates a
// DIFFERENT aggregate than the one its intention names (the real-world case: a Subscription-bound
// `changePlanOp` driver that also writes Invoice rows). This fixture reproduces that shape
// minimally with a second aggregate, 'Wallet', that has NO transitions of its own and is never
// itself the subject of any intention — it can only be touched as a side effect of an Account-bound
// driver, exactly like Invoice is touched as a side effect of a Subscription-bound driver in the
// real target.
//
// 'debit' and 'credit' are declared as ordinary self-loop Account transitions (openState ->
// openState, no requires — mirrors the original c09 fixture) but their DRIVERS never touch the
// accounts table at all: they mutate the account's paired wallet row directly. 'debit' (op A) drives
// that wallet's balance negative — a live `nonNegativeWalletBalance` violation on WALLET, not
// Account, the instant it lands, even though the executing intention names Account. 'credit' (op B)
// is itself spec-legal and zeroes the wallet balance back out before the sequence ends. Account
// itself declares NO invariants in this plan, so a touched-aggregate-scoped check (the pre-fix
// behavior) would find nothing to evaluate at all — not "the right aggregate but wrong timing," but
// literally the wrong aggregate. Only a check that widens to every bound aggregate can see the
// Wallet-side violation.

const walletAggDef: AggregateDef = {
  kind: 'aggregate',
  name: 'Wallet',
  fields: [
    { name: 'walletId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'balance', type: { kind: 'prim', prim: 'Money' } },
  ],
};

/** Account (unchanged fields/machine from tinyModel) + Wallet (new, no machine — Wallet is never
 *  itself a transition subject, only a side-mutated row). */
export const crossAggModel: DomainModel = {
  ...tinyModel,
  aggregates: [...tinyModel.aggregates, walletAggDef],
};

/** tinyDb()'s schema (accounts/account_entries/outbox) plus one new table for the second
 *  aggregate. Does NOT touch ../fixtures.ts — tinyDb() is reused as the base, extended here. */
export function crossAggDb(): Database.Database {
  const db = tinyDb();
  db.exec(`CREATE TABLE wallets (id TEXT PRIMARY KEY, balance INTEGER NOT NULL);`);
  return db;
}

// Account declares NO invariants here — deliberately, so a touched-aggregate-scoped check has
// nothing to find even if it ran correctly. The only invariant in this plan lives on Wallet.
const accountAggCrossAgg: PlanAggregate = {
  name: 'Account',
  fields: tinyModel.aggregates[0]!.fields,
  regions: tinyModel.aggregates[0]!.machine!.regions,
  transitions: [debitTransition, creditTransition],
  invariants: [],
};

const nonNegativeWalletBalance: PlanInvariant = {
  name: 'nonNegativeWalletBalance', aggregate: 'Wallet',
  candidate: {
    kind: 'statePredicate', aggregate: 'Wallet',
    body: {
      kind: 'cmp', op: 'ge',
      left: { kind: 'field', owner: 'self', path: ['balance'] },
      right: { kind: 'int', value: 0 },
    },
  },
  anchors: { specElement: 'invariant nonNegativeWalletBalance', provenance: [], witnessIds: [] },
};

const walletAgg: PlanAggregate = {
  name: 'Wallet', fields: walletAggDef.fields, regions: [], transitions: [],
  invariants: [nonNegativeWalletBalance],
};

export const crossAggPlan: GenPlan =
  { context: 'Tiny', aggregates: [accountAggCrossAgg, walletAgg], events: tinyModel.events };

export function crossAggCtx(): CheckContext {
  const input: GenInput = { model: crossAggModel, adopted: [], ledger: [] };
  return { input, plan: crossAggPlan, overrides, crosschecks: null, optOuts: [] };
}

// Create: seeds the account row AND its paired wallet (balance 0), keyed off the SAME id
// (`${id}-wallet`) so the transition drivers below can find it without any liveIds/rowPick
// machinery for Wallet — Wallet is never a chosen intention target in this fixture, only ever
// reached as a side effect, exactly like Invoice rows implicitly created/touched by a
// Subscription-bound driver in the real target.
const crossAggCreate: DriverModule['drivers']['create'] = {
  Account: (db, id) => {
    const d = db as Database.Database;
    d.prepare(`INSERT INTO accounts (id, owner_name, state) VALUES (?, ?, 'openState')`).run(id, `Owner-${id}`);
    d.prepare(`INSERT INTO wallets (id, balance) VALUES (?, 0)`).run(`${id}-wallet`);
  },
};

/** op A: intention names Account, but the driver never writes the accounts table at all — it
 *  drives the paired WALLET row negative. This is the shape that defeats a touched-aggregate
 *  filter: the aggregate that transiently violates its invariant is not the aggregate the
 *  intention (or the driver's own name) points at. */
function crossDebit(db: Database.Database, accountId: string, amount: number): void {
  db.prepare(`UPDATE wallets SET balance = balance - ? WHERE id = ?`).run(amount, `${accountId}-wallet`);
}

/** op B: itself spec-legal (Account, openState -> openState, no requires) and zeroes the paired
 *  wallet's balance back out — the "legally erased by the very next command" half of the pattern. */
function crossCredit(db: Database.Database, accountId: string, amount: number): void {
  db.prepare(`UPDATE wallets SET balance = balance + ? WHERE id = ?`).run(amount, `${accountId}-wallet`);
}

export const crossAggPatternDrivers: DriverModule = {
  drivers: {
    create: crossAggCreate,
    transitions: {
      debit: (db, id) => crossDebit(db as Database.Database, id, 100),
      credit: (db, id) => crossCredit(db as Database.Database, id, 100),
    },
  },
};
