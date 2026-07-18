import type { DomainModel, Field, Machine } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import { sumFieldPath } from '../ast/invariant.js';
import { isImplied } from '../engine/implied.js';
import type { ContextMapModel } from '../ast/contextmap.js';
import { defaultPath } from '../ast/contextmap.js';

const typeStr = (f: Field): string => {
  const t = f.type;
  switch (t.kind) {
    case 'prim': return t.prim;
    case 'enum': return t.enum;
    case 'value': return t.value;
    case 'ref': return `ref ${t.target}`;
    case 'list': return `List<${typeStr({ ...f, type: t.of })}>`;
    case 'optional': return `Optional<${typeStr({ ...f, type: t.of })}>`;
    case 'map': return `Map<${typeStr({ ...f, type: t.key })}, ${typeStr({ ...f, type: t.of })}>`;
    case 'generic': return `${t.ctor}<${t.args.map(a => typeStr({ ...f, type: a })).join(', ')}>`;
    case 'union': return t.arms.map(a => typeStr({ ...f, type: a })).join(' | ');
    case 'carrier': return t.name;
  }
};

const OPS = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' } as const;
// precedence: implies(1) < or(2) < and(3) < not(4) < atoms(5)
const prec = (p: Predicate): number =>
  p.kind === 'implies' ? 1 : p.kind === 'or' ? 2 : p.kind === 'and' ? 3 : p.kind === 'not' ? 4 : 5;
const wrap = (child: Predicate, parent: number): string =>
  prec(child) <= parent ? `(${predToText(child)})` : predToText(child);

function termToText(t: Term): string {
  switch (t.kind) {
    case 'field': return t.path.join('.');
    case 'int': return String(t.value);
    case 'enumval': return `${t.enum}.${t.value}`;
    case 'now': return 'now';
    case 'plus': return `${termToText(t.left)} + ${termToText(t.right)}`;
    case 'param': return t.name;
  }
}

export function predToText(p: Predicate): string {
  switch (p.kind) {
    case 'cmp': return `${termToText(p.left)} ${OPS[p.op]} ${termToText(p.right)}`;
    case 'inState': return `state ${p.region} in {${p.states.join(', ')}}`;
    case 'present': return `present(${p.path.join('.')})`;
    case 'and': return p.args.map(a => wrap(a, 3)).join(' && ');
    case 'or': return p.args.map(a => wrap(a, 2)).join(' || ');
    case 'not': return `! ${wrap(p.arg, 4)}`;
    case 'implies': return `${wrap(p.left, 1)} => ${wrap(p.right, 1)}`;
  }
}

export function candidateBodyText(c: Candidate): string {
  switch (c.kind) {
    case 'statePredicate': return predToText(c.body);
    case 'unique': return `unique while ${c.whileStates.region} in {${c.whileStates.states.join(', ')}} by (${c.by.map(p => p.join('.')).join(', ')})`;
    case 'refsResolve': return 'refs resolve';
    case 'cardinality': return `count ${c.where ? `where ${predToText(c.where)} ` : ''}<= ${c.atMost}`;
    case 'terminal': return `terminal ${c.region}.${c.state}`;
    case 'monotonic': return `monotonic ${c.field.join('.')}`;
    case 'conservation':
      // grammar: 'conserve' parts ('+' parts)+ — a single part would print as unparseable text
      if (c.parts.length < 2) throw new Error(`cannot print conservation on ${c.aggregate}: needs >= 2 parts, got ${c.parts.length}`);
      return `conserve ${c.parts.map(p => p.join('.')).join(' + ')} == ${c.total.join('.')}`;
    case 'leadsTo': return `from ${predToText(c.from)} leads to ${predToText(c.to)} under fairness "${c.fairness}"`;
    case 'sumOverCollection': {
      const ops = { eq: '==', le: '<=', ge: '>=' } as const;
      // Dot-joined via sumFieldPath, never `${c.field}`: a Path interpolates comma-joined, so the
      // bare template would silently emit `sum(legs, amount,amount)`. The .langium surface is
      // `field=PathExpr`, so this dotted form re-parses — see fromLangium's SumBody.
      return `${c.total.join('.')} ${ops[c.op]} sum(${c.collection}, ${sumFieldPath(c).join('.')})`;
    }
    case 'guard': throw new Error('candidateBodyText: a guard is a transition enablement, not an always-property — it has no invariant-source rendering (guards are never authored)');
  }
}

