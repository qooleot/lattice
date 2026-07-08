import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runAlloy } from '../../src/solvers/alloy-adapter.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { ALLOY_JAR } from '../../src/solvers/doctor.js';
import { traceAModel, invoiceLinesModel, someStatePredicateOnInvoice } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const h1: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] };
const h2: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

describe.skipIf(!existsSync(ALLOY_JAR))('alloy adapter (integration)', () => {
  it('finds a distinguishing witness for per-customer vs per-plan', async () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 3);
    expect(r.sat).toBe(true);
    const w = r.instances[0]!;
    const subs = w.entities.filter(e => e.type === 'Subscription' && e.fields['Access.state'] === 'Active');
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(r.ms).toBeLessThan(45_000);
  }, 120_000);

  it('returns UNSAT for a candidate against itself (merge signal)', async () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h1, exclusions: [], scope: 4 });
    const r = await runAlloy(als, 1);
    expect(r.sat).toBe(false);
  }, 120_000);

  // Task 7: owned collections — the InvoiceLine child sig carries a by-construction `owner: one
  // Invoice` relation; the adapter maps relation atoms to entity fields generically (no
  // owned-collection-specific parsing), so a witnessed InvoiceLine's `owner` field should resolve
  // to a real Invoice entity id, matching the evaluator's own convention (Task 6) exactly.
  //
  // Alloy's default `probe-permit` nonVacuous pred only asserts `some Invoice` — the solver's
  // scope permits zero InvoiceLine atoms and (verified separately, see task-7 report) will
  // actually return such a witness if left unconstrained, so this test cannot just run the
  // emitter's plain query and hope. A test-local `some InvoiceLine` fact is appended to the
  // emitted source (scaffolding only — the sig/relation shape under test is still fully
  // emitter-generated) to force at least one child into the witness, and a guard assertion below
  // makes sure the append actually landed and the test can never pass vacuously.
  it('witnesses InvoiceLine children whose owner resolves to a real Invoice entity', async () => {
    const base = astToAlloy(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], scope: 4 });
    const withChildFact = base.replace('run q { Hi and nonVacuous }', 'run q { Hi and nonVacuous and some InvoiceLine }');
    expect(withChildFact).not.toBe(base); // guard: the append must have actually matched and landed
    expect(withChildFact).toContain('some InvoiceLine');

    const r = await runAlloy(withChildFact, 3);
    expect(r.sat).toBe(true);
    const w = r.instances[0]!;
    const invoiceIds = new Set(w.entities.filter(e => e.type === 'Invoice').map(e => e.id));
    const children = w.entities.filter(e => e.type === 'InvoiceLine');
    expect(children.length).toBeGreaterThan(0); // never pass vacuously
    for (const child of children) {
      expect(typeof child.fields.owner).toBe('string');
      expect(invoiceIds.has(child.fields.owner as string)).toBe(true);
    }
  }, 120_000);
});
