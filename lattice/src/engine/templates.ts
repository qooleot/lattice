import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import { isQualifiedRef, numericFieldPaths } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Path } from '../ast/invariant.js';
import { impliedInvariants } from './implied.js';
import { toCamelName } from '../ast/naming.js';

// Children included (slice B2): a child-subject conservation now has a real Quint encoding
// (candidateToQuint's childContext/overChildren), so a @balance/@total tag on a nested entity's
// fields is no longer silently unmatched here the way it would have been before Task 6.
const owners = (m: DomainModel): (AggregateDef | EntityDef)[] =>
  [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];
const mk = (id: string, name: string, candidate: Candidate, prior = 0.9): CandidateInvariant =>
  ({ id, name, prior, source: 'template', candidate });

/**
 * The numeric path a `@balance`/`@total` tag on `f` names (slice B2): `[f.name]` for a numeric prim,
 * or `[f.name, ...sub]` for the single solver-numeric sub-field a value-typed field resolves to
 * (recursing through however many value hops it takes, exactly as domain.ts's `moneyFieldPaths`
 * does for "what carries money") — so `total : Amount` conserves as `total.amount` wherever
 * `total : Money` conserves as `total`, and `total : Outer` with `Outer { inner : Amount }` conserves
 * as `total.inner.amount` two hops down. Non-recursive would silently miss that last case even
 * though quint's pathToQuint already renders arbitrarily deep value paths — exactly the kind of
 * silent miss this slice exists to remove, so this recurses too.
 *
 * Null when the tag names nothing summable (no numeric sub-field) or is ambiguous (two or more
 * across the whole recursive descent). validateModel's `ambiguous-numeric-tag` reports that case at
 * load; this returns null so the template stays silent rather than guessing which sub-field was
 * meant.
 */
export function numericTagPath(m: DomainModel, f: Field): Path | null {
  const paths = numericFieldPaths(m, f);
  return paths.length === 1 ? paths[0]! : null;
}

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

    // #1 conservation: >=2 @balance + a @total. Paths resolve THROUGH a value type (slice B2) —
    // before this, tagging a value-typed money field silently stopped conservation firing.
    const balances = o.fields.filter(f => f.tags?.includes('balance'))
      .map(f => numericTagPath(m, f)).filter((p): p is Path => p !== null);
    const totalField = o.fields.find(f => f.tags?.includes('total'));
    const total = totalField ? numericTagPath(m, totalField) : null;
    if (balances.length >= 2 && total)
      adopt.push(mk(`tpl-1-${o.name}`, `Conservation_${o.name}`,
        { kind: 'conservation', aggregate: o.name, parts: balances, total }));

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
