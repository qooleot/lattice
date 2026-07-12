import type { Predicate } from './invariant.js';

export type PrimType = 'Int' | 'Text' | 'Date' | 'Duration' | 'Money' | 'Id';

export type TypeRef =
  | { kind: 'prim'; prim: PrimType }
  | { kind: 'enum'; enum: string }
  | { kind: 'ref'; target: string }
  | { kind: 'list'; of: TypeRef }
  | { kind: 'value'; value: string };

export interface Field {
  name: string;
  type: TypeRef;
  key?: boolean;
  const?: boolean;
  tags?: string[];   // semantic tags (spec plan §10.1): 'balance', 'total', 'monotonic', …
}
export interface StateDef { name: string; tags?: ('active' | 'terminal')[] }
export interface Region { name: string; initial: string; states: StateDef[] }
export interface TransitionDef {
  name: string; region: string; from: string[]; to: string;
  when?: string;
  requires?: Predicate;   // guard over the OWN aggregate's fields + machine state (design §3.3)
  emits?: string;         // declared event this transition announces on firing (design §3.6)
}
export interface Machine { regions: Region[]; transitions: TransitionDef[] }
export interface EnumDef { name: string; values: string[] }
/** Structural, keyless, flat value type (design §3.5): compared by structure, not identity — fields
 *  are prim/enum only in v1 (no ref/list/value-of-value), and its invariants are own-field laws
 *  auto-enforced at every use site (no solver/evaluator encoding yet — surface/AST/printer only). */
export interface ValueDef {
  kind: 'value'; name: string; fields: Field[];
  invariants?: { name: string; body: Predicate; doc?: string }[];
  doc?: string;
}
export interface EntityDef { kind: 'entity'; name: string; fields: Field[]; doc?: string }
export interface AggregateDef { kind: 'aggregate'; name: string; fields: Field[]; entities?: EntityDef[]; machine?: Machine; doc?: string }
export interface EventDef { name: string; fields: Field[]; doc?: string }

/** Service methods (design §3.6): carried structure only — never solver-encoded. A method's
 *  `kind` names exactly one of: a read-only query, a `performs`-reference to a declared transition
 *  on an aggregate (the "one method, one transition" rule), or a `creates` reference to an
 *  aggregate. `requires` is a method-level guard over params + (for performs/creates) the target
 *  aggregate's own fields/states — its Term may use the 'param' kind, legal ONLY here. */
export interface ParamDef { name: string; type: TypeRef }
export interface MethodDef {
  name: string; params: ParamDef[]; returns?: TypeRef; doc?: string;
  kind: { readOnly: true } | { performs: { aggregate: string; transition: string } } | { creates: string };
  requires?: Predicate;
}
export interface ServiceDef { name: string; methods: MethodDef[]; doc?: string }

/** The nested child an owned collection ranges over, or null (design §3.2). */
export function ownedCollectionChild(a: AggregateDef, f: Field): EntityDef | null {
  if (f.type.kind !== 'list' || f.type.of.kind !== 'ref') return null;
  return a.entities?.find(e => e.name === (f.type as any).of.target) ?? null;
}

export interface DomainModel {
  context: string;
  doc?: string;              // free-form human description; exempt from identifier validation
  ticksPerDay?: number;      // time granularity; default 24 (tick = 1 hour)
  enums: EnumDef[];
  values: ValueDef[];
  entities: EntityDef[];
  aggregates: AggregateDef[];
  events: EventDef[];
  services: ServiceDef[];
}

/** Cross-context reference (spec §4.2): target is 'Context.Type'. Structural only —
 *  excluded from NoOrphan/refs-resolve derivation and all solver encodings. */
export const isQualifiedRef = (t: TypeRef): t is TypeRef & { kind: 'ref' } =>
  t.kind === 'ref' && t.target.includes('.');
