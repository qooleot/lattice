import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import type { CaseEntity, CaseState } from './evaluate.js';

// Nested children included deliberately, unlike the same-named helper elsewhere: a witness names a
// child by its own entity name (`type: 'Posting'`), exactly as evaluate.ts:148 resolves children for
// sumOverCollection, so remapEntity's `e.type` lookup must find it or the child's flattened
// `<field>_<sub>` keys pass through un-normalized while every other entity's are dotted.
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] =>
  [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];

/**
 * Every LEAF path reachable from field `f`, as segments: `[[f.name]]` when `f` is not value-typed,
 * and one entry per leaf reachable through however many value hops it takes when it is — `total :
 * Outer`, `value Outer { inner : Amount }`, `value Amount { amount : Money, currency : Currency }`
 * yields `[['total','inner','amount'], ['total','inner','currency']]`. Both solvers flatten a value
 * to its LEAVES and nothing else (alloy.ts's valueSubRelations recurses to leaf sig relations;
 * quint nests records the adapter flattens to leaf keys), so the leaf set is exactly the key set
 * remapEntity has to rename — which is why this drives off the DECLARATIONS rather than splitting a
 * witness key on `_`. String-splitting cannot tell `total_inner_amount` (one value hop then another)
 * from a sub-field whose own name contains an underscore, and would have to guess.
 *
 * `visiting` guards a value cycle, matching domain.ts's fieldPathsWhere: validate.ts's `value-cycle`
 * rejects one at load, so this is unreachable on a validated model, but tests build a DomainModel
 * directly and must not hang. Total and side-effect-free — a fresh Set per branch.
 */
function valueLeafPaths(m: DomainModel, f: Field, visiting: ReadonlySet<string> = new Set()): string[][] {
  if (f.type.kind !== 'value') return [[f.name]];
  const valueName = f.type.value;
  if (visiting.has(valueName)) return [];
  const vdef = m.values.find(v => v.name === valueName);
  if (!vdef) return [];
  const nested = new Set(visiting).add(valueName);
  return vdef.fields.flatMap(sub => valueLeafPaths(m, sub, nested).map(p => [f.name, ...p]));
}

/**
 * Witness key normalization (design §3.5, task-11 brief): both solver adapters produce
 * underscore-flattened keys for a value-typed field's sub-fields — Alloy natively (its sig
 * relations ARE `<field>_<subfield>`, see emitOwnerSig in alloy.ts), Quint via its own ITF
 * flatten step (quint-adapter.ts's stateToEntities, for the nested-record `#map`-free object
 * case). The rest of the engine (evaluate.ts's resolveValue, salient.ts's renderTerm, validated
 * Candidate paths) all speak DOTTED paths (`['period', 'start']` -> `period.start`), matching
 * every other multi-segment path convention in the codebase (ref hops, machine-state accessors).
 * This is the single choke point that reconciles the two: for every entity in a CaseState, for
 * every LEAF reachable through that entity's value-typed fields, rename the solvers' underscore-
 * joined key to the dotted path — every other key (plain fields, ref ids, machine-state) passes
 * through unchanged.
 *
 * Values NEST (slice B2), so the walk goes to arbitrary DEPTH: `total_inner_amount` ->
 * `total.inner.amount`. It used to strip exactly one `<field>_` prefix, which for a two-level value
 * produced the half-dotted `total.inner_amount` — a key resolveValue's `path.join('.')` lookup never
 * matches, so it returned undefined and the judge PERMITTED a witness both solvers FORBID.
 */
function remapEntity(m: DomainModel, e: CaseEntity): CaseEntity {
  const owner = owners(m).find(o => o.name === e.type);
  const valueFields = owner?.fields.filter(f => f.type.kind === 'value') ?? [];
  if (valueFields.length === 0) return e;

  const dotted = new Map<string, string>();
  for (const f of valueFields)
    for (const p of valueLeafPaths(m, f)) dotted.set(p.join('_'), p.join('.'));

  const fields: CaseEntity['fields'] = {};
  for (const [k, v] of Object.entries(e.fields)) fields[dotted.get(k) ?? k] = v;
  return { ...e, fields };
}

export function remapValueKeys(m: DomainModel, cs: CaseState): CaseState {
  return {
    ...cs,
    entities: cs.entities.map(e => remapEntity(m, e)),
    ...(cs.trace ? { trace: cs.trace.map(step => step.map(e => remapEntity(m, e))) } : {}),
  };
}
