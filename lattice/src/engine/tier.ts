// Structural gate (Plan 3 Task 2): pure functions that split a candidate into per-conjunct pieces
// and classify each conjunct as `'sound'` (checkable from region/state facts alone) or
// `'abstract'` (references any data field, so it can only be trusted under abstractEvolution's
// over-approximation — see engine/evaluate.ts's `abstractEvolution` flag, Task 1). No solver calls
// here; the classifier (Task 3) wires this in.
import type { DomainModel } from '../ast/domain.js';
import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';

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

// Tier for one (already-split) conjunct: pure region/state facts, no data paths -> 'sound';
// references any data field -> 'abstract'. The data-vs-config/tag distinction is NOT needed here
// (that's Task 1's emission concern, not this gate) — any field reference at all makes a conjunct
// abstract. `m` is carried for signature symmetry with the classifier's other model-aware helpers;
// this gate doesn't currently need to consult field tags.
export function conjunctTier(m: DomainModel, c: Candidate): 'sound' | 'abstract' {
  void m;
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
      // by-paths are direct data-field references (used for equality comparison) — always present
      // for a real unique candidate, so this is abstract whenever by is non-empty.
      paths.push(...c.by);
      break;
    case 'terminal':
    case 'refsResolve':
      // pure region/state (terminal) or existence-only (refsResolve) facts — never a data field.
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
  }
  return paths.length === 0 ? 'sound' : 'abstract';
}
