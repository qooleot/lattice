import type {
  BuiltinDef, TypeAliasDef, RecordDef, EnumDef, ValueDef, EntityDef, AggregateDef, EventDef,
  ServiceDef, DomainModel, TypeRef,
} from '../ast/domain.js';

// The versioned, language-neutral IR (intermediate representation) — the stable contract an
// external (Ruby/Java) code generator consumes, exported as JSON via the `emit-ir` CLI command.
// `DomainModel` itself is the AST's own working representation and is free to evolve alongside the
// parser/solver/codegen internals; `IR` is a deliberate SEAM in front of it, versioned so a future
// shape change can be introduced as a new `irVersion` without breaking existing consumers.
//
// IR v1 mirrors the AST's Def types (`BuiltinDef`/`TypeAliasDef`/.../`ServiceDef`) exactly — it
// reuses them by import rather than redeclaring an identical shape. A future v2 may diverge (e.g.
// flatten `TypeRef`, drop AST-only fields) — that divergence is exactly what the `IR` interface +
// `toIR` seam below exists to absorb; callers depend on `IR`/`toIR`, never on `DomainModel` directly.
export const IR_VERSION = '1';

export interface IR {
  irVersion: string;
  context: string;
  doc?: string;
  ticksPerDay?: number;
  // AST leaves these four optional (a model without any is byte-identical to before parsing); IR
  // normalizes them to always-present arrays so a consumer never has to branch on `?? []`.
  builtins: BuiltinDef[];
  typeAliases: TypeAliasDef[];
  records: RecordDef[];
  enums: EnumDef[];
  values: ValueDef[];
  entities: EntityDef[];
  aggregates: AggregateDef[];
  events: EventDef[];
  services: ServiceDef[];
}

/** Compile-time drift guard: exhaustive over every `TypeRef.kind`. If a new kind is ever added to
 *  the AST without updating this file, the `default` arm's `never` assignment fails `tsc`. Not
 *  itself part of the IR shape — referenced by `walkTypeRefKinds` below so it participates in a real
 *  call and isn't dead-code-eliminated or lint-flagged as unused. */
function assertKnownTypeRef(t: TypeRef): void {
  switch (t.kind) {
    case 'prim': case 'enum': case 'ref': case 'list': case 'value':
    case 'optional': case 'map': case 'generic': case 'union': case 'carrier':
      return;
    default: {
      const _x: never = t;
      throw new Error(`unreachable: unknown TypeRef kind ${(_x as TypeRef).kind}`);
    }
  }
}

/** Recursively visits every nested TypeRef reachable from `t`, asserting each is a known kind
 *  (via `assertKnownTypeRef`) along the way. Exists solely to give the drift guard a real call
 *  site; callers of `toIR` do not need this — the AST is already validated upstream. */
function walkTypeRefKinds(t: TypeRef): void {
  assertKnownTypeRef(t);
  switch (t.kind) {
    case 'list': case 'optional': walkTypeRefKinds(t.of); return;
    case 'map': walkTypeRefKinds(t.key); walkTypeRefKinds(t.of); return;
    case 'generic': t.args.forEach(walkTypeRefKinds); return;
    case 'union': t.arms.forEach(walkTypeRefKinds); return;
    default: return;   // prim, enum, ref, value, carrier — no nested TypeRef
  }
}

/** Every TypeRef reachable from a Field: its own type, and (for a sum-type enum) each payload. */
function fieldsTypeRefs(fields: { type: TypeRef }[]): TypeRef[] { return fields.map(f => f.type); }

/** Walks every TypeRef reachable from a DomainModel — type aliases, record/value/entity/event/
 *  aggregate/service-param/service-return fields, and enum payloads — running the drift guard over
 *  each. Called once from `toIR` so the guard exercises real model shapes, not just the switch. */
function walkModelTypeRefs(m: DomainModel): void {
  for (const a of m.typeAliases ?? []) walkTypeRefKinds(a.target);
  for (const r of m.records ?? []) fieldsTypeRefs(r.fields).forEach(walkTypeRefKinds);
  for (const e of m.enums) for (const t of Object.values(e.payloads ?? {})) walkTypeRefKinds(t);
  for (const v of m.values) fieldsTypeRefs(v.fields).forEach(walkTypeRefKinds);
  for (const e of m.entities) fieldsTypeRefs(e.fields).forEach(walkTypeRefKinds);
  for (const a of m.aggregates) {
    fieldsTypeRefs(a.fields).forEach(walkTypeRefKinds);
    for (const e of a.entities ?? []) fieldsTypeRefs(e.fields).forEach(walkTypeRefKinds);
  }
  for (const e of m.events) fieldsTypeRefs(e.fields).forEach(walkTypeRefKinds);
  for (const s of m.services) for (const meth of s.methods) {
    for (const p of meth.params) walkTypeRefKinds(p.type);
    if (meth.returns) walkTypeRefKinds(meth.returns);
  }
}

/** Builds the versioned IR envelope from a `DomainModel`. Deep-clones so no live AST reference
 *  (mutable arrays/objects the engine still holds) leaks into the exported IR, normalizes the four
 *  optional collections to `[]`, and runs the drift guard over every TypeRef in the clone. */
export function toIR(model: DomainModel): IR {
  const m = structuredClone(model);
  walkModelTypeRefs(m);
  return {
    irVersion: IR_VERSION,
    context: m.context,
    doc: m.doc,
    ticksPerDay: m.ticksPerDay,
    builtins: m.builtins ?? [],
    typeAliases: m.typeAliases ?? [],
    records: m.records ?? [],
    enums: m.enums,
    values: m.values,
    entities: m.entities,
    aggregates: m.aggregates,
    events: m.events,
    services: m.services,
  };
}
