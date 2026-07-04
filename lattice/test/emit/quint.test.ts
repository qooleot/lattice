import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate } from '../fixtures.js';

describe('astToQuint', () => {
  const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(false), hj: graceCandidate(true), exclusions: [], maxSteps: 8 });

  it('emits vars, pools, init, step, and the agreement invariant', () => {
    expect(em.source).toContain('var now: int');
    expect(em.source).toContain('var subscriptions: str ->');
    expect(em.source).toContain('var invoices: str ->');
    expect(em.source).toContain('action step =');
    expect(em.source).toContain('val q_inv = iff(Hi, Hj)');
    expect(em.invariantName).toBe('q_inv');
    expect(em.varTypes).toEqual({ subscriptions: 'Subscription', invoices: 'Invoice' });
  });
  it('resolves cross-entity ref paths through map lookups', () => {
    expect(em.source).toContain('invoices.get(x.invoice).dueDate');
    expect(em.source).toContain('invoices.get(x.invoice).status');
  });
  it('emits a generic region mutator when no transitions are declared', () => {
    expect(em.source).toContain('set_Subscription_Access');
  });
  it('probe-forbid inverts the invariant with shape exclusions ORed in', () => {
    const p = astToQuint(traceBModel, { kind: 'probe-forbid', hi: graceCandidate(true), exclusions: [[
      { dim: 'now le invoice.dueDate + grace', value: false }, { dim: 'invoice.status = Unpaid', value: true }
    ]], maxSteps: 8 });
    expect(p.source).toContain('val q_inv = Hi or shape0');
    expect(p.source).toContain('val shape0 =');
  });
});
