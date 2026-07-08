import type { AggregateDef, DomainModel, EntityDef } from '../ast/domain.js';
import type { CaseEntity, CaseState } from './evaluate.js';

const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];

/**
 * Witness key normalization (design §3.5, task-11 brief): both solver adapters produce
 * underscore-flattened keys for a value-typed field's sub-fields — Alloy natively (its sig
 * relations ARE `<field>_<subfield>`, see emitOwnerSig in alloy.ts), Quint via its own ITF
 * flatten step (quint-adapter.ts's stateToEntities, for the nested-record `#map`-free object
 * case). The rest of the engine (evaluate.ts's resolveValue, salient.ts's renderTerm, validated
 * Candidate paths) all speak DOTTED paths (`['period', 'start']` -> `period.start`), matching
 * every other multi-segment path convention in the codebase (ref hops, machine-state accessors).
 * This is the single choke point that reconciles the two: for every entity in a CaseState, for
 * every value-typed field declared on that entity's type, rename `<field>_<subfield>` keys to
 * `<field>.<subfield>` — every other key (plain fields, ref ids, machine-state) passes through
 * unchanged.
 */
function remapEntity(m: DomainModel, e: CaseEntity): CaseEntity {
  const owner = owners(m).find(o => o.name === e.type);
  const valueFields = owner?.fields.filter(f => f.type.kind === 'value') ?? [];
  if (valueFields.length === 0) return e;

  const fields: CaseEntity['fields'] = {};
  for (const [k, v] of Object.entries(e.fields)) {
    let renamed = k;
    for (const f of valueFields) {
      const prefix = `${f.name}_`;
      if (k.startsWith(prefix)) { renamed = `${f.name}.${k.slice(prefix.length)}`; break; }
    }
    fields[renamed] = v;
  }
  return { ...e, fields };
}

export function remapValueKeys(m: DomainModel, cs: CaseState): CaseState {
  return {
    ...cs,
    entities: cs.entities.map(e => remapEntity(m, e)),
    ...(cs.trace ? { trace: cs.trace.map(step => step.map(e => remapEntity(m, e))) } : {}),
  };
}
