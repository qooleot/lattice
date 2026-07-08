import type { Candidate, Cmp, Path, Predicate, Term } from '../ast/invariant.js';
import { resolveValue, type CaseState } from './evaluate.js';
import type { SalientFact } from './session.js';
export type { SalientFact } from './session.js';

function pathsOf(c: Candidate): Path[] {
  switch (c.kind) {
    case 'unique': return c.by;
    default: return [];
  }
}
function collectCmps(p: Predicate, out: { op: Cmp; left: Term; right: Term }[]): void {
  switch (p.kind) {
    case 'cmp': {
      const isOrderOrArith = ['lt','le','gt','ge'].includes(p.op) || [p.left, p.right].some(t => t.kind === 'now' || t.kind === 'plus');
      // field-vs-field eq/ne (e.g. `x.a = x.b`) is captured deliberately (trace-B review fix) —
      // NOTE (final review): field-vs-INT eq/ne (e.g. `x.status = 3`) and other non-field-field
      // eq/ne combinations are still dropped by design here, same as before that fix. Only
      // order/arith comparisons and field-field eq/ne widen the `out` set; a plain field-vs-const
      // eq/ne dim is instead captured separately via collectEnumEq's enum-value equality path
      // (and, for non-enum int/text constants, not captured at all in slice 1). This is a known,
      // intentional gap in salient-fact coverage, not an oversight — narrowing it further would
      // require deciding how to render arbitrary int/text equality dims for shape exclusion, which
      // is out of scope for this slice.
      const isFieldFieldEqNe = (p.op === 'eq' || p.op === 'ne') && p.left.kind === 'field' && p.right.kind === 'field';
      if (isOrderOrArith || isFieldFieldEqNe) out.push(p);
      break;
    }
    case 'and': case 'or': p.args.forEach(a => collectCmps(a, out)); break;
    case 'not': collectCmps(p.arg, out); break;
    case 'implies': collectCmps(p.left, out); collectCmps(p.right, out); break;
    case 'inState': break;
  }
}
// Collect the distinct (region) names referenced by any `inState` predicate reachable within p —
// e.g. a statePredicate guarded by `inState(Open,Paid,Uncollectible)` on region `Lifecycle` needs
// its subjects' machine-state captured as a salient dim, or two candidates differing ONLY by that
// guard look identical to extractSalient (same masking class as the Task-17 `unique` bug — see
// planner.ts's `exclusionsFrom` comment). We only need the region name here: the actual value is
// read per-subject from `fields["<region>.state"]`, same accessor `evaluateCandidate`/`resolveValue`
// already use elsewhere for machine state.
function collectInStateRegions(p: Predicate, out: Set<string>): void {
  switch (p.kind) {
    case 'inState': out.add(p.region); break;
    case 'and': case 'or': p.args.forEach(a => collectInStateRegions(a, out)); break;
    case 'not': collectInStateRegions(p.arg, out); break;
    case 'implies': collectInStateRegions(p.left, out); collectInStateRegions(p.right, out); break;
    case 'cmp': break;
  }
}
function renderTerm(t: Term): string {
  switch (t.kind) {
    case 'field': return t.path.join('.');
    case 'int': return String(t.value);
    case 'enumval': return t.value;
    case 'now': return 'now';
    case 'plus': return `${renderTerm(t.left)} + ${renderTerm(t.right)}`;
  }
}
function evalTermOn(t: Term, e: any, s: CaseState): number | string | boolean | undefined {
  switch (t.kind) {
    case 'field': return resolveValue(s, e, t.path);
    case 'int': return t.value; case 'enumval': return t.value; case 'now': return s.now;
    case 'plus': { const l = evalTermOn(t.left, e, s), r = evalTermOn(t.right, e, s);
      return typeof l === 'number' && typeof r === 'number' ? l + r : undefined; }
  }
}

