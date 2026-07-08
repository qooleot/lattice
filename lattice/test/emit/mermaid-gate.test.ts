// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import mermaid from 'mermaid';
import { machineToMermaid } from '../../src/emit/mermaid/statechart.js';
import { domainToMermaid } from '../../src/emit/mermaid/domainDiagram.js';
import { contextMapToMermaid } from '../../src/emit/mermaid/contextMap.js';
import { specDiagramFiles, workspaceDiagramFiles } from '../../src/emit/mermaid/docs.js';
import { order, model, map } from './mermaid.test.js';
import type { AggregateDef } from '../../src/ast/domain.js';

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

  // Task 3: a guarded transition renders `name [sanitized predicate]` as the edge label —
  // exercise the real mermaid parser so guardLabel's `{}`/`&&`/`||`/`!` sanitization is validated
  // for real, not just asserted by string equality.
  it('statechart with a guarded transition (guard label sanitized: no {}, &&, ||, !)', async () => {
    const guarded: AggregateDef = { kind: 'aggregate', name: 'Invoice', doc: 'An invoice',
      fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' } },
        { name: 'totalDue', type: { kind: 'prim', prim: 'Money' } }],
      machine: { regions: [{ name: 'settlement', initial: 'open',
          states: [{ name: 'open' }, { name: 'paid', tags: ['terminal'] }] }],
        transitions: [{ name: 'settle', region: 'settlement', from: ['open'], to: 'paid',
          requires: { kind: 'and', args: [
            { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
            { kind: 'inState', owner: 'self', region: 'settlement', states: ['open'] }] } }] } };
    const src = machineToMermaid(guarded, guarded.machine!.regions[0]!);
    expect(src).not.toContain('&&');
    expect(src).not.toContain('{');
    expect(src).not.toContain('}');
    expect(src).toContain('[amountPaid >= totalDue and state settlement in (open)]');
    expect(await valid(src)).toBe(true);
  });

  // The `!` (not) branch of guardLabel was previously untested: predToText renders `not X` as
  // `! X` (already space-separated), so a naive `replaceAll('!', 'not ')` produced `not  X` —
  // a double space. Exercise it for real through the mermaid parser.
  it('statechart with a not-guarded transition (guard label: single-space "not ...")', async () => {
    const notGuarded: AggregateDef = { kind: 'aggregate', name: 'Invoice', doc: 'An invoice',
      fields: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true }],
      machine: { regions: [{ name: 'settlement', initial: 'open',
          states: [{ name: 'open' }, { name: 'paid', tags: ['terminal'] }] }],
        transitions: [{ name: 'settle', region: 'settlement', from: ['open'], to: 'paid',
          requires: { kind: 'not', arg: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] } } }] } };
    const src = machineToMermaid(notGuarded, notGuarded.machine!.regions[0]!);
    expect(src).not.toContain('!');
    expect(src).not.toContain('not  '); // no double space after "not" (the bug this test guards against)
    expect(src).toContain('[not state settlement in (paid)]');
    expect(await valid(src)).toBe(true);
  });
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
