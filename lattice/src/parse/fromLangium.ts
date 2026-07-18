import { parseLat, type ParseDiagnostic } from './parse.js';
import type * as G from './generated/ast.js';
import type { DomainModel, EnumDef, ValueDef, EntityDef, AggregateDef, EventDef, Field, TypeRef, Machine, Region, StateDef, TransitionDef, ServiceDef, MethodDef, ParamDef } from '../ast/domain.js';
import { ownedCollectionChild } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term, Path } from '../ast/invariant.js';
import { validateModel } from '../ast/validate.js';
import { PRIM_NAMES } from '../ast/reserved.js';
import { validateCandidate } from '../ast/grammar.js';
import { isImplied } from '../engine/implied.js';
import type { ContextMapModel, Relationship, Role } from '../ast/contextmap.js';
import { defaultPath, validateContextMap } from '../ast/contextmap.js';

export type LoadResult =
  | { ok: true; model: DomainModel; invariants: CandidateInvariant[]; warnings: ParseDiagnostic[] }
  | { ok: false; diagnostics: ParseDiagnostic[] };

export type ContextMapLoadResult =
  | { ok: true; map: ContextMapModel; warnings: ParseDiagnostic[] }
  | { ok: false; diagnostics: ParseDiagnostic[] };

const stripDoc = (d: string) => d.replace(/^\/\/\/\s?/, '');
const joinDocs = (docs: string[]): string | undefined =>
  docs.length ? docs.map(stripDoc).join(' ') : undefined;

const at = (node: any): { line: number; col: number } => {
  const c = node?.$cstNode;
  return { line: (c?.range?.start?.line ?? 0) + 1, col: (c?.range?.start?.character ?? 0) + 1 };
};
const diag = (code: string, message: string, node?: any): ParseDiagnostic =>
  ({ code, message, ...at(node) });

// Resolution order for a bare NamedType (design §3.5): prim → value → owner-ref → carrier → enum.
// The declared sets (value/owner/carrier) are mutually exclusive by validateModel's shared
// duplicate-name pool, so their relative order does not matter — it only affects the final
// unresolved-enum fallback, which must not shadow any in-scope declared name.
//
// The prim-first arm can no longer shadow a declaration: validateModel's `reserved-prim-name` puts
// prims into that same duplicate-name pool, so no declaration reaching here is spelled like one.
//
// The container/rich forms (List/Optional/Map/generic/union) are handled structurally above the
// bare-name resolution; a head `Optional<T>` is later normalized to the `?` flag in mapFields.
function mapType(t: G.LatType, enums: Set<string>, diags: ParseDiagnostic[], owners: Set<string>, values: Set<string>, carriers: Set<string>, resolveAlias: (n: string) => TypeRef | null = () => null): TypeRef {
  const rec = (x: G.LatType) => mapType(x, enums, diags, owners, values, carriers, resolveAlias);
  switch (t.$type) {
    case 'ListType': return { kind: 'list', of: rec((t as G.ListType).of) };
    case 'OptionalType': return { kind: 'optional', of: rec((t as G.OptionalType).of) };
    case 'MapType': { const mt = t as G.MapType; return { kind: 'map', key: rec(mt.key), of: rec(mt.of) }; }
    case 'RefType': return { kind: 'ref', target: (t as G.RefType).target };
    case 'UnionType': {
      // left-assoc `A | B | C` flattens to n-ary arms (as `&&`/`||` do in mapPred): a nested
      // union arm is spliced in, so `arms` is always a flat list of non-union types.
      const arms: TypeRef[] = [];
      const push = (x: G.LatType) => { const r = rec(x); if (r.kind === 'union') arms.push(...r.arms); else arms.push(r); };
      const u = t as G.UnionType; push(u.left); push(u.right);
      return { kind: 'union', arms };
    }
    case 'NamedType': {
      const nt = t as G.NamedType;
      // `Name<args>` — a generic constructor (carried; ctor opaque, args resolved). `Optional`/`Map`
      // never reach here (dedicated rules), so any ctor with args is a plain generic.
      if (nt.args.length) return { kind: 'generic', ctor: nt.name, args: nt.args.map(rec) };
      const name = nt.name;
      if (PRIM_NAMES.has(name)) return { kind: 'prim', prim: name as any };
      const alias = resolveAlias(name); if (alias) return alias;   // `type Name = T` — inlined
      if (values.has(name)) return { kind: 'value', value: name };
      if (owners.has(name)) return { kind: 'ref', target: name };
      if (carriers.has(name)) return { kind: 'carrier', name };   // declared `builtin` OR `type Name = {}` record
      return { kind: 'enum', enum: name };   // unresolved enum → validateModel reports unresolved-enum
    }
  }
}

