import { describe, it, expect } from 'vitest';
import { executeSequence } from './walk.js';
import { tinyCtx, tinyDrivers, buggyDrivers, strictDrivers, mkTinyDb } from './fixtures.js';
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
