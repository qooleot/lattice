import { describe, it, expect } from 'vitest';
import { validateCandidate, routeCandidate } from '../../src/ast/grammar.js';
import { invoiceLinesModel } from '../fixtures.js';
import type { DomainModel } from '../../src/ast/domain.js';

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

  // checkPath (the choke point shared by every candidate path — grammar.ts) also runs over
  // sumOverCollection's `total` path: a total ending in a key field or a Text field must be
  // rejected the same way any other candidate path would be.
  it('rejects a total path ending in a key field (key-path)', () =>
    expect(validateCandidate(sum({ total: ['invId'] }), invoiceLinesModel).map(d => d.code)).toContain('key-path'));
  it('rejects a total path ending in a Text field (unrepresentable-path)', () => {
    const modelWithText: DomainModel = {
      ...invoiceLinesModel,
      aggregates: [{
        ...invoiceLinesModel.aggregates[0]!,
        fields: [...invoiceLinesModel.aggregates[0]!.fields,
          { name: 'memo', type: { kind: 'prim', prim: 'Text' } }],
      }],
    };
    expect(validateCandidate(sum({ total: ['memo'] }), modelWithText).map(d => d.code)).toContain('unrepresentable-path');
  });
});
