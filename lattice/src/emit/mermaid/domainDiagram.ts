import type { AggregateDef, DomainModel, EntityDef, EnumDef, Field, TypeRef } from '../../ast/domain.js';
import { isQualifiedRef } from '../../ast/domain.js';

/** Type text for non-ref fields only — mirrors code.ts's typeStr but prints list as List~T~
 *  (mermaid classDiagram generics syntax). Never called on ref/list-of-ref (those are associations). */
function typeStr(t: TypeRef): string {
  switch (t.kind) {
    case 'prim': return t.prim;
    case 'enum': return t.enum;
    case 'value': return t.value;
    case 'list': return `List~${typeStr(t.of)}~`;
    case 'ref': throw new Error(`typeStr: ref ${t.target} should have been filtered as an association`);
  }
}

const stubId = (target: string) => target.replace('.', '_');

function classLines(name: string, fields: Field[], out: string[]): void {
  out.push(`    class ${name} {`);
  for (const f of fields) {
    if (f.type.kind === 'ref' || f.type.kind === 'list') continue;   // refs are associations, never members
    out.push(`      +${f.name} : ${typeStr(f.type)}${f.key ? ' «key»' : ''}${f.const ? ' «readonly»' : ''}`);
  }
  out.push('    }');
}

function enumLines(e: EnumDef, out: string[]): void {
  out.push(`    class ${e.name} {`, '      <<enumeration>>');
  for (const v of e.values) out.push(`      ${v}`);
  out.push('    }');
}

/** Collects associations in two passes — local (entity/list-of-entity) refs first, then
 *  qualified (cross-context) refs — per the golden ordering (spec §5.2), independent of
 *  each field's position among its siblings. */
function collectAssociations(owner: string, fields: Field[], stubs: Set<string>, local: string[], qualified: string[]): void {
  for (const f of fields) {
    const t = f.type;
    const ref = t.kind === 'ref' ? t : t.kind === 'list' && t.of.kind === 'ref' ? t.of : undefined;
    if (!ref) continue;
    const isList = t.kind === 'list';
    const target = ref.target;
    const qual = isQualifiedRef(ref);
    const targetName = qual ? stubId(target) : target;
    const relation = isList ? (qual ? '"1" ..> "*"' : '"1" --> "*"') : (qual ? '..>' : '-->');
    const line = `  ${owner} ${relation} ${targetName} : ${f.name}`;
    if (qual) { stubs.add(target); qualified.push(line); } else { local.push(line); }
  }
}

/** Service class box (design §3.6, Task 12): `<<service>>` stereotype, one `+method(params)`
 *  member line per method — never a field-carrying class (services carry no state). */
function serviceLines(s: DomainModel['services'][number], out: string[]): void {
  out.push(`    class ${s.name} {`, '      <<service>>');
  for (const mm of s.methods)
    out.push(`      +${mm.name}(${mm.params.map(p => p.name).join(', ')})`);
  out.push('    }');
}

/** One dashed dependency edge per distinct aggregate a service's methods perform/create against
 *  (deduped per service+target — a service with several methods targeting the same aggregate
 *  gets one edge, labeled by the first method that reaches it). */
function serviceDependencyLines(s: DomainModel['services'][number], out: string[]): void {
  const seen = new Set<string>();
  for (const mm of s.methods) {
    const target = 'performs' in mm.kind ? mm.kind.performs.aggregate : 'creates' in mm.kind ? mm.kind.creates : undefined;
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(`  ${s.name} ..> ${target} : ${mm.name}`);
  }
}

export function domainToMermaid(m: DomainModel): string {
  const out: string[] = ['classDiagram', `  namespace ${m.context} {`];
  const stubs = new Set<string>();
  const local: string[] = [];
  const qualified: string[] = [];

  const classHolders: (EntityDef | AggregateDef)[] = [...m.entities, ...m.aggregates];
  for (const c of classHolders) classLines(c.name, c.fields, out);
  for (const e of m.enums) enumLines(e, out);
  for (const s of m.services) serviceLines(s, out);
  out.push('  }');

  for (const c of classHolders) collectAssociations(c.name, c.fields, stubs, local, qualified);
  for (const s of m.services) serviceDependencyLines(s, local);

  for (const target of stubs)
    out.push(`  class ${stubId(target)}["${target}"] {`, '    <<external>>', '  }');

  out.push(...local, ...qualified);

  return out.join('\n') + '\n';
}
