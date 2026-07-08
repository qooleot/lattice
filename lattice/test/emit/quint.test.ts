import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate, invoicingModel, draftInvoiceUnique, graceCap } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { DomainModel } from '../../src/ast/domain.js';

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
  // Regression: extractSalient now captures machine-state as a salient dim (`<Region>.state =
  // <value>`) in the same format as enum-eq facts, so two statePredicate candidates differing
  // only by an inState guard aren't masked (see salient.ts's collectInStateRegions). Confirms the
  // quint rebuilder's existing enum-eq regex + splitPathStr ref-hop handling already round-trips
  // that dim correctly, with no changes needed to shapeToQuint itself.
  it('rebuilds a machine-state exclusion dim (`<Region>.state = <value>`) into a quint state comparison', () => {
    const p = astToQuint(traceBModel, { kind: 'probe-forbid', hi: graceCandidate(true), exclusions: [[
      { dim: 'Access.state = Active', value: true }
    ]], maxSteps: 8 });
    expect(p.source).toContain('val q_inv = Hi or shape0');
    expect(p.source).toContain('x.Access_state == "Active"');
  });

  // Regression (live session .lattice-session-subscriptions): quint-routed queries must constrain
  // witnesses to states that satisfy already-ADOPTED invariants, even alloy-routed kinds like
  // `unique` — otherwise the solver can present a composite-invalid witness (two Draft invoices
  // for one subscription) that forces the human into a corrupting verdict: a faithful `forbid`
  // prunes a live candidate whose subject matter is unrelated, `permit` contradicts the earlier
  // adoption. The adopted constraint is conjoined as `adoptedAll implies q_inv`, so a violation
  // (= a witness) must additionally satisfy every adopted invariant.
  it('conjoins adopted invariants — a violation must satisfy an adopted alloy-routed unique', () => {
    const p = astToQuint(invoicingModel, { kind: 'distinguish', hi: graceCap(72), hj: graceCap(24),
      exclusions: [], adopted: [draftInvoiceUnique], maxSteps: 8 });
    expect(p.source).toContain('val adopted0 = invoices.keys().forall(k1 => invoices.keys().forall(k2 =>');
    expect(p.source).toContain('invoices.get(k1).Lifecycle_state == "Draft"');
    expect(p.source).toContain('invoices.get(k1).subscription == invoices.get(k2).subscription');
    expect(p.source).toContain('val q_inv = (adopted0) implies (iff(Hi, Hj))');
  });
  it('adopted invariants also wrap probe queries; no adopted ⇒ q_inv unchanged', () => {
    const p = astToQuint(invoicingModel, { kind: 'probe-forbid', hi: graceCap(72),
      exclusions: [], adopted: [draftInvoiceUnique], maxSteps: 8 });
    expect(p.source).toContain('val q_inv = (adopted0) implies (Hi)');
    const bare = astToQuint(invoicingModel, { kind: 'probe-forbid', hi: graceCap(72), exclusions: [], maxSteps: 8 });
    expect(bare.source).toContain('val q_inv = Hi');
  });

  // Task 3: transition guards — a declared transition's `requires` predicate is conjoined into
  // the trans_ action alongside the from-state check (design §3.6).
  describe('guarded transitions', () => {
    const guardedModel: DomainModel = {
      context: 'Billing', ticksPerDay: 24, enums: [], entities: [],
      aggregates: [{
        kind: 'aggregate', name: 'Invoice',
        fields: [
          { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' } },
          { name: 'totalDue', type: { kind: 'prim', prim: 'Money' } }],
        machine: {
          regions: [{ name: 'settlement', initial: 'open', states: [{ name: 'open' }, { name: 'paid' }] }],
          transitions: [{
            name: 'settle', region: 'settlement', from: ['open'], to: 'paid',
            requires: { kind: 'cmp', op: 'ge',
              left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
              right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
          }],
        },
      }],
      events: [],
    };

    it('conjoins the guard predicate into the declared transition action', () => {
      const cap = (n: number): Candidate => ({
        kind: 'statePredicate', aggregate: 'Invoice',
        body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: n } },
      });
      const em = astToQuint(guardedModel, {
        kind: 'distinguish', hi: cap(72), hj: cap(24), exclusions: [], maxSteps: 8,
      });
      expect(em.source).toContain('action trans_Invoice_settle =');
      expect(em.source).toContain('invoices.get(id).amountPaid >= invoices.get(id).totalDue');
    });
  });
});
