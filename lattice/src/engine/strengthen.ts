import type { AggregateDef, DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Cmp, Predicate } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';
import { evaluateCandidate } from './evaluate.js';
import { astToQuintClassify } from '../emit/quint-classify.js';
import { astToQuint } from '../emit/quint.js';
import type { SolverDeps } from './planner.js';

type Guard = Extract<Candidate, { kind: 'guard' }>;

export interface GuardSiteRef { owner: string; region: string; transition: string }

// Pull the single own-field cmp the invariant is "about": a bare statePredicate body that is a cmp,
// or the consequent of an `implies`/the body when `where` gates it. Returns null if there's no clean
// own-field cmp (both operands must be `field` terms on `self`).
function invariantCmp(inv: CandidateInvariant): (Predicate & { kind: 'cmp' }) | null {
  const c = inv.candidate;
  if (c.kind !== 'statePredicate') return null;
  const pick = (p: Predicate): (Predicate & { kind: 'cmp' }) | null =>
    p.kind === 'cmp' ? p : p.kind === 'implies' ? pick(p.right) : null;
  const cm = pick(c.body);
  if (!cm) return null;
  const ownField = (t: any) => t?.kind === 'field' && t.owner === 'self';
  return ownField(cm.left) && ownField(cm.right) ? cm : null;
}

export function ctiTransition(m: DomainModel, violated: CandidateInvariant, w: CaseState): GuardSiteRef | null {
  const agg = violated.candidate.aggregate;
  if (!w.trace || w.trace.length === 0) return null;                 // violation at init → no transition
  const prev = w.trace[w.trace.length - 1]!;                         // state just before the violating one
  // the violating instance: the aggregate subject where the invariant is forbidden in the final state
  const bad = w.entities.find(e => e.type === agg &&
    evaluateCandidate(violated.candidate, { entities: [e] }) === 'forbid');
  if (!bad) return null;
  const before = prev.find(e => e.type === agg && e.id === bad.id);
  if (!before) return null;
  const machine = (m.aggregates as AggregateDef[]).find(a => a.name === agg)?.machine;
  if (!machine) return null;
  for (const r of machine.regions) {
    const key = `${r.name}.state`;                                    // CaseEntity fields key (evaluate.ts:52)
    const from = before.fields[key], to = bad.fields[key];
    if (from !== undefined && to !== undefined && from !== to) {      // a region moved this step
      const t = machine.transitions.find(tr => tr.region === r.name && tr.from.includes(String(from)) && tr.to === String(to));
      if (t) return { owner: agg, region: r.name, transition: t.name };
    }
  }
  return null;                                                        // only fields changed → accrual step
}

export function guardVariants(site: GuardSiteRef, violated: CandidateInvariant): Guard[] {
  const cm = invariantCmp(violated);
  if (!cm) return [];
  const ops: Cmp[] = ['eq', 'le', 'ge'];
  return ops.map(op => ({ kind: 'guard', aggregate: site.owner, region: site.region, transition: site.transition,
    predicate: { kind: 'cmp', op, left: cm.left, right: cm.right } }));
}

// The generate→auto-prune→resolve engine (design §8.5). Given a `violated` invariant and the
// already-`adopted` spec, derive the transition-guard that closes the violation's counterexample
// trace (CTI). Real-solver-backed throughout: every prune stage is a `quint verify` call.
export type Resolution =
  | { kind: 'auto-adopt'; guard: Guard }
  | { kind: 'inconsistent'; note: string }
  | { kind: 'distinguish'; survivors: Guard[] }
  | { kind: 'no-transition'; note: string };

const DEBUG = process.env.STRENGTHEN_DEBUG === '1';
const dbg = (stage: string, gs: Guard[]) => {
  if (DEBUG) console.error(`[strengthen] ${stage}: [${gs.map(g => (g.predicate.kind === 'cmp' ? g.predicate.op : g.predicate.kind)).join(', ')}]`);
};

