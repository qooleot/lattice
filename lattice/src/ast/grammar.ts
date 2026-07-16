import type { Candidate, Diagnostic, Engine, Path, Predicate, Term } from './invariant.js';
import type { DomainModel, AggregateDef, EntityDef, Field } from './domain.js';
import { isQualifiedRef, ownedCollectionChild } from './domain.js';

type Owner = AggregateDef | EntityDef;

function ownerDef(m: DomainModel, name: string): Owner | undefined {
  return m.aggregates.find(a => a.name === name) ?? m.entities.find(e => e.name === name);
}

/**
 * Resolve a field path from an owner, following refs across entities/aggregates. Returns the
 * terminal field or null. When the path hops through a qualified (cross-context) ref field, the
 * hop is refused: a `cross-context-ref-unsupported` diagnostic is pushed onto `out` (when given)
 * and resolution stops there, returning null — cross-context fields cannot appear in invariants
 * (spec §4.2).
 */
export function resolveFieldPath(m: DomainModel, ownerName: string, path: Path, out?: Diagnostic[]): Field | null {
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
    if (f.type.kind === 'ref') {
      const target = f.type.target;
      if (isQualifiedRef(f.type)) {
        out?.push({ code: 'cross-context-ref-unsupported',
          message: `path '${path.join('.')}' crosses the cross-context ref '${f.name}: ref ${target}' — cross-context fields cannot appear in invariants (spec §4.2)`,
          at: path.join('.') });
        return null;
      }
      def = ownerDef(m, target);
    } else if (f.type.kind === 'value') {
      // One flat value hop (design §3.5, v1): the next segment must name a field on the ValueDef,
      // and it must be the path's last segment — values carry prim/enum fields only, so there is
      // never a further hop past the sub-field.
      const vdef = m.values.find(x => x.name === (f.type as { kind: 'value'; value: string }).value);
      const sub = vdef?.fields.find(x => x.name === path[i + 1]);
      return i + 2 === path.length ? (sub ?? null) : null;
    } else def = undefined;
  }
  return null;
}

