import type { AggregateDef, DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Cmp, Predicate } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';
import { evaluateCandidate } from './evaluate.js';
import { astToQuint } from '../emit/quint.js';
import { expressibleAdopted, type SolverDeps } from './planner.js';

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
  | { kind: 'distinguish'; survivors: Guard[]; witnesses: CaseState[] }
  | { kind: 'no-transition'; note: string };

const DEBUG = process.env.STRENGTHEN_DEBUG === '1';
const dbg = (stage: string, gs: Guard[]) => {
  if (DEBUG) console.error(`[strengthen] ${stage}: [${gs.map(g => (g.predicate.kind === 'cmp' ? g.predicate.op : g.predicate.kind)).join(', ')}]`);
};

export async function strengthenInvariant(
  m: DomainModel, violated: CandidateInvariant, adopted: Candidate[], deps: SolverDeps, reachSteps = 6,
): Promise<Resolution> {
  // Peers = quint-expressible always-properties only (candidateToQuint throws on template-adopted
  // terminal/monotonic/leadsTo/refsResolve and on the `guard` kind), self-excluded — the conjunction
  // that forms the classify `q_inv`. Moving this filter INTO the engine (design carried fix iii) lets
  // callers pass raw `adoptedConstraints(s)` (the interactive hook does). Adopted GUARDS never render
  // as peers but MUST still ride into the machine — astToQuint conjoins them into their trans_ action
  // (design §8.3) — so they are kept in `machineAdopted` (the `adopted` channel of every probe below).
  const peers = expressibleAdopted('quint', adopted).filter(c => c !== violated.candidate && c.kind !== 'guard');
  const guards = adopted.filter((c): c is Guard => c.kind === 'guard');
  const machineAdopted: Candidate[] = [...peers, ...guards];

  // 1. Obtain the CTI (reachability from the real init) with its trace. Uses the guard-bearing
  //    astToQuint `probe-forbid` path (carried fix i): NOT astToQuintClassify, which cannot carry
  //    guards and would DROP any prior adopted guard on another transition — reporting a spurious CTI
  //    for an invariant a prior guard already fixes (the interactive hook accumulates such guards).
  //    q_inv = (peers ⇒ I) checked from `init`; a violation with a witness is a reachable peer-
  //    consistent ¬I — the counterexample-to-induction we must close. This is byte-equivalent to the
  //    old q_peersImpliesI reachability property (Task 4 report), just guard-bearing and matching 3b.
  const rEm = astToQuint(m, { kind: 'probe-forbid', hi: violated.candidate, exclusions: [], adopted: machineAdopted, maxSteps: reachSteps, abstractEvolution: true });
  const reach = await deps.quintVerify(rEm, { init: 'init', invariant: rEm.invariantName, maxSteps: reachSteps });
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
    const r = await deps.quint(m, { kind: 'probe-permit', hi: violated.candidate, exclusions: [], adopted: [...machineAdopted, g], maxSteps: reachSteps, abstractEvolution: true });
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
    const em = astToQuint(m, { kind: 'probe-forbid', hi: violated.candidate, exclusions: [], adopted: [...machineAdopted, g], maxSteps: reachSteps, abstractEvolution: true });
    const r = await deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps });
    if (!r.violated) closers.push(g);
  }
  dbg('closers', closers);
  // Consistent variants exist, but NONE close the CTI ⇒ no guard on this transition prevents the
  // violation — the CTI wasn't caused by this transition (typically an abstract-evolution accrual
  // artifact, design §10 spurious-CTI discipline). This is NOT a spec contradiction (that's 3a, above);
  // report the honest ceiling — "confirm intended" — rather than a fabricated inconsistency.
  if (!closers.length) return { kind: 'no-transition', note: `no ${site.transition} guard (shape ==/<=/>=) closes this CTI — the violation is not prevented by guarding this transition (likely an abstract-evolution accrual artifact); confirm intended (design §10)` };

  // 3c. Equivalence: collapse variants that no reachable state separates. Keep a closer as a new
  //     survivor only if it separates from every survivor already kept.
  const survivors: Guard[] = [];
  for (const g of closers) {
    let dup = false;
    for (const s of survivors) if (!(await separates(m, s, g, machineAdopted, deps, reachSteps))) { dup = true; break; }
    if (!dup) survivors.push(g);
  }
  dbg('survivors', survivors);

  // 4. Resolve.
  if (survivors.length === 1) return { kind: 'auto-adopt', guard: survivors[0]! };
  // ≥2 survivors: hand the author the SEPARATING WITNESS between each adjacent survivor pair (item 2)
  // — the concrete reachable state that tells the variants apart — so `strengthen --name X` can render
  // the choice and `--choose <op>` can adopt one. Reuses the same both-directions probe the
  // equivalence prune ran, so a distinguish always has at least one witness per collapsed pair.
  const witnesses: CaseState[] = [];
  for (let i = 0; i + 1 < survivors.length; i++) {
    const w = await separatingWitness(m, survivors[i]!, survivors[i + 1]!, machineAdopted, deps, reachSteps);
    if (w) witnesses.push(w);
  }
  return { kind: 'distinguish', survivors, witnesses };
}

// The SEPARATING WITNESS between two guards: a reachable (adopted-consistent) state that satisfies one
// guard-predicate but not the other — probed in BOTH directions, because a one-direction `a∧¬b` check
// is unsound: e.g. a=`eq`, b=`le` has `eq∧¬le` empty yet `le∧¬eq` (= amountPaid<totalDue) reachable,
// so they DO separate. Each direction is a `probe-permit` for a state where P∧¬Q holds (`not(P ⇒ Q)`),
// conjoined with the adopted spec; `violated:true` with a `witness` ⇒ that witness separates them.
// Returns the first direction's witness, else the other's, else null (the guards are equivalent).
async function separatingWitness(
  m: DomainModel, a: Guard, b: Guard, adopted: Candidate[], deps: SolverDeps, steps: number,
): Promise<CaseState | null> {
  const andNot = (p: Guard, q: Guard): Candidate => ({
    kind: 'statePredicate', aggregate: p.aggregate,
    body: { kind: 'not', arg: { kind: 'implies', left: p.predicate, right: q.predicate } },
  });
  const dir = async (p: Guard, q: Guard): Promise<CaseState | null> => {
    const r = await deps.quint(m, { kind: 'probe-permit', hi: andNot(p, q), exclusions: [], adopted, maxSteps: steps, abstractEvolution: true });
    return r.violated && r.witness ? r.witness : null;
  };
  return (await dir(a, b)) ?? (await dir(b, a));
}

// Two guards SEPARATE iff a separating witness exists — the equivalence prune keeps a closer only if
// it separates from every survivor already kept. Delegates to `separatingWitness` (same both-direction
// probes) so the prune behavior is identical whether or not the witness is later surfaced.
async function separates(
  m: DomainModel, a: Guard, b: Guard, adopted: Candidate[], deps: SolverDeps, steps: number,
): Promise<boolean> {
  return !!(await separatingWitness(m, a, b, adopted, deps, steps));
}
