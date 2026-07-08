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
