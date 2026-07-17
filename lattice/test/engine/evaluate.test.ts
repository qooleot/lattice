import { describe, it, expect } from 'vitest';
import { evaluateCandidate, resolveValue, type CaseState } from '../../src/engine/evaluate.js';
import type { Candidate } from '../../src/ast/invariant.js';

const uniqueByCustomerFamily: Candidate = {
  kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']]
};

// DPSF: two active subs, same customer, different plan, SAME family (spec §2.1)
const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p2', fields: { family: 'storage' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
// DPDF: same customer, DIFFERENT family
const dpdf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} }, { type: 'Family', id: 'compute', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p3', fields: { family: 'compute' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

const graceRule: Candidate = {
  kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['invoice', 'status'] }, right: { kind: 'enumval', enum: 'Status', value: 'Unpaid' } }
    ]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' }, right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } }
  }
};
const mkGraceCase = (now: number): CaseState => ({ now, entities: [
  { type: 'Invoice', id: 'i1', fields: { status: 'Unpaid', dueDate: 100 } },
  { type: 'Subscription', id: 's1', fields: { grace: 72, invoice: 'i1', 'Access.state': 'Active' } }
]});

describe('evaluateCandidate', () => {
  it('unique: forbids two active in same (customer, family)', () =>
    expect(evaluateCandidate(uniqueByCustomerFamily, dpsf)).toBe('forbid'));
  it('unique: permits two active in different families', () =>
    expect(evaluateCandidate(uniqueByCustomerFamily, dpdf)).toBe('permit'));
  it('unique: a by-tuple with an unresolvable component never convicts (unknown facts)', () => {
    // Witnesses never carry key fields (emitters drop them — atom identity suffices), so a
    // by-path like ['id'] resolves undefined on every subject. That must not read as a collision.
    const byKey: Candidate = { kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] }, by: [['id']] };
    expect(evaluateCandidate(byKey, dpsf)).toBe('permit');
    const composite: Candidate = { kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['id']] };
    expect(evaluateCandidate(composite, dpsf)).toBe('permit');
  });
  it('statePredicate: forbids unpaid beyond grace (5 days = 120 ticks past due, grace 72)', () =>
    expect(evaluateCandidate(graceRule, mkGraceCase(220))).toBe('forbid'));
  it('statePredicate: permits unpaid within grace (5 hours past due)', () =>
    expect(evaluateCandidate(graceRule, mkGraceCase(105))).toBe('permit'));
  it('cardinality: at most one Open period', () => {
    const c: Candidate = { kind: 'cardinality', aggregate: 'AccountingPeriod',
      where: { kind: 'inState', owner: 'self', region: 'Lifecycle', states: ['Open'] }, atMost: 1 };
    const two: CaseState = { entities: [
      { type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Open' } },
      { type: 'AccountingPeriod', id: 'p2', fields: { 'Lifecycle.state': 'Open' } }
    ]};
    expect(evaluateCandidate(c, two)).toBe('forbid');
    two.entities[1]!.fields['Lifecycle.state'] = 'Closed';
    expect(evaluateCandidate(c, two)).toBe('permit');
  });
  it('conservation: recognized + deferred == allocated', () => {
    const c: Candidate = { kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] };
    const ok: CaseState = { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 60, allocated: 100 } }] };
    const leak: CaseState = { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 50, allocated: 100 } }] };
    expect(evaluateCandidate(c, ok)).toBe('permit');
    expect(evaluateCandidate(c, leak)).toBe('forbid');
  });
  it('refsResolve: forbids a dangling ref', () => {
    const c: Candidate = { kind: 'refsResolve', aggregate: 'RevenueEntry' };
    const s: CaseState = { entities: [{ type: 'RevenueEntry', id: 'e1', fields: { obligation: 'ghost' } }] };
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
  it('refsResolve WITH fields: ignores an unresolvable string on a non-listed (qualified-ref) field', () => {
    // The w1 shape (task 16): Subscription.plan is a qualified cross-context ref (spec §4.2) —
    // witnesses legitimately carry a bare string like "plan1" with no Plan entity in scope.
    // A refsResolve candidate scoped to same-context fields only (via `fields`) must not convict.
    const c: Candidate = { kind: 'refsResolve', aggregate: 'Subscription', fields: ['latestInvoice'] };
    const s: CaseState = { entities: [
      { type: 'Subscription', id: 's1', fields: { plan: 'plan1', latestInvoice: 'inv1' } },
      { type: 'Invoice', id: 'inv1', fields: {} }
    ]};
    expect(evaluateCandidate(c, s)).toBe('permit');
  });
  it('refsResolve WITH fields: still forbids a dangling listed field', () => {
    const c: Candidate = { kind: 'refsResolve', aggregate: 'Subscription', fields: ['latestInvoice'] };
    const s: CaseState = { entities: [
      { type: 'Subscription', id: 's1', fields: { plan: 'plan1', latestInvoice: 'ghost' } }
    ]};
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
  it('refsResolve WITHOUT fields: keeps the legacy heuristic over all string fields (absence ⇒ old behavior)', () => {
    const c: Candidate = { kind: 'refsResolve', aggregate: 'Subscription' };
    const s: CaseState = { entities: [
      { type: 'Subscription', id: 's1', fields: { plan: 'plan1', latestInvoice: 'inv1' } },
      { type: 'Invoice', id: 'inv1', fields: {} }
    ]};
    // plan:"plan1" has no matching entity id → legacy heuristic still convicts (pre-existing behavior)
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });
  it('monotonic: forbids a decrease across the trace', () => {
    const c: Candidate = { kind: 'monotonic', aggregate: 'Obligation', field: ['recognized'] };
    const s: CaseState = {
      entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 30 } }],
      trace: [[{ type: 'Obligation', id: 'o1', fields: { recognized: 40 } }]]
    };
    expect(evaluateCandidate(c, s)).toBe('forbid');
    expect(evaluateCandidate(c, { ...s, trace: [[{ type: 'Obligation', id: 'o1', fields: { recognized: 10 } }]] })).toBe('permit');
  });
  it('terminal: forbids leaving a terminal state across the trace', () => {
    const c: Candidate = { kind: 'terminal', aggregate: 'AccountingPeriod', region: 'Lifecycle', state: 'Closed' };
    const s: CaseState = {
      entities: [{ type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Open' } }],
      trace: [[{ type: 'AccountingPeriod', id: 'p1', fields: { 'Lifecycle.state': 'Closed' } }]]
    };
    expect(evaluateCandidate(c, s)).toBe('forbid');
  });

  const sum = (over: Partial<any> = {}): any => ({ kind: 'sumOverCollection', aggregate: 'Invoice',
    collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'eq', total: ['totalDue'], ...over });
  const st = (amounts: number[], total: number): CaseState => ({ entities: [
    { type: 'Invoice', id: 'i1', fields: { totalDue: total, 'lines.count': amounts.length } },
    ...amounts.map((a, i) => ({ type: 'InvoiceLine', id: `i1#lines${i}`, fields: { amount: a, owner: 'i1' } })),
  ]});
  it('sumOverCollection: forbids mismatched totals, permits exact and unknown', () => {
    expect(evaluateCandidate(sum(), st([3, 4], 7))).toBe('permit');
    expect(evaluateCandidate(sum(), st([3, 4], 8))).toBe('forbid');
    expect(evaluateCandidate(sum({ op: 'le' }), st([3, 4], 9))).toBe('forbid');   // total <= sum fails: 9 > 7
    expect(evaluateCandidate(sum(), { entities: [{ type: 'Invoice', id: 'i1', fields: {} }] })).toBe('permit'); // unknown
  });

  // Task 11: value semantics — witnesses (post-remap, see witness.ts's remapValueKeys) store a
  // value field's sub-fields under a dotted key (e.g. 'period.start'), matching the dotted Path
  // resolveFieldPath now resolves. resolveValue's per-segment ref-hop walk would otherwise try to
  // treat 'period' as a ref field and look up an entity by that id — a dotted-key fast path avoids
  // that entirely for value paths.
  describe('resolveValue — dotted-key fast path for value fields', () => {
    it('resolves a value path directly off the dotted witness key', () => {
      expect(resolveValue({ entities: [] }, { type: 'S', id: 's', fields: { 'period.start': 5 } }, ['period', 'start'])).toBe(5);
    });
    it('still falls back to the per-segment walk for ref-hop paths', () => {
      const s: CaseState = { entities: [{ type: 'Plan', id: 'p1', fields: { family: 'storage' } }] };
      const e = { type: 'Subscription', id: 's1', fields: { plan: 'p1' } };
      expect(resolveValue(s, e, ['plan', 'family'])).toBe('storage');
    });
    it('statePredicate judges a value-field comparison from a dotted-key witness', () => {
      const c: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
        body: { kind: 'cmp', op: 'lt',
          left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
          right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };
      const ok: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { 'period.start': 3, 'period.end': 9 } }] };
      const bad: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { 'period.start': 9, 'period.end': 3 } }] };
      expect(evaluateCandidate(c, ok)).toBe('permit');
      expect(evaluateCandidate(c, bad)).toBe('forbid');
    });
  });

  // Defense-in-depth below validateCandidate (which REJECTS any param-bearing candidate as
  // ill-typed — see test/ast/validate-services.test.ts): a param term must never reach the
  // evaluator at runtime either. evalTerm's 'param' case throws rather than silently misjudging.
  it('evalTerm throws on a param term — candidates never carry params (validateCandidate rejects them upstream; this is the runtime backstop)', () => {
    const paramLeak: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['grace'] }, right: { kind: 'param', name: 'delta' } } };
    const s: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { grace: 72 } }] };
    expect(() => evaluateCandidate(paramLeak, s)).toThrow(/param terms/);
  });
});

describe('refsResolve judges a child (slice B2)', () => {
  const c: Candidate = { kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] };

  it('forbids a posting pointing at no account', () => {
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: {} },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', account: 'ghost' } }] })).toBe('forbid');
  });

  it('permits a posting pointing at a real account', () => {
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: {} },
      { type: 'Account', id: 'a1', fields: {} },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', account: 'a1' } }] })).toBe('permit');
  });
});
