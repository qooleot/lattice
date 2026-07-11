import { describe, it, expect } from 'vitest';
import { machineToMermaid } from '../../src/emit/mermaid/statechart.js';
import { domainToMermaid } from '../../src/emit/mermaid/domainDiagram.js';
import { contextMapToMermaid } from '../../src/emit/mermaid/contextMap.js';
import { MD_HEADER, MMD_HEADER, specDiagramFiles, workspaceDiagramFiles } from '../../src/emit/mermaid/docs.js';
import type { AggregateDef, DomainModel } from '../../src/ast/domain.js';
import type { ContextMapModel } from '../../src/ast/contextmap.js';
import { order, model, map, keywordMap } from './fixtures.js';

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

  // predToText renders `not X` as `! X` (space already present before the arg); guardLabel must
  // not double that space when it maps `!` -> `not `. Pin the exact single-space output.
  it('renders a not-guarded transition with a single space after "not"', () => {
    const notGuarded: AggregateDef = { ...order,
      machine: { regions: order.machine!.regions,
        transitions: [{ name: 'ship', region: 'fulfillment', from: ['open'], to: 'shipped',
          requires: { kind: 'not', arg: { kind: 'inState', owner: 'self', region: 'fulfillment', states: ['lost'] } } }] } };
    expect(machineToMermaid(notGuarded, notGuarded.machine!.regions[0]!)).toBe(
`stateDiagram-v2
  [*] --> open
  open --> shipped: ship [not state fulfillment in (lost)]
  shipped --> [*]
  lost --> [*]
`);
  });
});

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

  // Task 10: value objects add TypeRef kind 'value' — domainDiagram's typeStr must not crash on
  // it (mirrors code.ts's typeStr); a value-typed field prints as an ordinary member, same as enum.
  it('renders a value-typed field as an ordinary class member', () => {
    const withValue: DomainModel = { context: 'Billing',
      enums: [], values: [{ kind: 'value', name: 'Period',
        fields: [{ name: 'start', type: { kind: 'prim', prim: 'Date' } }, { name: 'end', type: { kind: 'prim', prim: 'Date' } }] }],
      entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Lease', fields: [
        { name: 'leaseId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'term', type: { kind: 'value', value: 'Period' } }] }],
      events: [], services: [] };
    expect(domainToMermaid(withValue)).toContain('+term : Period');
  });

  // const field (Plan 3a Task 3): printer/mermaid round-trip fidelity — a const:true field
  // renders the «readonly» stereotype after «key» in the class member line.
  it('renders a const field with a «readonly» stereotype', () => {
    const withConst: DomainModel = { context: 'Billing',
      enums: [], values: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Lease', fields: [
        { name: 'leaseId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'startDate', type: { kind: 'prim', prim: 'Date' }, const: true }] }],
      events: [], services: [] };
    expect(domainToMermaid(withConst)).toContain('+startDate : Date «readonly»');
  });

  // Task 12: services (design §3.6) — a <<service>> class box (no fields, one +method(params)
  // member per method) plus one dashed dependency edge per distinct performed/created aggregate.
  it('renders a service class box and dashed dependency edges', () => {
    const withService: DomainModel = { context: 'Billing',
      enums: [], values: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Subscription', fields: [
        { name: 'subId', type: { kind: 'prim', prim: 'Id' }, key: true }],
        machine: { regions: [{ name: 'Access', initial: 'trialing',
            states: [{ name: 'trialing' }, { name: 'active', tags: ['terminal'] }] }],
          transitions: [{ name: 'activate', region: 'Access', from: ['trialing'], to: 'active' }] } }],
      events: [],
      services: [{ name: 'SubscriptionOps', methods: [
        { name: 'createSubscription', params: [{ name: 'seats', type: { kind: 'prim', prim: 'Int' } }], kind: { creates: 'Subscription' } },
        { name: 'activate', params: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }], kind: { performs: { aggregate: 'Subscription', transition: 'activate' } } },
        { name: 'getSubscription', params: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }], kind: { readOnly: true } },
      ] }] };
    const src = domainToMermaid(withService);
    expect(src).toContain('class SubscriptionOps {');
    expect(src).toContain('<<service>>');
    expect(src).toContain('+createSubscription(seats)');
    expect(src).toContain('+activate(subId)');
    expect(src).toContain('+getSubscription(subId)');
    expect(src).toContain('SubscriptionOps ..> Subscription : createSubscription');
    // dedupe: only ONE edge to Subscription even though two methods target it
    expect(src.split('SubscriptionOps ..> Subscription').length - 1).toBe(1);
  });
});

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
  it('escapes node ids that collide with mermaid flowchart keywords, keeping labels exact', () => {
    expect(contextMapToMermaid(keywordMap)).toBe(
`flowchart LR
  end_["end"]
  subgraph_["subgraph"]
  Billing["Billing"]
  end_ -- "upstream" --> Billing
  Billing ---|sharedKernel| subgraph_
`);
  });
});

describe('specDiagramFiles', () => {
  it('assembles spec.diagrams.md + one CD + one SD per aggregate-region', () => {
    const files = specDiagramFiles(model);
    expect(files.map(f => f.relPath)).toEqual(
      ['spec.diagrams.md', 'diagrams/CD_Shop.mmd', 'diagrams/SD_Order_fulfillment.mmd']);

    const [md, cd, sd] = files;
    expect(md!.content.startsWith(MD_HEADER)).toBe(true);
    expect(cd!.content.startsWith(MMD_HEADER)).toBe(true);
    expect(sd!.content.startsWith(MMD_HEADER)).toBe(true);

    // the md embeds the Task-9 golden statechart output inside a ```mermaid fence
    const fenced = '```mermaid\n' + machineToMermaid(order, order.machine!.regions[0]!) + '```';
    expect(md!.content).toContain(fenced);
    expect(md!.content).toContain('# Shop — diagrams');
    expect(md!.content).toContain('## Domain');
    expect(md!.content).toContain('## Order — fulfillment');
  });

  it('generates what is modeled: no machines yields no SD files and no statechart sections', () => {
    const noMachineModel: DomainModel = { ...model,
      aggregates: model.aggregates.map(a => ({ ...a, machine: undefined })) };
    const files = specDiagramFiles(noMachineModel);
    expect(files.map(f => f.relPath)).toEqual(['spec.diagrams.md', 'diagrams/CD_Shop.mmd']);
    expect(files[0]!.content).not.toContain('stateDiagram-v2');
    expect(files[0]!.content).not.toContain('## Order — fulfillment');
  });
});

describe('workspaceDiagramFiles', () => {
  it('assembles context-map.generated.md + diagrams/context-map.mmd with a Relationships section', () => {
    const files = workspaceDiagramFiles(map);
    expect(files.map(f => f.relPath)).toEqual(['context-map.generated.md', 'diagrams/context-map.mmd']);

    const [genMd, mmd] = files;
    expect(genMd!.content.startsWith(MD_HEADER)).toBe(true);
    expect(mmd!.content.startsWith(MMD_HEADER)).toBe(true);
    expect(genMd!.content).toContain('# AcmeBilling — context map');
    expect(genMd!.content).toContain('```mermaid\n' + contextMapToMermaid(map) + '```');
    expect(genMd!.content).toContain('## Relationships');
    expect(genMd!.content).toContain('- Catalog upstreamDownstream Subscriptions');
    expect(genMd!.content).toContain('- Billing sharedKernel Subscriptions');
  });
});
