import type { AggregateDef, DomainModel, EntityDef } from '../ast/domain.js';
import { isQualifiedRef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const mk = (name: string, candidate: Candidate): CandidateInvariant =>
  ({ id: `implied-${name}`, name, prior: 1, source: 'template', candidate });

/**
 * Structure-implied invariants (spec P9): @terminal ⇒ stays-terminal, ref ⇒ refs-resolve,
 * Money (unless @signed) ⇒ non-negative. Derived at load, never printed (spec §3.4).
 * The elicitation flow (templates.ts) is untouched — golden traces must not shift.
 */
export function impliedInvariants(m: DomainModel): CandidateInvariant[] {
  const out: CandidateInvariant[] = [];
  const owners: (AggregateDef | EntityDef)[] = [...m.aggregates, ...m.entities];
  for (const o of owners) {
    for (const f of o.fields)
      if (f.type.kind === 'prim' && f.type.prim === 'Money' && !f.tags?.includes('signed'))
        out.push(mk(`nonNegative${cap(o.name)}${cap(f.name)}`, { kind: 'statePredicate', aggregate: o.name,
          body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: [f.name] },
            right: { kind: 'int', value: 0 } } }));
    if (o.fields.some(f => f.type.kind === 'ref' && !isQualifiedRef(f.type)))
      out.push(mk(`refsResolve${cap(o.name)}`, { kind: 'refsResolve', aggregate: o.name }));
    const machine = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of machine?.regions ?? [])
      for (const s of r.states.filter(s => s.tags?.includes('terminal')))
        out.push(mk(`terminal${cap(o.name)}${cap(r.name)}${cap(s.name)}`,
          { kind: 'terminal', aggregate: o.name, region: r.name, state: s.name }));
  }
  return out;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortDeep((v as Record<string, unknown>)[k])]));
  return v;
}
export const canonicalCandidate = (v: unknown): string => JSON.stringify(sortDeep(v));
export function isImplied(c: Candidate, m: DomainModel): boolean {
  const mine = canonicalCandidate(c);
  return impliedInvariants(m).some(d => canonicalCandidate(d.candidate) === mine);
}
