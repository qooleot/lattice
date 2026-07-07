import { describe, it, expect } from 'vitest';
import { machineToMermaid } from '../../src/emit/mermaid/statechart.js';
import { domainToMermaid } from '../../src/emit/mermaid/domainDiagram.js';
import type { AggregateDef, DomainModel } from '../../src/ast/domain.js';

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