export async function strengthenInvariant(
  m: DomainModel, violated: CandidateInvariant, adopted: Candidate[], deps: SolverDeps, reachSteps = 6,
): Promise<Resolution> {
  const peers = adopted.filter(c => c.kind !== 'guard');

  // 1. Obtain the CTI (reachability from the real init) with its trace. The classifier's reachability
  //    probe (design §5, Pillar A path): q_peersImpliesI = (peers ⇒ I) checked from `init`; a
  //    violation is a reachable peer-consistent ¬I — the counterexample-to-induction we must close.
  const rEm = astToQuintClassify(m, { invariant: violated.candidate, peers, probe: 'entailment', maxSteps: reachSteps });
  const reach = await deps.quintVerify(rEm, { init: 'init', invariant: 'q_peersImpliesI', maxSteps: reachSteps });
  if (!reach.violated || !reach.witness) return { kind: 'no-transition', note: 'invariant not violated (nothing to strengthen)' };
  const site = ctiTransition(m, violated, reach.witness);
  if (!site) return { kind: 'no-transition', note: 'CTI reached via accrual with no declared transition — confirm intended (design §10)' };

  // 2. Generate the shape lattice ({eq, le, ge}) for the identified transition.
  const variants = guardVariants(site, violated);
  if (!variants.length) return { kind: 'no-transition', note: 'no own-field cmp to shape a guard from' };
  dbg('generated', variants);

  // 3a. Consistency: drop variants with no model when conjoined with the adopted spec. Existence probe
  //     (design §8.5): a `probe-permit` for a reachable state satisfying the adopted spec with the
  //     guard conjoined into its `trans_` action — `violated:true` ⇒ such a state exists ⇒ consistent.
  const consistent: Guard[] = [];
  for (const g of variants) {
    const r = await deps.quint(m, { kind: 'probe-permit', hi: violated.candidate, exclusions: [], adopted: [...adopted, g], maxSteps: reachSteps, abstractEvolution: true });
    if (r.violated) consistent.push(g);
  }
  dbg('consistent', consistent);
  if (!consistent.length) return { kind: 'inconsistent', note: `no ${site.transition} guard variant is consistent with the adopted spec` };

  // 3b. Closes the CTI: keep variants under which the peer-consistent ¬I is no longer reachable. Same
  //     reachability shape as step 1, but through the astToQuint `probe-forbid` path so the candidate
  //     guard is conjoined into `settle`'s `trans_` action (adopted-guard emission, Task 2) —
  //     astToQuintClassify cannot carry a guard (candidateToQuint throws on the guard kind).
  //     q_inv = (peers ⇒ I); `!violated` ⇒ the guard closed the CTI.
  const closers: Guard[] = [];
  for (const g of consistent) {
    const em = astToQuint(m, { kind: 'probe-forbid', hi: violated.candidate, exclusions: [], adopted: [...adopted, g], maxSteps: reachSteps, abstractEvolution: true });
    const r = await deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps });
    if (!r.violated) closers.push(g);
  }
  dbg('closers', closers);
  if (!closers.length) return { kind: 'inconsistent', note: `no consistent ${site.transition} guard variant closes the CTI` };

  // 3c. Equivalence: collapse variants that no reachable state separates. Keep a closer as a new
  //     survivor only if it separates from every survivor already kept.
  const survivors: Guard[] = [];
  for (const g of closers) {
    let dup = false;
    for (const s of survivors) if (!(await separates(m, s, g, adopted, deps, reachSteps))) { dup = true; break; }
    if (!dup) survivors.push(g);
  }
  dbg('survivors', survivors);

  // 4. Resolve.
  if (survivors.length === 1) return { kind: 'auto-adopt', guard: survivors[0]! };
  return { kind: 'distinguish', survivors };
}

// Two guards SEPARATE iff some reachable (adopted-consistent) state satisfies one guard-predicate but
// not the other — probed in BOTH directions, because a one-direction `a∧¬b` check is unsound: e.g.
// a=`eq`, b=`le` has `eq∧¬le` empty yet `le∧¬eq` (= amountPaid<totalDue) reachable, so they DO
// separate. Each direction is a `probe-permit` for a state where P∧¬Q holds (`not(P ⇒ Q)`), conjoined
// with the adopted spec; `violated:true` ⇒ a separating state exists.
async function separates(
  m: DomainModel, a: Guard, b: Guard, adopted: Candidate[], deps: SolverDeps, steps: number,
): Promise<boolean> {
  const andNot = (p: Guard, q: Guard): Candidate => ({
    kind: 'statePredicate', aggregate: p.aggregate,
    body: { kind: 'not', arg: { kind: 'implies', left: p.predicate, right: q.predicate } },
  });
  const dir = async (p: Guard, q: Guard): Promise<boolean> => {
    const r = await deps.quint(m, { kind: 'probe-permit', hi: andNot(p, q), exclusions: [], adopted, maxSteps: steps, abstractEvolution: true });
    return r.violated;
  };
  return (await dir(a, b)) || (await dir(b, a));
}
