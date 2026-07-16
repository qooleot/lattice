// Drive-only test fixtures. Reuses tinyModel/tinyDb from ../fixtures.js (do NOT touch that file
// — it's shared with the passive-mode tests) and adds the drive-specific plan + drivers: a
// GenPlan with a GUARDED transition (passive-mode's tinyModel has none) so the walk executor's
// pre-state oracle has something real to evaluate, plus three driver maps exercising all three
// oracle outcomes (conformant, weakened-guard, over-strict).
import Database from 'better-sqlite3';
import { tinyDb, tinyModel } from '../fixtures.js';
import type { GenInput } from '../../generate/types.js';
import type { GenPlan, PlanAggregate, PlanTransition } from '../../generate/plan.js';
import type { Predicate } from '../../ast/invariant.js';
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
