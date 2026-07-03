import type { Candidate, Diagnostic, Engine, Path, Predicate, Term } from './invariant.js';
import type { DomainModel, AggregateDef, EntityDef } from './domain.js';

type Owner = AggregateDef | EntityDef;

function ownerDef(m: DomainModel, name: string): Owner | undefined {
  return m.aggregates.find(a => a.name === name) ?? m.entities.find(e => e.name === name);
}

/** Resolve a field path from an owner, following refs across entities/aggregates. Returns the terminal field or null. */
export function resolveFieldPath(m: DomainModel, ownerName: string, path: Path): any | null {
  let def = ownerDef(m, ownerName);
  for (let i = 0; i < path.length; i++) {
    if (!def) return null;
    const f = def.fields.find(x => x.name === path[i]);
    if (!f) return null;
    if (i === path.length - 1) return f;
    def = f.type.kind === 'ref' ? ownerDef(m, f.type.target) : undefined;
  }
  return null;
}

export function validateCandidate(c: Candidate, m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const agg = ownerDef(m, c.aggregate);
  if (!agg) return [{ code: 'unknown-aggregate', message: `no aggregate/entity named ${c.aggregate}` }];

  const checkPath = (p: Path, at: string) => {
    if (!resolveFieldPath(m, c.aggregate, p)) out.push({ code: 'unknown-path', message: `path ${p.join('.')} not found on ${c.aggregate}`, at });
  };
  const checkStates = (region: string, states: string[], at: string) => {
    const r = agg.machine?.regions.find(x => x.name === region);
    if (!r) { out.push({ code: 'unknown-region', message: `no region ${region} on ${c.aggregate}`, at }); return; }
    for (const s of states) if (!r.states.some(x => x.name === s))
      out.push({ code: 'unknown-state', message: `no state ${s} in ${c.aggregate}.${region}`, at });
  };
  const checkTerm = (t: Term, at: string) => {
    switch (t.kind) {
      case 'field': checkPath(t.path, at); break;
      case 'enumval': {
        const e = m.enums.find(x => x.name === t.enum);
        if (!e) out.push({ code: 'unknown-enum', message: `no enum ${t.enum}`, at });
        else if (!e.values.includes(t.value)) out.push({ code: 'unknown-enum-value', message: `${t.enum} has no value ${t.value}`, at });
        break;
      }
      case 'plus': checkTerm(t.left, at); checkTerm(t.right, at); break;
      case 'int': case 'now': break;
    }
  };
  const checkPred = (p: Predicate, at: string) => {
    switch (p.kind) {
      case 'cmp': checkTerm(p.left, at); checkTerm(p.right, at); break;
      case 'inState': checkStates(p.region, p.states, at); break;
      case 'and': case 'or': p.args.forEach((a, i) => checkPred(a, `${at}.${p.kind}[${i}]`)); break;
      case 'not': checkPred(p.arg, at); break;
      case 'implies': checkPred(p.left, `${at}.if`); checkPred(p.right, `${at}.then`); break;
    }
  };

  switch (c.kind) {
    case 'statePredicate': if (c.where) checkPred(c.where, 'where'); checkPred(c.body, 'body'); break;
    case 'unique': checkStates(c.whileStates.region, c.whileStates.states, 'whileStates'); c.by.forEach((p, i) => checkPath(p, `by[${i}]`)); break;
    case 'refsResolve': break;
    case 'cardinality': if (c.where) checkPred(c.where, 'where'); if (c.atMost < 0) out.push({ code: 'bad-cardinality', message: 'atMost must be >= 0' }); break;
    case 'terminal': checkStates(c.region, [c.state], 'terminal'); break;
    case 'monotonic': checkPath(c.field, 'field'); break;
    case 'conservation': c.parts.forEach((p, i) => checkPath(p, `parts[${i}]`)); checkPath(c.total, 'total'); break;
    case 'leadsTo': checkPred(c.from, 'from'); checkPred(c.to, 'to'); break;
  }
  return out;
}

function predNeedsArith(p: Predicate): boolean {
  switch (p.kind) {
    case 'cmp': return [p.left, p.right].some(termNeedsArith) || ['lt', 'le', 'gt', 'ge'].includes(p.op);
    case 'inState': return false;
    case 'and': case 'or': return p.args.some(predNeedsArith);
    case 'not': return predNeedsArith(p.arg);
    case 'implies': return predNeedsArith(p.left) || predNeedsArith(p.right);
  }
}
function termNeedsArith(t: Term): boolean {
  return t.kind === 'now' || t.kind === 'plus' || t.kind === 'int';
}

/** Spec §6.1 routing: structural → alloy; temporal/aggregation/arithmetic → quint. */
export function routeCandidate(c: Candidate): Engine {
  switch (c.kind) {
    case 'unique': case 'refsResolve': case 'cardinality': return 'alloy';
    case 'terminal': case 'monotonic': case 'conservation': case 'leadsTo': return 'quint';
    case 'statePredicate': {
      const arith = (c.where ? predNeedsArith(c.where) : false) || predNeedsArith(c.body);
      return arith ? 'quint' : 'alloy';
    }
  }
}
