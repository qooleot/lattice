import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';
import { impliedInvariants } from '../../src/engine/implied.js';
import { expressibleAdopted } from '../../src/engine/planner.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';

// The QUINT-PATH half of the optional-ref claim. Its sibling quint-optional.test.ts asserts on the
// engine's derivation (impliedInvariants drops the optional ref from refsResolve) and on emitted
// strings; neither answers whether the emitted MODEL admits the instance. That question has to be
// asked on quint specifically: refsResolve is a no-op in Alloy (`pred name { }` — refs are total in
// Alloy sigs by construction), so an Alloy run proves nothing either way.
describe('quint — optional fields (integration, real quint)', () => {
  const payment: DomainModel = {
    context: 'BillPayments', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'PaymentMethod', fields: [{ name: 'pmId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'paymentMethod', type: { kind: 'ref', target: 'PaymentMethod' }, optional: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'intent', initial: 'requiresPaymentMethod', states: [
        { name: 'requiresPaymentMethod' }, { name: 'succeeded', tags: ['terminal'] }] }],
        transitions: [{ name: 'succeed', region: 'intent', from: ['requiresPaymentMethod'], to: 'succeeded' }] } }],
    events: [], services: []
  };

  // The claim, stated as a query Apalache can refute: `requiresPaymentMethod ⇒ present(paymentMethod)`
  // must NOT hold of the emitted model. A counterexample IS the legal method-less Payment.
  const requiresMethodImpliesPresent: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'implies',
      left: { kind: 'inState', owner: 'self', region: 'intent', states: ['requiresPaymentMethod'] },
      right: { kind: 'present', path: ['paymentMethod'] } } };

  it('a method-less Payment in requiresPaymentMethod is a REACHABLE, spec-legal state', async () => {
    // The model's own implied invariants ride along as `adopted`, so q_inv is `adopted0 implies Hi`
    // and any witness satisfies the implied spec — the witness is a LEGAL instance, not merely a
    // state some solver could name.
    const adopted = expressibleAdopted('quint', impliedInvariants(payment).map(i => i.candidate));
    const em = astToQuint(payment, { kind: 'probe-forbid', hi: requiresMethodImpliesPresent, exclusions: [], maxSteps: 0, adopted });
    // Anchors: without these the run below could pass for reasons unrelated to the claim (an empty
    // adopted set makes "legal" vacuous; a dropped flag makes present() name a field that is not there).
    expect(em.source).toContain('val adopted0');
    expect(em.source).toContain('paymentMethodPresent: bool');

    const r = await runQuintVerify(em, { invariant: em.invariantName, maxSteps: 0 });
    expect(r.violated).toBe(true);
    const p = r.witness!.entities.find(e => e.type === 'Payment');
    expect(p, 'the counterexample must name a Payment').toBeDefined();
    expect(p!.fields['intent.state']).toBe('requiresPaymentMethod');
    expect(p!.fields['paymentMethodPresent']).toBe(false);
  }, 180_000);

  // The ref-hop existence gate on `present` (the `(allExist) and flag` conjunction in predToQuint).
  // Method is a plain entity: it starts `exists: false` and is only populated by create_Method, which
  // cannot run at --max-steps 0. So `present(method.fee)` reads through a record that was never
  // created — false for the TS judge (evaluate.ts resolves the path to undefined), and it must be
  // false here too. Ungated, the nondet placeholder `feePresent` is free to be true and Apalache
  // refutes `not(present(method.fee))`, the divergence this asserts against.
  const hop: DomainModel = {
    context: 'Hop', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Method', fields: [
      { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'fee', type: { kind: 'prim', prim: 'Money' }, optional: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
      { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'method', type: { kind: 'ref', target: 'Method' } }],
      machine: { regions: [{ name: 'intent', initial: 'pending', states: [{ name: 'pending' }] }], transitions: [] } }],
    events: [], services: []
  };
  const noFeeThroughUncreatedMethod: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
    body: { kind: 'not', arg: { kind: 'present', path: ['method', 'fee'] } } };

  it('present() through a never-created ref target is FALSE, matching the TS judge', async () => {
    const em = astToQuint(hop, { kind: 'probe-permit', hi: noFeeThroughUncreatedMethod, exclusions: [], maxSteps: 0 });
    expect(em.source).toContain('((methods.get(x.method).exists) and methods.get(x.method).feePresent)');
    const r = await runQuintVerify(em, { invariant: 'Hi', maxSteps: 0 });
    expect(r.violated, 'an ungrounded present() read manufactured a spurious witness').toBe(false);
  }, 180_000);
});
