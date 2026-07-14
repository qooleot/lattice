import type { DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { astToQuintClassify } from '../emit/quint-classify.js';
import { conjunctTier } from './tier.js';

export interface Classification {
  invariant: string; conjunct?: string;
  verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';  // classifier emits entailed/independent/violated; 'not-inductive' kept in the union for fwd-compat
  tier: 'sound' | 'abstract';
  caveat?: string;   // set ONLY on abstract-tier 'violated' (§6.3 over-approximation flip; see CAVEAT below)
  witness?: CaseState;
  reachable?: boolean;   // true on 'violated' (reachable ¬I)
  pinnedBy?: string[];   // peer names, when entailed (guard-level attribution is future work)
}

// §6.3 abstract-evolution over-approximation caveat (structural gate, Plan 3): an `abstract`-tier
// conjunct references a data field, so its verdict rests on abstractEvolution's over-approximation
// of accrual (engine/tier.ts + the Task 1 flag on astToQuintClassify). That over-approximation is
// one-sided — it can only manufacture SPURIOUS violations, never spurious holds — so the caveat
// attaches to the `violated` direction alone. Abstract-tier `entailed`/`independent` are trustworthy
// (a hold survives arbitrary accrual), and `sound`-tier verdicts touch no data field: both uncaveated.
export const OVER_APPROX_CAVEAT = 'abstract-evolution over-approximation: the accrual model permits this; the real (unmodeled) update rule may rule it out — add a guard or confirm intended';

// Design §5 corrected 2-probe: consecution (inductive?) + reachability-from-real-init (¬I reachable?).
// Sound over the equal-records slice, to reachability bound N (see plan §fidelity caveat / design §10).
// Classifies a SINGLE (already-split) conjunct `conj` of the parent invariant `inv`: the result is
// labelled with the parent's name + the conjunct index (conjunctsOf's tag), while emission and the
// tier gate run on the conjunct's own candidate.
export async function classifyInvariant(
  m: DomainModel, inv: CandidateInvariant, conj: { candidate: Candidate; conjunct?: string },
  peers: Candidate[], peerNames: string[], deps: SolverDeps, reachSteps = 6, guards: Candidate[] = [],
): Promise<Classification> {
  const tier = conjunctTier(m, conj.candidate);
  const base = { invariant: inv.name, conjunct: conj.conjunct, tier };
  // Adopted guards (I-1 fix) must ride into BOTH probes' machines: a guard changes the reachable state
  // space, so it affects the consecution machine's `trans_` actions AND the reachability-from-init
  // path. Passed through the `guards` channel (astToQuintClassify → astToQuint `adopted`), never as
  // peers (candidateToQuint throws on the guard kind).
  // Probe 1 — consecution (havoc indInit asserts peers ∧ I; one step): is I 1-step inductive?
  const cEm = astToQuintClassify(m, { invariant: conj.candidate, peers, probe: 'consecution', maxSteps: 1, guards });
  const consec = await deps.quintVerify(cEm, { init: 'indInit', invariant: cEm.invariantName, maxSteps: 1 });
  const inductive = !consec.violated;
  // Probe 2 — reachability from the REAL init (region states = @initial, so guards gate the path):
  // is a peer-consistent ¬I reachable within reachSteps? q_peersImpliesI from `init`.
  const rEm = astToQuintClassify(m, { invariant: conj.candidate, peers, probe: 'entailment', maxSteps: reachSteps, guards });
  const reach = await deps.quintVerify(rEm, { init: 'init', invariant: 'q_peersImpliesI', maxSteps: reachSteps });
  if (reach.violated) return { ...base, verdict: 'violated', witness: reach.witness, reachable: true,
    ...(tier === 'abstract' ? { caveat: OVER_APPROX_CAVEAT } : {}) };
  return inductive
    ? { ...base, verdict: 'entailed', pinnedBy: peerNames }
    : { ...base, verdict: 'independent', witness: consec.witness };
}
