import type { AggregateDef, DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Cmp, Predicate } from '../ast/invariant.js';
import type { CaseEntity, CaseState } from './evaluate.js';
import { evaluateCandidate } from './evaluate.js';

export interface GuardSiteRef { owner: string; region: string; transition: string }

// Pull the single own-field cmp the invariant is "about": a bare statePredicate body that is a cmp,
// or the consequent of an `implies`/the body when `where` gates it. Returns null if there's no clean
// own-field cmp (both operands must be `field` terms on `self`).
function invariantCmp(inv: CandidateInvariant): (Predicate & { kind: 'cmp' }) | null {
  const c = inv.candidate;
  if (c.kind !== 'statePredicate') return null;
  const pick = (p: Predicate): (Predicate & { kind: 'cmp' }) | null =>
    p.kind === 'cmp' ? p : p.kind === 'implies' ? pick(p.right) : null;
  const cm = pick(c.body);
  if (!cm) return null;
  const ownField = (t: any) => t?.kind === 'field' && t.owner === 'self';
  return ownField(cm.left) && ownField(cm.right) ? cm : null;
}

export function ctiTransition(m: DomainModel, violated: CandidateInvariant, w: CaseState): GuardSiteRef | null {
  const agg = (violated.candidate as any).aggregate as string;
  if (!w.trace || w.trace.length === 0) return null;                 // violation at init → no transition
  const prev = w.trace[w.trace.length - 1]!;                         // state just before the violating one
  // the violating instance: the aggregate subject where the invariant is forbidden in the final state
  const bad = w.entities.find(e => e.type === agg &&
    evaluateCandidate(violated.candidate, { entities: [e] }) === 'forbid');
  if (!bad) return null;
  const before = prev.find(e => e.type === agg && e.id === bad.id);
  if (!before) return null;
  const machine = (m.aggregates as AggregateDef[]).find(a => a.name === agg)?.machine;
  if (!machine) return null;
  for (const r of machine.regions) {
    const key = `${r.name}.state`;                                    // CaseEntity fields key (evaluate.ts:52)
    const from = before.fields[key], to = bad.fields[key];
    if (from !== undefined && to !== undefined && from !== to) {      // a region moved this step
      const t = machine.transitions.find(tr => tr.region === r.name && tr.from.includes(String(from)) && tr.to === String(to));
      if (t) return { owner: agg, region: r.name, transition: t.name };
    }
  }
  return null;                                                        // only fields changed → accrual step
}

export function guardVariants(site: GuardSiteRef, violated: CandidateInvariant): Extract<Candidate, { kind: 'guard' }>[] {
  const cm = invariantCmp(violated);
  if (!cm) return [];
  const ops: Cmp[] = ['eq', 'le', 'ge'];
  return ops.map(op => ({ kind: 'guard', aggregate: site.owner, region: site.region, transition: site.transition,
    predicate: { kind: 'cmp', op, left: cm.left, right: cm.right } }));
}
