import { describe, it, expect } from 'vitest';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { subscriptionsModel, paidImpliesExactConjunct, someStatePredicateOnInvoice, activePaidInFullCandidate } from '../fixtures.js';

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

  // Regex-hardening (Plan 2b Task 1, Step 7): hypOf's `\bvar\b` global-replace substitutes each
  // owner's collection var (e.g. `subscriptions`, `invoices`) with its inline nondet-built map,
  // ONE owner at a time, mutating the SAME `expr` string across iterations (quint-classify.ts:55).
  // The footgun this guards against: an EARLIER substitution's inline text could itself contain a
  // LATER owner's bare var name as a whole word, so the later regex pass would corrupt the
  // already-substituted map instead of only touching the hypothesis's own reference to that owner.
  // `activePaidInFullCandidate` (Subscription, `where status in {active}`) ref-hops into
  // `latestInvoice.{amountPaid,totalDue}` (Invoice) — a genuine multi-owner hypothesis exercising
  // BOTH owners' substitutions in the same expression, paired here with the Invoice-only
  // `paidImpliesExactConjunct` as the second peer/invariant so both `subscriptions` and `invoices`
  // are live substitution targets simultaneously.
  it('multi-owner hypothesis: substitutes each owner var with its inline map without corrupting either', () => {
    const em = astToQuintClassify(subscriptionsModel,
      { invariant: activePaidInFullCandidate, peers: [paidImpliesExactConjunct], probe: 'consecution', maxSteps: 1 });
    const indInit = em.source.slice(em.source.indexOf('action indInit'), em.source.indexOf('val q_I ='));
    // Both owners' inline maps are present in the hypothesis (the ref-hop into Invoice from the
    // Subscription-rooted candidate, and the Invoice-only peer).
    expect(indInit).toMatch(/\(SUBSCRIPTION_IDS\.mapBy/);
    expect(indInit).toMatch(/\(INVOICE_IDS\.mapBy/);
    // No bare `subscriptions`/`invoices` token survives outside a `.mapBy` expr — the only bare
    // occurrences allowed are the primed var ASSIGNMENTS (`subscriptions' =`/`invoices' =`), which
    // bind the var rather than reading it, and are emitted before hypothesis substitution ever runs.
    const bareOccurrences = (name: string) =>
      [...indInit.matchAll(new RegExp(`\\b${name}\\b`, 'g'))]
        .map(m => indInit.slice(m.index!, m.index! + name.length + 2))
        .filter(ctx => !ctx.startsWith(`${name}'`));   // exclude the `subscriptions' =` / `invoices' =` binder
    expect(bareOccurrences('subscriptions')).toEqual([]);
    expect(bareOccurrences('invoices')).toEqual([]);
  });
});
