import type { DomainModel, AggregateDef, EntityDef } from '../ast/domain.js';
import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';
import type { SalientFact } from '../engine/session.js';

export interface AlloyQuery {
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit';
  hi: Candidate; hj?: Candidate;
  exclusions: SalientFact[][];
  // Already-ADOPTED invariants, conjoined into every run body so witnesses can't land in states
  // the adopted spec forbids (the planner filters to kinds this emitter can express — see
  // expressibleAdopted in planner.ts, and QuintQuery.adopted for the corrupting-verdict rationale).
  adopted?: Candidate[];
  scope: number;
  // Boundary probes ask the solver for "any" witness to a single candidate's own predicate;
  // when the candidate ignores a domain field entirely (e.g. a uniqueness key that doesn't
  // include `plan.family`), a plain SAT search has no reason to ever vary that field between the
  // two witnessed subjects — Kodkod's symmetry breaking canonicalizes unconstrained relations to
  // reuse the same atom. That silently hides exactly the kind of witness a human reviewer needs
  // to catch a hypothesis that is too coarse. Setting this asks the query to additionally force
  // some field NOT referenced by the candidate to differ between the two subjects, wherever the
  // domain schema has one reachable. This is purely a function of the domain schema (which
  // relations exist), never of any hidden ground truth, so it does not bias toward a specific
  // answer — it only makes the probe more thorough. Callers should retry without it on UNSAT.
  varyUnreferenced?: boolean;
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

/**
 * Rebuild a judged shape (salient facts) as an existential pattern to exclude.
 *
 * NOTE (final review): this always emits a PAIR-shaped exclusion (`some disj a, b: agg | ...`).
 * That is correct for `unique` subjects, whose whole candidate shape is inherently pairwise
 * (a, b range over the same aggregate, comparing by-key fields between them). It is the WRONG
 * shape for a `statePredicate` subject whose salient facts came from field-field eq/ne dims
 * (e.g. `x.a = x.b` on a single record) — those dims describe a single-record fact, not a
 * cross-record one, and forcing `some disj a, b` to exclude them doesn't express the same
 * condition. This is currently unreachable in slice 1: statePredicate candidates whose facts
 * include field-field eq/ne dims always route to Quint (see routeCandidate/predNeedsArith —
 * arithmetic/ordering comparisons force the quint route, and field-field eq/ne dims only appear
 * behind such comparisons in the slice-1 candidate set), so this Alloy path never actually sees
 * them. Left as a known latent gap rather than fixed, since fixing it blind (without a witnessed
 * repro reaching this code path) risks a subtler, harder-to-verify regression than the gap itself.
 */
function shapeToPred(facts: SalientFact[], subject: Candidate, name: string): string {
  const agg = subject.aggregate;
  const w = subject.kind === 'unique' ? subject.whileStates : null;
  const conj: string[] = [];
  for (const f of facts) {
    const mEq = f.dim.match(/^(.+) equal$/);
    if (mEq) { const p = mEq[1]!.split('.'); conj.push(`${alloyPath('a', p)} ${f.value ? '=' : '!='} ${alloyPath('b', p)}`); continue; }
    const mVal = f.dim.match(/^(.+) = (.+)$/);
    if (mVal) {
      // A dim whose path is `<Region>.state` (extractSalient's machine-state capture, same format
      // as an enum-eq fact) is NOT a real field path — Alloy has no `.state` sub-relation on the
      // region name. The region state lives on the `<Region>_state` relation, valued by the
      // `<Agg>_<Region>_<Value>` one-sig (see emitStateSigs/inStateExpr) — the generic
      // dotted-path -> `a.<path>` rendering below would emit invalid Alloy (`a.Lifecycle.state =
      // Open`) for this case, so it must be special-cased ahead of the generic branch.
      const stateMatch = mVal[1]!.match(/^(\w+)\.state$/);
      if (stateMatch) { conj.push(`a.${stateMatch[1]}_state = ${agg}_${stateMatch[1]}_${mVal[2]}`); continue; }
      conj.push(`${alloyPath('a', mVal[1]!.split('.'))} = ${mVal[2]}`); continue;
    }
    // 'inState count' and comparison dims don't constrain structural shapes further
  }
  const inS = w ? `${inStateExpr(agg, 'a', w.region, w.states)} and ${inStateExpr(agg, 'b', w.region, w.states)} and ` : '';
  return `pred ${name} { some disj a, b: ${agg} | ${inS}${conj.join(' and ') || 'a != b'} }`;
}

/** Own comparison paths of a candidate — the dims it already looks at (so we don't force those). */
function ownPaths(c: Candidate): Path[] {
  return c.kind === 'unique' ? c.by : [];
}

/**
 * One- and two-hop field paths reachable from `aggName`, via ref-typed fields, that are NOT
 * already among `exclude`. Two hops (e.g. `plan.family`) covers the common "key implies a coarser
 * grouping" shape without walking the whole schema graph — deep enough for the domain-agnostic
 * thoroughness nudge this is used for, without risking runaway path explosion on larger schemas.
 *
 * When a ref field's target has its own data fields, only the deepest path through it is kept
 * (not the bare ref too): the bare ref is trivially varied by picking any two distinct target
 * atoms regardless of their data, so a solver satisfying "some field differs" via cheapest-first
 * search would vary the ref and never bother varying the more informative field behind it.
 */
function extraComparisonPaths(m: DomainModel, aggName: string, exclude: Path[]): Path[] {
  const byName = new Map<string, AggregateDef | EntityDef>([...m.entities, ...m.aggregates].map(o => [o.name, o]));
  const excluded = new Set(exclude.map(p => p.join('.')));
  const owner = byName.get(aggName);
  if (!owner) return [];
  const out: Path[] = [];
  for (const f of owner.fields) {
    if (f.type.kind !== 'ref') continue;
    const target = byName.get(f.type.target);
    // Comparable one-hop-further fields (ref or data — atom identity compares fine either way,
    // same as `extractSalient`/`shapeToPred` already do for `by` paths).
    const deeper: Path[] = (target?.fields ?? [])
      .filter(f2 => !f2.key)
      .map(f2 => [f.name, f2.name])
      .filter(p => !excluded.has(p.join('.')));
    if (deeper.length > 0) out.push(...deeper);
    else if (!excluded.has(f.name)) out.push([f.name]);
  }
  return out;
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
  (q.adopted ?? []).forEach((c, i) => parts.push(candidateToPred(c, `Adopted${i}`)));
  // Alloy's `and` binds tighter than `or`, so a disjunctive body (the distinguish query) must be
  // parenthesized before conjoining extras — `A or B and C` scopes C to B only, which silently
  // limited exclusions to the `(not Hi and Hj)` disjunct.
  const guard = (body: string) => body.includes(' or ') ? `(${body})` : body;
  const extras = [...q.exclusions.map((_, i) => `(not shape${i})`), ...(q.adopted ?? []).map((_, i) => `Adopted${i}`)];
  const constrain = (body: string) => extras.length ? [guard(body), ...extras].join(' and ') : body;

  // See AlloyQuery.varyUnreferenced: nudge probes toward a witness that also varies a domain
  // field the candidate itself doesn't look at, so the human sees a maximally informative case
  // instead of one Kodkod's symmetry breaking collapsed to the narrowest satisfying instance.
  const varyClause = (() => {
    if (!q.varyUnreferenced || q.hi.kind !== 'unique' || (q.kind !== 'probe-forbid' && q.kind !== 'probe-permit')) return '';
    const extra = extraComparisonPaths(m, q.hi.aggregate, ownPaths(q.hi));
    if (extra.length === 0) return '';
    return ' and (' + extra.map(p => `${alloyPath('a', p)} != ${alloyPath('b', p)}`).join(' or ') + ')';
  })();

  const wrapVary = (body: string) => varyClause ? `some disj a, b: ${(q.hi as { aggregate: string }).aggregate} | ${body}${varyClause}` : body;

  if (q.kind === 'distinguish') parts.push(`run q { ${constrain('(Hi and not Hj) or (not Hi and Hj)')} } for ${q.scope} but 5 Int`);
  else if (q.kind === 'probe-forbid') parts.push(`run q { ${wrapVary(constrain('(not Hi)'))} } for ${q.scope} but 5 Int`);
  else { parts.push(nonVacuousPred(q.hi)); parts.push(`run q { ${wrapVary(constrain('Hi and nonVacuous'))} } for ${q.scope} but 5 Int`); }
  return parts.join('\n\n') + '\n';
}
