import type { AggregateDef, DomainModel, EntityDef, EventDef, Field, TypeRef, ValueDef } from '../../ast/domain.js';
import { ownedCollectionChild } from '../../ast/domain.js';

// Faithful full-model TypeScript type emitter (Slice 3). Renders the ENTIRE DomainModel — enums,
// values, entities, aggregates (+ nested children), events, and `builtin` carriers — with the full
// CML rich type system. This is the "replace CML" codegen artifact, NOT the solver-scoped SQLite
// reference service (render/types.ts): that one is GenPlan-bound and throws on value/list/carried
// kinds; this one renders from the DomainModel directly and NEVER throws on any TypeRef kind.
//
// The emitted file is a faithful type SURFACE: it may reference external generic constructors
// (`Result<…>`) and opaque `builtin` carriers that this file does not itself define, exactly as CML
// output references shared type libraries. It is not intended to typecheck standalone under `tsc`.

/** Every TypeRef kind → its TS type. Exhaustive by design (no `default`) so tsc flags a new kind. */
function tsType(t: TypeRef): string {
  switch (t.kind) {
    case 'prim': return t.prim === 'Text' || t.prim === 'Id' ? 'string' : t.prim === 'Boolean' ? 'boolean' : 'number'; // Int/Money/Date/Duration → number (ticks)
    case 'enum': return t.enum;            // the emitted string-literal-union alias
    case 'ref': return 'string';           // foreign id (incl. qualified cross-context refs)
    case 'value': return t.value;          // the emitted value interface
    case 'list': return `${tsType(t.of)}[]`;
    case 'optional': return `${tsType(t.of)} | null`;                       // nested optional (head Optional is the `?` flag)
    case 'map': return `Record<${tsType(t.key)}, ${tsType(t.of)}>`;          // Map<K,V>
    case 'generic': return `${t.ctor}<${t.args.map(tsType).join(', ')}>`;    // Result<T,E>, user generics — faithful, external
    case 'union': return t.arms.map(tsType).join(' | ');                     // A | B
    case 'carrier': return t.name;         // opaque builtin — resolved by the top-of-file alias block
  }
}

// A field renders as an optional PROPERTY (`name?: T`) when the head is optional — the parser
// normalizes a head `Optional<T>` to Field.optional, so that flag is the single source of truth for
// head-optionality (a nested optional stays a `| null` union via tsType). `const` → `readonly`,
// matching render/types.ts. `typeStr` overrides the field's own type (used for owned collections,
// which embed the child interface rather than exposing meaningless foreign ids).
//
// When a field has a doc and/or a visibility tag (@public / @hookOnly), a JSDoc comment is emitted
// above the field line. Visibility rules (CML semantics: internal is the default):
//   @public + @hookOnly → @public (hook-only)
//   @public only        → @public
//   @hookOnly only      → @public (hook-only)
//   neither             → no visibility marker
function fieldLine(f: Field, typeStr = tsType(f.type)): string {
  const isPublic = f.tags?.includes('public') ?? false;
  const isHookOnly = f.tags?.includes('hookOnly') ?? false;
  let visMarker: string | undefined;
  if (isPublic || isHookOnly) visMarker = isHookOnly ? '@public (hook-only)' : '@public';

  const parts: string[] = [];
  if (f.doc) parts.push(f.doc);
  if (visMarker) parts.push(visMarker);

  const propLine = `  ${f.const ? 'readonly ' : ''}${f.name}${f.optional ? '?' : ''}: ${typeStr};`;
  if (parts.length === 0) return propLine;
  return `  /** ${parts.join(' ')} */\n${propLine}`;
}

function iface(name: string, fields: Field[], extra: string[] = []): string {
  const lines = [...fields.map(f => fieldLine(f)), ...extra];
  return `export interface ${name} {\n${lines.join('\n')}\n}\n`;
}

function valueIface(v: ValueDef): string { return iface(v.name, v.fields); }
function entityIface(e: EntityDef): string { return iface(e.name, e.fields); }
function eventIface(e: EventDef): string { return iface(e.name, e.fields); }

