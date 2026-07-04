import { describe, it, expect } from 'vitest';
import { runQuint } from '../../src/solvers/quint-adapter.js';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate } from '../fixtures.js';

describe('quint adapter (integration)', () => {
  it('finds a disagreement witness between grace-0 and grace-window rules', async () => {
    const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(false), hj: graceCandidate(true), exclusions: [], maxSteps: 8 });
    const r = await runQuint(em, 8);
    expect(r.violated).toBe(true);
    const w = r.witness!;
    expect(w.now).toBeTypeOf('number');
    const sub = w.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields['Access.state']).toBeDefined();
    expect(r.ms).toBeLessThan(45_000);
  }, 180_000);

  it('reports no violation for a candidate against itself (merge signal)', async () => {
    const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(true), hj: graceCandidate(true), exclusions: [], maxSteps: 5 });
    const r = await runQuint(em, 5);
    expect(r.violated).toBe(false);
  }, 180_000);
});
