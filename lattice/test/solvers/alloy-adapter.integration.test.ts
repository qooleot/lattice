import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runAlloy } from '../../src/solvers/alloy-adapter.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { ALLOY_JAR } from '../../src/solvers/doctor.js';
import { traceAModel } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const h1: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] };
const h2: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

describe.skipIf(!existsSync(ALLOY_JAR))('alloy adapter (integration)', () => {
  it('finds a distinguishing witness for per-customer vs per-plan', async () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 3);
    expect(r.sat).toBe(true);
    const w = r.instances[0]!;
    const subs = w.entities.filter(e => e.type === 'Subscription' && e.fields['Access.state'] === 'Active');
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(r.ms).toBeLessThan(45_000);
  }, 120_000);

  it('returns UNSAT for a candidate against itself (merge signal)', async () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h1, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat).toBe(false);
  }, 120_000);
});
