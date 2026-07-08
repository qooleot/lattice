import { describe, it, expect } from 'vitest';
import { validateCandidate, routeCandidate, resolveFieldPath } from '../../src/ast/grammar.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { DomainModel } from '../../src/ast/domain.js';
import { periodModel } from '../fixtures.js';

// Minimal model stub — real DomainModel arrives in Task 2; grammar.ts only reads these arrays.
const model: any = {
  context: 'Billing',
  enums: [{ name: 'Status', values: ['Paid', 'Unpaid'] }], values: [],
  entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'grace', type: { kind: 'prim', prim: 'Duration' } },
      { name: 'dueDate', type: { kind: 'prim', prim: 'Date' } },
      { name: 'status', type: { kind: 'enum', enum: 'Status' } },
      { name: 'note', type: { kind: 'prim', prim: 'Text' } }
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

describe('validateCandidate — solver-dropped field paths', () => {
  // Both emitters drop key and Text/Id fields from the solver-facing model (atom identity
  // suffices), so a candidate path terminating in one is unrepresentable: Alloy/Quint emission
  // references a nonexistent field, and the TS judge resolves it to undefined on every witness.
  it('rejects unique by the aggregate\'s own key as a key-path', () => {
    const bad: Candidate = { ...uniqueCand, by: [['id']] };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('key-path');
  });
  it('rejects a ref-hop path terminating at the referenced entity\'s key, suggesting the bare ref', () => {
    const bad: Candidate = { ...uniqueCand, by: [['customer', 'id']] };
    const diags = validateCandidate(bad, model);
    expect(diags.map(d => d.code)).toContain('key-path');
    expect(diags.find(d => d.code === 'key-path')!.message).toContain("'customer'");
  });
  it('rejects a statePredicate term path ending in a key field', () => {
    const bad: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['customer', 'id'] }, right: { kind: 'field', owner: 'self', path: ['customer', 'id'] } } };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('key-path');
  });
  it('rejects a path ending in a Text field as unrepresentable', () => {
    const bad: Candidate = { ...uniqueCand, by: [['note']] };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unrepresentable-path');
  });
  it('still accepts ref, enum, and numeric-prim paths', () => {
    const ok: Candidate = { ...uniqueCand, by: [['customer'], ['status'], ['grace']] };
    expect(validateCandidate(ok, model)).toEqual([]);
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

  it('rejects a field Term with owner other than self', () => {
    const bad: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'Subscription', path: ['status'] }, right: { kind: 'enumval', enum: 'Status', value: 'Paid' } } };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unsupported-owner');
  });

  it('rejects an inState Predicate with owner other than self', () => {
    const bad: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'inState', owner: 'Subscription', region: 'Access', states: ['Active'] } };
    expect(validateCandidate(bad, model).map(d => d.code)).toContain('unsupported-owner');
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

describe('resolveFieldPath — ref-hop machine-state paths', () => {
  it('accepts a ref-hop machine-state path (period → Lifecycle.state)', async () => {
    const { revrecModel } = await import('../fixtures.js');
    const c: Candidate = { kind: 'statePredicate', aggregate: 'RevenueEntry',
      body: { kind: 'implies',
        left: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['period', 'Lifecycle.state'] }, right: { kind: 'enumval', enum: 'PeriodState', value: 'Closed' } },
        right: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['postedAt'] }, right: { kind: 'field', owner: 'self', path: ['period', 'closedAt'] } } } };
    expect(validateCandidate(c, revrecModel)).toEqual([]);
  });
});

// Local fixture (tests don't import across test files): an Order aggregate with a qualified
// cross-context ref field `plan: ref Catalog.Plan` (spec §4.2).
const base = (target: string): DomainModel => ({
  context: 'Billing', ticksPerDay: 24,
  enums: [], values: [],
  entities: [],
  aggregates: [{
    kind: 'aggregate', name: 'Order',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'plan', type: { kind: 'ref', target } }
    ]
  }],
  events: []
});

// Task 11: value semantics — a value-typed field is one flat, inline hop (design §3.5): the path
// resolves through the ValueDef's own fields, never nested further (values carry prim/enum fields
// only in v1 — see validate.ts's `value-flat` diagnostic).
describe('resolveFieldPath — value hop', () => {
  it('resolves a path into a value-typed field\'s own field', () => {
    expect(resolveFieldPath(periodModel, 'Subscription', ['period', 'start'])?.type).toEqual({ kind: 'prim', prim: 'Date' });
    expect(resolveFieldPath(periodModel, 'Subscription', ['period', 'end'])?.type).toEqual({ kind: 'prim', prim: 'Date' });
  });
  it('resolves the bare value field itself as the terminal segment', () => {
    const f = resolveFieldPath(periodModel, 'Subscription', ['period']);
    expect(f?.name).toBe('period');
    expect(f?.type).toEqual({ kind: 'value', value: 'Period' });
  });
  it('rejects an unknown sub-field of a value type', () => {
    expect(resolveFieldPath(periodModel, 'Subscription', ['period', 'bogus'])).toBeNull();
  });
  it('rejects a path with more than one hop past a value field (v1: flat values only)', () => {
    expect(resolveFieldPath(periodModel, 'Subscription', ['period', 'start', 'extra'])).toBeNull();
  });
  it('validateCandidate accepts a statePredicate comparing period.start vs period.end', () => {
    const c: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt',
        left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };
    expect(validateCandidate(c, periodModel)).toEqual([]);
  });
});

describe('validateCandidate — cross-context ref exclusion (spec §4.2)', () => {
  it('validateCandidate rejects paths traversing a qualified ref', () => {
    const m = base('Catalog.Plan');
    const c: Candidate = { kind: 'statePredicate', aggregate: 'Order',
      body: { kind: 'cmp', op: 'ge',
        left: { kind: 'field', owner: 'self', path: ['plan', 'licenseFee'] },
        right: { kind: 'int', value: 0 } } };
    expect(validateCandidate(c, m).some(d => d.code === 'cross-context-ref-unsupported')).toBe(true);
  });
});
