import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import type { DomainModel, MethodDef } from '../../src/ast/domain.js';

// Base: an Invoice aggregate with a `settle` transition (mirrors Task 3's Invoice fixture, e.g.
// lattice/test/emit/mermaid-gate.test.ts's guarded-transition Invoice).
const invoiceModel = (): DomainModel => ({
  context: 'Billing', enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{
    kind: 'aggregate', name: 'Invoice', doc: 'An invoice',
    fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' } },
      { name: 'totalDue', type: { kind: 'prim', prim: 'Money' } }],
    machine: { regions: [{ name: 'settlement', initial: 'open',
        states: [{ name: 'open' }, { name: 'paid', tags: ['terminal'] }] }],
      transitions: [{ name: 'settle', region: 'settlement', from: ['open'], to: 'paid' }] },
  }],
});

const svc = (m: Partial<MethodDef>): DomainModel => ({ ...invoiceModel(), services: [{ name: 'Billing',
  methods: [{ name: 'settle', params: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' } }],
    kind: { performs: { aggregate: 'Invoice', transition: 'settle' } }, ...m }] }] });

describe('services', () => {
  it('accepts performs targeting a declared transition', () => expect(validateModel(svc({}))).toEqual([]));

  it('rejects unknown transitions', () =>
    expect(validateModel(svc({ kind: { performs: { aggregate: 'Invoice', transition: 'nope' } } }))
      .map(d => d.code)).toContain('unknown-transition'));

  it('accepts a param+field guard on performs; rejects unknown params/fields', () => {
    expect(validateModel(svc({ params: [{ name: 'delta', type: { kind: 'prim', prim: 'Int' } }],
      requires: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'param', name: 'delta' } } }))).toEqual([]);
    expect(validateModel(svc({ requires: { kind: 'cmp', op: 'ge',
      left: { kind: 'param', name: 'ghost' }, right: { kind: 'int', value: 0 } } }))
      .map(d => d.code)).toContain('unknown-param');
  });

  it('read-only guards may reference params only', () =>
    expect(validateModel(svc({ kind: { readOnly: true }, requires: { kind: 'cmp', op: 'ge',
      left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: 0 } } }))
      .map(d => d.code)).toContain('guard-cross-aggregate'));

  it('rejects an unknown aggregate on performs', () =>
    expect(validateModel(svc({ kind: { performs: { aggregate: 'Ghost', transition: 'settle' } } }))
      .map(d => d.code)).toContain('unknown-aggregate'));

  it('rejects an unknown aggregate on creates', () =>
    expect(validateModel(svc({ kind: { creates: 'Ghost' } })).map(d => d.code)).toContain('unknown-aggregate'));

  it('accepts creates targeting a declared aggregate', () =>
    expect(validateModel(svc({ kind: { creates: 'Invoice' } }))).toEqual([]));

  it('creates guard may reference params + the target aggregate\'s own fields', () =>
    expect(validateModel(svc({ kind: { creates: 'Invoice' },
      params: [{ name: 'seedAmount', type: { kind: 'prim', prim: 'Money' } }],
      requires: { kind: 'cmp', op: 'ge', left: { kind: 'param', name: 'seedAmount' }, right: { kind: 'int', value: 0 } } }))).toEqual([]));

  it('read-only guard referencing a declared param is accepted', () =>
    expect(validateModel(svc({ kind: { readOnly: true },
      params: [{ name: 'threshold', type: { kind: 'prim', prim: 'Int' } }],
      requires: { kind: 'cmp', op: 'ge', left: { kind: 'param', name: 'threshold' }, right: { kind: 'int', value: 0 } } }))).toEqual([]));

  it('naming: service PascalCase, method/param camelCase warnings surface via reserved/invalid-name checks', () => {
    const bad: DomainModel = { ...invoiceModel(), services: [{ name: '1Bad',
      methods: [{ name: 'ok', params: [], kind: { readOnly: true } }] }] };
    expect(validateModel(bad).map(d => d.code)).toContain('invalid-name');
  });

  it('parse (grammar.ts validateCandidate): candidates never carry param terms', async () => {
    const { validateCandidate } = await import('../../src/ast/grammar.js');
    const m = invoiceModel();
    const bad = { kind: 'statePredicate' as const, aggregate: 'Invoice',
      body: { kind: 'cmp' as const, op: 'ge' as const, left: { kind: 'param' as const, name: 'x' }, right: { kind: 'int' as const, value: 0 } } };
    const diags = validateCandidate(bad, m);
    expect(diags.map(d => d.code)).toContain('ill-typed');
  });
});
