import type { Predicate } from './invariant.js';

export type PrimType = 'Int' | 'Text' | 'Date' | 'Duration' | 'Money' | 'Id';

export type TypeRef =
  | { kind: 'prim'; prim: PrimType }
  | { kind: 'enum'; enum: string }
  | { kind: 'ref'; target: string }
  | { kind: 'list'; of: TypeRef };

export interface Field {
  name: string;
  type: TypeRef;
  key?: boolean;
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
export interface EntityDef { kind: 'entity'; name: string; fields: Field[]; doc?: string }
export interface AggregateDef { kind: 'aggregate'; name: string; fields: Field[]; entities?: EntityDef[]; machine?: Machine; doc?: string }
export interface EventDef { name: string; fields: Field[]; doc?: string }

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
  entities: EntityDef[];
  aggregates: AggregateDef[];
  events: EventDef[];
}

/** Cross-context reference (spec §4.2): target is 'Context.Type'. Structural only —
 *  excluded from NoOrphan/refs-resolve derivation and all solver encodings. */
export const isQualifiedRef = (t: TypeRef): t is TypeRef & { kind: 'ref' } =>
  t.kind === 'ref' && t.target.includes('.');
