import type { AggregateDef, DomainModel, EntityDef, ValueDef } from '../ast/domain.js';
import { isQualifiedRef, moneyFieldPaths } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Diagnostic, Path, Predicate, Term } from '../ast/invariant.js';
import { toCamelName } from '../ast/naming.js';

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
  // Children included, matching impliedInvariants' owner list below: an aggregate-owned child's
  // value-typed field is legal and encoded in both solvers (Alloy flattens it onto the child sig;
  // Quint nests it in the child record) — so its value's own laws must hold there too, not just
  // at the top-level owner's use site.
  const owners: (AggregateDef | EntityDef)[] =
    [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];
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

/**
 * Every non-negative-eligible money path on an owner (spec P9, slice B2). A path is `[f]` for a
 * plain `Money` field and `[f, sub]` for each `Money` sub-field of a value-typed field — so
 * `total : Amount` yields `total.amount` wherever `total : Money` yields `total`.
 *
 * **Sign is read off the USE SITE, never the value declaration.** A `value Amount` is used at
 * `Bill.total` (must be non-negative) and `LedgerAccount.balance` (must go negative); one tag on the
 * declaration could not express both even in principle. Hence only the OWNER field's tags are read
 * below; a sub-field's own tags are not consulted — validateModel rejects a sign tag written inside
 * a value declaration (`value-money-sign-inert`), so there is exactly one place sign is written.
 *
 * The shape of "what carries money" lives in domain.ts's moneyFieldPaths — shared with
 * validate.ts's undecidedMoneySigns (the DEMAND side) so the two cannot drift. Only the `@signed`
 * use-site gate below is this function's own: it is a derivation policy, not a shape fact.
 */
export function moneyPaths(m: DomainModel, o: AggregateDef | EntityDef): Path[] {
  const out: Path[] = [];
  for (const f of o.fields) {
    if (f.tags?.includes('signed')) continue;             // opted out at the use site
    out.push(...moneyFieldPaths(m, f));
  }
  return out;
}

const nonNegativeBody = (path: Path): Predicate =>
  ({ kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path }, right: { kind: 'int', value: 0 } });

/**
 * Structure-implied invariants (spec P9): @terminal ⇒ stays-terminal, ref ⇒ refs-resolve,
 * Money (unless @signed) ⇒ non-negative. Derived at load, never printed (spec §3.4).
 */