function mapFields(fs: G.FieldDecl[], enums: Set<string>, diags: ParseDiagnostic[], owners: Set<string>, values: Set<string>, carriers: Set<string>, resolveAlias: (n: string) => TypeRef | null = () => null): Field[] {
  return fs.map(f => {
    let type = mapType(f.type, enums, diags, owners, values, carriers, resolveAlias);
    let optional = f.optional;
    // A head `Optional<T>` is the canonical head-optional form written long — normalize it to the
    // `?` flag (design: ast/domain.ts TypeRef doc) so `fee : Optional<Money>` and `fee : Money?`
    // yield ONE AST, and the flag-based validation (optional-value/-list/-key) and derivation
    // (impliedInvariants' present-gate) apply uniformly. A NESTED optional (`Map<K, Optional<V>>`,
    // `List<Optional<T>>`) is not at the field head, so it stays a TypeRef 'optional' — carried.
    if (type.kind === 'optional') { optional = true; type = type.of; }
    const field: Field = { name: f.name, type };
    if (optional) field.optional = true;
    if (f.key) field.key = true;
    if (f.const) field.const = true;
    if (f.tags.length) field.tags = f.tags.map(t => t.name);
    return field;
  });
}

function mapLifecycles(lifs: G.LifecycleDecl[], ownerName: string, diags: ParseDiagnostic[], enums: Map<string, string[]>): Machine {
  const regions: Region[] = lifs.map(r => {
    const states: StateDef[] = r.states.map(s => {
      const tags = s.tags.map(t => t.name).filter(t => t === 'active' || t === 'terminal') as ('active' | 'terminal')[];
      const st: StateDef = { name: s.name };
      if (tags.length) st.tags = tags;
      return st;
    });
    const initials = r.states.filter(s => s.tags.some(t => t.name === 'initial'));
    if (initials.length !== 1)
      diags.push(diag('multiple-initial',
        `lifecycle ${ownerName}.${r.name} must have exactly one @initial state (found ${initials.length})`, r));
    return { name: r.name, initial: initials[0]?.name ?? r.states[0]!.name, states };
  });
  const transitions: TransitionDef[] = lifs.flatMap(r => r.transitions.map(t => {
    const tr: TransitionDef = { name: t.name, region: r.name, from: [...t.from], to: t.to };
    if (t.when) tr.when = t.when;
    if (t.requires) tr.requires = mapPred(t.requires, enums);
    if (t.emits) tr.emits = t.emits;
    return tr;
  }));
  return { regions, transitions };
}

// Service methods (design §3.6, Task 12): carried structure only. Each method's guard sees its
// own params (shadowing fields — a `param` PathRef never reaches this far since mapType's
// resolution happens per-method via the params set threaded into mapPred/mapTerm).
function mapMethods(methods: G.MethodDecl[], enums: Set<string>, diags: ParseDiagnostic[],
    owners: Set<string>, values: Set<string>, carriers: Set<string>, enumMap: Map<string, string[]>,
    resolveAlias: (n: string) => TypeRef | null = () => null): MethodDef[] {
  return methods.map(mm => {
    const params: ParamDef[] = mm.params.map(p => ({ name: p.name, type: mapType(p.type, enums, diags, owners, values, carriers, resolveAlias) }));
    const paramNames = new Set(params.map(p => p.name));
    const kind: MethodDef['kind'] = mm.readOnly ? { readOnly: true }
      : mm.creates !== undefined ? { creates: mm.creates }
      : { performs: { aggregate: mm.performsAgg!, transition: mm.performsTransition! } };
    const def: MethodDef = { name: mm.name, params, kind };
    if (mm.returns) def.returns = mapType(mm.returns, enums, diags, owners, values, carriers, resolveAlias);
    if (mm.requires) def.requires = mapPred(mm.requires, enumMap, paramNames);
    const d = joinDocs([...mm.docs]); if (d) def.doc = d;
    return def;
  });
}

