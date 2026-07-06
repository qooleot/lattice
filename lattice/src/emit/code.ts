import type { DomainModel, Field, Machine } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import { isImplied } from '../engine/implied.js';

const typeStr = (f: Field): string =>
  f.type.kind === 'prim' ? f.type.prim : f.type.kind === 'enum' ? f.type.enum
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
  }
}

export function predToText(p: Predicate): string {
  switch (p.kind) {
    case 'cmp': return `${termToText(p.left)} ${OPS[p.op]} ${termToText(p.right)}`;
    case 'inState': return `state ${p.region} in {${p.states.join(', ')}}`;
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
    case 'conservation': return `conserve ${c.parts.map(p => p.join('.')).join(' + ')} == ${c.total.join('.')}`;
    case 'leadsTo': return `from ${predToText(c.from)} leads to ${predToText(c.to)} under fairness "${c.fairness}"`;
  }
}

const doc = (d: string | undefined, indent: string, out: string[]) => { if (d) out.push(`${indent}/// ${d}`); };
const pad = (n: string, w: number) => n + ' '.repeat(Math.max(1, w - n.length));

function fieldLines(fields: Field[], indent: string, out: string[]): void {
  const w = Math.max(...fields.map(f => f.name.length)) + 1;
  for (const f of fields)
    out.push(`${indent}${pad(f.name, w)}: ${typeStr(f)}${f.key ? ' key' : ''}${f.tags?.length ? ' @' + f.tags.join(' @') : ''}`);
}

function machineLines(mach: Machine, out: string[]): void {
  out.push('    machine {');
  for (const r of mach.regions) {
    const states = r.states.map(s => {
      const tags = [...(s.name === r.initial ? ['initial'] : []), ...(s.tags ?? [])];
      return s.name + (tags.length ? ' @' + tags.join(' @') : '');
    }).join(', ');
    out.push(`      region ${r.name} { states { ${states} } }`);
  }
  for (const t of mach.transitions)
    out.push(`      transition ${t.name} { region ${t.region}; from ${t.from} to ${t.to}${t.when ? `; when ${t.when}` : ''} }`);
  out.push('    }');
}

function invariantLines(inv: CandidateInvariant, indent: string, on: string | undefined, out: string[]): void {
  doc(inv.doc, indent, out);
  const c = inv.candidate;
  const where = c.kind === 'statePredicate' && c.where ? ` where ${predToText(c.where)}` : '';
  out.push(`${indent}invariant ${inv.name}${on ? ` on ${on}` : ''}${where} { ${candidateBodyText(c)} }`);
}

export function astToCode(m: DomainModel, adopted: CandidateInvariant[]): string {
  const explicit = adopted.filter(i => !isImplied(i.candidate, m));   // spec §3.4: implied never printed
  const out: string[] = [];
  doc(m.doc, '', out);
  out.push(`context ${m.context} {`, '');
  if (m.ticksPerDay !== undefined) out.push(`  ticksPerDay = ${m.ticksPerDay}`, '');
  for (const e of m.enums) out.push(`  enum ${e.name} { ${e.values.join(', ')} }`);
  if (m.enums.length) out.push('');
  for (const ent of m.entities) {
    doc(ent.doc, '  ', out);
    out.push(`  entity ${ent.name} {`);
    fieldLines(ent.fields, '    ', out);
    out.push('  }', '');
  }
  for (const ev of m.events) {
    out.push(`  event ${ev.name} {`);
    fieldLines(ev.fields, '    ', out);
    out.push('  }', '');
  }
  for (const a of m.aggregates) {
    doc(a.doc, '  ', out);
    out.push(`  aggregate ${a.name} {`);
    fieldLines(a.fields, '    ', out);
    if (a.machine) { out.push(''); machineLines(a.machine, out); }
    for (const inv of explicit.filter(i => i.candidate.aggregate === a.name)) {
      out.push('');
      invariantLines(inv, '    ', undefined, out);
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
