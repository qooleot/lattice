import { describe, it, expect } from 'vitest';
import { conjunctsOf, fieldsIn, conjunctTier } from '../../src/engine/tier.js';
import type { Candidate, Predicate } from '../../src/ast/invariant.js';
import {
  subscriptionsModel, invoicingModel, invoiceLinesModel,
  amountPaidAtMostTotalConjunct, paidImpliesExactConjunct,
  someStatePredicateOnInvoice, draftInvoiceUnique, someCardinalityOnInvoice,
} from '../fixtures.js';

// Fixtures type these as the Candidate union, so `.body` needs narrowing at each use site.
const bodyOf = (c: Candidate): Predicate => {
  if (c.kind !== 'statePredicate') throw new Error(`expected statePredicate, got ${c.kind}`);
  return c.body;
};
const amountPaidAtMostTotalBody = bodyOf(amountPaidAtMostTotalConjunct);
const paidImpliesExactBody = bodyOf(paidImpliesExactConjunct);

// The committed Never_Overpaid_And_Paid_Exact invariant's `&&` body, reassembled from its two
// documented conjunct fixtures (fixtures.ts:283-307) — exactly the "neverOverpaidAndPaidExact"
// shape the brief calls out.
const neverOverpaidAndPaidExact: Candidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  body: { kind: 'and', args: [amountPaidAtMostTotalBody, paidImpliesExactBody] },
};

const terminalOnInvoice: Candidate = { kind: 'terminal', aggregate: 'Invoice', region: 'settlement', state: 'paid' };

describe('conjunctsOf', () => {
  it('splits an and-bodied statePredicate into one candidate per conjunct, index-tagged', () => {
    const out = conjunctsOf(neverOverpaidAndPaidExact);
    expect(out.length).toBe(2);
    expect(out[0]!.conjunct).toBe('0');
    expect(out[0]!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Invoice', body: amountPaidAtMostTotalBody });
    expect(out[1]!.conjunct).toBe('1');
    expect(out[1]!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Invoice', body: paidImpliesExactBody });
  });

  it('passes a non-and statePredicate through as a single untagged candidate', () => {
    expect(conjunctsOf(someStatePredicateOnInvoice)).toEqual([{ candidate: someStatePredicateOnInvoice }]);
  });

  it('passes a unique candidate through unchanged', () => {
    expect(conjunctsOf(draftInvoiceUnique)).toEqual([{ candidate: draftInvoiceUnique }]);
  });

  it('passes a terminal candidate through unchanged', () => {
    expect(conjunctsOf(terminalOnInvoice)).toEqual([{ candidate: terminalOnInvoice }]);
  });
});

describe('fieldsIn', () => {
  it('returns the region (and no paths) for an inState-only predicate', () => {
    const result = fieldsIn({ kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] });
    expect(result.paths).toEqual([]);
    expect(result.regions).toEqual(new Set(['settlement']));
  });

  it('returns the field paths for a cmp predicate', () => {
    const result = fieldsIn(amountPaidAtMostTotalBody);
    expect(result.paths).toEqual([['amountPaid'], ['totalDue']]);
    expect(result.regions).toEqual(new Set());
  });

  it('walks implies/inState + cmp together (paidImpliesExactConjunct shape)', () => {
    const result = fieldsIn(paidImpliesExactBody);
    expect(result.paths).toEqual([['amountPaid'], ['totalDue']]);
    expect(result.regions).toEqual(new Set(['settlement']));
  });
});

describe('conjunctTier', () => {
  it('tiers an inState-only conjunct as sound', () => {
    const c: Candidate = { kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] } };
    expect(conjunctTier(subscriptionsModel, c)).toBe('sound');
  });

  it('tiers a conjunct referencing amountPaid/totalDue as abstract', () => {
    expect(conjunctTier(subscriptionsModel, amountPaidAtMostTotalConjunct)).toBe('abstract');
  });

  it('tiers a terminal candidate (region-only) as sound', () => {
    expect(conjunctTier(subscriptionsModel, terminalOnInvoice)).toBe('sound');
  });

  it('tiers a cardinality candidate with no where clause as sound', () => {
    expect(conjunctTier(invoiceLinesModel, someCardinalityOnInvoice)).toBe('sound');
  });

  it('tiers a unique candidate (its by-paths reference data fields) as abstract', () => {
    expect(conjunctTier(invoicingModel, draftInvoiceUnique)).toBe('abstract');
  });
});
