import { describe, it, expect } from 'vitest';
import { machineToMermaid } from '../../src/emit/mermaid/statechart.js';
import { domainToMermaid } from '../../src/emit/mermaid/domainDiagram.js';
import { contextMapToMermaid } from '../../src/emit/mermaid/contextMap.js';
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

describe('machineToMermaid', () => {
  it('renders initial, transitions (labeled), terminals', () => {
    expect(machineToMermaid(order, order.machine!.regions[0]!)).toBe(
`stateDiagram-v2
  [*] --> open
  open --> shipped: ship
  open --> lost: vanish
  shipped --> [*]
  lost --> [*]
`);
  });
  it('renders a region with no transitions as states only', () => {
    const bare: AggregateDef = { ...order, machine: { regions: order.machine!.regions, transitions: [] } };
    expect(machineToMermaid(bare, bare.machine!.regions[0]!)).toBe(
`stateDiagram-v2
  [*] --> open
  shipped --> [*]
  lost --> [*]
`);
  });
});

export const model: DomainModel = { context: 'Shop',
  enums: [{ name: 'Color', values: ['red', 'blue'] }],
  entities: [{ kind: 'entity', name: 'Customer',
    fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [order], events: [] };

describe('domainToMermaid', () => {
  it('renders namespace, enum class, external stub, and associations', () => {
    expect(domainToMermaid(model)).toBe(
`classDiagram
  namespace Shop {
    class Customer {
      +id : Id «key»
    }
    class Order {
      +orderId : Id «key»
      +color : Color
      +total : Money
    }
    class Color {
      <<enumeration>>
      red
      blue
    }
  }
  class Catalog_Plan["Catalog.Plan"] {
    <<external>>
  }
  Order --> Customer : customer
  Order "1" --> "*" Customer : tags
  Order ..> Catalog_Plan : plan
`);
  });
});

export const map: ContextMapModel = { name: 'AcmeBilling',
  contexts: [{ name: 'Subscriptions', path: 'subscriptions' }, { name: 'Catalog', path: 'catalog' },
             { name: 'Billing', path: 'billing' }],
  relationships: [
    { kind: 'upstreamDownstream', left: 'Catalog', right: 'Subscriptions',
      upstreamRoles: ['openHost', 'publishedLanguage'], downstreamRoles: ['anticorruption'], exposes: ['Plan'] },
    { kind: 'sharedKernel', left: 'Billing', right: 'Subscriptions' }] };

describe('contextMapToMermaid', () => {
  it('renders contexts and keyword-labeled relationship edges', () => {
    expect(contextMapToMermaid(map)).toBe(
`flowchart LR
  Subscriptions["Subscriptions"]
  Catalog["Catalog"]
  Billing["Billing"]
  Catalog -- "upstream (openHost, publishedLanguage) exposes Plan / downstream (anticorruption)" --> Subscriptions
  Billing ---|sharedKernel| Subscriptions
`);
  });
  it('renders a bare upstream edge without roles or exposes', () => {
    const bareMap: ContextMapModel = { name: 'M',
      contexts: [{ name: 'A', path: 'a' }, { name: 'B', path: 'b' }],
      relationships: [{ kind: 'upstreamDownstream', left: 'A', right: 'B' }] };
    expect(contextMapToMermaid(bareMap)).toContain('  A -- "upstream" --> B');
  });
});
