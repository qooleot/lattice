import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';

// Regression for the E2E-surfaced bug: a QUALIFIED (cross-context) ref field drew from a
// non-existent `<TARGET>_IDS` pool (e.g. `oneOf(CATALOG.PLAN_IDS)`) → quint QNT404 "Name 'CATALOG'
// not found". Qualified refs (spec §4.2) are opaque, never-traversed ids with no in-model pool, so
// the init draw must use an inline opaque string set. A same-context ref still draws from its pool.
const model: DomainModel = {
  context: 'Subscriptions',
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'subId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'plan', type: { kind: 'ref', target: 'Catalog.Plan' } },   // qualified / cross-context
      { name: 'latestInvoice', type: { kind: 'ref', target: 'Invoice' } }, // same-context
    ],
    machine: { regions: [{ name: 'status', initial: 'trialing', states: [{ name: 'trialing' }, { name: 'active' }] }], transitions: [] },
  }, {
    kind: 'aggregate', name: 'Invoice',
    fields: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'settlement', initial: 'draft', states: [{ name: 'draft' }] }], transitions: [] },
  }],
  entities: [], enums: [], values: [], events: [], services: [],
} as unknown as DomainModel;

const trueProbe: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } };

describe('astToQuint qualified (cross-context) ref init draw', () => {
  const em = astToQuint(model, { kind: 'probe-permit', hi: trueProbe, exclusions: [], maxSteps: 1 });
  it('does NOT reference a pool for the foreign type (no CATALOG.PLAN_IDS)', () => {
    expect(em.source).not.toContain('CATALOG.PLAN_IDS');
    expect(em.source).not.toMatch(/oneOf\(CATALOG/);
  });
  it('draws the qualified ref from an inline opaque string set', () => {
    expect(em.source).toContain('nondet nd_subscription_plan = oneOf(Set("plan_x", "plan_y"))');
  });
  it('still draws a same-context ref from its declared _IDS pool', () => {
    expect(em.source).toContain('oneOf(INVOICE_IDS)');
  });
});
