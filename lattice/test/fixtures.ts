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

// Mirrors the live `.lattice-session-subscriptions` shape that exposed the adopted-invariant
// leak: Invoice drafts reference a Subscription, and an adopted `unique` invariant forbids two
// Draft invoices for the same subscription — while the elicitation loop is still distinguishing
// unrelated Subscription statePredicate candidates on the quint route.
export const invoicingModel: DomainModel = {
  context: 'Invoicing', ticksPerDay: 24,
  enums: [],
  entities: [],
  aggregates: [
    { kind: 'aggregate', name: 'Subscription', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'grace', type: { kind: 'prim', prim: 'Duration' } }],
      machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [
        { name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }], transitions: [] } },
    { kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'subscription', type: { kind: 'ref', target: 'Subscription' } }],
      machine: { regions: [{ name: 'Lifecycle', initial: 'Draft', states: [
        { name: 'Draft' }, { name: 'Finalized', tags: ['terminal'] }] }], transitions: [] } }
  ],
  events: []
};

export const draftInvoiceUnique: Candidate = { kind: 'unique', aggregate: 'Invoice',
  whileStates: { region: 'Lifecycle', states: ['Draft'] }, by: [['subscription']] };

// Two quint-routed (arith cmp) Subscription candidates whose subject matter is unrelated to
// Invoice uniqueness — distinguishable at grace = 72 (le 72 holds, le 24 fails).
export const graceCap = (hours: number): Candidate => ({
  kind: 'statePredicate', aggregate: 'Subscription',
  where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
  body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['grace'] }, right: { kind: 'int', value: hours } }
});

// Task 5/6: an Invoice aggregate with an owned collection of InvoiceLine children (design §3.2 /
// §6.1). Shared across emit/adapter/evaluator tests. Carries `totalDue: Money @total` so later
// (sum-over-collection) tasks can reuse this same fixture without another variant.
export const invoiceLinesModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [], entities: [], events: [],
  aggregates: [{
    kind: 'aggregate', name: 'Invoice',
    fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] },
      { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'InvoiceLine' } } }],
    entities: [{ kind: 'entity', name: 'InvoiceLine', fields: [
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
  }],
};

export const someStatePredicateOnInvoice: Candidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: 0 } },
};

export const revrecModel: DomainModel = {
  context: 'RevRec', ticksPerDay: 24,
  enums: [{ name: 'EntryKind', values: ['Recognition', 'Correction'] }, { name: 'PeriodState', values: ['Open', 'Closed'] }],
  entities: [
    { kind: 'entity', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'monotonic'] },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] },
    { kind: 'entity', name: 'RevenueEntry', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'obligation', type: { kind: 'ref', target: 'Obligation' } },
      { name: 'period', type: { kind: 'ref', target: 'AccountingPeriod' } },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'kind', type: { kind: 'enum', enum: 'EntryKind' } },
      { name: 'postedAt', type: { kind: 'prim', prim: 'Date' } }] }
  ],
  aggregates: [{ kind: 'aggregate', name: 'AccountingPeriod', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'closedAt', type: { kind: 'prim', prim: 'Date' } },
      { name: 'lockWindow', type: { kind: 'prim', prim: 'Duration' } }],
    machine: { regions: [{ name: 'Lifecycle', initial: 'Open', states: [
      { name: 'Open', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }], transitions: [] } }],
  events: []
};
