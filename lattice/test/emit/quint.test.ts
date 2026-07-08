import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { traceBModel, graceCandidate, invoicingModel, draftInvoiceUnique, graceCap, invoiceLinesModel, someStatePredicateOnInvoice, sumCandidate, periodModel } from '../fixtures.js';
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
      context: 'Billing', ticksPerDay: 24, enums: [], values: [], entities: [],
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
      events: [], services: [],
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

  // Task 6: owned collections (design §6.1) — bounded map `f: int -> {childFields}` plus an
  // `fCount: int` sibling inside the owner record, with per-index nondet draws at init.
  it('encodes owned collections as bounded maps with a count', () => {
    const em = astToQuint(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], maxSteps: 3 });
    expect(em.source).toContain('lines: int -> { amount: int }');
    expect(em.source).toContain('linesCount: int');
    // per-index init draws, bounded by OWNED_BOUND
    expect(em.source).toContain('nondet nd_invoice_lines_0_amount');
    expect(em.source).toContain('nondet nd_invoice_linesCount = oneOf(0.to(3))');
    expect(em.varTypes['invoices#lines']).toBe('InvoiceLine');
  });

  // Task 9: sum-over-collection (design §6.2) — adopted sums compile to a bounded fold over the
  // owned-collection bounded map, conjoined the same way any other adopted constraint is.
  it('compiles adopted sums to a bounded fold', () => {
    const em = astToQuint(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice,
      exclusions: [], adopted: [sumCandidate], maxSteps: 2 });
    expect(em.source).toContain('range(0, 3).foldl(0, (acc, i) => if (i < x.linesCount) acc + x.lines.get(i).amount else acc)');
  });

  // Task 9: shapeToQuint rebuilds a sum witness's salient dims (count/sum/total — see salient.ts's
  // extractSalient sumOverCollection branch) as quint conjuncts, so a prior sum verdict's witness
  // shape can be excluded from later probes on the same aggregate.
  it('rebuilds sum salient dims (count/sum/total) into quint exclusion conjuncts', () => {
    const p = astToQuint(invoiceLinesModel, { kind: 'probe-forbid', hi: sumCandidate, exclusions: [[
      { dim: 'lines.count', value: 2 }, { dim: 'sum(lines.amount)', value: 7 }, { dim: 'totalDue value', value: 7 },
    ]], maxSteps: 2 });
    expect(p.source).toContain('x.linesCount == 2');
    expect(p.source).toContain('range(0, 3).foldl(0, (acc, i) => if (i < x.linesCount) acc + x.lines.get(i).amount else acc) == 7');
    expect(p.source).toContain('x.totalDue == 7');
  });

  // Task 11: value objects (design §3.5) get real quint encoding — a value-typed field becomes an
  // inline nested record (no map indirection: values are keyless/flat, embedded by value).
  describe('value fields — nested record encoding', () => {
    const periodCand: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt',
        left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };
    const em = astToQuint(periodModel, { kind: 'probe-permit', hi: periodCand, exclusions: [], maxSteps: 2 });

    it('emits the value field as an inline nested record type', () => {
      expect(em.source).toContain('period: { start: int, end: int }');
    });
    it('renders a value-hop path as a plain dotted accessor (no map-get)', () => {
      expect(em.source).toContain('x.period.start');
      expect(em.source).toContain('x.period.end');
    });
    it('initializes each value sub-field with its own nondet draw', () => {
      expect(em.source).toMatch(/nondet nd_subscription_period_start = oneOf/);
      expect(em.source).toMatch(/nondet nd_subscription_period_end = oneOf/);
      expect(em.source).toContain('period: { start: nd_subscription_period_start, end: nd_subscription_period_end }');
    });
  });

  // Defense-in-depth below validateCandidate (which REJECTS any param-bearing candidate as
  // ill-typed — see test/ast/validate-services.test.ts): a param term must never reach quint
  // emission either. termToQuint's (and refHopsInTerm's) 'param' case throws rather than silently
  // emitting nonsense quint source referencing a method parameter that doesn't exist as state.
  it('astToQuint throws on a param-bearing candidate — param terms never reach the emitter (validateCandidate rejects them upstream; this is the routing backstop)', () => {
    const paramLeak: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['grace'] }, right: { kind: 'param', name: 'delta' } } };
    expect(() => astToQuint(traceBModel, { kind: 'probe-forbid', hi: paramLeak, exclusions: [], maxSteps: 8 })).toThrow(/param terms/);
  });
});
