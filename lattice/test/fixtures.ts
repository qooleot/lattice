import type { DomainModel } from '../src/ast/domain.js';
import type { Candidate, CandidateInvariant } from '../src/ast/invariant.js';

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
export const someCardinalityOnInvoice: Candidate = {
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

// Plan 2 Task 3 (astToQuintClassify integration): the committed Subscriptions model, transcribed
// from specs/subscriptions/spec.lat + .lattice-session-subscriptions/model.json. The only
// deviation is the `plan: ref Catalog.Plan` field, DROPPED here: it is an external qualified ref
// (fieldQType renders it as opaque `str`, initValue would emit `oneOf(CATALOG.PLAN_IDS)` — an
// undefined pool with an illegal dotted identifier — so the machine can't be emitted standalone,
// exactly the substitution the spike made by hand). `plan` is read by no invariant under test, so
// dropping it changes nothing about the paid-conjunct consecution. Both aggregates + their real
// transition guards (notably settle's `amountPaid == totalDue`) are kept verbatim.
export const subscriptionsModel: DomainModel = {
  context: 'Subscriptions', ticksPerDay: 24,
  enums: [], values: [], entities: [],
  aggregates: [
    {
      kind: 'aggregate', name: 'Subscription',
      fields: [
        { name: 'subId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'seats', type: { kind: 'prim', prim: 'Int' } },
        { name: 'periodStart', type: { kind: 'prim', prim: 'Date' } },
        { name: 'periodEnd', type: { kind: 'prim', prim: 'Date' } },
        { name: 'accruedUnits', type: { kind: 'prim', prim: 'Int' } },
        { name: 'paidInvoiceCount', type: { kind: 'prim', prim: 'Int' } },
        { name: 'maxRetries', type: { kind: 'prim', prim: 'Int' } },
        { name: 'latestInvoice', type: { kind: 'ref', target: 'Invoice' } }],
      machine: {
        regions: [{ name: 'status', initial: 'trialing', states: [
          { name: 'trialing' }, { name: 'active', tags: ['active'] }, { name: 'pastDue', tags: ['active'] },
          { name: 'canceled', tags: ['terminal'] }, { name: 'expired', tags: ['terminal'] }] }],
        transitions: [
          { name: 'activate', region: 'status', from: ['trialing'], to: 'active', emits: 'SubscriptionActivated',
            requires: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] }, right: { kind: 'int', value: 1 } } },
          { name: 'expireTrial', region: 'status', from: ['trialing'], to: 'expired' },
          { name: 'paymentFailed', region: 'status', from: ['active'], to: 'pastDue' },
          { name: 'recover', region: 'status', from: ['pastDue'], to: 'active' },
          { name: 'cancel', region: 'status', from: ['trialing', 'active', 'pastDue'], to: 'canceled', emits: 'SubscriptionCanceled' },
          { name: 'dunningExhausted', region: 'status', from: ['pastDue'], to: 'canceled' }],
      },
    },
    {
      kind: 'aggregate', name: 'Invoice',
      fields: [
        { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'subscription', type: { kind: 'ref', target: 'Subscription' } },
        { name: 'licenseFeeAmount', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] },
        { name: 'usageAmount', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] },
        { name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] },
        { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'retryCount', type: { kind: 'prim', prim: 'Int' } }],
      machine: {
        regions: [{ name: 'settlement', initial: 'draft', states: [
          { name: 'draft' }, { name: 'open', tags: ['active'] }, { name: 'paid', tags: ['terminal'] },
          { name: 'void', tags: ['terminal'] }, { name: 'uncollectible', tags: ['terminal'] }] }],
        transitions: [
          { name: 'finalize', region: 'settlement', from: ['draft'], to: 'open', emits: 'InvoiceFinalized',
            requires: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
              right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['licenseFeeAmount'] }, right: { kind: 'field', owner: 'self', path: ['usageAmount'] } } } },
          { name: 'settle', region: 'settlement', from: ['open'], to: 'paid', emits: 'InvoicePaid',
            requires: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } },
          { name: 'voidDraft', region: 'settlement', from: ['draft'], to: 'void' },
          { name: 'voidOpen', region: 'settlement', from: ['open'], to: 'void' },
          { name: 'writeOff', region: 'settlement', from: ['open'], to: 'uncollectible' }],
      },
    },
  ],
  events: [
    { name: 'SubscriptionActivated', fields: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }] },
    { name: 'SubscriptionCanceled', fields: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }] },
    { name: 'InvoicePaid', fields: [{ name: 'invoiceId', type: { kind: 'prim', prim: 'Id' } }] },
    { name: 'InvoiceFinalized', fields: [{ name: 'invoiceId', type: { kind: 'prim', prim: 'Id' } }] }],
  // Plan 2b Task 5 (method⊨transition): the committed SubscriptionService.activate performs the
  // `activate` transition (guard `paidInvoiceCount >= 1`) but declares NO `requires` — the worked
  // "method weaker than guard" example (design §5). Its `subId` param is an Id (no quint pool),
  // so it is drawn-skipped by the harness; the undefined `requires` renders as the weakest antecedent.
  services: [{ name: 'SubscriptionService', methods: [
    { name: 'activate', params: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }],
      kind: { performs: { aggregate: 'Subscription', transition: 'activate' } } }] }],
};

// The `state settlement in {paid} => amountPaid == totalDue` conjunct of the committed Invoice
// invariant Never_Overpaid_And_Paid_Exact (the second `and` arg; transcribed from the ledger's
// adopted entry). Its consecution is forced by settle's guard (`amountPaid == totalDue`), the only
// transition into `paid` — the worked-example verdict for the classifier's consecution probe.
export const paidImpliesExactConjunct: Candidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  body: { kind: 'implies',
    left: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
    right: { kind: 'cmp', op: 'eq',
      left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
      right: { kind: 'field', owner: 'self', path: ['totalDue'] } } },
};
export const paidInvFixture: CandidateInvariant = {
  id: 'paid-conjunct', name: 'paidImpliesExactConjunct', prior: 1, source: 'template',
  candidate: paidImpliesExactConjunct,
};

// The committed Subscriptions coupling invariant (specs/subscriptions/spec.lat:46) — a Subscription
// statePredicate that ref-hops into its `latestInvoice` (design §5's corrected worked example): NOT
// guard-enforced, so its reachability probe finds a real counterexample (`recover`/`activate` reach
// `active` with an unpaid `latestInvoice`) — the classifier's `violated` verdict, not `entailed`.
export const activePaidInFullCandidate: Candidate = {
  kind: 'statePredicate', aggregate: 'Subscription',
  where: { kind: 'inState', owner: 'self', region: 'status', states: ['active'] },
  body: { kind: 'cmp', op: 'eq',
    left: { kind: 'field', owner: 'self', path: ['latestInvoice', 'amountPaid'] },
    right: { kind: 'field', owner: 'self', path: ['latestInvoice', 'totalDue'] } },
};
export const activePaidInFullFixture: CandidateInvariant = {
  id: 'active-paid-in-full', name: 'activePaidInFull', prior: 1, source: 'template',
  candidate: activePaidInFullCandidate,
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
