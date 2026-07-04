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
    case 'cmp': if (['lt','le','gt','ge'].includes(p.op) || [p.left, p.right].some(t => t.kind === 'now' || t.kind === 'plus')) out.push(p); break;
    case 'and': case 'or': p.args.forEach(a => collectCmps(a, out)); break;
    case 'not': collectCmps(p.arg, out); break;
    case 'implies': collectCmps(p.left, out); collectCmps(p.right, out); break;
    case 'inState': break;
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
