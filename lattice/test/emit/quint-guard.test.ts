import { describe, it, expect } from 'vitest';
import { astToQuintGuard } from '../../src/emit/quint-guard.js';
import { subscriptionsModel } from '../fixtures.js';

describe('astToQuintGuard', () => {
  it('stuck probe names q_not_stuck and negates the state predicate over the out-guards', () => {
    const em = astToQuintGuard(subscriptionsModel, { owner: 'Invoice', region: 'settlement', state: 'open' }, 'stuck');
    expect(em.invariantName).toBe('q_not_stuck');
    expect(em.source).toContain('val stuck =');
    expect(em.source).toContain('settlement_state == "open"');
    expect(em.source).toContain('val q_not_stuck = not stuck');
    // out-guard of `open` is settle's `amountPaid == totalDue`, negated inside `stuck`.
    expect(em.source).toMatch(/not\s*\(.*amountPaid.*==.*totalDue/);
    // reuses the base machine (abstract-evolution → evolve_ actions present) and real init.
    expect(em.source).toContain('action init =');
    expect(em.source).toContain('action evolve_Invoice_amountPaid');
  });
  it('reach probe names q_not_reach and asserts the bare state predicate', () => {
    const em = astToQuintGuard(subscriptionsModel, { owner: 'Subscription', region: 'status', state: 'active' }, 'reach');
    expect(em.invariantName).toBe('q_not_reach');
    expect(em.source).toContain('val reach =');
    expect(em.source).toContain('status_state == "active"');
    expect(em.source).toContain('val q_not_reach = not reach');
  });
});
