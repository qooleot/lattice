import type { AggregateDef, Region } from '../../ast/domain.js';

/** stateDiagram-v2 for one region: [*]→initial, one labeled edge per declared transition,
 *  @terminal states →[*]. Names are grammar-ID-constrained, hence mermaid-safe (spec §5). */
export function machineToMermaid(agg: AggregateDef, region: Region): string {
  const out = ['stateDiagram-v2', `  [*] --> ${region.initial}`];
  for (const t of (agg.machine?.transitions ?? []).filter(t => t.region === region.name))
    for (const f of t.from) out.push(`  ${f} --> ${t.to}: ${t.name}`);
  for (const s of region.states.filter(s => s.tags?.includes('terminal')))
    out.push(`  ${s.name} --> [*]`);
  return out.join('\n') + '\n';
}