const doc = (d: string | undefined, indent: string, out: string[]) => { if (d) out.push(`${indent}/// ${d}`); };
const pad = (n: string, w: number) => n + ' '.repeat(Math.max(1, w - n.length));

function fieldLines(fields: Field[], indent: string, out: string[]): void {
  const w = Math.max(...fields.map(f => f.name.length)) + 1;
  for (const f of fields) {
    doc(f.doc, indent, out);
    out.push(`${indent}${pad(f.name, w)}: ${typeStr(f)}${f.optional ? '?' : ''}${f.key ? ' key' : ''}${f.const ? ' const' : ''}${f.tags?.length ? ' @' + f.tags.join(' @') : ''}`);
  }
}

// Adopted `guard` candidates (§8.5-8.7 CTI-strengthening write-back) conjoin into their transition's
// authored `requires` at emit time — guards are never authored directly (see candidateBodyText's
// loud-exclusion for the kind), only ever adopted via `engine strengthen`. A transition with no
// adopted guard renders EXACTLY as before (single-item combine returns the authored `requires`
// object itself, so predToText sees the identical AST) — this keeps no-guard `.lat` output
// byte-identical, a hard constraint for every model that predates guard adoption.
// Order-independent structural key for a predicate — recursively sorts object keys so two ASTs that
// differ only in property insertion order (parsed authored `requires` vs a generated guard predicate)
// still compare equal.
function canonKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonKey).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map(k => JSON.stringify(k) + ':' + canonKey((v as Record<string, unknown>)[k])).join(',') + '}';
}

function combineRequires(requires: Predicate | undefined, guards: Predicate[]): Predicate | undefined {
  const all = requires ? [requires, ...guards] : guards;
  // Drop structurally-identical duplicates (design carried fix iv) so a guard equal to the authored
  // `requires` — or to another guard on the same transition — never renders `p && p`. First
  // occurrence wins, preserving the authored-then-guards order.
  const seen = new Set<string>();
  const deduped = all.filter(p => { const k = canonKey(p); return seen.has(k) ? false : (seen.add(k), true); });
  if (deduped.length === 0) return undefined;
  if (deduped.length === 1) return deduped[0];
  return { kind: 'and', args: deduped };
}

function machineLines(agg: string, mach: Machine, guardsByTransition: Map<string, Predicate[]>, out: string[], indent = '    '): void {
  for (const r of mach.regions) {
    out.push(`${indent}lifecycle ${r.name} {`);
    const states = r.states.map(s => {
      const tags = [...(s.name === r.initial ? ['initial'] : []), ...(s.tags ?? [])];
      return s.name + (tags.length ? ' @' + tags.join(' @') : '');
    }).join(', ');
    out.push(`${indent}  states { ${states} }`);
    for (const t of mach.transitions.filter(t => t.region === r.name)) {
      const guards = guardsByTransition.get(`${agg}.${r.name}.${t.name}`) ?? [];
      const effective = combineRequires(t.requires, guards);
      out.push(`${indent}  transition ${t.name} { from ${t.from.join(', ')} to ${t.to}${t.when ? `; when ${t.when}` : ''}${effective ? `; requires ${predToText(effective)}` : ''}${t.emits ? `; emits ${t.emits}` : ''} }`);
    }
    out.push(`${indent}}`);
  }
}

function invariantLines(inv: CandidateInvariant, indent: string, on: string | undefined, out: string[]): void {
  doc(inv.doc, indent, out);
  const c = inv.candidate;
  const where = c.kind === 'statePredicate' && c.where ? ` where ${predToText(c.where)}` : '';
  out.push(`${indent}invariant ${inv.name}${on ? ` on ${on}` : ''}${where} { ${candidateBodyText(c)} }`);
}

// Emit per-kind blocks filtered to decls matching the given module (undefined = top-level only).
function emitBuiltins(builtins: DomainModel['builtins'], modFilter: string | undefined, indent: string, out: string[]): void {
  const items = (builtins ?? []).filter(b => b.module === modFilter);
  if (items.length) { for (const b of items) out.push(`${indent}builtin ${b.name}${b.ref ? ` = "${b.ref}"` : ''}`); out.push(''); }
}

function emitEnums(enums: DomainModel['enums'], modFilter: string | undefined, indent: string, out: string[]): void {
  const items = enums.filter(e => e.module === modFilter);
  for (const e of items) {
    if (!e.values.length) throw new Error(`cannot print enum ${e.name}: it has no values`);
    const variants = e.values.map(v => { const p = e.payloads?.[v]; return p ? `${v}(${typeStr({ name: '', type: p })})` : v; });
    out.push(`${indent}enum ${e.name} { ${variants.join(', ')} }`);
  }
  if (items.length) out.push('');
}

