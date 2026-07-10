import type { Candidate, Predicate, Term } from '../ast/invariant.js';
import type { PlanInvariant } from './plan.js';

const TS_OPS = { eq: '===', ne: '!==', lt: '<', le: '<=', gt: '>', ge: '>=' } as const;

function term(t: Term): string {
  switch (t.kind) {
    case 'field': return `row.${t.path.join('.')}`;   // dotted path resolves refs at compile scope (own-row fields in v1)
    case 'int': return String(t.value);
    case 'enumval': return `'${t.value}'`;
    case 'now': return 'now';
    case 'plus': return `(${term(t.left)} + ${term(t.right)})`;
    case 'param': throw new Error('param terms are illegal in invariants');
  }
}

function pred(p: Predicate): string {
  switch (p.kind) {
    case 'cmp': return `${term(p.left)} ${TS_OPS[p.op]} ${term(p.right)}`;
    case 'inState': return `[${p.states.map(s => `'${s}'`).join(', ')}].includes(row.${p.region})`;
    case 'and': return p.args.map(a => `(${pred(a)})`).join(' && ');
    case 'or': return p.args.map(a => `(${pred(a)})`).join(' || ');
    case 'not': return `!(${pred(p.arg)})`;
    case 'implies': return `(!(${pred(p.left)}) || (${pred(p.right)}))`;
  }
}

export interface CompiledCheck { name: string; kind: 'row' | 'table'; bodyTs: string; }

export function compileInvariantCheck(inv: PlanInvariant): CompiledCheck {
  const c: Candidate = inv.candidate;
  switch (c.kind) {
    case 'statePredicate': {
      const body = pred(c.body);
      const bodyTs = c.where ? `!(${pred(c.where)}) || (${body})` : body;
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
