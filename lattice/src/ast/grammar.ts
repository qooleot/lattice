import type { Candidate, Diagnostic, Engine, Path, Predicate, Term } from './invariant.js';
import type { DomainModel, AggregateDef, EntityDef, Field } from './domain.js';

type Owner = AggregateDef | EntityDef;

function ownerDef(m: DomainModel, name: string): Owner | undefined {
  return m.aggregates.find(a => a.name === name) ?? m.entities.find(e => e.name === name);
}

/** Resolve a field path from an owner, following refs across entities/aggregates. Returns the terminal field or null. */
export function resolveFieldPath(m: DomainModel, ownerName: string, path: Path): Field | null {
  let def = ownerDef(m, ownerName);
  for (let i = 0; i < path.length; i++) {
    if (!def) return null;
    // Ref-hop machine-state path: a final `<Region>.state` segment reads the resolved owner's
    // machine region state directly (not a declared field) — e.g. ['period', 'Lifecycle.state']
    // hops through `period` then reads AccountingPeriod's Lifecycle region state.
    const seg = path[i]!;
    const stateMatch = seg.match(/^(\w+)\.state$/);
    if (stateMatch && i === path.length - 1) {
      const machine = (def as any).machine;
      return machine?.regions.some((r: any) => r.name === stateMatch[1]) ? { name: seg, type: { kind: 'prim', prim: 'Text' } } : null;
    }
    const f = def.fields.find(x => x.name === seg);
    if (!f) return null;
    if (i === path.length - 1) return f;
    def = f.type.kind === 'ref' ? ownerDef(m, f.type.target) : undefined;
  }
  return null;
}

const KNOWN_KINDS = new Set([
  'statePredicate', 'unique', 'refsResolve', 'cardinality',
  'terminal', 'monotonic', 'conservation', 'leadsTo'
]);

function truncate(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/**
 * Structural shape validation for LLM-emitted JSON masquerading as a Candidate.
 * Runs before any semantic checks — verifies the runtime shape actually matches
 * the declared kind's TypeScript type, so later code can assume well-typed input.
 */
function shapeErrors(c: any): Diagnostic[] {
  if (typeof c !== 'object' || c === null) return [{ code: 'ill-typed', message: `candidate: expected object, got ${truncate(c)}` }];
  if (!KNOWN_KINDS.has(c.kind)) return [{ code: 'out-of-grammar', message: `unknown candidate kind ${truncate(c.kind)}` }];

  const isString = (v: unknown) => typeof v === 'string';
  const isPath = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
  const isPathArray = (v: unknown): v is string[][] => Array.isArray(v) && v.every(isPath);
  const isTerm = (v: unknown): v is object => typeof v === 'object' && v !== null && isString((v as any).kind);
  const isPredicate = (v: unknown): v is object => typeof v === 'object' && v !== null && isString((v as any).kind);
  const isWhileStates = (v: unknown): v is object =>
    typeof v === 'object' && v !== null && isString((v as any).region) &&
    Array.isArray((v as any).states) && (v as any).states.every(isString);

  const check = (ok: boolean, field: string, shape: string, value: unknown): Diagnostic | null =>
    ok ? null : { code: 'ill-typed', message: `${field}: expected ${shape}, got ${truncate(value)}` };

  let err: Diagnostic | null = null;
  switch (c.kind) {
    case 'statePredicate':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? (c.where !== undefined ? check(isPredicate(c.where), 'where', 'Predicate object', c.where) : null)
        ?? check(isPredicate(c.body), 'body', 'Predicate object', c.body);
      break;
    case 'unique':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isWhileStates(c.whileStates), 'whileStates', '{region: string, states: string[]}', c.whileStates)
        ?? check(isPathArray(c.by), 'by', 'Path[] (array of string[])', c.by);
      break;
    case 'refsResolve':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate);
      break;
    case 'cardinality':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(c.where === null || isPredicate(c.where), 'where', 'Predicate object or null', c.where)
        ?? check(typeof c.atMost === 'number', 'atMost', 'number', c.atMost);
      break;
    case 'terminal':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isString(c.region), 'region', 'string', c.region)
        ?? check(isString(c.state), 'state', 'string', c.state);
      break;
    case 'monotonic':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isPath(c.field), 'field', 'Path (array of string)', c.field);
      break;
    case 'conservation':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isPathArray(c.parts), 'parts', 'Path[] (array of string[])', c.parts)
        ?? check(isPath(c.total), 'total', 'Path (array of string)', c.total);
      break;
    case 'leadsTo':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isPredicate(c.from), 'from', 'Predicate object', c.from)
        ?? check(isPredicate(c.to), 'to', 'Predicate object', c.to)
        ?? check(isString(c.fairness), 'fairness', 'string', c.fairness);
      break;
  }
  return err ? [err] : [];
}

export function validateCandidate(c: Candidate, m: DomainModel): Diagnostic[] {
  // Normalize explicit null to absent for optional statePredicate.where
  // (JSON has no undefined, so LLM-emitted null must be treated as absent)
  if (c.kind === 'statePredicate' && (c as any).where === null) {
    delete (c as any).where;
  }

  const shapeErrs = shapeErrors(c);
  if (shapeErrs.length) return shapeErrs;

  const out: Diagnostic[] = [];
  const agg = ownerDef(m, c.aggregate);
  if (!agg) return [{ code: 'unknown-aggregate', message: `no aggregate/entity named ${c.aggregate}` }];

  const checkPath = (p: Path, at: string) => {
    if (!resolveFieldPath(m, c.aggregate, p)) out.push({ code: 'unknown-path', message: `path ${p.join('.')} not found on ${c.aggregate}`, at });
  };
  const checkStates = (region: string, states: string[], at: string) => {
    const machine = agg.kind === 'aggregate' ? agg.machine : undefined;
    const r = machine?.regions.find((x: { name: string }) => x.name === region);
    if (!r) { out.push({ code: 'unknown-region', message: `no region ${region} on ${c.aggregate}`, at }); return; }
    for (const s of states) if (!r.states.some((x: { name: string }) => x.name === s))
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
