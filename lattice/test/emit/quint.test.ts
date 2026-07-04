import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

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
  it('emits a cardinality candidate as a counting predicate (mixed-kind pairs, e.g. arith vs cardinality, must co-emit on one engine)', () => {
    const card: Candidate = { kind: 'cardinality', aggregate: 'Subscription', where: null, atMost: 99 };
    const p = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(true), hj: card, exclusions: [], maxSteps: 8 });
    expect(p.source).toContain('.filter(k => { val x = subscriptions.get(k) x.exists and (true) }).size() <= 99');
    expect(p.source).toContain('val q_inv = iff(Hi, Hj)');
  });
  it('gates comparisons that read through a ref on that record actually existing (a non-machine aggregate like Invoice starts exists:false and is only ever created nondeterministically — without this guard Apalache can "read" its pre-populated placeholder fields to fabricate a witness for a record that was never created)', () => {
    // Every cmp in graceCandidate's body reads invoice.status or invoice.dueDate through the
    // `invoice` ref, so each must be individually gated: `invoices.get(x.invoice).exists implies <cmp>`.
    expect(em.source).toContain('(invoices.get(x.invoice).exists) implies (invoices.get(x.invoice).status == "Unpaid")');
    expect(em.source).toContain('(invoices.get(x.invoice).exists) implies (now <= invoices.get(x.invoice).dueDate + x.grace)');
  });
});
