import type { DomainModel } from '../src/ast/domain.js';
import type { Candidate } from '../src/ast/invariant.js';

export const traceAModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [], values: [],
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
  events: [], services: []
};

export const traceBModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [{ name: 'InvStatus', values: ['Paid', 'Unpaid'] }], values: [],
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
  events: [], services: []
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
  enums: [], values: [],
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
  events: [], services: []
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
  enums: [], values: [], entities: [], events: [], services: [],
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

// Alloy-routable structural candidate on Invoice — `unique` needs a machine region this fixture's
// Invoice doesn't have, so `cardinality` (also alloy-routed, no whileStates) stands in — used by
// sum-in-solvers tests (Task 9) that need an alloy query whose Hi is NOT itself the sum candidate.
export const someUniqueOnInvoice: Candidate = {
  kind: 'cardinality', aggregate: 'Invoice', where: null, atMost: 99,
};

// Task 9: sum-over-collection candidate — Invoice.totalDue must equal the sum of its InvoiceLine
// amounts (design §6.2/§6.4). Shared across the quint/alloy emitter, salient, and integration tests.
export const sumCandidate: Candidate = {
  kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'eq', total: ['totalDue'],
};

// Task 11: value semantics — a Subscription aggregate with a `period: Period` value field, where
// Period = {start: Date, end: Date, invariant wellOrdered { start < end }}. Shared across
// grammar/evaluate/quint/alloy/implied/templates/integration tests for value path resolution,
// nested-record (quint) / flattened-field (alloy) encoding, and type-carried law instantiation.
export const periodModel: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [], events: [], entities: [], services: [],
  values: [{
    kind: 'value', name: 'Period',
    fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }],
    invariants: [{ name: 'wellOrdered', body: { kind: 'cmp', op: 'lt',
      left: { kind: 'field', owner: 'self', path: ['start'] }, right: { kind: 'field', owner: 'self', path: ['end'] } } }],
  }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'period', type: { kind: 'value', value: 'Period' } }],
  }],
};

// Task 14: golden trace D fixture — invoice-lines domain end-to-end with real solvers (design
// DoD item 3). Combines invoiceLinesModel's nested InvoiceLine collection + totalDue @total with
// periodModel's Period value (wellOrdered invariant) plus a settlement lifecycle (requires/emits)
// and a Billing service performing the settle transition, per the task-14 brief's model spec.
export const traceDModel: DomainModel = {
  context: 'Invoicing', ticksPerDay: 24,
  enums: [], entities: [],
  values: [{
    kind: 'value', name: 'Period',
    fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }],
    invariants: [{ name: 'wellOrdered', body: { kind: 'cmp', op: 'lt',
      left: { kind: 'field', owner: 'self', path: ['start'] }, right: { kind: 'field', owner: 'self', path: ['end'] } } }],
  }],
  aggregates: [{
    kind: 'aggregate', name: 'Invoice',
    fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'period', type: { kind: 'value', value: 'Period' } },
      { name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] },
      { name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'InvoiceLine' } } }],
    entities: [{ kind: 'entity', name: 'InvoiceLine', fields: [
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
      { name: 'draft', tags: [] }, { name: 'open', tags: ['active'] }, { name: 'paid', tags: ['terminal'] }] }],
      transitions: [
        { name: 'finalize', region: 'settlement', from: ['draft'], to: 'open',
          requires: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: 0 } } },
        { name: 'settle', region: 'settlement', from: ['open'], to: 'paid', emits: 'InvoicePaid' }] },
  }],
  events: [{ name: 'InvoicePaid', fields: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' } }] }],
  services: [{ name: 'Billing', methods: [
    { name: 'settle', params: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' } }],
      kind: { performs: { aggregate: 'Invoice', transition: 'settle' } } }] }],
};

// Task 14: H1/H2 sumOverCollection rivals distinguished on totalDue == sum vs totalDue <= sum
// (design §6.2/§6.4) — H1 is the b02 shape (equality is the domain truth for this trace).
export const traceDSumEq: Candidate = {
  kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'eq', total: ['totalDue'],
};
export const traceDSumLe: Candidate = {
  kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'le', total: ['totalDue'],
};

export const revrecModel: DomainModel = {
  context: 'RevRec', ticksPerDay: 24,
  enums: [{ name: 'EntryKind', values: ['Recognition', 'Correction'] }, { name: 'PeriodState', values: ['Open', 'Closed'] }], values: [],
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
  events: [], services: []
};
