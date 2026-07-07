// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import mermaid from 'mermaid';
import { machineToMermaid } from '../../src/emit/mermaid/statechart.js';
import { domainToMermaid } from '../../src/emit/mermaid/domainDiagram.js';
import { contextMapToMermaid } from '../../src/emit/mermaid/contextMap.js';
import { specDiagramFiles, workspaceDiagramFiles } from '../../src/emit/mermaid/docs.js';
import { order, model, map, keywordMap } from './mermaid.test.js';

mermaid.initialize({ startOnLoad: false });
// mermaid.parse with suppressErrors:false never resolves to `false` — it resolves to a
// ParseResult on success or throws on invalid syntax (see mermaid's ParseOptions/parse docs).
// So "parses cleanly" is just "did not throw".
const valid = async (src: string) => {
  await mermaid.parse(src, { suppressErrors: false });
  return true;
};

describe('generated mermaid parses (the GitHub-renderability gate)', () => {
  it('statechart', async () => expect(await valid(machineToMermaid(order, order.machine!.regions[0]!))).toBe(true));
  it('domain diagram (incl. «key», List~T~, external stub, namespace)', async () =>
    expect(await valid(domainToMermaid(model))).toBe(true));
  it('context map (incl. label edges and ---|kind| edges)', async () =>
    expect(await valid(contextMapToMermaid(map))).toBe(true));
  it('context map with contexts named after flowchart keywords (end, subgraph)', async () =>
    expect(await valid(contextMapToMermaid(keywordMap))).toBe(true));
});

/** Extracts every ```mermaid ... ``` fenced block from a markdown document. */
function extractMermaidBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) blocks.push(m[1]!);
  return blocks;
}

describe('assembled docs mermaid blocks parse (spec.diagrams.md / context-map.generated.md)', () => {
  it('every block embedded in specDiagramFiles\' spec.diagrams.md parses', async () => {
    const md = specDiagramFiles(model).find(f => f.relPath === 'spec.diagrams.md')!;
    const blocks = extractMermaidBlocks(md.content);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(await valid(b)).toBe(true);
  });

  it('every block embedded in workspaceDiagramFiles\' context-map.generated.md parses', async () => {
    const md = workspaceDiagramFiles(map).find(f => f.relPath === 'context-map.generated.md')!;
    const blocks = extractMermaidBlocks(md.content);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(await valid(b)).toBe(true);
  });
});
