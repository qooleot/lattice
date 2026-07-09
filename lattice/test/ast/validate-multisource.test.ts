import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';

const model = (from: string[], to: string): DomainModel => ({
  context: 'C', enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{ kind: 'aggregate', name: 'A',
    fields: [{ name: 'aId', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'lc', initial: 's1',
      states: [{ name: 's1' }, { name: 's2' }, { name: 's3' }] }],
      transitions: [{ name: 't', region: 'lc', from, to }] } }],
});

describe('multi-source transitions', () => {
  it('accepts distinct sources', () => {
    expect(validateModel(model(['s1', 's2'], 's3'))).toEqual([]);
  });
  it('rejects duplicate sources', () => {
    expect(validateModel(model(['s1', 's1'], 's3')).map(d => d.code)).toContain('duplicate-source');
  });
  it('rejects self-loops (to appears in from)', () => {
    expect(validateModel(model(['s1', 's2'], 's2')).map(d => d.code)).toContain('self-loop');
  });
  it('rejects unknown source states', () => {
    expect(validateModel(model(['nope'], 's2')).map(d => d.code)).toContain('unknown-transition-state');
  });
});
