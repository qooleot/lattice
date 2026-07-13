// Structural gate (Plan 3 Task 2; D1): pure functions that split a candidate into per-conjunct
// pieces and classify each conjunct as `'sound'` (decided soundly by the frozen model) or
// `'abstract'` (references an EVOLVING field — non-const Int/Money — so it can only be trusted under
// abstractEvolution's over-approximation; see `QuintQuery.abstractEvolution` in emit/quint.ts, set
// by emit/quint-classify.ts, Task 1). No solver calls here; the classifier (Task 3) wires this in.
import type { DomainModel, Field } from '../ast/domain.js';
import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';
import { isEvolvingField } from '../emit/quint.js';

// The set of field NAMES that actually EVOLVE (non-const Int/Money — exactly the fields the emitter
// emits `evolve_` actions for; see isEvolvingField in emit/quint.ts). Iterates every owner that can
// carry evolving fields: aggregates, their nested entities, and top-level entities.
// KNOWN RESIDUAL: the set is model-wide, keyed by name only, so if two owners shared a field name
// where one evolves and one is const/non-evolving, a reference to the non-evolving one is
// conservatively tiered 'abstract'. That is the SAFE direction (over-caution; a caveat only attaches
// to a `violated` finding) and does not occur in the committed model. Owner-precise resolution would
// require threading field-term owners through fieldsIn — out of scope.
function evolvingFieldNames(m: DomainModel): Set<string> {
  const names = new Set<string>();
  const add = (fields: Field[]) => { for (const f of fields) if (isEvolvingField(f)) names.add(f.name); };
  for (const a of m.aggregates) {
    add(a.fields);
    for (const e of a.entities ?? []) add(e.fields);
  }
  for (const e of m.entities) add(e.fields);
  return names;
}

// Split a statePredicate whose body is a top-level `and` into one Candidate per conjunct
// (index-tagged); other Candidate kinds (and non-and bodies) pass through as a single [c].
export function conjunctsOf(c: Candidate): { candidate: Candidate; conjunct?: string }[] {
  if (c.kind === 'statePredicate' && c.body.kind === 'and') {
    return c.body.args.map((a, i) => ({ candidate: { ...c, body: a }, conjunct: String(i) }));
  }
  return [{ candidate: c }];
}

function walkTerm(t: Term, paths: Path[]): void {
  switch (t.kind) {
    case 'field': paths.push(t.path); break;
    case 'plus': walkTerm(t.left, paths); walkTerm(t.right, paths); break;
    case 'int': case 'enumval': case 'now': case 'param': break;
  }
}

// Which data-field paths + region names a predicate references (recursion mirrors salient.ts's
// collectCmps/collectInStateRegions: walk and/or args, not.arg, implies both sides; cmp collects
// field-term paths from left/right — walking plus, unlike collectCmps this keeps every cmp op,
// since fieldsIn's job is "does this touch any data field at all", not salient-fact rendering;
// inState adds its region).
export function fieldsIn(p: Predicate): { paths: Path[]; regions: Set<string> } {
  const paths: Path[] = [];
  const regions = new Set<string>();
  const walk = (pred: Predicate): void => {
    switch (pred.kind) {
      case 'cmp': walkTerm(pred.left, paths); walkTerm(pred.right, paths); break;
      case 'inState': regions.add(pred.region); break;
      case 'and': case 'or': pred.args.forEach(walk); break;
      case 'not': walk(pred.arg); break;
      case 'implies': walk(pred.left); walk(pred.right); break;
    }
  };
  walk(p);
  return { paths, regions };
}

// Tier for one (already-split) conjunct (D1): 'abstract' iff it references a field that actually
// EVOLVES (a non-const Int/Money field — the same set the emitter gives `evolve_` actions), else
// 'sound'. A conjunct touching only refs, enums, const fields, Date/Duration fields, or pure
// region/state facts is 'sound' — the frozen model already decides it soundly, so no
// over-approximation caveat is warranted. Aligns the gate to the abstract-evolution over-approx it
// guards, rather than "references any data field at all".
export function conjunctTier(m: DomainModel, c: Candidate): 'sound' | 'abstract' {
  const paths: Path[] = [];
  switch (c.kind) {
    case 'statePredicate':
      paths.push(...fieldsIn(c.body).paths);
      if (c.where) paths.push(...fieldsIn(c.where).paths);
      break;
    case 'cardinality':
      if (c.where) paths.push(...fieldsIn(c.where).paths);
      break;
    case 'unique':
      // by-paths are direct data-field references (used for equality comparison). Abstract only if
      // one of them names an evolving field (e.g. `by [subscription]` — a ref — is sound).
      paths.push(...c.by);
      break;
    case 'terminal':
      // pure region/state facts — never a data field.
      break;
    case 'refsResolve':
      // fields names ref-typed data fields on the aggregate (bare names, like
      // sumOverCollection.field below). Ref fields never evolve, so a refsResolve is sound unless a
      // listed name happens to match an evolving field (does not occur in practice).
      paths.push(...(c.fields ?? []).map((f) => [f]));
      break;
    case 'monotonic':
      paths.push(c.field);
      break;
    case 'conservation':
      paths.push(...c.parts, c.total);
      break;
    case 'sumOverCollection':
      paths.push([c.field], c.total);
      break;
    case 'leadsTo':
      paths.push(...fieldsIn(c.from).paths, ...fieldsIn(c.to).paths);
      break;
    case 'guard': throw new Error('conjunctTier: guards are transition enablements, never classified as invariants');
  }
  const evolving = evolvingFieldNames(m);
  return paths.some(p => p.some(seg => evolving.has(seg))) ? 'abstract' : 'sound';
}
