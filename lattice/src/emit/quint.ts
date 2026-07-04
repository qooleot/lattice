import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import type { Candidate, Cmp, Path, Predicate, Term } from '../ast/invariant.js';
import type { SalientFact } from '../engine/session.js';

export interface QuintQuery { kind: 'distinguish' | 'probe-forbid' | 'probe-permit'; hi: Candidate; hj?: Candidate; exclusions: SalientFact[][]; maxSteps: number }
export interface QuintEmission { source: string; invariantName: string; varTypes: Record<string, string> }

const varName = (n: string) => n.charAt(0).toLowerCase() + n.slice(1) + 's';
const isIntPrim = (p: string) => ['Int', 'Money', 'Date', 'Duration'].includes(p);
const INT_POOL = 'Set(0, 24, 72, 100)';
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];

function fieldQType(m: DomainModel, f: Field): string | null {
  if (f.key) return null;
  if (f.type.kind === 'ref') return 'str';
  if (f.type.kind === 'enum') return 'str';
  if (f.type.kind === 'prim') return isIntPrim(f.type.prim) ? 'int' : null;   // Text/Id dropped
  return null;   // lists unsupported in slice-1 quint emission
}
function initValue(m: DomainModel, f: Field, nondets: string[], tag: string): string | null {
  const t = fieldQType(m, f);
  if (!t) return null;
  const nd = `nd_${tag}_${f.name}`;
  if (f.type.kind === 'enum') {
    const vals = m.enums.find(e => e.name === (f.type as any).enum)!.values.map(v => `"${v}"`).join(', ');
    nondets.push(`nondet ${nd} = oneOf(Set(${vals}))`);
  } else if (f.type.kind === 'ref') {
    nondets.push(`nondet ${nd} = oneOf(${(f.type as any).target.toUpperCase()}_IDS)`);
  } else nondets.push(`nondet ${nd} = oneOf(${INT_POOL})`);
  return nd;
}

function termToQuint(m: DomainModel, t: Term, self: string, ownerName: string): string {
  switch (t.kind) {
    case 'int': return String(t.value);
    case 'enumval': return `"${t.value}"`;
    case 'now': return 'now';
    case 'plus': return `${termToQuint(m, t.left, self, ownerName)} + ${termToQuint(m, t.right, self, ownerName)}`;
    case 'field': return pathToQuint(m, t.path, self, ownerName);
  }
}
function pathToQuint(m: DomainModel, path: Path, self: string, ownerName: string): string {
  let expr = self, owner = ownerName;
  for (let i = 0; i < path.length; i++) {
    const def = owners(m).find(o => o.name === owner)!;
    const f = def.fields.find(x => x.name === path[i])!;
    expr = `${expr}.${path[i]}`;
    if (i < path.length - 1 && f.type.kind === 'ref') {
      owner = f.type.target;
      expr = `${varName(owner)}.get(${expr})`;
    }
  }
  return expr;
}

