import type { AggregateDef, DomainModel, EntityDef, Field, ValueDef } from '../ast/domain.js';
import { isQualifiedRef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Path, Predicate, Term } from '../ast/invariant.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const mk = (name: string, candidate: Candidate): CandidateInvariant =>
  ({ id: `implied-${name}`, name, prior: 1, source: 'template', candidate });

/** Prefix every own-scope field path in a Term with `prefix` (design §3.5's value-hop paths). */
function prefixTerm(t: Term, prefix: Path): Term {
  switch (t.kind) {
    case 'field': return { ...t, path: [...prefix, ...t.path] };
    case 'plus': return { ...t, left: prefixTerm(t.left, prefix), right: prefixTerm(t.right, prefix) };
    case 'int': case 'enumval': case 'now': return t;
    // value invariants never carry a param term (method-guard-only) — passthrough for exhaustiveness
    case 'param': return t;
  }
}
/** Prefix every own-scope field path in a Predicate with `prefix` — see prefixTerm. */
export function prefixPredicate(p: Predicate, prefix: Path): Predicate {
  switch (p.kind) {
    case 'cmp': return { ...p, left: prefixTerm(p.left, prefix), right: prefixTerm(p.right, prefix) };
    case 'inState': return p;   // values carry no machine (design §3.5) — inState never appears in a value invariant
    case 'present': return { ...p, path: [...prefix, ...p.path] };
    case 'and': return { ...p, args: p.args.map(a => prefixPredicate(a, prefix)) };
    case 'or': return { ...p, args: p.args.map(a => prefixPredicate(a, prefix)) };
    case 'not': return { ...p, arg: prefixPredicate(p.arg, prefix) };
    case 'implies': return { ...p, left: prefixPredicate(p.left, prefix), right: prefixPredicate(p.right, prefix) };
  }
}

/**
 * Type-carried laws (design §3.5/§6): every value-typed field `f: V` on an owner instantiates
 * each of V's own invariants as a statePredicate CANDIDATE on the OWNER, with every term path
 * prefixed `[f.name, …]` — e.g. Period.wellOrdered (`start < end`) on Subscription.period becomes
 * a candidate reading `period.start < period.end`. impliedInvariants (below) is the only caller,
 * and templates.ts's matchTemplates adopts impliedInvariants' output verbatim, so this is the one
 * derivation of value laws — there is no second copy to disagree with it. isImplied's shape match
 * suppresses the per-site printed form whether the candidate was adopted into a session or derived
 * fresh here, because astToCode filters on candidate shape, not id/source.
 */
export function valueLawInstances(m: DomainModel): { owner: AggregateDef | EntityDef; field: string; value: ValueDef; inv: NonNullable<ValueDef['invariants']>[number]; candidate: Candidate }[] {
  const out: { owner: AggregateDef | EntityDef; field: string; value: ValueDef; inv: NonNullable<ValueDef['invariants']>[number]; candidate: Candidate }[] = [];
  const owners: (AggregateDef | EntityDef)[] = [...m.aggregates, ...m.entities];
  for (const o of owners) {
    for (const f of o.fields) {
      if (f.type.kind !== 'value') continue;
      const vdef = m.values.find(v => v.name === (f.type as { kind: 'value'; value: string }).value);
      if (!vdef) continue;
      for (const inv of vdef.invariants ?? []) {
        out.push({ owner: o, field: f.name, value: vdef, inv,
          candidate: { kind: 'statePredicate', aggregate: o.name, body: prefixPredicate(inv.body, [f.name]) } });
      }
    }
  }
  return out;
}

/** Money ⇒ non-negative, opted out of by @signed (spec P9). */
const nonNegativeMoneyFields = (o: AggregateDef | EntityDef): Field[] =>
  o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed'));

const nonNegativeBody = (field: string): Predicate =>
  ({ kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [field] }, right: { kind: 'int', value: 0 } });

/**
 * Structure-implied invariants (spec P9): @terminal ⇒ stays-terminal, ref ⇒ refs-resolve,
 * Money (unless @signed) ⇒ non-negative. Derived at load, never printed (spec §3.4).
 */
export function impliedInvariants(m: DomainModel): CandidateInvariant[] {
  const out: CandidateInvariant[] = [];
  const owners: (AggregateDef | EntityDef)[] = [...m.aggregates, ...m.entities];
  for (const o of owners) {
    for (const f of nonNegativeMoneyFields(o))
      out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`,
        { kind: 'statePredicate', aggregate: o.name, body: nonNegativeBody(f.name) }));
    const sameContextRefFields = o.fields.filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type)).map(f => f.name);
    if (sameContextRefFields.length > 0)
      out.push(mk(`refsResolve${cap(o.name)}`, { kind: 'refsResolve', aggregate: o.name, fields: sameContextRefFields }));
    const machine = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of machine?.regions ?? [])
      for (const s of r.states.filter(s => s.tags?.includes('terminal')))
        out.push(mk(`terminal${cap(o.name)}${cap(r.name)}${cap(s.name)}`,
          { kind: 'terminal', aggregate: o.name, region: r.name, state: s.name }));
  }
  // Type-carried laws (design §3.5): every value-typed field's own invariants, instantiated at
  // each use site — see valueLawInstances. Never printed: isImplied's shape match, used by
  // astToCode, keys on candidate shape rather than id or source, so it suppresses a value law
  // read back from a session as readily as one derived fresh here.
  for (const { owner, field, value, inv } of valueLawInstances(m))
    out.push({ id: `implied-val${value.name}${cap(owner.name)}${cap(field)}${cap(inv.name)}`,
      name: `val${value.name}${cap(owner.name)}${cap(field)}${cap(inv.name)}`, prior: 1, source: 'template',
      candidate: { kind: 'statePredicate', aggregate: owner.name, body: prefixPredicate(inv.body, [field]) } });
  return out;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortDeep((v as Record<string, unknown>)[k])]));
  return v;
}
export const canonicalCandidate = (v: unknown): string => JSON.stringify(sortDeep(v));

// refsResolve.fields is new (task 16): candidates adopted/stored before its introduction have no
// `fields` key, while freshly-derived candidates always carry it. Strip it from BOTH sides before
// canonicalizing so a legacy stored candidate (no `fields`) still shape-matches a newly-derived one
// (with `fields`) — otherwise isImplied would stop recognizing old adopted refsResolve candidates
// as implied, causing them to double-print/reprint on regeneration.
const stripRefsResolveFields = (v: unknown): unknown => {
  if (v && typeof v === 'object' && (v as any).kind === 'refsResolve') {
    const { fields, ...rest } = v as any;
    return rest;
  }
  return v;
};
const canonicalForDedup = (v: unknown): string => canonicalCandidate(stripRefsResolveFields(v));

export function isImplied(c: Candidate, m: DomainModel): boolean {
  const mine = canonicalForDedup(c);
  return impliedInvariants(m).some(d => canonicalForDedup(d.candidate) === mine);
}
