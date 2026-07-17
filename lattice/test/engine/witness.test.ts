import { describe, it, expect } from 'vitest';
import { remapValueKeys } from '../../src/engine/witness.js';
import { periodModel } from '../fixtures.js';
import { evaluateCandidate, type CaseState } from '../../src/engine/evaluate.js';
import { impliedInvariants } from '../../src/engine/implied.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { astToQuint } from '../../src/emit/quint.js';
import { parseITF } from '../../src/solvers/quint-adapter.js';
import type { DomainModel } from '../../src/ast/domain.js';

describe('remapValueKeys', () => {
  it('renames underscore-flattened value keys to dotted, leaving other fields untouched', () => {
    const cs: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3, other_thing: 1 } }] };
    const out = remapValueKeys(periodModel, cs);
    expect(out.entities[0]!.fields).toEqual({ 'period.start': 3, other_thing: 1 });
  });

  it('remaps every declared sub-field of the value type', () => {
    const cs: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3, period_end: 9 } }] };
    const out = remapValueKeys(periodModel, cs);
    expect(out.entities[0]!.fields).toEqual({ 'period.start': 3, 'period.end': 9 });
  });

  it('leaves entities of a type with no value fields untouched', () => {
    const cs: CaseState = { entities: [{ type: 'Other', id: 'o1', fields: { foo_bar: 1 } }] };
    const out = remapValueKeys(periodModel, cs);
    expect(out.entities[0]!.fields).toEqual({ foo_bar: 1 });
  });

  it('does not mutate the input CaseState', () => {
    const cs: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3 } }] };
    remapValueKeys(periodModel, cs);
    expect(cs.entities[0]!.fields).toEqual({ period_start: 3 });
  });

  it('preserves now/trace and remaps every trace step entity too', () => {
    const cs: CaseState = {
      now: 5,
      entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3 } }],
      trace: [[{ type: 'Subscription', id: 's1', fields: { period_start: 1 } }]],
    };
    const out = remapValueKeys(periodModel, cs);
    expect(out.now).toBe(5);
    expect(out.trace![0]![0]!.fields).toEqual({ 'period.start': 1 });
  });

  it('handles an entity type not present in the model without crashing', () => {
    const cs: CaseState = { entities: [{ type: 'Bogus', id: 'x1', fields: { a_b: 1 } }] };
    expect(() => remapValueKeys(periodModel, cs)).not.toThrow();
    expect(remapValueKeys(periodModel, cs).entities[0]!.fields).toEqual({ a_b: 1 });
  });
});

describe('child value keys normalize (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], services: [], events: [], entities: [],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'value', value: 'Amount' } }] }] }],
  };

  it('renames a CHILD entity\'s flattened value key to a dotted path', () => {
    const cs = { entities: [{ type: 'Posting', id: 'p1', fields: { amount_amount: 5, owner: 't1' } }] };
    const out = remapValueKeys(m, cs);
    expect(out.entities[0]!.fields['amount.amount']).toBe(5);
    expect(out.entities[0]!.fields['amount_amount']).toBeUndefined();
  });

  it('renames ONLY the value-prefixed key, leaving the child\'s other keys untouched', () => {
    // Asserts the whole object, not one key: `expect(fields['owner']).toBe('t1')` alone passes even
    // with the widening reverted, because a missed `e.type` lookup returns the entity unchanged —
    // so `owner` survives either way and the test proves nothing.
    const cs: CaseState = { entities: [{ type: 'Posting', id: 'p1', fields: { amount_amount: 5, owner: 't1' } }] };
    expect(remapValueKeys(m, cs).entities[0]!.fields).toEqual({ 'amount.amount': 5, owner: 't1' });
  });
});

// The design's own motivating shape: a value whose field is ANOTHER value. Legalised by slice B2,
// which made eight walkers recursive and missed the two on the witness side.
const twoLevel: DomainModel = {
  context: 'L', services: [], events: [], entities: [],
  enums: [{ name: 'Currency', values: ['usd', 'eur'] }],
  values: [
    { kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'currency', type: { kind: 'enum', enum: 'Currency' } }] },
    { kind: 'value', name: 'Outer', fields: [
      { name: 'inner', type: { kind: 'value', value: 'Amount' } }] }],
  aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
    { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'total', type: { kind: 'value', value: 'Outer' }, tags: ['unsigned'] }] }],
};

