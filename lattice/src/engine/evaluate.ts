import type { Candidate, Path, Predicate, Term } from '../ast/invariant.js';

export interface CaseEntity { type: string; id: string; fields: Record<string, string | number | boolean> }
export interface CaseState { now?: number; entities: CaseEntity[]; trace?: CaseEntity[][] }
export type Verdict = 'permit' | 'forbid';

export function resolveValue(s: CaseState, e: CaseEntity, path: Path): string | number | boolean | undefined {
  let cur: CaseEntity | undefined = e;
  for (let i = 0; i < path.length; i++) {
    if (!cur) return undefined;
    const v: string | number | boolean | undefined = cur.fields[path[i]!];
    if (i === path.length - 1) return v;
    cur = s.entities.find(x => x.id === v);
  }
  return undefined;
}

function evalTerm(t: Term, self: CaseEntity, s: CaseState): number | string | boolean | undefined {
  switch (t.kind) {
    case 'field': return resolveValue(s, self, t.path);
    case 'int': return t.value;
    case 'enumval': return t.value;
    case 'now': return s.now;
    case 'plus': {
      const l = evalTerm(t.left, self, s), r = evalTerm(t.right, self, s);
      return typeof l === 'number' && typeof r === 'number' ? l + r : undefined;
    }
  }
}

function evalPred(p: Predicate, self: CaseEntity, s: CaseState): boolean {
  switch (p.kind) {
    case 'cmp': {
      const l = evalTerm(p.left, self, s), r = evalTerm(p.right, self, s);
      if (l === undefined || r === undefined) return true; // unknown facts don't convict
      switch (p.op) {
        case 'eq': return l === r; case 'ne': return l !== r;
        case 'lt': return (l as number) < (r as number); case 'le': return (l as number) <= (r as number);
        case 'gt': return (l as number) > (r as number); case 'ge': return (l as number) >= (r as number);
      }
    }
    case 'inState': return p.states.includes(String(self.fields[`${p.region}.state`]));
    case 'and': return p.args.every(a => evalPred(a, self, s));
    case 'or': return p.args.some(a => evalPred(a, self, s));
    case 'not': return !evalPred(p.arg, self, s);
    case 'implies': return !evalPred(p.left, self, s) || evalPred(p.right, self, s);
  }
}

const inStates = (e: CaseEntity, w: { region: string; states: string[] }) =>
  w.states.includes(String(e.fields[`${w.region}.state`]));

export function evaluateCandidate(c: Candidate, s: CaseState): Verdict {
  const subjects = () => s.entities.filter(e => e.type === c.aggregate);
  switch (c.kind) {
    case 'statePredicate': {
      const ok = subjects().every(e =>
        (c.where && !evalPred(c.where, e, s)) ? true : evalPred(c.body, e, s));
      return ok ? 'permit' : 'forbid';
    }
    case 'unique': {
      const seen = new Set<string>();
      for (const e of subjects().filter(e => inStates(e, c.whileStates))) {
        const vals = c.by.map(p => resolveValue(s, e, p));
        if (vals.some(v => v === undefined)) continue;   // unknown facts don't convict (matches cmp)
        const key = vals.map(String).join('|');
        if (seen.has(key)) return 'forbid';
        seen.add(key);
      }
      return 'permit';
    }
    case 'cardinality': {
      const n = subjects().filter(e => !c.where || evalPred(c.where, e, s)).length;
      return n <= c.atMost ? 'permit' : 'forbid';
    }
    case 'refsResolve': {
      const ids = new Set(s.entities.map(e => e.id));
      for (const e of subjects())
        for (const [k, v] of Object.entries(e.fields))
          if (!k.includes('.') && typeof v === 'string' && !ids.has(v) && looksLikeRef(s, k, e)) return 'forbid';
      return 'permit';
    }
    case 'terminal': {
      for (const e of subjects()) {
        const history = [...(s.trace ?? []).map(step => step.find(x => x.id === e.id)), e].filter(Boolean) as CaseEntity[];
        let entered = false;
        for (const snap of history) {
          const st = String(snap.fields[`${c.region}.state`]);
          if (entered && st !== c.state) return 'forbid';
          if (st === c.state) entered = true;
        }
      }
      return 'permit';
    }
    case 'monotonic': {
      for (const e of subjects()) {
        const history = [...(s.trace ?? []).map(step => step.find(x => x.id === e.id)), e].filter(Boolean) as CaseEntity[];
        let prev = -Infinity;
        for (const snap of history) {
          const v = resolveValue(s, snap, c.field);
          if (typeof v === 'number') { if (v < prev) return 'forbid'; prev = v; }
        }
      }
      return 'permit';
    }
    case 'conservation': {
      for (const e of subjects()) {
        const parts = c.parts.map(p => resolveValue(s, e, p));
        const total = resolveValue(s, e, c.total);
        if (parts.every(v => typeof v === 'number') && typeof total === 'number' &&
            (parts as number[]).reduce((a, b) => a + b, 0) !== total) return 'forbid';
      }
      return 'permit';
    }
    case 'leadsTo': return 'permit'; // liveness is not judgeable on a finite case; template-only (§6.1)
  }
}

// Conservative stub: any string field whose value is no entity's id counts as a dangling ref.
// Exact for solver-produced witnesses (emitters guarantee non-state string fields are refs).
// Hand-authored cases MUST use numbers/enums for data fields — enforced by convention in fidelity/PROTOCOL.md.
function looksLikeRef(s: CaseState, _field: string, _e: CaseEntity): boolean {
  return s.entities.length > 0;
}