// `params` (design §3.6, Task 12): inside a METHOD requires, a single-segment PathRef matching a
// declared param name maps to {kind:'param', name} — params shadow fields (see service.md).
// Default empty set at every non-method call site (transitions, invariants, value laws).
function mapTerm(e: G.Expr, enums: Map<string, string[]>, params: Set<string> = new Set()): Term {
  switch (e.$type) {
    case 'IntLit': return { kind: 'int', value: parseInt((e as G.IntLit).value, 10) };
    case 'NowLit': return { kind: 'now' };
    case 'PlusExpr': {
      const p = e as G.PlusExpr;
      return { kind: 'plus', left: mapTerm(p.left, enums, params), right: mapTerm(p.right, enums, params) };
    }
    case 'PathRef': {
      const segs = (e as G.PathRef).segments;
      if (segs.length === 2 && enums.has(segs[0]!) && enums.get(segs[0]!)!.includes(segs[1]!))
        return { kind: 'enumval', enum: segs[0]!, value: segs[1]! };
      if (segs.length === 1 && params.has(segs[0]!)) return { kind: 'param', name: segs[0]! };
      return { kind: 'field', owner: 'self', path: [...segs] };
    }
    default: throw new Error(`unmapped expr ${(e as any).$type}`);
  }
}

function mapPred(p: G.Predicate, enums: Map<string, string[]>, params: Set<string> = new Set()): Predicate {
  switch (p.$type) {
    case 'BinPred': {
      const b = p as G.BinPred;
      const l = mapPred(b.left, enums, params), r = mapPred(b.right, enums, params);
      if (b.op === '=>') return { kind: 'implies', left: l, right: r };
      const kind = b.op === '&&' ? 'and' as const : 'or' as const;
      // flatten left-assoc chains of the SAME connective into n-ary args
      const args = l.kind === kind ? [...(l as any).args, r] : [l, r];
      return { kind, args };
    }
    case 'NotPred': return { kind: 'not', arg: mapPred((p as G.NotPred).arg, enums, params) };
    case 'StatePred': {
      const s = p as G.StatePred;
      return { kind: 'inState', owner: 'self', region: s.region, states: [...s.states] };
    }
    case 'Comparison': {
      const c = p as G.Comparison;
      const ops: Record<string, 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'> =
        { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
      return { kind: 'cmp', op: ops[c.op]!, left: mapTerm(c.left, enums, params), right: mapTerm(c.right, enums, params) };
    }
    case 'PresentPred': return { kind: 'present', path: mapPath((p as G.PresentPred).path) };
    default: throw new Error(`unmapped predicate ${(p as any).$type}`);
  }
}

const mapPath = (p: G.PathExpr): Path => [...p.segments];

function mapBody(inv: G.InvariantDecl, aggregate: string, aggDef: AggregateDef | undefined, enums: Map<string, string[]>): Candidate {
  const b = inv.body;
  const where = inv.where ? mapPred(inv.where, enums) : undefined;
  switch (b.$type) {
    case 'UniqueBody': return { kind: 'unique', aggregate,
      whileStates: { region: (b as G.UniqueBody).region, states: [...(b as G.UniqueBody).states] },
      by: (b as G.UniqueBody).by.map(mapPath) };
    case 'RefsResolveBody': return { kind: 'refsResolve', aggregate };
    case 'CardinalityBody': return { kind: 'cardinality', aggregate,
      where: (b as G.CardinalityBody).where ? mapPred((b as G.CardinalityBody).where!, enums) : null,
      atMost: parseInt((b as G.CardinalityBody).atMost, 10) };
    case 'TerminalBody': return { kind: 'terminal', aggregate,
      region: (b as G.TerminalBody).region, state: (b as G.TerminalBody).state };
    case 'MonotonicBody': return { kind: 'monotonic', aggregate, field: mapPath((b as G.MonotonicBody).field) };
    case 'ConserveBody': return { kind: 'conservation', aggregate,
      parts: (b as G.ConserveBody).parts.map(mapPath), total: mapPath((b as G.ConserveBody).total) };
    case 'LeadsToBody': return { kind: 'leadsTo', aggregate,
      from: mapPred((b as G.LeadsToBody).from, enums), to: mapPred((b as G.LeadsToBody).to, enums),
      // Langium's default value converter already strips STRING-terminal quotes (rule name STRING
      // triggers ValueConverter.convertString); slicing again here truncated the first/last real chars.
      fairness: (b as G.LeadsToBody).fairness };
    case 'SumBody': {
      const b2 = b as G.SumBody;
      const f = aggDef?.fields.find(x => x.name === b2.collection);
      const child = aggDef && f ? ownedCollectionChild(aggDef, f) : null;
      const ops: Record<string, 'eq' | 'le' | 'ge'> = { '==': 'eq', '<=': 'le', '>=': 'ge' };
      // `field` is now a PathExpr on the surface, so a value hop (`sum(postings, amount.amount)`)
      // parses. A SINGLE segment maps back to the legacy bare `string`, not `['amount']`: the two
      // forms print identically (`sumFieldPath(c).join('.')`), so the surface cannot distinguish
      // them and the parser must pick one. It must be the string. `canonicalCandidate` is a raw
      // key-sorted JSON.stringify — it does NOT normalize `field` — so re-parsing a stored
      // `field: 'amount'` as `['amount']` would change its canonical form while the stored copy
      // kept the string, and every comparison keyed on that canonical form would see a change that
      // is not one. The one proven to fire is diff.ts's `changedInvariants` (:170-172), which
      // compares `cjson(before.candidate) !== cjson(after.candidate)` over `canonicalSet`'s output
      // under a matching name: re-parsing an unedited .lat would diff every stored sumOverCollection
      // as CHANGED. (Not rehydrateIds, which matches by NAME and never reads the candidate; not
      // isImplied, which is vacuously false here — impliedInvariants derives only terminal /
      // refsResolve / nonNegative / value-law candidates and never mints a sumOverCollection. An
      // earlier revision of this comment cited both; both were dead ends.) The string is also what
      // makes print∘parse the identity for every pre-widening candidate.
      const segs = mapPath(b2.field);
      return { kind: 'sumOverCollection', aggregate, collection: b2.collection,
        child: child?.name ?? '', field: segs.length === 1 ? segs[0]! : segs,
        op: ops[b2.op]!, total: mapPath(b2.total) };
    }
    default: {
      const c: Candidate = { kind: 'statePredicate', aggregate, body: mapPred((b as G.PredicateBody).pred, enums) };
      if (where) (c as any).where = where;
      return c;
    }
  }
}

const CAMEL = /^[a-z][A-Za-z0-9]*$/, PASCAL = /^[A-Z][A-Za-z0-9]*$/;
/** `loc` maps a construct key (see the `locs` population in loadLatText) to its CST position. */
function namingWarnings(m: DomainModel, invNames: string[],
    loc: (key: string) => { line: number; col: number }): ParseDiagnostic[] {
  const out: ParseDiagnostic[] = [];
  const warn = (kind: string, n: string, re: RegExp, style: string, key: string) => {
    if (!re.test(n)) out.push({ code: 'naming-convention', ...loc(key),
      message: `${kind} '${n}' should be ${style} (spec P8)` });
  };
  warn('context', m.context, PASCAL, 'PascalCase', 'context');
  for (const b of m.builtins ?? []) warn('builtin', b.name, PASCAL, 'PascalCase', `builtin:${b.name}`);
  for (const e of m.enums) { warn('enum', e.name, PASCAL, 'PascalCase', `enum:${e.name}`); e.values.forEach(v => warn('enum value', v, CAMEL, 'camelCase', `enum:${e.name}`)); }
  for (const v of m.values) {
    warn('value', v.name, PASCAL, 'PascalCase', `owner:${v.name}`);
    v.fields.forEach(f => warn('field', f.name, CAMEL, 'camelCase', `field:${v.name}.${f.name}`));
  }
  const owners = [...m.entities, ...m.aggregates];
  for (const o of owners) {
    warn(o.kind, o.name, PASCAL, 'PascalCase', `owner:${o.name}`);
    o.fields.forEach(f => warn('field', f.name, CAMEL, 'camelCase', `field:${o.name}.${f.name}`));
    const mach = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of mach?.regions ?? []) { warn('region', r.name, CAMEL, 'camelCase', `region:${o.name}.${r.name}`); r.states.forEach(s => warn('state', s.name, CAMEL, 'camelCase', `state:${o.name}.${r.name}.${s.name}`)); }
    mach?.transitions.forEach(t => warn('transition', t.name, CAMEL, 'camelCase', `transition:${o.name}.${t.name}`));
  }
  for (const e of m.events) warn('event', e.name, PASCAL, 'PascalCase', `owner:${e.name}`);
  for (const s of m.services) {
    warn('service', s.name, PASCAL, 'PascalCase', `owner:${s.name}`);
    for (const mm of s.methods) {
      warn('method', mm.name, CAMEL, 'camelCase', `method:${s.name}.${mm.name}`);
      mm.params.forEach(p => warn('param', p.name, CAMEL, 'camelCase', `method:${s.name}.${mm.name}`));
    }
  }
  invNames.forEach(n => warn('invariant', n, CAMEL, 'camelCase', `invariant:${n}`));
  return out;
}