function emitTypeAliases(typeAliases: DomainModel['typeAliases'], modFilter: string | undefined, indent: string, out: string[]): void {
  const items = (typeAliases ?? []).filter(ta => ta.module === modFilter);
  for (const ta of items) { doc(ta.doc, indent, out); out.push(`${indent}type ${ta.name} = ${typeStr({ name: '', type: ta.target })}`); }
  if (items.length) out.push('');
}

function emitRecords(records: DomainModel['records'], modFilter: string | undefined, indent: string, out: string[]): void {
  for (const r of (records ?? []).filter(r => r.module === modFilter)) {
    doc(r.doc, indent, out);
    out.push(`${indent}type ${r.name} = {`);
    fieldLines(r.fields, indent + '  ', out);
    out.push(`${indent}}`, '');
  }
}

function emitValues(values: DomainModel['values'], modFilter: string | undefined, indent: string, out: string[]): void {
  for (const v of values.filter(v => v.module === modFilter)) {
    doc(v.doc, indent, out);
    out.push(`${indent}value ${v.name} {`);
    fieldLines(v.fields, indent + '  ', out);
    for (const inv of v.invariants ?? []) {
      doc(inv.doc, indent + '  ', out);
      out.push(`${indent}  invariant ${inv.name} { ${predToText(inv.body)} }`);
    }
    out.push(`${indent}}`, '');
  }
}

function emitEntities(entities: DomainModel['entities'], modFilter: string | undefined, indent: string, out: string[]): void {
  for (const ent of entities.filter(e => e.module === modFilter)) {
    doc(ent.doc, indent, out);
    out.push(`${indent}entity ${ent.name} {`);
    fieldLines(ent.fields, indent + '  ', out);
    out.push(`${indent}}`, '');
  }
}

function emitEvents(events: DomainModel['events'], modFilter: string | undefined, indent: string, out: string[]): void {
  for (const ev of events.filter(e => e.module === modFilter)) {
    doc(ev.doc, indent, out);
    out.push(`${indent}event ${ev.name} {`);
    fieldLines(ev.fields, indent + '  ', out);
    out.push(`${indent}}`, '');
  }
}

function emitAggregates(aggregates: DomainModel['aggregates'], modFilter: string | undefined, indent: string, explicit: CandidateInvariant[], guardsByTransition: Map<string, Predicate[]>, out: string[]): void {
  for (const a of aggregates.filter(a => a.module === modFilter)) {
    doc(a.doc, indent, out);
    out.push(`${indent}aggregate ${a.name} {`);
    fieldLines(a.fields, indent + '  ', out);
    for (const child of a.entities ?? []) {
      out.push('');
      doc(child.doc, indent + '  ', out);
      out.push(`${indent}  entity ${child.name} {`);
      fieldLines(child.fields, indent + '    ', out);
      out.push(`${indent}  }`);
    }
    if (a.machine) { out.push(''); machineLines(a.name, a.machine, guardsByTransition, out, indent + '  '); }
    for (const inv of explicit.filter(i => i.candidate.aggregate === a.name)) {
      out.push('');
      invariantLines(inv, indent + '  ', undefined, out);
    }
    out.push(`${indent}}`, '');
  }
}

function emitServices(services: DomainModel['services'], modFilter: string | undefined, indent: string, out: string[]): void {
  for (const s of services.filter(s => s.module === modFilter)) {
    doc(s.doc, indent, out);
    out.push(`${indent}service ${s.name} {`);
    for (const mm of s.methods) {
      doc(mm.doc, indent + '  ', out);
      const params = mm.params.map(p => `${p.name}: ${typeStr({ name: p.name, type: p.type })}`).join(', ');
      const ret = mm.returns ? `: ${typeStr({ name: '', type: mm.returns })}` : '';
      const kind = 'readOnly' in mm.kind ? 'read-only'
        : 'creates' in mm.kind ? `creates ${mm.kind.creates}`
        : `performs ${mm.kind.performs.aggregate}.${mm.kind.performs.transition}`;
      out.push(`${indent}  ${mm.name}(${params})${ret} ${kind}${mm.requires ? ` requires ${predToText(mm.requires)}` : ''}`);
    }
    out.push(`${indent}}`, '');
  }
}

