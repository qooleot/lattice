import type { Candidate, Predicate, Term } from '../ast/invariant.js';
import type { PlanInvariant } from './plan.js';

const TS_OPS = { eq: '===', ne: '!==', lt: '<', le: '<=', gt: '>', ge: '>=' } as const;

function term(t: Term, rowVar: string): string {
  switch (t.kind) {
    case 'field': return `${rowVar}.${t.path.join('.')}`;   // dotted path resolves refs at compile scope (own-row fields in v1)
    case 'int': return String(t.value);
    case 'enumval': return `'${t.value}'`;
    case 'now': return 'now';
    case 'plus': return `(${term(t.left, rowVar)} + ${term(t.right, rowVar)})`;
    case 'param': throw new Error('param terms are illegal in invariants');
  }
}

/**
 * Renders a Predicate to a TS boolean expression over a caller-chosen row-variable name.
 * Shared by the invariant-check compiler (rowVar 'row') and the command-handler renderer,
 * which guards `requires` predicates over the loaded row under the same variable name.
 */
export function predToTs(p: Predicate, rowVar: string): string {
  switch (p.kind) {
    case 'cmp': return `${term(p.left, rowVar)} ${TS_OPS[p.op]} ${term(p.right, rowVar)}`;
    case 'inState': return `[${p.states.map(s => `'${s}'`).join(', ')}].includes(${rowVar}.${p.region})`;
    // `?.` survives an absent/NULL ref hop (the exact case present() answers); `!= null` reads
    // SQLite's NULL — not just undefined — as absence, while 0/'' stay facts.
    case 'present': return `${rowVar}.${p.path.join('?.')} != null`;
    case 'and': return p.args.map(a => `(${predToTs(a, rowVar)})`).join(' && ');
    case 'or': return p.args.map(a => `(${predToTs(a, rowVar)})`).join(' || ');
    case 'not': return `!(${predToTs(p.arg, rowVar)})`;
    case 'implies': return `(!(${predToTs(p.left, rowVar)}) || (${predToTs(p.right, rowVar)}))`;
  }
}

export interface CompiledCheck { name: string; kind: 'row' | 'table'; bodyTs: string; }

export function compileInvariantCheck(inv: PlanInvariant): CompiledCheck {
  const c: Candidate = inv.candidate;
  switch (c.kind) {
    case 'statePredicate': {
      const body = predToTs(c.body, 'row');
      const bodyTs = c.where ? `!(${predToTs(c.where, 'row')}) || (${body})` : body;
      return { name: inv.name, kind: 'row', bodyTs };
    }
    case 'unique': {
      const stateGuard = `[${c.whileStates.states.map(s => `'${s}'`).join(', ')}].includes(r.${c.whileStates.region})`;
      const keyExpr = c.by.map(p => `r.${p.join('.')}`).join(" + '|' + ");
      // no two in-scope rows share the key
      const bodyTs =
        `(() => { const seen = new Set(); for (const r of rows) { if (!(${stateGuard})) continue; ` +
        `const k = ${keyExpr}; if (seen.has(k)) return false; seen.add(k); } return true; })()`;
      return { name: inv.name, kind: 'table', bodyTs };
    }
    default:
      throw new Error(`unsupported invariant kind: ${c.kind} (invariant ${inv.name}) — ` +
        `v1 compiles statePredicate + unique; temporal/liveness kinds are out of scope (see design §5)`);
  }
}
