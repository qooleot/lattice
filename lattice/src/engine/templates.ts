import type { AggregateDef, DomainModel, EntityDef } from '../ast/domain.js';
import { isQualifiedRef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import { impliedInvariants } from './implied.js';
import { toCamelName } from '../ast/naming.js';

const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];
const mk = (id: string, name: string, candidate: Candidate, prior = 0.9): CandidateInvariant =>
  ({ id, name, prior, source: 'template', candidate });

export function matchTemplates(m: DomainModel): { adopt: CandidateInvariant[]; seeds: CandidateInvariant[] } {
  // The structure-implied families (non-negativity, refs-resolve, terminal, value laws) are NOT
  // derived here. implied.ts is their single source of truth and its output is adopted verbatim:
  // adoption is what puts a rule in front of the solver (planner.ts's adoptedConstraints reads
  // s.candidates; impliedInvariants never reaches a solver on its own), so a second derivation
  // here bought nothing but the opportunity to disagree — which it took, ignoring @signed while
  // implied.ts honoured it. Only rules with no implied.ts counterpart are matched below.
  const adopt: CandidateInvariant[] = [...impliedInvariants(m)];
  const seeds: CandidateInvariant[] = [];

  for (const o of owners(m)) {
    const refs = o.fields.filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type));
    const machine = (o as AggregateDef).machine;

    // #1 conservation: >=2 @balance + a @total
    const balances = o.fields.filter(f => f.tags?.includes('balance'));
    const total = o.fields.find(f => f.tags?.includes('total'));
    if (balances.length >= 2 && total)
      adopt.push(mk(`tpl-1-${o.name}`, `Conservation_${o.name}`,
        { kind: 'conservation', aggregate: o.name, parts: balances.map(b => [b.name]), total: [total.name] }));

    // #8 monotonic from @monotonic tag
    for (const f of o.fields.filter(f => f.tags?.includes('monotonic')))
      adopt.push(mk(`tpl-8-${o.name}-${f.name}`, `Monotonic_${o.name}_${f.name}`,
        { kind: 'monotonic', aggregate: o.name, field: [f.name] }));

    for (const r of machine?.regions ?? []) {
      // #7 single-active (uniqueness) — catalog §10.2 row 7: an @active state on a CHILD
      // COLLECTION seeds `unique while active by (parent)`. Deliberately silent for a refless
      // aggregate: singleton-ness is a claim about how many instances EXIST and is not recoverable
      // from field shape, so it is elicited or authored (`count where … <= 1`), never inferred.
      const actives = r.states.filter(s => s.tags?.includes('active')).map(s => s.name);
      if (actives.length > 0)
        for (const f of refs)
          seeds.push(mk(`tpl-7-${o.name}-${f.name}`, `UniquePer_${o.name}_${f.name}`,
            { kind: 'unique', aggregate: o.name, whileStates: { region: r.name, states: actives }, by: [[f.name]] }, 0.4));

      // #6+#11 grace-window shell: @active states + a Duration field + a (possibly one-hop) Date path
      const duration = o.fields.find(f => f.type.kind === 'prim' && f.type.prim === 'Duration');
      const datePath = findDatePath(m, o);
      if (actives.length && duration && datePath)
        seeds.push(mk(`tpl-11-${o.name}`, `DeadlineBound_${o.name}`,
          { kind: 'statePredicate', aggregate: o.name,
            body: { kind: 'implies',
              left: { kind: 'inState', owner: 'self', region: r.name, states: actives },
              right: { kind: 'cmp', op: 'le', left: { kind: 'now' },
                right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: datePath }, right: { kind: 'field', owner: 'self', path: [duration.name] } } } } }, 0.5));
    }
  }
  // Fold names onto the convention here, at the boundary where THIS module authors them, exactly
  // as cli.ts's `propose` does for agent-authored names (docs/language/naming-conventions.md): a
  // machine-authored name is normalized, a hand-written one only warned. Folding at the return
  // keeps the literals above readable as `NonNegative_${o.name}_${f.name}` while nothing outside
  // ever sees the un-folded form.
  const fold = (i: CandidateInvariant): CandidateInvariant => ({ ...i, name: toCamelName(i.name) });
  return { adopt: adopt.map(fold), seeds: seeds.map(fold) };
}

function findDatePath(m: DomainModel, o: AggregateDef | EntityDef): string[] | null {
  const direct = o.fields.find(f => f.type.kind === 'prim' && f.type.prim === 'Date');
  if (direct) return [direct.name];
  for (const f of o.fields) if (f.type.kind === 'ref' && !isQualifiedRef(f.type)) {
    const t = owners(m).find(x => x.name === (f.type as any).target);
    const d = t?.fields.find(x => x.type.kind === 'prim' && x.type.prim === 'Date');
    if (d) return [f.name, d.name];
  }
  return null;
}