describe('two-level value keys normalize to a full dotted path (slice B2)', () => {
  it('dots EVERY level of a two-level value key, not just the first', () => {
    const cs: CaseState = { entities: [{ type: 'Bill', id: 'b1',
      fields: { total_inner_amount: -5, total_inner_currency: 'usd', billId: 'b1' } }] };
    // Before the fix this was { 'total.inner_amount': -5, ... } — one underscore stripped, a key
    // resolveValue's `path.join('.')` lookup can never match.
    expect(remapValueKeys(twoLevel, cs).entities[0]!.fields).toEqual({
      'total.inner.amount': -5, 'total.inner.currency': 'usd', billId: 'b1',
    });
  });

  it('does not hang on a hand-built cyclic value graph', () => {
    const cyclic: DomainModel = {
      context: 'L', enums: [], services: [], events: [], entities: [],
      values: [
        { kind: 'value', name: 'A', fields: [{ name: 'b', type: { kind: 'value', value: 'B' } }] },
        { kind: 'value', name: 'B', fields: [{ name: 'a', type: { kind: 'value', value: 'A' } }] }],
      aggregates: [{ kind: 'aggregate', name: 'Cyc', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'v', type: { kind: 'value', value: 'A' } }] }],
    };
    const cs: CaseState = { entities: [{ type: 'Cyc', id: 'c1', fields: { v_b_a: 1 } }] };
    expect(() => remapValueKeys(cyclic, cs)).not.toThrow();
  });
});

// THE test this slice was missing. Every value walker was made recursive except the two on the
// witness side, so for a two-level value both solvers FORBID a negative leaf while the TS judge
// PERMITTED it. hypothesis.ts compares evaluateCandidate against the human's verdict, so that
// divergence prunes a CORRECT candidate as contradicted by evidence — the bug class this codebase
// most needs to avoid. Asserting the emitters alone (test/emit/alloy.test.ts's two-level case) can
// never catch it: the emitters were right, the witness path was not.
describe('TS judge and BOTH solvers agree on a two-level value (divergence guard)', () => {
  const derived = impliedInvariants(twoLevel);
  const nonNeg = derived.find(i => i.name === 'nonNegativeBillTotalInnerAmount')!;

  it('derives the leaf rule over the full two-hop path', () => {
    expect(nonNeg).toBeDefined();
    expect((nonNeg.candidate as any).body.left.path).toEqual(['total', 'inner', 'amount']);
  });

  it('ALLOY forbids total_inner_amount: -5, and the judge agrees', () => {
    // What the solver was asked: the flattened relation, constrained non-negative.
    const src = astToAlloy(twoLevel, { kind: 'probe-permit', exclusions: [], scope: 4, hi: nonNeg.candidate });
    expect(src).toMatch(/sig Bill \{[^}]*total_inner_amount: one Int/s);
    expect(src).toContain('.total_inner_amount');

    // The witness an Alloy counterexample yields, verbatim: underscore-flattened relation names.
    const witness: CaseState = { entities: [{ type: 'Bill', id: 'b1',
      fields: { total_inner_amount: -5, total_inner_currency: 'usd' } }] };
    expect(evaluateCandidate(nonNeg.candidate, remapValueKeys(twoLevel, witness))).toBe('forbid');
  });

  it('QUINT forbids the same state, and the judge agrees on the ITF it returns', () => {
    const em = astToQuint(twoLevel, { kind: 'probe-permit', exclusions: [], maxSteps: 1, hi: nonNeg.candidate });
    expect(em.source).toMatch(/total:\s*\{\s*inner:\s*\{/);
    expect(em.source).toContain('.total.inner.amount');

    // The ITF Apalache returns for that state: a nested record, integers #bigint-wrapped.
    const itf = { states: [{ bills: { '#map': [['b1', { exists: true,
      total: { inner: { amount: { '#bigint': '-5' }, currency: 'usd' } } }]] } }] };
    const cs = parseITF(itf, em.varTypes);
    // Every leaf de-big'd and flattened — no raw ITF object survives to print [object Object].
    expect(cs.entities[0]!.fields).toEqual({ total_inner_amount: -5, total_inner_currency: 'usd' });
    expect(evaluateCandidate(nonNeg.candidate, remapValueKeys(twoLevel, cs))).toBe('forbid');
  });
});