export function loadLatText(text: string): LoadResult {
  const parsed = parseLat(text);
  if (!parsed.ok) return parsed;
  const file = parsed.cst;
  if (!file.context)
    return { ok: false, diagnostics: [{ code: 'wrong-file-kind', line: 1, col: 1,
      message: 'expected a context file, got a contextMap — apply/emit operate on spec.lat; use the docs command for the workspace map' }] };
  const cst = file.context;
  const diags: ParseDiagnostic[] = [];
  // CST positions for naming warnings, keyed as in namingWarnings (enum values share their
  // enum's position — value tokens have no individual AST nodes)
  const locs = new Map<string, { line: number; col: number }>();
  const noteFields = (owner: string, fs: G.FieldDecl[]) => { for (const f of fs) locs.set(`field:${owner}.${f.name}`, at(f)); };
  locs.set('context', at(cst));

  const enumDecls = cst.items.filter((i): i is G.EnumDecl => i.$type === 'EnumDecl');
  for (const e of enumDecls) locs.set(`enum:${e.name}`, at(e));
  const enumSet = new Set(enumDecls.map(e => e.name));
  const enumMap = new Map(enumDecls.map(e => [e.name, e.variants.map(v => v.name)]));

  // owners in scope for bare-name ref resolution (mapType): top-level entities, aggregates, and
  // every nested entity name declared inside an aggregate — collected in a pre-pass so forward
  // references (a field naming an owner declared later in the file) still resolve.
  const ownerNames = new Set<string>();
  for (const item of cst.items) {
    if (item.$type === 'EntityDecl') ownerNames.add((item as G.EntityDecl).name);
    if (item.$type === 'AggregateDecl') {
      const a = item as G.AggregateDecl;
      ownerNames.add(a.name);
      for (const e of a.entities) ownerNames.add(e.name);
    }
  }
  // value type names in scope for bare-name resolution (mapType: prim → value → owner-ref →
  // carrier → enum), same forward-reference rationale as ownerNames above.
  const valueDecls = cst.items.filter((i): i is G.ValueDecl => i.$type === 'ValueDecl');
  const valueNames = new Set(valueDecls.map(v => v.name));
  // declared `builtin` carrier names — a bare name matching one maps to TypeRef kind 'carrier'.
  const builtinDecls = cst.items.filter((i): i is G.BuiltinDecl => i.$type === 'BuiltinDecl');
  // `type` declarations (Slice 4): `target` set ⇒ alias; unset ⇒ record (free-form carried struct).
  const typeDecls = cst.items.filter((i): i is G.TypeDecl => i.$type === 'TypeDecl');
  const recordDecls = typeDecls.filter(td => td.target === undefined);
  const aliasDecls = new Map(typeDecls.filter(td => td.target !== undefined).map(td => [td.name, td]));
  // A record name resolves to a `carrier` (carried, codegen-only) exactly like a builtin — the two
  // differ only in what's declared (a record has fields), not in how a reference to them is typed.
  const carrierNames = new Set([...builtinDecls.map(b => b.name), ...recordDecls.map(td => td.name)]);

  // Alias table (prim → alias → value → owner → carrier → enum). Resolved eagerly & cycle-guarded so
  // use sites carry the inlined target (CML semantics). resolveAlias recurses through mapType, so an
  // alias whose target names another alias resolves transitively.
  const aliasTable = new Map<string, TypeRef>();
  const resolvingAliases = new Set<string>();
  const resolveAlias = (name: string): TypeRef | null => {
    if (aliasTable.has(name)) return aliasTable.get(name)!;
    const decl = aliasDecls.get(name);
    if (!decl) return null;
    if (resolvingAliases.has(name)) {
      diags.push(diag('alias-cycle', `type alias ${name} is part of a cycle — an alias cannot resolve to itself`, decl));
      return { kind: 'carrier', name };   // break the cycle with a harmless placeholder
    }
    resolvingAliases.add(name);
    const t = mapType(decl.target!, enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias);
    resolvingAliases.delete(name);
    aliasTable.set(name, t);
    return t;
  };
  for (const name of aliasDecls.keys()) resolveAlias(name);

  const model: DomainModel = {
    context: cst.name,
    enums: enumDecls.map(e => ({ name: e.name, values: e.variants.map(v => v.name) }) as EnumDef),
    values: [], entities: [], aggregates: [], events: [], services: [],
  };
  // STRING terminal already strips quotes (Langium ValueConverter — see leadsTo fairness note).
  if (builtinDecls.length) model.builtins = builtinDecls.map(b => (b.ref ? { name: b.name, ref: b.ref } : { name: b.name }));
  if (aliasDecls.size) model.typeAliases = [...aliasDecls.values()].map(td => {
    const a: { name: string; target: TypeRef; doc?: string } = { name: td.name, target: aliasTable.get(td.name)! };
    const d = joinDocs([...td.docs]); if (d) a.doc = d;
    locs.set(`owner:${td.name}`, at(td));
    return a;
  });
  if (recordDecls.length) model.records = recordDecls.map(td => {
    const r: { name: string; fields: Field[]; doc?: string } = { name: td.name,
      fields: mapFields([...td.fields], enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias) };
    const d = joinDocs([...td.docs]); if (d) r.doc = d;
    locs.set(`owner:${td.name}`, at(td)); noteFields(td.name, [...td.fields]);
    return r;
  });
  const topDoc = joinDocs([...file.docs]);
  if (topDoc) model.doc = topDoc;
  for (const b of builtinDecls) locs.set(`builtin:${b.name}`, at(b));
  // Sum-type enum payloads (Slice 4): resolved now that the carrier set + alias table are ready.
  // model.enums is in enumDecls order, so the index aligns.
  enumDecls.forEach((ed, i) => {
    const withPayload = ed.variants.filter(v => v.payload);
    if (!withPayload.length) return;
    const payloads: Record<string, TypeRef> = {};
    for (const v of withPayload) payloads[v.name] = mapType(v.payload!, enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias);
    (model.enums[i] as EnumDef).payloads = payloads;
  });

  for (const item of cst.items) {
    switch (item.$type) {
      case 'TicksDecl': model.ticksPerDay = parseInt((item as G.TicksDecl).value, 10); break;
      case 'ValueDecl': {
        const v = item as G.ValueDecl;
        const def: ValueDef = { kind: 'value', name: v.name, fields: mapFields([...v.fields], enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias) };
        if (v.invariants.length) def.invariants = v.invariants.map(inv => {
          // value invariants are unconditional own-field laws (design §3.5): `on`/`where` on the
          // header, or any body shape besides a plain predicate, is out of scope in v1.
          if (inv.target || inv.where || inv.body.$type !== 'PredicateBody')
            diags.push(diag('value-invariant-plain', `value invariant ${v.name}.${inv.name}: value invariants take a plain predicate body only — no 'on', 'where', or non-predicate body form`, inv));
          const body = inv.body.$type === 'PredicateBody' ? mapPred((inv.body as G.PredicateBody).pred, enumMap)
            : { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } as Predicate;
          const vi: { name: string; body: Predicate; doc?: string } = { name: inv.name, body };
          const d = joinDocs([...inv.docs]); if (d) vi.doc = d;
          locs.set(`invariant:${inv.name}`, at(inv));
          return vi;
        });
        const d = joinDocs([...v.docs]); if (d) def.doc = d;
        locs.set(`owner:${v.name}`, at(v)); noteFields(v.name, [...v.fields]);
        model.values.push(def); break;
      }
      case 'EntityDecl': {
        const e = item as G.EntityDecl;
        const def: EntityDef = { kind: 'entity', name: e.name, fields: mapFields([...e.fields], enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias) };
        const d = joinDocs([...e.docs]); if (d) def.doc = d;
        locs.set(`owner:${e.name}`, at(e)); noteFields(e.name, [...e.fields]);
        model.entities.push(def); break;
      }
      case 'EventDecl': {
        const e = item as G.EventDecl;
        const def: EventDef = { name: e.name, fields: mapFields([...e.fields], enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias) };
        const d = joinDocs([...e.docs]); if (d) def.doc = d;
        locs.set(`owner:${e.name}`, at(e)); noteFields(e.name, [...e.fields]);
        model.events.push(def); break;
      }
      case 'AggregateDecl': {
        const a = item as G.AggregateDecl;
        const def: AggregateDef = { kind: 'aggregate', name: a.name, fields: mapFields([...a.fields], enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias) };
        if (a.entities.length) def.entities = [...a.entities].map(e => {
          const child: EntityDef = { kind: 'entity', name: e.name, fields: mapFields([...e.fields], enumSet, diags, ownerNames, valueNames, carrierNames, resolveAlias) };
          const d = joinDocs([...e.docs]); if (d) child.doc = d;
          locs.set(`owner:${e.name}`, at(e)); noteFields(e.name, [...e.fields]);
          return child;
        });
        if (a.lifecycles.length) def.machine = mapLifecycles([...a.lifecycles], a.name, diags, enumMap);
        const d = joinDocs([...a.docs]); if (d) def.doc = d;
        locs.set(`owner:${a.name}`, at(a)); noteFields(a.name, [...a.fields]);
        for (const r of a.lifecycles) {
          locs.set(`region:${a.name}.${r.name}`, at(r));
          for (const st of r.states) locs.set(`state:${a.name}.${r.name}.${st.name}`, at(st));
          for (const t of r.transitions) locs.set(`transition:${a.name}.${t.name}`, at(t));
        }
        model.aggregates.push(def); break;
      }
      case 'ServiceDecl': {
        const s = item as G.ServiceDecl;
        const def: ServiceDef = { name: s.name, methods: mapMethods([...s.methods], enumSet, diags, ownerNames, valueNames, carrierNames, enumMap, resolveAlias) };
        const d = joinDocs([...s.docs]); if (d) def.doc = d;
        locs.set(`owner:${s.name}`, at(s));
        for (const mm of s.methods) locs.set(`method:${s.name}.${mm.name}`, at(mm));
        model.services.push(def); break;
      }
    }
  }

  // invariants: inside aggregates (implicit owner) and at context level (require `on`)
  const rawInvs: { decl: G.InvariantDecl; owner: string }[] = [];
  for (const item of cst.items) {
    if (item.$type === 'AggregateDecl')
      for (const inv of (item as G.AggregateDecl).invariants) {
        if (inv.target && inv.target !== (item as G.AggregateDecl).name)
          diags.push(diag('redundant-target', `invariant ${inv.name}: 'on ${inv.target}' inside aggregate ${(item as G.AggregateDecl).name}`, inv));
        rawInvs.push({ decl: inv, owner: (item as G.AggregateDecl).name });
      }
    if (item.$type === 'InvariantDecl') {
      const inv = item as G.InvariantDecl;
      if (!inv.target) { diags.push(diag('missing-target', `context-level invariant ${inv.name} needs 'on <Entity|Aggregate>'`, inv)); continue; }
      rawInvs.push({ decl: inv, owner: inv.target });
    }
  }

  const modelDiags = validateModel(model).map(d =>
    ({ code: d.code, message: d.at ? `${d.message} (at ${d.at})` : d.message, line: 1, col: 1 }));
  diags.push(...modelDiags);
  if (diags.length) return { ok: false, diagnostics: diags };

  const warnings: ParseDiagnostic[] = [];
  const invariants: CandidateInvariant[] = [];
  for (const { decl, owner } of rawInvs) {
    let candidate: Candidate;
    try { candidate = mapBody(decl, owner, model.aggregates.find(x => x.name === owner), enumMap); }
    catch (err) { diags.push(diag('unmapped-construct', String(err), decl)); continue; }
    if (decl.where && candidate.kind !== 'statePredicate') {
      // grammar accepts a header `where` on any body; only statePredicate carries one in the AST
      diags.push(diag('where-unsupported', `invariant ${decl.name}: 'where' guards apply only to predicate bodies`, decl));
      continue;
    }
    const gram = validateCandidate(candidate, model);
    if (gram.length) { gram.forEach(g => diags.push({ code: g.code, message: `invariant ${decl.name}: ${g.message}${g.at ? ` (at ${g.at})` : ''}`, ...at(decl) })); continue; }
    if (isImplied(candidate, model)) {
      warnings.push({ code: 'redundant-invariant',
        message: `invariant ${decl.name} restates a structure-implied rule; it is derived automatically and will not be printed`, ...at(decl) });
      continue;
    }
    const inv: CandidateInvariant = { id: `hand-${decl.name}`, name: decl.name, prior: 1, source: 'template', candidate };
    const d = joinDocs([...decl.docs]); if (d) inv.doc = d;
    locs.set(`invariant:${decl.name}`, at(decl));
    invariants.push(inv);
  }
  if (diags.length) return { ok: false, diagnostics: diags };

  warnings.push(...namingWarnings(model, invariants.map(i => i.name),
    k => locs.get(k) ?? { line: 1, col: 1 }));
  return { ok: true, model, invariants, warnings };
}

