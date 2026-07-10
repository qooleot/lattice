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
