import { describe, it, expect } from 'vitest';
import { validateCandidate, routeCandidate } from '../../src/ast/grammar.js';
import { invoiceLinesModel } from '../fixtures.js';

const sum = (over: Partial<any> = {}): any => ({ kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'eq', total: ['totalDue'], ...over });

describe('sumOverCollection', () => {
  it('accepts the b02 shape', () => expect(validateCandidate(sum(), invoiceLinesModel)).toEqual([]));
  it('rejects non-owned collections', () =>
    expect(validateCandidate(sum({ collection: 'totalDue' }), invoiceLinesModel).map(d => d.code)).toContain('sum-not-owned-collection'));
  it('rejects a child mismatch', () =>
    expect(validateCandidate(sum({ child: 'Invoice' }), invoiceLinesModel).map(d => d.code)).toContain('sum-not-owned-collection'));
  it('rejects non-numeric child fields', () =>
    expect(validateCandidate(sum({ field: 'lineId' }), invoiceLinesModel).map(d => d.code)).toContain('ill-typed'));
  it('routes to quint', () => expect(routeCandidate(sum())).toBe('quint'));
});
