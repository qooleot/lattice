import type { DomainModel } from '../src/ast/domain.js';
import type { Candidate } from '../src/ast/invariant.js';

export const traceAModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [],
  entities: [
    { kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] },
    { kind: 'entity', name: 'Family', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] },
    { kind: 'entity', name: 'Plan', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'family', type: { kind: 'ref', target: 'Family' } }] }
  ],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'plan', type: { kind: 'ref', target: 'Plan' } }],
    machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [
      { name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] }
  }],
  events: []
};

export const traceBModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [{ name: 'InvStatus', values: ['Paid', 'Unpaid'] }],
  entities: [],
  aggregates: [
    { kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'status', type: { kind: 'enum', enum: 'InvStatus' } },
      { name: 'dueDate', type: { kind: 'prim', prim: 'Date' } }] },
    { kind: 'aggregate', name: 'Subscription', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'grace', type: { kind: 'prim', prim: 'Duration' } },
      { name: 'invoice', type: { kind: 'ref', target: 'Invoice' } }],
      machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [
        { name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Suspended' }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] } }
  ],
  events: []
};

export const graceCandidate = (withGrace: boolean): Candidate => ({
  kind: 'statePredicate', aggregate: 'Subscription',
  body: { kind: 'implies',
    left: { kind: 'and', args: [
      { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['invoice', 'status'] }, right: { kind: 'enumval', enum: 'InvStatus', value: 'Unpaid' } }]},
    right: { kind: 'cmp', op: 'le', left: { kind: 'now' },
      right: withGrace
        ? { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] }, right: { kind: 'field', owner: 'self', path: ['grace'] } }
        : { kind: 'field', owner: 'self', path: ['invoice', 'dueDate'] } } }
});