export function astToCode(m: DomainModel, adopted: CandidateInvariant[]): string {
  // spec §3.4: implied never printed; guards (§8.5-8.7) are never printed as standalone `invariant`
  // blocks either — they render only via their transition's `requires` (guardsByTransition below).
  const explicit = adopted.filter(i => i.candidate.kind !== 'guard' && !isImplied(i.candidate, m));
  const guardsByTransition = new Map<string, Predicate[]>();
  for (const i of adopted) {
    if (i.candidate.kind !== 'guard') continue;
    const g = i.candidate;
    const key = `${g.aggregate}.${g.region}.${g.transition}`;
    const list = guardsByTransition.get(key);
    if (list) list.push(g.predicate); else guardsByTransition.set(key, [g.predicate]);
  }
  const out: string[] = [];
  doc(m.doc, '', out);
  out.push(`context ${m.context} {`, '');
  if (m.ticksPerDay !== undefined) out.push(`  ticksPerDay = ${m.ticksPerDay}`, '');

  // Collect module names in first-appearance order across all decl kinds.
  const allDeclsWithModule: Array<{ module?: string }> = [
    ...(m.builtins ?? []),
    ...m.enums,
    ...(m.typeAliases ?? []),
    ...(m.records ?? []),
    ...m.values,
    ...m.entities,
    ...m.events,
    ...m.aggregates,
    ...m.services,
  ];
  const moduleOrder: string[] = [];
  for (const d of allDeclsWithModule) {
    if (d.module && !moduleOrder.includes(d.module)) moduleOrder.push(d.module);
  }

  // Emit top-level (module === undefined) decls first, by kind — exactly as before.
  // `builtin` carriers: declared before types that reference them.
  emitBuiltins(m.builtins, undefined, '  ', out);
  emitEnums(m.enums, undefined, '  ', out);
  emitTypeAliases(m.typeAliases, undefined, '  ', out);
  emitRecords(m.records, undefined, '  ', out);
  emitValues(m.values, undefined, '  ', out);
  emitEntities(m.entities, undefined, '  ', out);
  emitEvents(m.events, undefined, '  ', out);
  emitAggregates(m.aggregates, undefined, '  ', explicit, guardsByTransition, out);
  emitServices(m.services, undefined, '  ', out);

  // Context-level invariants that are not inside any aggregate.
  for (const inv of explicit.filter(i => !m.aggregates.some(a => a.name === i.candidate.aggregate))) {
    invariantLines(inv, '  ', inv.candidate.aggregate, out);
    out.push('');
  }

  // Emit module blocks in first-appearance order.
  for (const mod of moduleOrder) {
    out.push(`  module ${mod} {`, '');
    emitBuiltins(m.builtins, mod, '    ', out);
    emitEnums(m.enums, mod, '    ', out);
    emitTypeAliases(m.typeAliases, mod, '    ', out);
    emitRecords(m.records, mod, '    ', out);
    emitValues(m.values, mod, '    ', out);
    emitEntities(m.entities, mod, '    ', out);
    emitEvents(m.events, mod, '    ', out);
    emitAggregates(m.aggregates, mod, '    ', explicit, guardsByTransition, out);
    emitServices(m.services, mod, '    ', out);
    // remove trailing empty line before closing brace
    while (out[out.length - 1] === '') out.pop();
    out.push('  }', '');
  }

  while (out[out.length - 1] === '') out.pop();
  out.push('}');
  return out.join('\n') + '\n';
}

export function contextMapToCode(map: ContextMapModel): string {
  const out: string[] = [];
  doc(map.doc, '', out);
  out.push(`contextMap ${map.name} {`);
  for (const c of map.contexts)
    out.push(`  contains ${c.name}${c.path === defaultPath(c.name) ? '' : ` from "${c.path}"`}`);
  for (const r of map.relationships) {
    out.push('');
    doc(r.doc, '  ', out);
    const head = r.kind === 'upstreamDownstream'
      ? `${r.left} upstream of ${r.right}`
      : `${r.left} ${r.kind === 'partnership' ? 'partnership' : 'sharedKernel'} with ${r.right}`;
    out.push(`  ${head} {`);
    if (r.upstreamRoles?.length) out.push(`    upstream roles ${r.upstreamRoles.join(', ')}`);
    if (r.downstreamRoles?.length) out.push(`    downstream roles ${r.downstreamRoles.join(', ')}`);
    if (r.exposes?.length) out.push(`    exposes ${r.exposes.join(', ')}`);
    out.push('  }');
  }
  out.push('}');
  return out.join('\n') + '\n';
}
