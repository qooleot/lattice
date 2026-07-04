import { describe, it, expect } from 'vitest';
import { validateCandidate, routeCandidate } from '../../src/ast/grammar.js';
import type { Candidate } from '../../src/ast/invariant.js';

// Minimal model stub — real DomainModel arrives in Task 2; grammar.ts only reads these arrays.
const model: any = {
  context: 'Billing',
  enums: [{ name: 'Status', values: ['Paid', 'Unpaid'] }],
  entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'grace', type: { kind: 'prim', prim: 'Duration' } },
      { name: 'dueDate', type: { kind: 'prim', prim: 'Date' } },
      { name: 'status', type: { kind: 'enum', enum: 'Status' } }
    ],
    machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [{ name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] }
  }],
  events: []
};

const uniqueCand: Candidate = {
  kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']]
};

const graceCand: Candidate = {
  kind: 'statePredicate', aggregate: 'Subscription',
  body: {
    kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['status'] }, right: { kind: 'enumval', enum: 'Status', value: 'Unpaid' } }
    ]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' }, right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } }
  }
};

describe('validateCandidate', () => {
  it('accepts a well-formed unique candidate', () => {
    expect(validateCandidate(uniqueCand, model)).toEqual([]);
  });
  it('rejects unknown aggregate', () => {
    const bad = { ...uniqueCand, aggregate: 'Nope' };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-aggregate');
  });
  it('rejects unknown field path', () => {
    const bad: Candidate = { ...uniqueCand, by: [['nonexistent']] };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-path');
  });
  it('rejects unknown state in whileStates', () => {
    const bad: Candidate = { ...uniqueCand, whileStates: { region: 'Access', states: ['Zombie'] } };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-state');
  });
  it('rejects unknown enum value', () => {
    const bad: Candidate = JSON.parse(JSON.stringify(graceCand));
    (bad as any).body.left.args[1].right.value = 'Bogus';
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unknown-enum-value');
  });
});

describe('validateCandidate — structural shape validation', () => {
  it('treats explicit null as absent for optional statePredicate.where', () => {
    const withNull: any = { kind: 'statePredicate', aggregate: 'Subscription',
      where: null,
      body: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] } };
    const withoutWhere: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] } };
    expect(validateCandidate(withNull, model)).toEqual([]);
    expect(validateCandidate(withoutWhere, model)).toEqual([]);
    expect(routeCandidate(withNull)).toEqual(routeCandidate(withoutWhere));
  });

  it('rejects conservation with flat parts (string[] instead of Path[]) without throwing', () => {
    const bad: Candidate = {
      kind: 'conservation', aggregate: 'Subscription',
      parts: ['a', 'b'] as any, total: ['grace']
    };
    let result: ReturnType<typeof validateCandidate> = [];
    expect(() => { result = validateCandidate(bad, model); }).not.toThrow();
    expect(result.map(d => d.code)).toContain('ill-typed');
  });

  it('rejects unknown candidate kind as out-of-grammar', () => {
    const bad: any = { kind: 'wibble', aggregate: 'Subscription' };
    const result = validateCandidate(bad, model);
    expect(result.map(d => d.code)).toContain('out-of-grammar');
  });

  it('rejects unique with flat by (string[] instead of Path[]) as ill-typed', () => {
    const bad: Candidate = {
      kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] },
      by: ['customer'] as any
    };
    let result: ReturnType<typeof validateCandidate> = [];
    expect(() => { result = validateCandidate(bad, model); }).not.toThrow();
    expect(result.map(d => d.code)).toContain('ill-typed');
  });
});

describe('routeCandidate', () => {
  it('routes structural forms to alloy', () => {
    expect(routeCandidate(uniqueCand)).toBe('alloy');
    expect(routeCandidate({ kind: 'refsResolve', aggregate: 'Subscription' })).toBe('alloy');
    expect(routeCandidate({ kind: 'cardinality', aggregate: 'Subscription', where: null, atMost: 1 })).toBe('alloy');
  });
  it('routes temporal/arithmetic forms to quint', () => {
    expect(routeCandidate(graceCand)).toBe('quint');
    expect(routeCandidate({ kind: 'terminal', aggregate: 'Subscription', region: 'Access', state: 'Ended' })).toBe('quint');
    expect(routeCandidate({ kind: 'monotonic', aggregate: 'Subscription', field: ['recognized'] })).toBe('quint');
    expect(routeCandidate({ kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] })).toBe('quint');
  });
  it('routes an arithmetic-free statePredicate to alloy', () => {
    const rel: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active', 'Trialing', 'Ended'] } };
    expect(routeCandidate(rel)).toBe('alloy');
  });
});
