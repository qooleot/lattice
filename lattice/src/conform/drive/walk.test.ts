import { describe, it, expect } from 'vitest';
import { executeSequence } from './walk.js';
import type { DriverModule } from './walk.js';
import { tinyCtx, tinyDrivers, buggyDrivers, strictDrivers, mkTinyDb, tinyPlanWithSibling } from './fixtures.js';
import { tinyModel } from '../fixtures.js';
import type { Intention } from './intent.js';
import type { GenPlan, PlanAggregate, PlanTransition } from '../../generate/plan.js';

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

  it('a final accepted step landing exactly on the checkEvery boundary does not duplicate the live violation', () => {
    // Driver creates the row already in closedState with no AccountClosed event ever emitted —
    // a live tier-2 "no legal path" violation that persists in the db for every subsequent
    // checkDb call (nothing in this sequence ever fixes it). checkEvery: 1 means the single
    // create step's acceptance (stats.accepted === 1) lands exactly on the in-loop checkpoint
    // boundary, so the buggy unconditional end-of-sequence sweep would re-run checkDb against
    // identical state and duplicate the finding.
    const dupCheckDrivers: DriverModule = {
      drivers: {
        create: {
          Account: (db, id) => {
            (db as any).prepare(
              `INSERT INTO accounts (id, owner_name, state) VALUES (?, ?, 'closedState')`,
            ).run(id, `Owner-${id}`);
          },
        },
        transitions: {},
      },
    };
    const r = executeSequence(mkTinyDb, dupCheckDrivers, tinyCtx(), seq(create(2)), { checkEvery: 1, clockStep: 60 });
    const noLegalPath = r.violations.filter(v => v.detail.includes('no legal path'));
    expect(noLegalPath).toHaveLength(1);
  });

  it('throws loudly when the observed row is missing the transition\'s region-state key', () => {
    // Hand-built plan whose transition names a region ('bogusRegion') that doesn't match any
    // key the observer projects for Account — must fail loud, not silently coerce to undefined.
    const badTransition: PlanTransition = {
      name: 'close', region: 'bogusRegion', from: ['openState'], to: 'closedState', emits: 'AccountClosed',
      anchors: { specElement: 'transition close', provenance: [], witnessIds: [] },
    };
    const badAgg: PlanAggregate = {
      name: 'Account',
      fields: tinyModel.aggregates[0]!.fields,
      regions: tinyModel.aggregates[0]!.machine!.regions,
      transitions: [badTransition],
      invariants: [],
    };
    const badPlan: GenPlan = { context: 'Tiny', aggregates: [badAgg], events: tinyModel.events };
    const ctx = { ...tinyCtx(), plan: badPlan };
    expect(() => executeSequence(mkTinyDb, tinyDrivers, ctx, seq(create(2), close(0)), OPTS))
      .toThrow(/missing region-state key 'bogusRegion\.state'.*Account#d-account-1/s);
  });

  it('post-accept re-attribution: probe close accepted, but a legal sibling (discard) explains the ' +
    'pre→post step — not a violation', () => {
    // seed=1 → balance 500 (odd), so 'close' (requires balance==0) is illegal from openState:
    // buggyDrivers accepts it unconditionally, moving the row openState -> closedState. With
    // tinyPlanWithSibling, 'discard' (same region, from openState, no requires, to closedState)
    // explains that exact pre->post step, so the acceptance re-attributes instead of violating.
    const ctx = { ...tinyCtx(), plan: tinyPlanWithSibling };
    const r = executeSequence(mkTinyDb, buggyDrivers, ctx, seq(create(1), probeClose(0)), OPTS);
    expect(r.violations).toEqual([]);
    expect(r.stats.reattributions).toBe(1);
    expect(r.narrative.some(line => line.includes('re-attributed to discard'))).toBe(true);
  });

  it('post-accept re-attribution: with no sibling transition declared, the same accepted probe ' +
    'is still caught as a violation (c04-class weakened-guard catch survives)', () => {
    // Identical sequence, but tinyCtx()'s plan (tinyPlanForWalk) declares ONLY 'close' — no
    // sibling can explain the openState -> closedState step, so re-attribution finds nothing and
    // the acceptance is reported exactly as before this amendment.
    const r = executeSequence(mkTinyDb, buggyDrivers, tinyCtx(), seq(create(1), probeClose(0)), OPTS);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/accepted a spec-illegal command/);
    expect(r.stats.reattributions).toBe(0);
  });

  it('rowPick resolves against a live read, reaching a row created inside the driver (not tracked by any mirror)', () => {
    // seed=4: 4 % 4 === 0 triggers tinyDrivers.create's bonus second account (id 'd-account-1-b',
    // balance 0). Before the knownIds mirror was removed, that row was never recorded anywhere
    // the executor could see, so rowPick=1 would always fall back to the only tracked id
    // ('d-account-1'). With live reads, ORDER BY id puts the bonus row second, so rowPick=1
    // resolves to it — provable from the narrative line naming the exact row.
    const r = executeSequence(mkTinyDb, tinyDrivers, tinyCtx(), seq(create(4), close(1)), OPTS);
    expect(r.violations).toEqual([]);
    expect(r.narrative.some(line => line.includes('Account#d-account-1-b'))).toBe(true);
  });
});