export function impliedInvariants(m: DomainModel): CandidateInvariant[] {
  const out: CandidateInvariant[] = [];
  // Children included (slice B2): validate.ts:320's undecidedMoneySigns already DEMANDS a sign
  // decision for a child's Money field, while this list excluded children — so the tag was demanded
  // and ignored. candidateToQuint's childContext branch gives the derived rule a real encoding.
  const owners: (AggregateDef | EntityDef)[] =
    [...m.aggregates, ...m.entities, ...m.aggregates.flatMap(a => a.entities ?? [])];
  for (const o of owners) {
    for (const p of moneyPaths(m, o)) {
      const f = o.fields.find(x => x.name === p[0])!;
      out.push(mk(`nonNegative${cap(o.name)}${p.map(cap).join('')}`,
        { kind: 'statePredicate', aggregate: o.name,
          // An absent amount is not a negative one. The assertion form would make every optional
          // Money mandatory and defeat optionality, so the guard form is forced, not chosen.
          // Only a top-level field can be optional (optional-value forbids an optional value
          // sub-field; optional-owned-child forbids an optional child field), so the guard reads
          // the head segment.
          // A head `Optional<T>` counts as optional whether the parser recorded it as the
          // Field.optional flag or left it as an `optional` TYPE at the head — either way an absent
          // amount is not a negative one, so the present-guard is forced.
          body: (f.optional || f.type.kind === 'optional')
            ? { kind: 'implies', left: { kind: 'present', path: [f.name] }, right: nonNegativeBody(p) }
            : nonNegativeBody(p) }));
    }
    // Optional refs stay IN refsResolve: the judge's arm skips an absent value (evaluate.ts's
    // `typeof v === 'string'` guard), so absence is never an orphan — but a PRESENT optional ref
    // that dangles is one, and this rule is its only enforcement (Alloy-vacuous, Quint-unemitted).
    // Safe only because quint-adapter strips flag-false placeholders before the judge sees them.
    const sameContextRefFields = o.fields
      .filter(f => f.type.kind === 'ref' && !isQualifiedRef(f.type))
      .map(f => f.name);
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

/** Every field path a Predicate reads, for describing a candidate in a collision diagnostic. */
function predicatePaths(p: Predicate): Path[] {
  const out: Path[] = [];
  const term = (t: Term): void => {
    switch (t.kind) {
      case 'field': out.push(t.path); break;
      case 'plus': term(t.left); term(t.right); break;
      case 'int': case 'enumval': case 'now': case 'param': break;
    }
  };
  const walk = (q: Predicate): void => {
    switch (q.kind) {
      case 'cmp': term(q.left); term(q.right); break;
      case 'present': out.push(q.path); break;
      case 'and': case 'or': q.args.forEach(walk); break;
      case 'not': walk(q.arg); break;
      case 'implies': walk(q.left); walk(q.right); break;
      case 'inState': break;
    }
  };
  walk(p);
  return out;
}

/** `Owner.the.path` — the detail that distinguishes two rules the derived name has merged. */
function describeDerived(c: Candidate): string {
  const detail =
    c.kind === 'statePredicate' ? [...new Set(predicatePaths(c.body).map(p => p.join('.')))].join(' & ')
    : c.kind === 'refsResolve' ? (c.fields ?? []).join(', ')
    : c.kind === 'terminal' ? `${c.region}.${c.state}`
    : '';
  return detail ? `${c.aggregate}.${detail}` : `${c.aggregate} (${c.kind})`;
}

/**
 * Distinct derived rules that fold onto ONE name (review finding, slice B2). Derived names
 * concatenate capitalized segments with no separator — `nonNegative${cap(owner)}${path.map(cap)}` —
 * so two paths whose segments differ only in where the word boundaries fall produce the same name:
 * a plain `totalAmount : Money` and a value-typed `total : Amount{amount : Money}` on one owner
 * BOTH mint `nonNegativeInvoiceTotalAmount`. Same hazard for `terminal${owner}${region}${state}`.
 *
 * **A separator cannot fix this.** Every derived name is folded through `toCamelName`
 * (templates.ts's `fold`), which splits on `_` and re-camelCases each segment — so
 * `nonNegative_Invoice_total_amount` and `nonNegative_Invoice_totalAmount` both fold back to
 * `nonNegativeInvoiceTotalAmount` and the collision returns. Nor is a disambiguating suffix right:
 * it would tax the 99% non-colliding case to serve the 1%, and `nonNegativeBillTotalAmount` must
 * stay exactly that — the name is read by humans in `explain` and in generated `.lat`.
 *
 * So this is reported, not repaired — the same judgment cli.ts's `propose` already makes for
 * agent-authored names: two distinct rules on one name is a real ambiguity no normalizer can
 * settle, and only the author can say which field should be renamed. `propose` guarded the
 * agent-authored half while the derived half went unguarded; that asymmetry was the bug. Silently
 * colliding is the worst option: id- AND name-keyed lookups (cli.ts's `explain`, reconcile.ts's
 * `rehydrateIds`) resolve to whichever rule came first, making the second unreachable and
 * unrestorable while both are ledgered under one provenance.
 *
 * Called at BOTH doors a model enters a session by: cli.ts's `init` (the --model JSON) and cli.ts's
 * `apply` (the .lat, gated once after the parse so it covers the fresh-session and reconcile
 * branches alike). Not init-only: an earlier revision of this comment reasoned that `matchTemplates`
 * has a single caller, which is true but about the wrong function — `impliedInvariants` is what
 * mints these names, and `reconcile.ts`'s `canonicalSet` plus apply's §5.8 fresh-session branch both
 * reach it without going through `init`.
 *
 * Not folded into `validateModel`, which is the other thing that runs at both doors: this is a claim
 * about DERIVED names, not about the model's own well-formedness, and `ast/` would have to import
 * `engine/implied.ts` to know them — inverting the existing `engine → ast` direction.
 *
 * Keyed on the FOLDED name (what actually reaches the session) and grouped by canonical candidate,
 * so a rule derived twice identically — two same-named `Money` fields on one owner, which
 * `validateModel` tolerates — is a harmless duplicate, not a reported ambiguity.
 */
export function derivedNameCollisions(m: DomainModel): Diagnostic[] {
  const byName = new Map<string, CandidateInvariant[]>();
  for (const i of impliedInvariants(m)) {
    const key = toCamelName(i.name);
    byName.set(key, [...(byName.get(key) ?? []), i]);
  }
  const out: Diagnostic[] = [];
  for (const [name, group] of byName) {
    const distinct = [...new Map(group.map(i => [canonicalCandidate(i.candidate), i])).values()];
    if (distinct.length < 2) continue;
    out.push({ code: 'derived-name-collision', at: distinct[0]!.candidate.aggregate,
      message: `${distinct.length} structure-implied invariants collapse onto the single derived name '${name}': ${distinct.map(i => describeDerived(i.candidate)).join(' vs ')}. Derived names join the owner and path segments with no separator, so these distinct rules are indistinguishable by name — one would silently shadow the other. Rename one of the colliding fields so the two names differ.` });
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
