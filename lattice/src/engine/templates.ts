import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import { isQualifiedRef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import { isUnsignedMoney, nonNegativeBody, valueLawInstances } from './implied.js';

const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];
const mk = (id: string, name: string, candidate: Candidate, prior = 0.9): CandidateInvariant =>
  ({ id, name, prior, source: 'template', candidate });

export function matchTemplates(m: DomainModel): { adopt: CandidateInvariant[]; seeds: CandidateInvariant[] } {
  const adopt: CandidateInvariant[] = [];
  const seeds: CandidateInvariant[] = [];

  // Type-carried laws (design §3.5/§6): every value-typed field's own invariants, adopted at each
  // use site — mirrors Money non-negativity (#2 below) exactly: implied.ts derives the same
  // candidate shape for parse-dedup (never printed), this gives it template provenance so the
  // elicitation/enforcement loop treats it as an adopted invariant like any other template match.
  for (const { owner, field, value, inv, candidate } of valueLawInstances(m))
    adopt.push(mk(`tpl-val-${value.name}-${owner.name}-${field}-${inv.name}`,
      `ValueLaw_${owner.name}_${field}_${inv.name}`, candidate));

  for (const o of owners(m)) {
    const refs = o.fields.filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type));
    const machine = (o as AggregateDef).machine;

    // #1 conservation: >=2 @balance + a @total
    const balances = o.fields.filter(f => f.tags?.includes('balance'));
    const total = o.fields.find(f => f.tags?.includes('total'));
    if (balances.length >= 2 && total)
      adopt.push(mk(`tpl-1-${o.name}`, `Conservation_${o.name}`,
        { kind: 'conservation', aggregate: o.name, parts: balances.map(b => [b.name]), total: [total.name] }));

    // #2 non-negative for Money fields — @signed opts out (isUnsignedMoney is the shared rule)
    for (const f of o.fields.filter(isUnsignedMoney))
      adopt.push(mk(`tpl-2-${o.name}-${f.name}`, `NonNegative_${o.name}_${f.name}`,
        { kind: 'statePredicate', aggregate: o.name, body: nonNegativeBody(f.name) }));

    // #8 monotonic from @monotonic tag
    for (const f of o.fields.filter(f => f.tags?.includes('monotonic')))
      adopt.push(mk(`tpl-8-${o.name}-${f.name}`, `Monotonic_${o.name}_${f.name}`,
        { kind: 'monotonic', aggregate: o.name, field: [f.name] }));

    // #9 no-orphan for owners with refs — fields scopes evaluation to same-context (unqualified)
    // ref fields only (spec §4.2 excludes qualified/cross-context refs from invariant semantics).
    if (refs.length > 0)
      adopt.push(mk(`tpl-9-${o.name}`, `NoOrphan_${o.name}`,
        { kind: 'refsResolve', aggregate: o.name, fields: refs.map(f => f.name) }));

    for (const r of machine?.regions ?? []) {
      // #3 terminal
      for (const s of r.states.filter(s => s.tags?.includes('terminal')))
        adopt.push(mk(`tpl-3-${o.name}-${s.name}`, `Terminal_${o.name}_${s.name}`,
          { kind: 'terminal', aggregate: o.name, region: r.name, state: s.name }));

      // #7 single-active (uniqueness) — catalog §10.2 row 7: an @active state on a CHILD
      // COLLECTION seeds `unique while active by (parent)`. Deliberately silent for a refless
      // aggregate: singleton-ness is a claim about how many instances EXIST and is not recoverable
      // from field shape, so it is elicited or authored (`count where … <= 1`), never inferred.
      const actives = r.states.filter(s => s.tags?.includes('active')).map(s => s.name);
      if (actives.length > 0)
        for (const f of refs)
          seeds.push(mk(`tpl-7-${o.name}-${f.name}`, `UniquePer_${f.name}`,
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
  return { adopt, seeds };
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
