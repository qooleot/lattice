import { describe, it, expect } from 'vitest';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { subscriptionsModel, paidImpliesExactConjunct, someStatePredicateOnInvoice } from '../fixtures.js';

// Emission-shape tests (mirroring test/emit/quint.test.ts's `.toContain` style). The brief's
// illustrative snippet paired `someStatePredicateOnInvoice` (reads `totalDue`) with `invoicingModel`
// (whose Invoice has neither `totalDue` nor a `settlement` region) — an incoherent combination. The
// coherent subject of this task is the committed Subscriptions Invoice (region `settlement`, fields
// totalDue/amountPaid), so these tests use `subscriptionsModel` + `paidImpliesExactConjunct`, which
// makes the region-havoc assertion (`settlement_state: nd_...`) meaningful.
describe('astToQuintClassify', () => {
  it('consecution: emits indInit havocing region state and asserting the hypothesis, checks q_I over one step', () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [someStatePredicateOnInvoice], probe: 'consecution', maxSteps: 1 });
    expect(em.source).toContain('action indInit');
    expect(em.source).toMatch(/settlement_state: nd_/);   // region state havoced, not fixed "draft"
    expect(em.source).toContain('val q_I =');
    expect(em.invariantName).toBe('q_I');
    expect(em.source).toContain('action step =');          // step reused verbatim
    // the drawn machine is still emitted (init + transitions), so the probe can take a step
    expect(em.source).toContain('action init =');
    expect(em.source).toContain('trans_Invoice_settle');
  });

  it('consecution: asserts (peersAnd and I) at indInit — the peer predicate is present in indInit', () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [someStatePredicateOnInvoice], probe: 'consecution', maxSteps: 1 });
    // hypothesis is asserted on the DRAWN record (an inline mapBy over the nondets), never by
    // reading the primed var — so `invoices'` must not appear inside indInit.
    const indInit = em.source.slice(em.source.indexOf('action indInit'), em.source.indexOf('val q_I ='));
    expect(indInit).toContain('.mapBy(id =>');
    expect(indInit).toContain("invoices' =");        // the primed var IS bound (assigned), as required
    expect(indInit).not.toContain("invoices'.");     // but never READ via a method chain (Quint forbids this in init)
    // both the invariant and the peer are asserted in the hypothesis
    expect(indInit).toContain('settlement_state == "paid"');   // the paid-conjunct (I)
    expect(indInit).toContain('totalDue >= 0');                // the peer (someStatePredicateOnInvoice)
    // named vals for the peer set
    expect(em.source).toContain('val peer0 =');
    expect(em.source).toContain('val peersAnd = (peer0)');
    expect(em.source).toContain('val q_peersImpliesI = (peersAnd implies q_I)');
  });

  it('entailment: checks q_peersImpliesI and asserts only peers at indInit', () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [someStatePredicateOnInvoice], probe: 'entailment', maxSteps: 0 });
    expect(em.source).toContain('val q_peersImpliesI =');
    expect(em.invariantName).toBe('q_peersImpliesI');
    // entailment asserts ONLY the peers at indInit (not I) — the paid-conjunct body must be absent
    // from indInit, while still present as the named `val q_I` used by q_peersImpliesI.
    const indInit = em.source.slice(em.source.indexOf('action indInit'), em.source.indexOf('val q_I ='));
    expect(indInit).not.toContain('settlement_state == "paid"');
    expect(indInit).toContain('totalDue >= 0');
    expect(em.source).toContain('val q_I =');
  });

  it('no peers ⇒ peersAnd is true; consecution hypothesis is just I', () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [], probe: 'consecution', maxSteps: 1 });
    expect(em.source).toContain('val peersAnd = true');
    expect(em.source).toContain('val q_peersImpliesI = (peersAnd implies q_I)');
  });

  it('emits varTypes for every owner (witness parsing needs them)', () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [], probe: 'consecution', maxSteps: 1 });
    expect(Object.keys(em.varTypes).length).toBeGreaterThan(0);
    expect(em.varTypes).toMatchObject({ subscriptions: 'Subscription', invoices: 'Invoice' });
  });
});
