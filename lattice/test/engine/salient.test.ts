import { describe, it, expect } from 'vitest';
import { extractSalient, renderWitnessTable, salientKey } from '../../src/engine/salient.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';
import { sumCandidate } from '../fixtures.js';

const uniq: Candidate = { kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] };
const uniqPerPlan: Candidate = { kind: 'unique', aggregate: 'Subscription',
  whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

const dpsf: CaseState = { entities: [
  { type: 'Customer', id: 'c1', fields: {} },
  { type: 'Family', id: 'storage', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'storage' } },
  { type: 'Plan', id: 'p2', fields: { family: 'storage' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};

describe('extractSalient', () => {
  it('captures pairwise equality dims for structural candidates', () => {
    const facts = extractSalient([uniq, uniqPerPlan], dpsf);
    const byDim = Object.fromEntries(facts.map(f => [f.dim, f.value]));
    expect(byDim['customer equal']).toBe(true);
    expect(byDim['plan equal']).toBe(false);
    expect(byDim['plan.family equal']).toBe(true);
  });
  it('captures comparison dims for arithmetic candidates', () => {
    const grace: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'le', left: { kind: 'now' },
        right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } } } };
    const s: CaseState = { now: 220, entities: [{ type: 'Subscription', id: 's1', fields: { dueDate: 100, grace: 72 } }] };
    const facts = extractSalient([grace], s);
    expect(facts.find(f => f.dim === 'now le dueDate + grace')!.value).toBe(false);
  });
  it('captures field-field eq/ne dims and avoids duplicate enum-eq dims', () => {
    const fieldEqPred: Candidate = { kind: 'statePredicate', aggregate: 'Order',
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['a'] }, right: { kind: 'field', owner: 'self', path: ['b'] } } };
    const s1: CaseState = { entities: [{ type: 'Order', id: 'o1', fields: { a: 1, b: 1 } }] };
    const facts1 = extractSalient([fieldEqPred], s1);
    expect(facts1.find(f => f.dim === 'a eq b')!.value).toBe(true);

    const s2: CaseState = { entities: [{ type: 'Order', id: 'o2', fields: { a: 1, b: 2 } }] };
    const facts2 = extractSalient([fieldEqPred], s2);
    expect(facts2.find(f => f.dim === 'a eq b')!.value).toBe(false);

    // Field-eq-enumval should only produce one dim (the enum form), not a duplicate eq form
    const fieldEnumPred: Candidate = { kind: 'statePredicate', aggregate: 'Order',
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['kind'] }, right: { kind: 'enumval', enum: 'OrderKind', value: 'Correction' } } };
    const s3: CaseState = { entities: [{ type: 'Order', id: 'o3', fields: { kind: 'Correction' } }] };
    const facts3 = extractSalient([fieldEnumPred], s3);
    const kindDims = facts3.filter(f => f.dim.includes('kind'));
    expect(kindDims).toHaveLength(1);
    expect(kindDims[0]!.dim).toBe('kind = Correction');
  });
});

// Task 9: sum-over-collection salient dims (design §6.2/§6.4) — reuses evaluate.test.ts's `sum`/`st`
// fixture convention: an Invoice with `totalDue` + `lines.count` fields, owning InvoiceLine children
// via `owner: '<parent id>'`.
const st = (amounts: number[], total: number): CaseState => ({ entities: [
  { type: 'Invoice', id: 'i1', fields: { totalDue: total, 'lines.count': amounts.length } },
  ...amounts.map((a, i) => ({ type: 'InvoiceLine', id: `i1#lines${i}`, fields: { amount: a, owner: 'i1' } })),
]});

describe('extractSalient — sumOverCollection dims (masking regressions)', () => {
  it('captures count/sum/total dims for a single-subject witness', () => {
    const facts = extractSalient([sumCandidate], st([3, 4], 7));
    const byDim = Object.fromEntries(facts.map(f => [f.dim, f.value]));
    expect(byDim['lines.count']).toBe(2);
    expect(byDim['sum(lines.amount)']).toBe(7);
    expect(byDim['totalDue value']).toBe(7);
  });
  it('sum dims: same count+sum+total ⇒ same salient key regardless of row split (shape may exclude both)', () => {
    const a = extractSalient([sumCandidate], st([3, 4], 7));
    const b = extractSalient([sumCandidate], st([5, 2], 7));
    expect(salientKey(a)).toBe(salientKey(b));
  });
  it('sum dims: different sums ⇒ different keys (a judged shape must not cancel a distinct pair)', () => {
    const a = extractSalient([sumCandidate], st([3, 4], 7));
    const b = extractSalient([sumCandidate], st([3, 5], 7));
    expect(salientKey(a)).not.toBe(salientKey(b));
  });
  it('sum dims: two subjects disagreeing on sums drop the dim (all-subjects-agree)', () => {
    const twoInvoices: CaseState = { entities: [...st([3], 3).entities,
      { type: 'Invoice', id: 'i2', fields: { totalDue: 9, 'lines.count': 1 } },
      { type: 'InvoiceLine', id: 'i2#lines0', fields: { amount: 9, owner: 'i2' } }] };
    expect(extractSalient([sumCandidate], twoInvoices).map(f => f.dim)).not.toContain('sum(lines.amount)');
  });
});

// Task 11: value semantics (design §3.5) — renderTerm already joins a field path with '.', so a
// value-hop path (['period', 'start']) renders as the dotted dim key `period.start` with no code
// changes needed; resolveFieldPath (grammar.ts) now resolves that same dotted key back through
// its value hop. This is the salient-side verification the task-11 brief asks for.
describe('extractSalient — value-field (dotted) comparison dims', () => {
  it('renders a comparison dim over value sub-field paths as dotted, matching resolveFieldPath', () => {
    const periodCmp: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt',
        left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };
    const s: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { 'period.start': 3, 'period.end': 9 } }] };
    const facts = extractSalient([periodCmp], s);
    expect(facts.find(f => f.dim === 'period.start lt period.end')!.value).toBe(true);
  });
});

describe('renderWitnessTable', () => {
  it('renders a deterministic markdown table with humanized ticks', () => {
    const s: CaseState = { now: 220, entities: [
      { type: 'Invoice', id: 'i1', fields: { status: 'Unpaid', dueDate: 100 } },
      { type: 'Subscription', id: 's1', fields: { grace: 72, invoice: 'i1', 'Access.state': 'Active' } }
    ]};
    const t = renderWitnessTable(s, 24);
    expect(t).toContain('| Subscription |');
    expect(t).toContain('Access.state: Active');
    expect(t).toContain('grace: 72 ticks (3 days)');
    expect(t).toContain('now = 220 ticks');
  });
});

describe('salientKey', () => {
  it('is order-insensitive', () => {
    expect(salientKey([{ dim: 'a', value: 1 }, { dim: 'b', value: true }]))
      .toBe(salientKey([{ dim: 'b', value: true }, { dim: 'a', value: 1 }]));
  });
});
