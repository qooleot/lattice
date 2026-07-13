import type { AggregateDef, DomainModel } from '../ast/domain.js';
import type { Candidate } from '../ast/invariant.js';
import type { GuardSite } from '../engine/guard-structure.js';
import { astToQuint, owners, predToQuint, varName, type QuintEmission } from './quint.js';

// A statePredicate whose body is the vacuous `0 == 0` — expressible, never referenced by the guard
// invariant (we slice only the machine head), keeps astToQuint's q_inv construction happy.
const TRUE_PROBE: Candidate = { kind: 'statePredicate', aggregate: '', body:
  { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } } as Candidate;

/** A guard-analysis probe over the abstract-evolution machine (design §7.3.4). Mirrors
 *  astToQuintClassify: slice the base machine's head (module through the `step` line), append the
 *  stuck/reach `val`s, and name the negated predicate as the invariant. */
export function astToQuintGuard(m: DomainModel, site: GuardSite, kind: 'stuck' | 'reach'): QuintEmission {
  // Any candidate works as `hi` — we only reuse the machine, not q_inv. Use the first adopted-free
  // structural fact by picking a trivial always-true probe target: reuse the base with abstract
  // evolution on so numeric guards can be satisfied/blocked by accrual.
  const base = astToQuint(m, { kind: 'probe-permit', hi: TRUE_PROBE, exclusions: [], maxSteps: 1, abstractEvolution: true });
  const stepIdx = base.source.indexOf('\n  action step = any {');
  if (stepIdx < 0) throw new Error('astToQuintGuard: could not locate the `step` action in the base emission');
  const head = base.source.slice(0, base.source.indexOf('\n', stepIdx + 1));

  const o = owners(m).find(x => x.name === site.owner) as AggregateDef | undefined;
  if (!o) throw new Error(`astToQuintGuard: unknown owner ${site.owner}`);
  const v = varName(o.name);
  const IDS = `${o.name.toUpperCase()}_IDS`;
  const inState = `${v}.get(id).exists and ${v}.get(id).${site.region}_state == "${site.state}"`;

  let valLines: string; let invariantName: string;
  if (kind === 'reach') {
    valLines = [`val reach = ${IDS}.exists(id => ${inState})`, `val q_not_reach = not(reach)`].map(l => '  ' + l).join('\n');
    invariantName = 'q_not_reach';
  } else {
    const outs = (o.machine?.transitions ?? []).filter(t => t.region === site.region && t.from.includes(site.state));
    // "stuck" = in-state AND every out-guard false. An unguarded out-transition (no `requires`) is
    // always enabled — same convention as astToQuint's own trans_ action guard — so its negation is
    // `not (true)`, correctly making the state never stuck via that transition. Zero out-transitions
    // → the map has no conjuncts beyond inState (always stuck in S).
    const negGuards = outs.map(t => `not (${t.requires ? predToQuint(m, t.requires, `${v}.get(id)`, o.name) : 'true'})`);
    const stuckExpr = [inState, ...negGuards].join(' and ');
    valLines = [`val stuck = ${IDS}.exists(id => ${stuckExpr})`, `val q_not_stuck = not(stuck)`].map(l => '  ' + l).join('\n');
    invariantName = 'q_not_stuck';
  }
  const source = `${head}\n\n${valLines}\n}\n`;
  return { source, invariantName, varTypes: base.varTypes };
}