// Every `<var>.get(<expr>)` sub-expression a multi-hop path passes through when crossing a ref
// (mirrors pathToQuint's own ref-hop detection). Non-machine aggregates/entities start with
// `exists: false` and are only ever populated by a `create_*` action (see initValue/emitOwnerSig
// above) — but Quint's map model still returns a concrete (nondeterministically chosen) value for
// every key regardless of that flag, since field access is never itself gated on `exists`. Without
// requiring each hop's target to actually exist, Apalache is free to "read" a never-created
// record's placeholder fields to manufacture a counterexample that refers to data that was never
// instantiated — a spurious witness, not a real violation. refHopsInTerm/predToQuint's `cmp` case
// below use these to gate each comparison on its ref targets actually existing.
function refHopsIn(m: DomainModel, path: Path, self: string, ownerName: string): string[] {
  const hops: string[] = [];
  let expr = self, owner = ownerName;
  for (let i = 0; i < path.length; i++) {
    const def = owners(m).find(o => o.name === owner)!;
    const f = def.fields.find(x => x.name === path[i])!;
    expr = `${expr}.${path[i]}`;
    if (i < path.length - 1 && f.type.kind === 'ref') {
      owner = f.type.target;
      expr = `${varName(owner)}.get(${expr})`;
      hops.push(expr);
    }
  }
  return hops;
}
function refHopsInTerm(m: DomainModel, t: Term, self: string, ownerName: string): string[] {
  switch (t.kind) {
    case 'field': return refHopsIn(m, t.path, self, ownerName);
    case 'plus': return [...refHopsInTerm(m, t.left, self, ownerName), ...refHopsInTerm(m, t.right, self, ownerName)];
    case 'int': case 'enumval': case 'now': return [];
  }
}
function predToQuint(m: DomainModel, p: Predicate, self: string, ownerName: string): string {
  switch (p.kind) {
    case 'cmp': {
      const ops: Record<Cmp, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      const cmp = `(${termToQuint(m, p.left, self, ownerName)} ${ops[p.op]} ${termToQuint(m, p.right, self, ownerName)})`;
      // Match evaluate.ts's evalPred('cmp'): "unknown facts don't convict" — if either side reads
      // through a ref to a record that was never created (see refHopsIn above), the comparison's
      // operands are meaningless placeholder data, not a real fact, so this node must evaluate to
      // true (vacuously) exactly like the TS judge does, rather than let Apalache read through to
      // a never-created record to manufacture a spurious counterexample.
      const hops = [...refHopsInTerm(m, p.left, self, ownerName), ...refHopsInTerm(m, p.right, self, ownerName)];
      if (hops.length === 0) return cmp;
      const allExist = [...new Set(hops)].map(h => `${h}.exists`).join(' and ');
      return `((${allExist}) implies ${cmp})`;
    }
    case 'inState': return '(' + p.states.map(s => `${self}.${p.region}_state == "${s}"`).join(' or ') + ')';
    case 'and': return '(' + p.args.map(a => predToQuint(m, a, self, ownerName)).join(' and ') + ')';
    case 'or': return '(' + p.args.map(a => predToQuint(m, a, self, ownerName)).join(' or ') + ')';
    case 'not': return `(not(${predToQuint(m, p.arg, self, ownerName)}))`;
    case 'implies': return `(${predToQuint(m, p.left, self, ownerName)} implies ${predToQuint(m, p.right, self, ownerName)})`;
  }
}

function candidateToQuint(m: DomainModel, c: Candidate, name: string): string {
  const v = varName(c.aggregate);
  if (c.kind === 'statePredicate') {
    const guard = c.where ? `${predToQuint(m, c.where, 'x', c.aggregate)} implies ` : '';
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${guard}${predToQuint(m, c.body, 'x', c.aggregate)}) })`;
  }
  if (c.kind === 'conservation') {
    const parts = c.parts.map(p => pathToQuint(m, p, 'x', c.aggregate)).join(' + ');
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${parts} == ${pathToQuint(m, c.total, 'x', c.aggregate)}) })`;
  }
  if (c.kind === 'cardinality') {
    const guard = c.where ? predToQuint(m, c.where, 'x', c.aggregate) : 'true';
    return `val ${name} = ${v}.keys().filter(k => { val x = ${v}.get(k) x.exists and (${guard}) }).size() <= ${c.atMost}`;
  }
  throw new Error(`${c.kind} is never solver-queried on quint in slice-1 (template auto-adopt only)`);
}

/** Rebuild judged shapes: match salient dims against the candidates' comparisons + enum-eq facts. */
function shapeToQuint(m: DomainModel, facts: SalientFact[], cands: Candidate[], name: string): string {
  const agg = cands[0]!.aggregate;
  const v = varName(agg);
  const conj: string[] = [];
  for (const f of facts) {
    const mVal = f.dim.match(/^([\w.]+) = (\w+)$/);
    if (mVal) { conj.push(`${pathToQuint(m, mVal[1]!.split('.'), 'x', agg)} == "${mVal[2]}"`); continue; }
    const mCmp = f.dim.match(/^(.+) (eq|ne|lt|le|gt|ge) (.+)$/);
    if (mCmp) {
      const ops: Record<string, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      const render = (s: string) => s.split(' + ').map(part => part === 'now' || /^\d+$/.test(part) ? part : pathToQuint(m, part.split('.'), 'x', agg)).join(' + ');
      conj.push(`(${render(mCmp[1]!)} ${ops[mCmp[2]!]} ${render(mCmp[3]!)}) == ${f.value}`);
    }
  }
  return `val ${name} = ${v}.keys().exists(k => { val x = ${v}.get(k) x.exists and ${conj.join(' and ') || 'true'} })`;
}

