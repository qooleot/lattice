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

describe('validateModel', () => {
  it('accepts a well-formed model', () => expect(validateModel(good)).toEqual([]));

  it('rejects a ref to a missing target', () => {
    const m = structuredClone(good);
    (m.aggregates[0]!.fields[1]!.type as any).target = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unresolved-ref');
  });

  it('rejects an unknown enum', () => {
    const m = structuredClone(good);
    (m.aggregates[0]!.fields[2]!.type as any).enum = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unresolved-enum');
  });

  it('rejects a transition whose from-state is missing', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.from = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-transition-state');
  });

  it('rejects a region whose initial state is missing', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.regions[0]!.initial = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-initial-state');
  });

  it('rejects duplicate top-level names', () => {
    const m = structuredClone(good);
    m.entities.push({ kind: 'entity', name: 'Subscription', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    expect(validateModel(m).map(d => d.code)).toContain('duplicate-name');
  });

  it('rejects an aggregate without a key field', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields = m.aggregates[0]!.fields.filter(f => !f.key);
    expect(validateModel(m).map(d => d.code)).toContain('missing-key');
  });

  it('rejects an event trigger that names no declared event', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.when = 'GhostEvent';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-event');
  });

  it('rejects a transition that references an unknown region', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.region = 'Ghost';
    expect(validateModel(m).map(d => d.code)).toContain('unknown-region');
  });

  it('rejects a field literally named state', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields.push({ name: 'state', type: { kind: 'prim', prim: 'Text' } });
    expect(validateModel(m).map(d => d.code)).toContain('reserved-field-name');
  });
});
