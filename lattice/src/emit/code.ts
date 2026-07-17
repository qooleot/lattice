import type { DomainModel, Field, Machine } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import { isImplied } from '../engine/implied.js';
import type { ContextMapModel } from '../ast/contextmap.js';
import { defaultPath } from '../ast/contextmap.js';

const typeStr = (f: Field): string =>
  f.type.kind === 'prim' ? f.type.prim : f.type.kind === 'enum' ? f.type.enum
  : f.type.kind === 'value' ? f.type.value
  : f.type.kind === 'ref' ? `ref ${f.type.target}` : `List<${typeStr({ ...f, type: f.type.of })}>`;

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
      return `${c.total.join('.')} ${ops[c.op]} sum(${c.collection}, ${c.field})`;
    }
    case 'guard': throw new Error('candidateBodyText: a guard is a transition enablement, not an always-property — it has no invariant-source rendering (guards are never authored)');
  }
}

const doc = (d: string | undefined, indent: string, out: string[]) => { if (d) out.push(`${indent}/// ${d}`); };
const pad = (n: string, w: number) => n + ' '.repeat(Math.max(1, w - n.length));

function fieldLines(fields: Field[], indent: string, out: string[]): void {
  const w = Math.max(...fields.map(f => f.name.length)) + 1;
  for (const f of fields)
    out.push(`${indent}${pad(f.name, w)}: ${typeStr(f)}${f.optional ? '?' : ''}${f.key ? ' key' : ''}${f.const ? ' const' : ''}${f.tags?.length ? ' @' + f.tags.join(' @') : ''}`);
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

function machineLines(agg: string, mach: Machine, guardsByTransition: Map<string, Predicate[]>, out: string[]): void {
  for (const r of mach.regions) {
    out.push(`    lifecycle ${r.name} {`);
    const states = r.states.map(s => {
      const tags = [...(s.name === r.initial ? ['initial'] : []), ...(s.tags ?? [])];
      return s.name + (tags.length ? ' @' + tags.join(' @') : '');
    }).join(', ');
    out.push(`      states { ${states} }`);
    for (const t of mach.transitions.filter(t => t.region === r.name)) {
      const guards = guardsByTransition.get(`${agg}.${r.name}.${t.name}`) ?? [];
      const effective = combineRequires(t.requires, guards);
      out.push(`      transition ${t.name} { from ${t.from.join(', ')} to ${t.to}${t.when ? `; when ${t.when}` : ''}${effective ? `; requires ${predToText(effective)}` : ''}${t.emits ? `; emits ${t.emits}` : ''} }`);
    }
    out.push('    }');
  }
}

function invariantLines(inv: CandidateInvariant, indent: string, on: string | undefined, out: string[]): void {
  doc(inv.doc, indent, out);
  const c = inv.candidate;
  const where = c.kind === 'statePredicate' && c.where ? ` where ${predToText(c.where)}` : '';
  out.push(`${indent}invariant ${inv.name}${on ? ` on ${on}` : ''}${where} { ${candidateBodyText(c)} }`);
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
  for (const e of m.enums) {
    // grammar requires >= 1 value — 'enum X {  }' would not parse back
    if (!e.values.length) throw new Error(`cannot print enum ${e.name}: it has no values`);
    out.push(`  enum ${e.name} { ${e.values.join(', ')} }`);
  }
  if (m.enums.length) out.push('');
  for (const v of m.values) {
    doc(v.doc, '  ', out);
    out.push(`  value ${v.name} {`);
    fieldLines(v.fields, '    ', out);
    for (const inv of v.invariants ?? []) {
      doc(inv.doc, '    ', out);
      out.push(`    invariant ${inv.name} { ${predToText(inv.body)} }`);
    }
    out.push('  }', '');
  }
  for (const ent of m.entities) {
    doc(ent.doc, '  ', out);
    out.push(`  entity ${ent.name} {`);
    fieldLines(ent.fields, '    ', out);
    out.push('  }', '');
  }
  for (const ev of m.events) {
    doc(ev.doc, '  ', out);
    out.push(`  event ${ev.name} {`);
    fieldLines(ev.fields, '    ', out);
    out.push('  }', '');
  }
  for (const a of m.aggregates) {
    doc(a.doc, '  ', out);
    out.push(`  aggregate ${a.name} {`);
    fieldLines(a.fields, '    ', out);
    for (const child of a.entities ?? []) {
      out.push('');
      doc(child.doc, '    ', out);
      out.push(`    entity ${child.name} {`);
      fieldLines(child.fields, '      ', out);
      out.push('    }');
    }
    if (a.machine) { out.push(''); machineLines(a.name, a.machine, guardsByTransition, out); }
    for (const inv of explicit.filter(i => i.candidate.aggregate === a.name)) {
      out.push('');
      invariantLines(inv, '    ', undefined, out);
    }
    out.push('  }', '');
  }
  for (const s of m.services) {
    doc(s.doc, '  ', out);
    out.push(`  service ${s.name} {`);
    for (const mm of s.methods) {
      doc(mm.doc, '    ', out);
      const params = mm.params.map(p => `${p.name}: ${typeStr({ name: p.name, type: p.type })}`).join(', ');
      const ret = mm.returns ? `: ${typeStr({ name: '', type: mm.returns })}` : '';
      const kind = 'readOnly' in mm.kind ? 'read-only'
        : 'creates' in mm.kind ? `creates ${mm.kind.creates}`
        : `performs ${mm.kind.performs.aggregate}.${mm.kind.performs.transition}`;
      out.push(`    ${mm.name}(${params})${ret} ${kind}${mm.requires ? ` requires ${predToText(mm.requires)}` : ''}`);
    }
    out.push('  }', '');
  }
  for (const inv of explicit.filter(i => !m.aggregates.some(a => a.name === i.candidate.aggregate))) {
    invariantLines(inv, '  ', inv.candidate.aggregate, out);
    out.push('');
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
