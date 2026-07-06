import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel } from '../../src/ast/domain.js';

const good: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [{ name: 'Status', values: ['Paid', 'Unpaid'] }],
  entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'status', type: { kind: 'enum', enum: 'Status' } }
    ],
    machine: {
      regions: [{ name: 'Access', initial: 'Trialing', states: [{ name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }],
      transitions: [{ name: 'activate', region: 'Access', from: 'Trialing', to: 'Active', when: 'PaymentSucceeded' }]
    }
  }],
  events: [{ name: 'PaymentSucceeded', fields: [] }]
};

describe('validateModel rejects grammar-keyword identifiers (spec §3.4 conformance)', () => {
  it('rejects a field named "count" (a reserved .lat keyword)', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields.push({ name: 'count', type: { kind: 'prim', prim: 'Int' } });
    const diags = validateModel(m);
    expect(diags.map(d => d.code)).toContain('reserved-word');
    const d = diags.find(x => x.code === 'reserved-word')!;
    expect(d.message).toContain("'count'");
    expect(d.message).toContain('keyword');
  });

  it('rejects an aggregate named "terminal"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.name = 'terminal';
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('rejects an enum value named "from"', () => {
    const m = structuredClone(good);
    m.enums[0]!.values.push('from');
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('rejects a machine region named "state"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.regions[0]!.name = 'state';
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('rejects a transition named "to"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.name = 'to';
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('accepts the well-formed model with no reserved names', () => {
    expect(validateModel(good).map(d => d.code)).not.toContain('reserved-word');
  });
});
