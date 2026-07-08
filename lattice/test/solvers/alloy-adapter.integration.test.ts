import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runAlloy } from '../../src/solvers/alloy-adapter.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { ALLOY_JAR } from '../../src/solvers/doctor.js';
import { traceAModel, invoiceLinesModel, someStatePredicateOnInvoice, periodModel } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import { remapValueKeys } from '../../src/engine/witness.js';

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

  // Task 11 (design §3.5): value semantics round-trip through the real Alloy solver. period_start/
  // period_end are Alloy-native flattened sig relations (emitOwnerSig's value branch); after
  // remapValueKeys (the same normalization realDeps applies at the cli.ts boundary) the witness
  // must carry dotted period.start/period.end keys, and evaluateCandidate must judge a
  // period.start < period.end candidate consistently against the witness's actual values.
  it('round-trips a value field through the real solver: witness carries period.start/period.end post-remap, judged consistently', async () => {
    const periodCand: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt',
        left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };
    const als = astToAlloy(periodModel, { kind: 'probe-permit', hi: periodCand, exclusions: [], scope: 4 });
    expect(als).toContain('period_start: one Int');
    const r = await runAlloy(als, 3);
    expect(r.sat).toBe(true);
    const raw = r.instances[0]!;
    expect(raw.entities.some(e => 'period_start' in e.fields)).toBe(true);   // guard: pre-remap shape is underscore-flattened

    const w = remapValueKeys(periodModel, raw);
    const sub = w.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields['period.start']).toBeTypeOf('number');
    expect(sub.fields['period.end']).toBeTypeOf('number');
    expect(sub.fields).not.toHaveProperty('period_start');

    expect(evaluateCandidate(periodCand, w)).toBe('permit');
    expect(Number(sub.fields['period.start'])).toBeLessThan(Number(sub.fields['period.end']));
  }, 120_000);
});