export function extractSalient(cands: Candidate[], s: CaseState): SalientFact[] {
  const facts = new Map<string, SalientFact>();
  for (const c of cands) {
    if (c.kind === 'unique') {
      // union of by-paths + their prefixes across all candidates gives the comparison dims
      const subjects = s.entities.filter(e => e.type === c.aggregate &&
        c.whileStates.states.includes(String(e.fields[`${c.whileStates.region}.state`])));
      const dims = new Set<string>();
      for (const cc of cands) for (const p of pathsOf(cc)) {
        for (let i = 1; i <= p.length; i++) dims.add(p.slice(0, i).join('.'));
      }
      for (let i = 0; i < subjects.length; i++) for (let j = i + 1; j < subjects.length; j++) {
        for (const d of dims) {
          const path = d.split('.');
          const a = resolveValue(s, subjects[i]!, path), b = resolveValue(s, subjects[j]!, path);
          if (a !== undefined && b !== undefined) facts.set(`${d} equal`, { dim: `${d} equal`, value: a === b });
        }
      }
      facts.set('inState count', { dim: 'inState count', value: subjects.length });
    }
    if (c.kind === 'statePredicate' || c.kind === 'cardinality') {
      const preds: Predicate[] = c.kind === 'statePredicate' ? [c.body, ...(c.where ? [c.where] : [])] : (c.where ? [c.where] : []);
      const cmps: { op: Cmp; left: Term; right: Term }[] = [];
      preds.forEach(p => collectCmps(p, cmps));
      const subjects = s.entities.filter(e => e.type === c.aggregate);
      for (const cmp of cmps) for (const e of subjects) {
        const l = evalTermOn(cmp.left, e, s), r = evalTermOn(cmp.right, e, s);
        if (l === undefined || r === undefined) continue;
        const dim = `${renderTerm(cmp.left)} ${cmp.op} ${renderTerm(cmp.right)}`;
        const val = cmp.op === 'eq' ? l === r : cmp.op === 'ne' ? l !== r
          : cmp.op === 'lt' ? (l as number) < (r as number) : cmp.op === 'le' ? (l as number) <= (r as number)
          : cmp.op === 'gt' ? (l as number) > (r as number) : (l as number) >= (r as number);
        facts.set(dim, { dim, value: val });
      }
      // enum-valued equality facts (e.g. kind = Correction) so shapes distinguish entry kinds
      for (const p of preds) collectEnumEq(p, subjects, s, facts);
      // machine-state facts (e.g. Lifecycle.state = Open): collectCmps deliberately skips
      // `inState` (it isn't a Cmp), so without this, two candidates differing only by an inState
      // guard are indistinguishable to extractSalient — a prior verdict's rebuilt shape can then
      // cover the whole Hi≠Hj region and the planner falsely merges them as equivalent. Captured
      // in the SAME dim format collectEnumEq uses (`"<Region>.state = <value>"`, value `true`) so
      // both shape rebuilders' existing enum-eq regex/branch pick it up unchanged.
      //
      // Both shape rebuilders reconstruct a witness's facts as a conjunction on ONE existentially
      // quantified record (quint's `exists(k => ...)`, alloy's single `a`/`all x`) — never "for
      // each subject". Quint models always instantiate 2 ids per aggregate (see astToQuint's
      // `_IDS` pool), so a multi-region-state model routinely has two live subjects in different
      // states within the same witness. Naively recording BOTH states as separate `true` facts
      // (`Region.state = Active` and `Region.state = Trialing`) would conjoin them onto that one
      // variable — `x.Region_state == "Active" and x.Region_state == "Trialing"` — which is
      // unsatisfiable for a single record, silently turning the whole exclusion shape into a dead
      // always-false conjunct (verified live: this masked the actual probe-forbid exclusion in
      // golden trace B once inState capture was added). So only emit the fact when every subject
      // that has this region agrees on its value — a disagreement means "which subject's state"
      // is exactly the ambiguity a single-existential shape can't express, so drop it rather than
      // emit a self-contradictory conjunct.
      const regions = new Set<string>();
      for (const p of preds) collectInStateRegions(p, regions);
      for (const region of regions) {
        const values = new Set(subjects.map(e => e.fields[`${region}.state`]).filter(v => v !== undefined));
        if (values.size === 1) {
          const v = [...values][0];
          facts.set(`${region}.state = ${v}`, { dim: `${region}.state = ${v}`, value: true });
        }
      }
    }
    if (c.kind === 'sumOverCollection') {
      // Design §6.2/§6.4: three numeric dims characterize a sum witness — child count, sum of the
      // child field, and the parent's own total. Convention matches evaluate.ts's judge: children
      // are CaseEntities with fields.owner === parent.id; parent carries '<collection>.count'.
      const subjects = s.entities.filter(e => e.type === c.aggregate);
      const per = subjects.map(e => {
        const kids = s.entities.filter(x => x.type === c.child && x.fields['owner'] === e.id);
        const vals = kids.map(k => k.fields[c.field]);
        const total = resolveValue(s, e, c.total);
        return { n: kids.length,
          sum: vals.every(v => typeof v === 'number') ? (vals as number[]).reduce((a, b) => a + b, 0) : undefined,
          total: typeof total === 'number' ? total : undefined };
      });
      // all-subjects-agree guard (same rationale as the inState capture above): a single-existential
      // shape (quint's `exists(k => ...)`, alloy's single `all x`/`a`) cannot express "which
      // subject", so subjects disagreeing on a dim's value must drop it rather than conjoin
      // contradictory facts onto one variable.
      const agree = <T>(vs: (T | undefined)[]): T | undefined => {
        const set = new Set(vs.filter(v => v !== undefined));
        return set.size === 1 ? [...set][0] as T : undefined;
      };
      const n = agree(per.map(p => p.n)), sum = agree(per.map(p => p.sum)), total = agree(per.map(p => p.total));
      if (n !== undefined) facts.set(`${c.collection}.count`, { dim: `${c.collection}.count`, value: n });
      if (sum !== undefined) facts.set(`sum(${c.collection}.${c.field})`, { dim: `sum(${c.collection}.${c.field})`, value: sum });
      if (total !== undefined) facts.set(`${c.total.join('.')} value`, { dim: `${c.total.join('.')} value`, value: total });
    }
  }
  return [...facts.values()].sort((a, b) => a.dim.localeCompare(b.dim));
}
function collectEnumEq(p: Predicate, subjects: any[], s: CaseState, facts: Map<string, SalientFact>): void {
  if (p.kind === 'cmp' && p.op === 'eq' && p.left.kind === 'field' && p.right.kind === 'enumval') {
    for (const e of subjects) {
      const v = resolveValue(s, e, p.left.path);
      if (v !== undefined) facts.set(`${p.left.path.join('.')} = ${v}`, { dim: `${p.left.path.join('.')} = ${v}`, value: true });
    }
  } else if (p.kind === 'and' || p.kind === 'or') p.args.forEach(a => collectEnumEq(a, subjects, s, facts));
  else if (p.kind === 'not') collectEnumEq(p.arg, subjects, s, facts);
  else if (p.kind === 'implies') { collectEnumEq(p.left, subjects, s, facts); collectEnumEq(p.right, subjects, s, facts); }
}

const TIME_FIELDS = /date|grace|window|at$|deadline/i;
function humanizeTicks(n: number, ticksPerDay: number): string {
  if (n % ticksPerDay === 0) return `${n} ticks (${n / ticksPerDay} days)`;
  return `${n} ticks (${n} hours)`;   // ticksPerDay=24 ⇒ tick = 1 hour
}

export function renderWitnessTable(s: CaseState, ticksPerDay = 24): string {
  const lines = ['| Entity | Id | Facts |', '|---|---|---|'];
  for (const e of [...s.entities].sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id))) {
    const facts = Object.entries(e.fields).map(([k, v]) =>
      typeof v === 'number' && TIME_FIELDS.test(k) ? `${k}: ${humanizeTicks(v, ticksPerDay)}` : `${k}: ${v}`);
    lines.push(`| ${e.type} | ${e.id} | ${facts.join(' · ') || '—'} |`);
  }
  if (s.now !== undefined) lines.push(`| _clock_ | — | now = ${s.now} ticks |`);
  return lines.join('\n');
}

export function salientKey(f: SalientFact[]): string {
  return [...f].sort((a, b) => a.dim.localeCompare(b.dim)).map(x => `${x.dim}=${x.value}`).join(';');
}