const KNOWN_KINDS = new Set([
  'statePredicate', 'unique', 'refsResolve', 'cardinality',
  'terminal', 'monotonic', 'conservation', 'leadsTo', 'sumOverCollection'
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
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? (c.fields !== undefined ? check(isPath(c.fields), 'fields', 'string[] (optional)', c.fields) : null);
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
    case 'sumOverCollection':
      err = check(isString(c.aggregate), 'aggregate', 'string', c.aggregate)
        ?? check(isString(c.collection), 'collection', 'string', c.collection)
        ?? check(isString(c.child), 'child', 'string', c.child)
        ?? check(isString(c.field), 'field', 'string', c.field)
        ?? check(['eq', 'le', 'ge'].includes(c.op), 'op', "'eq'|'le'|'ge'", c.op)
        ?? check(isPath(c.total), 'total', 'Path (array of string)', c.total);
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

  // Both emitters drop key and Text/Id fields from the solver-facing model (alloy.ts
  // emitOwnerSig, quint.ts fieldQType — atom identity suffices), so a path terminating in one is
  // unrepresentable: emission references a nonexistent field and the TS judge resolves undefined
  // on every witness. Reject here — the single choke point both `propose` and `admit` pass
  // through — instead of letting the engine silently misjudge or the solver hard-fail.
  const SOLVER_INT_PRIMS = ['Int', 'Money', 'Date', 'Duration'];
  const checkPath = (p: Path, at: string) => {
    const before = out.length;
    const f = resolveFieldPath(m, c.aggregate, p, out);
    if (!f) {
      if (out.length === before) out.push({ code: 'unknown-path', message: `path ${p.join('.')} not found on ${c.aggregate}`, at });
      return;
    }
    if (/^\w+\.state$/.test(p[p.length - 1]!)) return;   // machine-state accessor — representable
    if (f.key) out.push({ code: 'key-path', message: p.length === 1
      ? `path ${p.join('.')} is a key field — keys are unique by construction and dropped from the solver-facing model, so comparing them is vacuous`
      : `path ${p.join('.')} ends at a key field — refs already compare by identity; use '${p.slice(0, -1).join('.')}' instead`, at });
    else if (f.type.kind === 'prim' && !SOLVER_INT_PRIMS.includes(f.type.prim))
      out.push({ code: 'unrepresentable-path', message: `path ${p.join('.')} ends in a ${f.type.prim} field — Text/Id fields are dropped from the solver-facing model`, at });
  };
  const checkStates = (region: string, states: string[], at: string) => {
    const machine = agg.kind === 'aggregate' ? agg.machine : undefined;
    const r = machine?.regions.find((x: { name: string }) => x.name === region);
    if (!r) { out.push({ code: 'unknown-region', message: `no region ${region} on ${c.aggregate}`, at }); return; }
    for (const s of states) if (!r.states.some((x: { name: string }) => x.name === s))
      out.push({ code: 'unknown-state', message: `no state ${s} in ${c.aggregate}.${region}`, at });
  };
  // Evaluator/emitters (evaluate.ts, alloy.ts, quint.ts) silently treat any `owner` value as the
  // quantified subject ('self') — slice 1 never actually resolves a foreign owner. Make the
  // grammar honest about that rather than let it quietly no-op on unsupported input.
  const checkOwner = (owner: string, at: string) => {
    if (owner !== 'self') out.push({ code: 'unsupported-owner', message: "only owner:'self' is supported in slice 1", at });
  };
  const checkTerm = (t: Term, at: string) => {
    switch (t.kind) {
      case 'field': checkOwner(t.owner, at); checkPath(t.path, at); break;
      case 'enumval': {
        const e = m.enums.find(x => x.name === t.enum);
        if (!e) out.push({ code: 'unknown-enum', message: `no enum ${t.enum}`, at });
        else if (!e.values.includes(t.value)) out.push({ code: 'unknown-enum-value', message: `${t.enum} has no value ${t.value}`, at });
        break;
      }
      case 'plus': checkTerm(t.left, at); checkTerm(t.right, at); break;
      case 'int': case 'now': break;
      // Candidates never carry param terms (design §3.6) — 'param' is legal ONLY inside a
      // MethodDef.requires, which never becomes a Candidate. Loud rejection here is the routing
      // restriction: an LLM-emitted or hand-built candidate carrying one is out-of-grammar.
      case 'param': out.push({ code: 'ill-typed', message: 'param terms are method-guard-only', at }); break;
    }
  };
  const checkPred = (p: Predicate, at: string) => {
    switch (p.kind) {
      case 'cmp': checkTerm(p.left, at); checkTerm(p.right, at); break;
      case 'inState': checkOwner(p.owner, at); checkStates(p.region, p.states, at); break;
      case 'present': checkPath(p.path, at); break;
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
    case 'sumOverCollection': {
      const a = m.aggregates.find(x => x.name === c.aggregate);
      const f = a?.fields.find(x => x.name === c.collection);
      const child = a && f ? ownedCollectionChild(a, f) : null;
      if (!child || child.name !== c.child) {
        out.push({ code: 'sum-not-owned-collection', message: `${c.collection} is not an owned collection of ${c.aggregate} with child ${c.child}`, at: 'collection' });
        break;
      }
      const cf = child.fields.find(x => x.name === c.field);
      if (!cf || cf.key || cf.type.kind !== 'prim' || !SOLVER_INT_PRIMS.includes(cf.type.prim))
        out.push({ code: 'ill-typed', message: `sum field ${c.child}.${c.field} must be a numeric (Int/Money/Date/Duration) non-key field`, at: 'field' });
      checkPath(c.total, 'total');   // numeric own path; reuses key-path/unrepresentable-path guards
      break;
    }
  }
  return out;
}

function predNeedsArith(p: Predicate): boolean {
  switch (p.kind) {
    case 'cmp': return [p.left, p.right].some(termNeedsArith) || ['lt', 'le', 'gt', 'ge'].includes(p.op);
    case 'inState': return false;
    // definedness is structural (an Alloy partial relation), not arithmetic — routes like inState
    case 'present': return false;
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
    case 'terminal': case 'monotonic': case 'conservation': case 'leadsTo': case 'sumOverCollection': return 'quint';
    case 'statePredicate': {
      const arith = (c.where ? predNeedsArith(c.where) : false) || predNeedsArith(c.body);
      return arith ? 'quint' : 'alloy';
    }
    case 'guard': throw new Error('routeCandidate: a guard is a transition enablement, not an always-property — it is never solver-routed as an invariant');
  }
}
