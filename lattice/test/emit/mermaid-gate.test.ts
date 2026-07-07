// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import mermaid from 'mermaid';
import { machineToMermaid } from '../../src/emit/mermaid/statechart.js';
import { domainToMermaid } from '../../src/emit/mermaid/domainDiagram.js';
import { contextMapToMermaid } from '../../src/emit/mermaid/contextMap.js';
import { order, model, map } from './mermaid.test.js';

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
});
