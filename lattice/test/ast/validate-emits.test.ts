import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';

const model = (opts: { emits: string }): DomainModel => ({
  context: 'C', enums: [], entities: [],
  events: [{ name: 'Paid', fields: [] }],
  aggregates: [{ kind: 'aggregate', name: 'A',
    fields: [{ name: 'aId', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'lc', initial: 's1',
      states: [{ name: 's1' }, { name: 's2' }] }],
      transitions: [{ name: 't', region: 'lc', from: ['s1'], to: 's2', emits: opts.emits }] } }],
});

describe('transition emits', () => {
  it('accepts emits naming a declared event and rejects unknown ones', () => {
    expect(validateModel(model({ emits: 'Paid' }))).toEqual([]);
    const diags = validateModel(model({ emits: 'Nope' }));
    expect(diags.map(d => d.code)).toContain('unknown-event');
    expect(diags.find(d => d.code === 'unknown-event')!.message).toContain('emits');
  });
});
