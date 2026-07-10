// Tiny hand-built input for fast renderer tests.
import type { GenInput } from './types.js';
import type { LedgerEntry } from '../engine/session.js';

export const tinyInput: GenInput = {
  model: {
    context: 'Bank', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [{
      kind: 'aggregate', name: 'Account',
      fields: [
        { name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'balance', type: { kind: 'prim', prim: 'Int' } },
      ],
      machine: {
        regions: [{ name: 'status', initial: 'open', states: [
          { name: 'open', tags: ['active'] }, { name: 'closed', tags: ['terminal'] }] }],
        transitions: [{ name: 'close', region: 'status', from: ['open'], to: 'closed',
          requires: { kind: 'cmp', op: 'eq',
            left: { kind: 'field', owner: 'self', path: ['balance'] }, right: { kind: 'int', value: 0 } } }],
      },
    }],
  },
  adopted: [{
    id: 'inv-nonneg', name: 'nonNegativeBalance', prior: 1, source: 'seed',
    candidate: { kind: 'statePredicate', aggregate: 'Account',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['balance'] }, right: { kind: 'int', value: 0 } } },
  }],
  ledger: [
    { kind: 'adopted', at: '2026-01-01', invariant: { id: 'inv-nonneg', name: 'nonNegativeBalance', prior: 1, source: 'seed',
        candidate: { kind: 'statePredicate', aggregate: 'Account',
          body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['balance'] }, right: { kind: 'int', value: 0 } } } },
      provenance: 'seed:template' } as LedgerEntry,
  ],
};

// Same shape as tinyInput but with judged verdict witnesses in the ledger, so renderInvariants'
// provenance-comment tests can assert the "witnesses exercising aggregate <Name>" wording without
// perturbing tinyInput (other tasks' tests assert on tinyInput's exact rendered output).
export const witnessedInput: GenInput = {
  model: tinyInput.model,
  adopted: tinyInput.adopted,
  ledger: [
    ...tinyInput.ledger,
    { kind: 'verdict', at: '2026-01-01', witnessId: 'w1', judge: 'permit', question: 'q1', salient: [],
      witness: { entities: [{ id: 'a1', type: 'Account', fields: { balance: 5, status: 'open' } }] } } as LedgerEntry,
    { kind: 'verdict', at: '2026-01-01', witnessId: 'w3', judge: 'forbid', question: 'q2', salient: [],
      witness: { entities: [{ id: 'a2', type: 'Account', fields: { balance: -1, status: 'open' } }] } } as LedgerEntry,
  ],
};

// Exercises the table-kind (unique) invariant path through renderInvariants — mirrors the
// Subscriptions precedent (`oneDraftInvoicePerSubscription`) and commands.test.ts's local docInput.
export const tableInput: GenInput = {
  model: {
    context: 'Docs', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [{
      kind: 'aggregate', name: 'Doc',
      fields: [
        { name: 'docId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'owner', type: { kind: 'prim', prim: 'Text' } },
      ],
      machine: {
        regions: [{ name: 'status', initial: 'draft', states: [
          { name: 'draft', tags: [] }, { name: 'published', tags: [] }] }],
        transitions: [{ name: 'publish', region: 'status', from: ['draft'], to: 'published' }],
      },
    }],
  },
  adopted: [{
    id: 'inv-onepub', name: 'onePublishedPerOwner', prior: 1, source: 'seed',
    candidate: { kind: 'unique', aggregate: 'Doc',
      whileStates: { region: 'status', states: ['published'] }, by: [['owner']] },
  }],
  ledger: [
    { kind: 'adopted', at: '2026-01-01', invariant: { id: 'inv-onepub', name: 'onePublishedPerOwner', prior: 1, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Doc',
          whileStates: { region: 'status', states: ['published'] }, by: [['owner']] } },
      provenance: 'seed:template' } as LedgerEntry,
  ],
};
