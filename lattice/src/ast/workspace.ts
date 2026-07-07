import type { Diagnostic } from './invariant.js';
import type { ContextMapModel, Relationship } from './contextmap.js';
import type { DomainModel, Field, TypeRef } from './domain.js';
import { isQualifiedRef } from './domain.js';

export interface WorkspaceMemberModel { name: string; model: DomainModel }

/** Cross-spec workspace validation (spec §4.4). Pure: given a context map and the loaded
 *  member models, checks belt-and-braces name consistency, that every `exposes` entry names
 *  a real entity/aggregate in the exposing context(s), and that every qualified ref (`ref
 *  Context.Type`) is covered by a relationship whose direction and `exposes` list permit it.
 *  Never throws — accumulates and returns diagnostics. */
export function validateWorkspace(map: ContextMapModel, members: WorkspaceMemberModel[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const mem of members) {
    if (mem.model.context !== mem.name)
      out.push({
        code: 'context-name-mismatch',
        message: `member '${mem.name}' declares context '${mem.model.context}' — names must match`,
        at: mem.name,
      });
  }

  // Declared entity/aggregate names per context, from the loaded member models.
  const declaredTypes = new Map<string, Set<string>>();
  for (const mem of members) {
    const set = declaredTypes.get(mem.name) ?? new Set<string>();
    for (const e of mem.model.entities) set.add(e.name);
    for (const a of mem.model.aggregates) set.add(a.name);
    declaredTypes.set(mem.name, set);
  }

  for (const r of map.relationships) {
    const exposes = r.exposes ?? [];
    for (const type of exposes) {
      const ok =
        r.kind === 'upstreamDownstream'
          ? (declaredTypes.get(r.left)?.has(type) ?? false)
          : (declaredTypes.get(r.left)?.has(type) ?? false) || (declaredTypes.get(r.right)?.has(type) ?? false);
      if (!ok)
        out.push({
          code: 'unknown-exposed-type',
          message: `relationship ${r.left}-${r.right} exposes '${type}', which is not declared as an entity or aggregate in the exposing context`,
          at: `${r.left}-${r.right}`,
        });
    }
  }

  const known = new Set(map.contexts.map(c => c.name));

  const isCoveredBy = (memberName: string, targetCtx: string, type: string, r: Relationship): boolean => {
    const exposes = r.exposes ?? [];
    if (!exposes.includes(type)) return false;
    if (r.kind === 'upstreamDownstream') {
      // exposing context is `left` (upstream); coverage requires the member to be `right` (downstream)
      return r.left === targetCtx && r.right === memberName;
    }
    // symmetric kinds cover both directions
    return (r.left === memberName && r.right === targetCtx) || (r.left === targetCtx && r.right === memberName);
  };

  const collectQualifiedRefs = (t: TypeRef): { target: string }[] => {
    if (t.kind === 'list') return collectQualifiedRefs(t.of);
    if (isQualifiedRef(t)) return [{ target: t.target }];
    return [];
  };

  for (const mem of members) {
    const fieldSets: { fields: Field[]; ownerAt: string }[] = [
      ...mem.model.entities.map(e => ({ fields: e.fields, ownerAt: e.name })),
      ...mem.model.aggregates.map(a => ({ fields: a.fields, ownerAt: a.name })),
    ];
    for (const { fields, ownerAt } of fieldSets) {
      for (const f of fields) {
        for (const ref of collectQualifiedRefs(f.type)) {
          const at = `${mem.name}.${ownerAt}.${f.name}`;
          const dot = ref.target.indexOf('.');
          const targetCtx = ref.target.slice(0, dot);
          const targetType = ref.target.slice(dot + 1);

          if (!known.has(targetCtx)) {
            out.push({
              code: 'uncovered-cross-context-ref',
              message: `ref ${ref.target} in ${at}: context ${targetCtx} not in map`,
              at,
            });
            continue;
          }

          const covered = map.relationships.some(r => isCoveredBy(mem.name, targetCtx, targetType, r));
          if (!covered)
            out.push({
              code: 'uncovered-cross-context-ref',
              message: `ref ${ref.target} in ${at}: no relationship exposes ${targetType} from ${targetCtx} to ${mem.name}`,
              at,
            });
        }
      }
    }
  }

  return out;
}
