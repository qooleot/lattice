import type { AggregateDef, Region } from '../../ast/domain.js';
import type { Predicate } from '../../ast/invariant.js';
import { predToText } from '../code.js';

// Mermaid edge labels can't safely carry the .lat predicate syntax verbatim: `{`/`}` collide with
// stateDiagram-v2's own state-composition brackets, `&&`/`||`/`!` read as odd inline tokens to the
// parser in a label context. Sanitize to plain words so the guard is legible without breaking parse.
const guardLabel = (p: Predicate): string =>
  predToText(p).replaceAll('&&', 'and').replaceAll('||', 'or')
    .replaceAll('{', '(').replaceAll('}', ')').replaceAll('!', 'not ');

/** stateDiagram-v2 for one region: [*]→initial, one labeled edge per declared transition
 *  (guarded transitions append a sanitized `[predicate]` suffix — design §3.6),
 *  @terminal states →[*]. Names are grammar-ID-constrained, hence mermaid-safe (spec §5). */
export function machineToMermaid(agg: AggregateDef, region: Region): string {
  const out = ['stateDiagram-v2', `  [*] --> ${region.initial}`];
  for (const t of (agg.machine?.transitions ?? []).filter(t => t.region === region.name)) {
    const label = `${t.name}${t.requires ? ` [${guardLabel(t.requires)}]` : ''}`;
    for (const f of t.from) out.push(`  ${f} --> ${t.to}: ${label}`);
  }
  for (const s of region.states.filter(s => s.tags?.includes('terminal')))
    out.push(`  ${s.name} --> [*]`);
  return out.join('\n') + '\n';
}
