import { describe, it, expect } from 'vitest';
import { extractSalient, renderWitnessTable, salientKey } from '../../src/engine/salient.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

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
