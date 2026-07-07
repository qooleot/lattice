// Shared mermaid-emit fixtures. Lives outside *.test.ts so mermaid-gate.test.ts
// (jsdom) can import them without re-registering mermaid.test.ts's suites.
import type { AggregateDef, DomainModel } from '../../src/ast/domain.js';
import type { ContextMapModel } from '../../src/ast/contextmap.js';

export const order: AggregateDef = { kind: 'aggregate', name: 'Order', doc: 'A customer order',
  fields: [
    { name: 'orderId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
    { name: 'plan', type: { kind: 'ref', target: 'Catalog.Plan' } },
    { name: 'tags', type: { kind: 'list', of: { kind: 'ref', target: 'Customer' } } },
    { name: 'color', type: { kind: 'enum', enum: 'Color' } },
    { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
  machine: { regions: [{ name: 'fulfillment', initial: 'open',
      states: [{ name: 'open' }, { name: 'shipped', tags: ['terminal'] }, { name: 'lost', tags: ['terminal'] }] }],
    transitions: [
      { name: 'ship', region: 'fulfillment', from: 'open', to: 'shipped' },
      { name: 'vanish', region: 'fulfillment', from: 'open', to: 'lost' }] } };

export const model: DomainModel = { context: 'Shop',
  enums: [{ name: 'Color', values: ['red', 'blue'] }],
  entities: [{ kind: 'entity', name: 'Customer',
    fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [order], events: [] };

export const map: ContextMapModel = { name: 'AcmeBilling',
  contexts: [{ name: 'Subscriptions', path: 'subscriptions' }, { name: 'Catalog', path: 'catalog' },
             { name: 'Billing', path: 'billing' }],
  relationships: [
    { kind: 'upstreamDownstream', left: 'Catalog', right: 'Subscriptions',
      upstreamRoles: ['openHost', 'publishedLanguage'], downstreamRoles: ['anticorruption'], exposes: ['Plan'] },
    { kind: 'sharedKernel', left: 'Billing', right: 'Subscriptions' }] };