export function loadContextMapText(text: string): ContextMapLoadResult {
  const parsed = parseLat(text);
  if (!parsed.ok) return parsed;
  const file = parsed.cst;
  if (!file.map)
    return { ok: false, diagnostics: [{ code: 'wrong-file-kind', line: 1, col: 1,
      message: 'expected a contextMap file, got a context — the workspace map lives in context-map.lat' }] };
  const m = file.map;
  const map: ContextMapModel = {
    name: m.name,
    contexts: m.contains.map(c => ({ name: c.name, path: c.path ?? defaultPath(c.name) })),
    relationships: m.relationships.map(r => {
      const rel: Relationship = {
        kind: r.kind === 'upstream' ? 'upstreamDownstream' : r.kind as 'partnership' | 'sharedKernel',
        left: r.left, right: r.right,
      };
      if (r.upstreamRoles.length) rel.upstreamRoles = [...r.upstreamRoles] as Role[];
      if (r.downstreamRoles.length) rel.downstreamRoles = [...r.downstreamRoles] as Role[];
      if (r.exposes.length) rel.exposes = [...r.exposes];
      const d = joinDocs([...r.docs]); if (d) rel.doc = d;
      return rel;
    }),
  };
  const topDoc = joinDocs([...file.docs]); if (topDoc) map.doc = topDoc;
  const diags = validateContextMap(map).map(d =>
    ({ code: d.code, message: d.at ? `${d.message} (at ${d.at})` : d.message, line: 1, col: 1 }));
  if (diags.length) return { ok: false, diagnostics: diags };
  const warnings: ParseDiagnostic[] = [];
  if (!PASCAL.test(map.name)) warnings.push({ code: 'naming-convention', ...at(file.map),
    message: `contextMap '${map.name}' should be PascalCase (spec P8)` });
  for (const c of m.contains) if (!PASCAL.test(c.name)) warnings.push({ code: 'naming-convention',
    ...at(c), message: `context '${c.name}' should be PascalCase (spec P8)` });
  return { ok: true, map, warnings };
}