function aggregateIface(a: AggregateDef): string {
  // An owned collection (`List<ref Child>` over a nested entity) embeds the child interface —
  // `lines: InvoiceLine[]` — NOT `string[]`: an owned child has no identity outside its owner, so
  // the foreign-id rendering that a plain `ref` gets would be meaningless here.
  const fieldLines = a.fields.map(f => {
    const child = ownedCollectionChild(a, f);
    return fieldLine(f, child ? `${child.name}[]` : tsType(f.type));
  });
  // one member per machine region, typed as the union of its state-name literals (as render/types.ts)
  const regionMembers = (a.machine?.regions ?? []).map(r =>
    `  ${r.name}: ${r.states.map(s => `'${s.name}'`).join(' | ')};`);
  const own = `export interface ${a.name} {\n${[...fieldLines, ...regionMembers].join('\n')}\n}\n`;
  const children = (a.entities ?? []).map(entityIface);
  return [own, ...children].join('\n');
}

function emitEnum(e: DomainModel['enums'][number]): string {
  const body = e.payloads && Object.keys(e.payloads).length
    ? `export type ${e.name} = ${e.values.map(v => e.payloads![v] ? `{ kind: '${v}'; value: ${tsType(e.payloads![v]!)} }` : `{ kind: '${v}' }`).join(' | ')};`
    : `export type ${e.name} = ${e.values.map(v => `'${v}'`).join(' | ')};`;
  return e.doc ? `/** ${e.doc} */\n${body}` : body;
}

export function renderTsTypes(model: DomainModel): string {
  const out: string[] = [`// GENERATED by lattice from context ${model.context} — DO NOT EDIT. Regenerate instead.`, ''];

  if (model.builtins?.filter(b => !b.module).length) {
    out.push('// Opaque `builtin` carriers — external types; supply a real type by editing/importing if wanted.');
    for (const b of model.builtins!.filter(b => !b.module)) out.push(`export type ${b.name} = unknown;${b.ref ? `   // external: ${b.ref}` : ''}`);
    out.push('');
  }

  // Plain enums → string-literal unions. Sum-type enums → discriminated unions. Top-level first.
  const topEnums = model.enums.filter(e => !e.module);
  for (const e of topEnums) out.push(emitEnum(e));
  if (topEnums.length) out.push('');

  // `type` records → interfaces. Aliases NOT emitted (inlined at use sites).
  // Top-level types (no module) first, as before.
  const topBlocks = [
    ...(model.records ?? []).filter(r => !r.module).map(r => iface(r.name, r.fields)),
    ...model.values.filter(v => !v.module).map(valueIface),
    ...model.entities.filter(e => !e.module).map(entityIface),
    ...model.aggregates.filter(a => !a.module).map(aggregateIface),
    ...model.events.filter(e => !e.module).map(eventIface),
  ];
  if (topBlocks.length) out.push(topBlocks.join('\n'));

  // Collect module names in first-appearance order across all decl kinds.
  const allDeclsWithModule: Array<{ module?: string }> = [
    ...(model.builtins ?? []),
    ...model.enums,
    ...(model.records ?? []),
    ...model.values,
    ...model.entities,
    ...model.aggregates,
    ...model.events,
  ];
  const moduleOrder: string[] = [];
  for (const d of allDeclsWithModule) {
    if (d.module && !moduleOrder.includes(d.module)) moduleOrder.push(d.module);
  }

  // Emit per-module banners followed by that module's types.
  for (const mod of moduleOrder) {
    out.push('');
    out.push(`// ── module: ${mod} ──`);

    const modBuiltins = (model.builtins ?? []).filter(b => b.module === mod);
    if (modBuiltins.length) {
      out.push('// Opaque `builtin` carriers — external types; supply a real type by editing/importing if wanted.');
      for (const b of modBuiltins) out.push(`export type ${b.name} = unknown;${b.ref ? `   // external: ${b.ref}` : ''}`);
      out.push('');
    }

    const modEnums = model.enums.filter(e => e.module === mod);
    for (const e of modEnums) out.push(emitEnum(e));
    if (modEnums.length) out.push('');

    const modBlocks = [
      ...(model.records ?? []).filter(r => r.module === mod).map(r => iface(r.name, r.fields)),
      ...model.values.filter(v => v.module === mod).map(valueIface),
      ...model.entities.filter(e => e.module === mod).map(entityIface),
      ...model.aggregates.filter(a => a.module === mod).map(aggregateIface),
      ...model.events.filter(e => e.module === mod).map(eventIface),
    ];
    if (modBlocks.length) out.push(modBlocks.join('\n'));
  }

  return out.join('\n').replace(/\n+$/, '\n');
}
