import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Predicate } from '../../src/ast/invariant.js';

const model = (requires?: Predicate): DomainModel => ({
  context: 'C', enums: [], values: [], entities: [], events: [],
  aggregates: [
    { kind: 'aggregate', name: 'Other',
      fields: [{ name: 'oId', type: { kind: 'prim', prim: 'Id' }, key: true }] },
    { kind: 'aggregate', name: 'Invoice',
      fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'other', type: { kind: 'ref', target: 'Other' } },
        { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' } },
        { name: 'totalDue', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'settlement', initial: 'open',
        states: [{ name: 'open' }, { name: 'paid' }] }],
        transitions: [{ name: 'settle', region: 'settlement', from: ['open'], to: 'paid',
          ...(requires ? { requires } : {}) }] } }],
});
const cmp = (l: string[], r: string[]): Predicate =>
  ({ kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: l }, right: { kind: 'field', owner: 'self', path: r } });

describe('transition guards', () => {
  it('accepts a guard over own numeric fields', () => {
    expect(validateModel(model(cmp(['amountPaid'], ['totalDue'])))).toEqual([]);
  });
  it('rejects ref-hop paths in guards (own-aggregate only, design §3.3)', () => {
    const diags = validateModel(model(cmp(['other', 'oId'], ['totalDue'])));
    expect(diags.map(d => d.code)).toContain('guard-cross-aggregate');
  });
  it('rejects a guard naming a foreign region', () => {
    const diags = validateModel(model({ kind: 'inState', owner: 'self', region: 'nope', states: ['open'] }));
    expect(diags.map(d => d.code)).toContain('unknown-region');
  });
});
