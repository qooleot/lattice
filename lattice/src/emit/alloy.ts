import type { DomainModel, AggregateDef, EntityDef } from '../ast/domain.js';
import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';
import type { SalientFact } from '../engine/session.js';

export interface AlloyQuery {
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit';
  hi: Candidate; hj?: Candidate;
  exclusions: SalientFact[][];
  scope: number;
}

const isIntPrim = (p: string) => ['Int', 'Money', 'Date', 'Duration'].includes(p);

function emitOwnerSig(o: AggregateDef | EntityDef): string {
  const fields: string[] = [];
  for (const f of o.fields) {
    if (f.key) continue;
    if (f.type.kind === 'ref') fields.push(`  ${f.name}: one ${f.type.target}`);
    else if (f.type.kind === 'enum') fields.push(`  ${f.name}: one ${f.type.enum}`);
    else if (f.type.kind === 'prim' && isIntPrim(f.type.prim)) fields.push(`  ${f.name}: one Int`);
    // Text/Id dropped — atom identity suffices
  }
  const machine = (o as AggregateDef).machine;
  for (const r of machine?.regions ?? []) fields.push(`  ${r.name}_state: one ${o.name}_${r.name}`);
  return `sig ${o.name} {\n${fields.join(',\n')}\n}`;
}

function emitStateSigs(a: AggregateDef): string {
  return (a.machine?.regions ?? []).map(r =>
    `abstract sig ${a.name}_${r.name} {}\n` +
    r.states.map(s => `one sig ${a.name}_${r.name}_${s.name} extends ${a.name}_${r.name} {}`).join('\n')
  ).join('\n');
}

const alloyPath = (v: string, p: Path) => [v, ...p].join('.');

function inStateExpr(agg: string, v: string, region: string, states: string[]): string {
  return '(' + states.map(s => `${v}.${region}_state = ${agg}_${region}_${s}`).join(' or ') + ')';
}

function termToAlloy(t: Term, v: string): string {
  switch (t.kind) {
    case 'field': return alloyPath(v, t.path);
    case 'int': return String(t.value);
    case 'enumval': return t.value;
    case 'now': throw new Error('now is not expressible structurally — route to quint');
    case 'plus': return `${termToAlloy(t.left, v)}.plus[${termToAlloy(t.right, v)}]`;
  }
}
function predToAlloy(p: Predicate, agg: string, v: string): string {
  switch (p.kind) {
    case 'cmp': {
      const l = termToAlloy(p.left, v), r = termToAlloy(p.right, v);
      const ops: Record<string, string> = { eq: '=', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      return `(${l} ${ops[p.op]} ${r})`;
    }
    case 'inState': return inStateExpr(agg, v, p.region, p.states);
    case 'and': return '(' + p.args.map(a => predToAlloy(a, agg, v)).join(' and ') + ')';
    case 'or': return '(' + p.args.map(a => predToAlloy(a, agg, v)).join(' or ') + ')';
    case 'not': return `(not ${predToAlloy(p.arg, agg, v)})`;
    case 'implies': return `(${predToAlloy(p.left, agg, v)} implies ${predToAlloy(p.right, agg, v)})`;
  }
}

function candidateToPred(c: Candidate, name: string): string {
  switch (c.kind) {
    case 'unique': {
      const inS = (v: string) => inStateExpr(c.aggregate, v, c.whileStates.region, c.whileStates.states);
      const eqs = c.by.map(p => `${alloyPath('a', p)} = ${alloyPath('b', p)}`).join(' and ');
      return `pred ${name} { all disj a, b: ${c.aggregate} | (${inS('a')} and ${inS('b')}) implies not (${eqs}) }`;
    }
    case 'refsResolve': return `pred ${name} { }`;   // refs are total in Alloy sigs by construction — vacuously true
    case 'cardinality': {
      const guard = c.where ? predToAlloy(c.where, c.aggregate, 'x') : 'x = x';
      return `pred ${name} { #{ x: ${c.aggregate} | ${guard} } <= ${c.atMost} }`;
    }
    case 'statePredicate': {
      const guard = c.where ? `${predToAlloy(c.where, c.aggregate, 'x')} implies ` : '';
      return `pred ${name} { all x: ${c.aggregate} | ${guard}${predToAlloy(c.body, c.aggregate, 'x')} }`;
    }
    default: throw new Error(`${c.kind} routes to quint, not alloy`);
  }
}

/** Rebuild a judged shape (salient facts) as an existential pattern to exclude. */
function shapeToPred(facts: SalientFact[], subject: Candidate, name: string): string {
  const agg = subject.aggregate;
  const w = subject.kind === 'unique' ? subject.whileStates : null;
  const conj: string[] = [];
  for (const f of facts) {
    const mEq = f.dim.match(/^(.+) equal$/);
    if (mEq) { const p = mEq[1]!.split('.'); conj.push(`${alloyPath('a', p)} ${f.value ? '=' : '!='} ${alloyPath('b', p)}`); continue; }
    const mVal = f.dim.match(/^(.+) = (.+)$/);
    if (mVal) { conj.push(`${alloyPath('a', mVal[1]!.split('.'))} = ${mVal[2]}`); continue; }
    // 'inState count' and comparison dims don't constrain structural shapes further
  }
  const inS = w ? `${inStateExpr(agg, 'a', w.region, w.states)} and ${inStateExpr(agg, 'b', w.region, w.states)} and ` : '';
  return `pred ${name} { some disj a, b: ${agg} | ${inS}${conj.join(' and ') || 'a != b'} }`;
}

function nonVacuousPred(c: Candidate): string {
  if (c.kind === 'unique') {
    const inS = (v: string) => inStateExpr(c.aggregate, v, c.whileStates.region, c.whileStates.states);
    return `pred nonVacuous { some disj a, b: ${c.aggregate} | ${inS('a')} and ${inS('b')} }`;
  }
  if (c.kind === 'statePredicate' && c.body.kind === 'implies')
    return `pred nonVacuous { some x: ${c.aggregate} | ${predToAlloy(c.body.left, c.aggregate, 'x')} }`;
  return `pred nonVacuous { some ${c.aggregate} }`;
}

export function astToAlloy(m: DomainModel, q: AlloyQuery): string {
  const parts: string[] = [`module lattice_q`];
  for (const e of m.enums) parts.push(`abstract sig ${e.name} {}\n` + e.values.map(v => `one sig ${v} extends ${e.name} {}`).join('\n'));
  for (const e of m.entities) parts.push(emitOwnerSig(e));
  for (const a of m.aggregates) { parts.push(emitStateSigs(a)); parts.push(emitOwnerSig(a)); }
  parts.push(candidateToPred(q.hi, 'Hi'));
  if (q.hj) parts.push(candidateToPred(q.hj, 'Hj'));
  q.exclusions.forEach((facts, i) => parts.push(shapeToPred(facts, q.hi, `shape${i}`)));
  const notShapes = q.exclusions.map((_, i) => `(not shape${i})`).join(' and ');
  const withShapes = (body: string) => notShapes ? `${body} and ${notShapes}` : body;
  if (q.kind === 'distinguish') parts.push(`run q { ${withShapes('(Hi and not Hj) or (not Hi and Hj)')} } for ${q.scope} but 5 Int`);
  else if (q.kind === 'probe-forbid') parts.push(`run q { ${withShapes('(not Hi)')} } for ${q.scope} but 5 Int`);
  else { parts.push(nonVacuousPred(q.hi)); parts.push(`run q { ${withShapes('Hi and nonVacuous')} } for ${q.scope} but 5 Int`); }
  return parts.join('\n\n') + '\n';
}
