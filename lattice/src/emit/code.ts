import type { DomainModel, Field } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import { renderCandidateEnglish } from './prose.js';

const typeStr = (f: Field): string =>
  f.type.kind === 'prim' ? f.type.prim : f.type.kind === 'enum' ? f.type.enum
  : f.type.kind === 'ref' ? `ref ${f.type.target}` : `List<${typeStr({ ...f, type: f.type.of })}>`;

export function astToCode(m: DomainModel, adopted: CandidateInvariant[]): string {
  const pad = (n: string, w: number) => n + ' '.repeat(Math.max(1, w - n.length));
  const out: string[] = [`context ${m.context} {`, ''];
  for (const e of m.enums) out.push(`  enum ${e.name} { ${e.values.join(', ')} }`);
  if (m.enums.length) out.push('');
  for (const ent of m.entities) {
    out.push(`  entity ${ent.name} {`);
    const w = Math.max(...ent.fields.map(f => f.name.length)) + 1;
    for (const f of ent.fields) out.push(`    ${pad(f.name, w)}: ${typeStr(f)}${f.key ? ' key' : ''}${f.tags?.length ? '  @' + f.tags.join(' @') : ''}`);
    out.push('  }', '');
  }
  for (const a of m.aggregates) {
    out.push(`  aggregate ${a.name} {`);
    const w = Math.max(...a.fields.map(f => f.name.length)) + 1;
    for (const f of a.fields) out.push(`    ${pad(f.name, w)}: ${typeStr(f)}${f.key ? ' key' : ''}${f.tags?.length ? '  @' + f.tags.join(' @') : ''}`);
    if (a.machine) {
      out.push('    machine {');
      for (const r of a.machine.regions) {
        const states = r.states.map(s => s.name + (s.tags?.length ? ' @' + s.tags.join(' @') : '')).join(', ');
        out.push(`      region ${r.name} { states { ${states} } }`);
      }
      for (const t of a.machine.transitions)
        out.push(`      transition ${t.name} { region ${t.region}; from ${t.from} to ${t.to}${t.when ? `; when ${t.when}` : ''} }`);
      out.push('    }');
    }
    for (const inv of adopted.filter(i => i.candidate.aggregate === a.name)) {
      const c = inv.candidate;
      if (c.kind === 'unique') out.push(`    unique while ${c.whileStates.states.join('/')} by (${c.by.map(p => p.join('.')).join(', ')})`);
      else out.push(`    invariant ${inv.name} {}  // ${renderCandidateEnglish(c)}`);
    }
    out.push('  }', '');
  }
  // context-level invariants on entities
  for (const inv of adopted.filter(i => !m.aggregates.some(a => a.name === i.candidate.aggregate)))
    out.push(`  invariant ${inv.name} {}  // ${renderCandidateEnglish(inv.candidate)}`);
  out.push('}');
  return out.join('\n') + '\n';
}
