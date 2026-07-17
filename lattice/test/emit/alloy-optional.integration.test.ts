import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runAlloy } from '../../src/solvers/alloy-adapter.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { ALLOY_JAR } from '../../src/solvers/doctor.js';
import { impliedInvariants } from '../../src/engine/implied.js';
import { expressibleAdopted } from '../../src/engine/planner.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';

// Real-solver armor for the three gate polarities (emit/alloy.ts): the session's manual
// "UNSAT before, SAT after" experiments, made repeatable. String tests can't catch a
// precedence/operator slip that real Alloy would silently invert.
const payment: DomainModel = {
  context: 'BillPayments', ticksPerDay: 24, enums: [], values: [],
  entities: [{ kind: 'entity', name: 'PayMethod', fields: [
    { name: 'pmId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'fee', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
    // Optional leaf so present() can legally target a THROUGH-HOP path (present-not-optional
    // rejects present() on a required leaf) — exercised by the no-gate polarity test below.
    { name: 'tag', type: { kind: 'prim', prim: 'Int' }, optional: true }] }],
  aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
    { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'paymentMethod', type: { kind: 'ref', target: 'PayMethod' }, optional: true }],
    machine: { regions: [{ name: 'intent', initial: 'requiresPaymentMethod', states: [
      { name: 'requiresPaymentMethod', tags: ['active'] }, { name: 'succeeded', tags: ['terminal'] }] }],
      transitions: [{ name: 'succeed', region: 'intent', from: ['requiresPaymentMethod'], to: 'succeeded' }] } }],
  events: [], services: []
};

// Pins every Payment method-less when adopted (alloy-expressible: a statePredicate without `now`).
// Both the present-polarity and unique-gate tests below need it to close off alternate witnesses.
const noMethod: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
  body: { kind: 'not', arg: { kind: 'present', path: ['paymentMethod'] } } };

describe.skipIf(!existsSync(ALLOY_JAR))('alloy — optional-field gates (integration, real Alloy)', () => {
  it('cmp gate: a method-less Payment satisfies a fee rule read through the absent hop', async () => {
    const feePositive: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['paymentMethod', 'fee'] }, right: { kind: 'int', value: 0 } } };
    const mustHaveMethod: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'present', path: ['paymentMethod'] } };
    const adopted = [...expressibleAdopted('alloy', impliedInvariants(payment).map(i => i.candidate)), feePositive];
    // A witness violating `present(paymentMethod)` is exactly the method-less Payment; it must be
    // SAT even with feePositive adopted — pre-gate Alloy's empty join made this UNSAT.
    const als = astToAlloy(payment, { kind: 'probe-forbid', hi: mustHaveMethod, exclusions: [], adopted, scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat, 'the method-less Payment must be reachable under a through-hop fee rule').toBe(true);
  }, 120_000);

  it('present() needs no gate: some x.paymentMethod.tag is already false through the absent hop', async () => {
    const noTagThroughHop: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'not', arg: { kind: 'present', path: ['paymentMethod', 'tag'] } } };
    // Adopting noMethod pins every Payment method-less, so the probe's SAT can only come from the
    // no-gate polarity itself: `some x.paymentMethod.tag` must read FALSE on the empty hop. A
    // wrongly cmp-style-gated present — `(some x.paymentMethod) implies (some x.paymentMethod.tag)`
    // — negates to "method present AND tag absent", which is UNSAT with every Payment method-less.
    const als = astToAlloy(payment, { kind: 'probe-permit', hi: noTagThroughHop, exclusions: [], adopted: [noMethod], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat, 'not(present(paymentMethod.tag)) must be witnessable through the absent hop').toBe(true);
    const pays = r.instances[0]!.entities.filter(e => e.type === 'Payment');
    expect(pays.length).toBeGreaterThan(0);   // never pass vacuously
    for (const p of pays) expect(p.fields).not.toHaveProperty('paymentMethod');
  }, 120_000);

  it('unique gate: two method-less Payments do not collide on a through-hop key (none = none must not convict)', async () => {
    const uniqueByFee: Candidate = { kind: 'unique', aggregate: 'Payment',
      whileStates: { region: 'intent', states: ['requiresPaymentMethod'] }, by: [['paymentMethod', 'fee']] };
    const twoActive: Candidate = { kind: 'cardinality', aggregate: 'Payment', atMost: 1,
      where: { kind: 'inState', owner: 'self', region: 'intent', states: ['requiresPaymentMethod'] } };
    // Violating `atMost 1` needs TWO active Payments. Adopting noMethod alongside uniqueByFee pins
    // EVERY Payment method-less, so the only route to that pair passes through the none = none
    // comparison: gated, the collision's `(some a.paymentMethod and some b.paymentMethod)` conjunct
    // is false and hop-less pairs don't collide → SAT; ungated, `none = none` reads TRUE for every
    // pair → collision → the adopted unique forbids the pair → UNSAT. Without the pin the query
    // stays SAT even with the gate deleted (two Payments with distinct real methods and distinct
    // fees satisfy it), and the test would not flip on a regression.
    const als = astToAlloy(payment, { kind: 'probe-forbid', hi: twoActive, exclusions: [], adopted: [uniqueByFee, noMethod], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat, 'two method-less Payments must be able to coexist under a through-hop unique').toBe(true);
    const active = r.instances[0]!.entities.filter(e =>
      e.type === 'Payment' && e.fields['intent.state'] === 'requiresPaymentMethod');
    expect(active.length).toBeGreaterThanOrEqual(2);   // the pair really is there
    for (const p of active) expect(p.fields).not.toHaveProperty('paymentMethod');   // and really method-less
  }, 120_000);
});
