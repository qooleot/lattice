import type { ContextMapModel, Relationship } from '../../ast/contextmap.js';

// Bare words mermaid 11's flowchart lexer tokenizes before NODE_STRING, so they cannot be
// node ids (verified empirically against mermaid.parse; matching is case-sensitive).
const FLOWCHART_KEYWORDS = new Set([
  'end', 'subgraph', 'graph', 'flowchart', 'style', 'classDef', 'class', 'click',
  'linkStyle', 'interpolate', 'href', 'call',
]);

function nodeId(name: string): string {
  return FLOWCHART_KEYWORDS.has(name) ? `${name}_` : name;
}

function assembleLabelForUpstreamDownstream(rel: Relationship): string {
  let label = 'upstream';

  if (rel.upstreamRoles && rel.upstreamRoles.length > 0) {
    label += ` (${rel.upstreamRoles.join(', ')})`;
  }

  if (rel.exposes && rel.exposes.length > 0) {
    label += ` exposes ${rel.exposes.join(', ')}`;
  }

  if (rel.downstreamRoles && rel.downstreamRoles.length > 0) {
    label += ` / downstream (${rel.downstreamRoles.join(', ')})`;
  }

  return label;
}

function assembleEdge(rel: Relationship): string {
  if (rel.kind === 'upstreamDownstream') {
    const label = assembleLabelForUpstreamDownstream(rel);
    return `  ${nodeId(rel.left)} -- "${label}" --> ${nodeId(rel.right)}`;
  }

  // Symmetric kinds (partnership, sharedKernel)
  if (rel.exposes && rel.exposes.length > 0) {
    const label = `${rel.kind} exposes ${rel.exposes.join(', ')}`;
    return `  ${nodeId(rel.left)} ---|"${label}"| ${nodeId(rel.right)}`;
  }

  return `  ${nodeId(rel.left)} ---|${rel.kind}| ${nodeId(rel.right)}`;
}

export function contextMapToMermaid(map: ContextMapModel): string {
  const out: string[] = ['flowchart LR'];

  // Emit context nodes
  for (const ctx of map.contexts) {
    out.push(`  ${nodeId(ctx.name)}["${ctx.name}"]`);
  }

  // Emit relationship edges
  for (const rel of map.relationships) {
    out.push(assembleEdge(rel));
  }

  return out.join('\n') + '\n';
}