export function astToQuint(m: DomainModel, q: QuintQuery): QuintEmission {
  const varTypes: Record<string, string> = {};
  const decls: string[] = ['var now: int'];
  const pools: string[] = [];
  const initNondets: string[] = [];
  const initSets: string[] = [`now' = 0`];
  const allVars = ['now', ...owners(m).map(o => varName(o.name))];
  const frame = (changed: string[]) => allVars.filter(v => !changed.includes(v)).map(v => `${v}' = ${v}`);
  const actions: string[] = [];

  for (const o of owners(m)) {
    const v = varName(o.name);
    varTypes[v] = o.name;
    const fields = o.fields.map(f => { const t = fieldQType(m, f); return t ? `${f.name}: ${t}` : null; }).filter(Boolean) as string[];
    const machine = (o as AggregateDef).machine;
    for (const r of machine?.regions ?? []) fields.push(`${r.name}_state: str`);
    decls.push(`var ${v}: str -> { exists: bool, ${fields.join(', ')} }`);
    pools.push(`val ${o.name.toUpperCase()}_IDS = Set("${o.name.toLowerCase()}1", "${o.name.toLowerCase()}2")`);

    const inits: string[] = [`exists: ${machine ? 'true' : 'false'}`];   // machine-bearing exist from init; plain entities are created
    for (const f of o.fields) {
      const nd = initValue(m, f, initNondets, o.name.toLowerCase());
      if (nd) inits.push(`${f.name}: ${nd}`);
    }
    for (const r of machine?.regions ?? []) inits.push(`${r.name}_state: "${r.initial}"`);
    initSets.push(`${v}' = ${o.name.toUpperCase()}_IDS.mapBy(id => { ${inits.join(', ')} })`);

    // actions: declared transitions; generic region mutator when a region has none; create for non-machine entities; enum mutators
    for (const r of machine?.regions ?? []) {
      const declared = (machine!.transitions ?? []).filter(t => t.region === r.name);
      for (const t of declared) actions.push(
        `action trans_${o.name}_${t.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) all { ${v}.get(id).${r.name}_state == "${t.from}", ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", "${t.to}")), ${frame([v]).join(', ')} } }`);
      if (declared.length === 0) actions.push(
        `action set_${o.name}_${r.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet s = oneOf(Set(${r.states.map(x => `"${x.name}"`).join(', ')})) all { ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", s)), ${frame([v]).join(', ')} } }`);
    }
    if (!machine) {
      const nds: string[] = []; const sets: string[] = ['exists: true'];
      for (const f of o.fields) { const nd = initValue(m, f, nds, `c_${o.name.toLowerCase()}`); if (nd) sets.push(`${f.name}: ${nd}`); }
      actions.push(`action create_${o.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) ${nds.join(' ')} all { ${v}' = ${v}.set(id, { ${sets.join(', ')} }), ${frame([v]).join(', ')} } }`);
    }
    for (const f of o.fields.filter(f => f.type.kind === 'enum')) {
      const vals = m.enums.find(e => e.name === (f.type as any).enum)!.values.map(x => `"${x}"`).join(', ');
      actions.push(`action mut_${o.name}_${f.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet nv = oneOf(Set(${vals})) all { ${v}' = ${v}.set(id, ${v}.get(id).with("${f.name}", nv)), ${frame([v]).join(', ')} } }`);
    }
  }
  actions.push(`action tick = { nondet dt = oneOf(Set(1, 5, 24, 120)) all { now' = now + dt, ${frame(['now']).join(', ')} } }`);

  const preds: string[] = [candidateToQuint(m, q.hi, 'Hi')];
  if (q.hj) preds.push(candidateToQuint(m, q.hj, 'Hj'));
  q.exclusions.forEach((facts, i) => preds.push(shapeToQuint(m, facts, [q.hi, ...(q.hj ? [q.hj] : [])], `shape${i}`)));
  const shapes = q.exclusions.map((_, i) => `shape${i}`);
  const inv = q.kind === 'distinguish' ? ['iff(Hi, Hj)', ...shapes].join(' or ')
    : q.kind === 'probe-forbid' ? ['Hi', ...shapes].join(' or ')
    : `not(${['Hi', ...shapes.map(s => `not(${s})`)].join(' and ')})`;
  preds.push(`val q_inv = ${inv}`);

  const actionNames = actions.map(a => a.split(' ')[1]!);
  const source = `module lattice_q {
${decls.map(d => '  ' + d).join('\n')}

${pools.map(p => '  ' + p).join('\n')}

  action init = { ${initNondets.join(' ')} all { ${initSets.join(', ')} } }

${actions.map(a => '  ' + a).join('\n')}

  action step = any { ${actionNames.join(', ')} }

${preds.map(p => '  ' + p).join('\n')}
}
`;
  return { source, invariantName: 'q_inv', varTypes };
}
