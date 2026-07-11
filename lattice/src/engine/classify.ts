import type { DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { astToQuintClassify } from '../emit/quint-classify.js';

export interface Classification {
  invariant: string; conjunct?: string;
  verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';  // classifier emits entailed/independent/violated; 'not-inductive' kept in the union for fwd-compat
  tier: 'sound';
  caveat?: string;   // set on entailed/independent only (§6.1 honest-ceiling: see CAVEAT below)
  witness?: CaseState;
  reachable?: boolean;   // true on 'violated' (reachable ¬I)
  pinnedBy?: string[];   // peer names, when entailed (guard-level attribution is future work)
}

// §6.1 honest-ceiling caveat (whole-branch review, must-fix): abstract-evolution modeling (design
// §6, real accrual semantics for data fields) is deferred to Plan 3 and not in the code yet. An
// unguarded data-field invariant (e.g. amountPaid <= 100) classifies entailed/independent with
// tier:'sound' — but that soundness currently rests only on the bounded INT_POOL sampling in
// emission, not on any semantic argument. Guard-forced verdicts ARE genuinely sound, but the
// classifier can't cheaply distinguish guard-forced from pool-bounded, so this is a blanket
// caveat on the two "confirms a fact" verdicts. 'violated' (the safe false-alarm direction) is
// exempt — see design §10.
const HONEST_CEILING_CAVEAT = 'provisional: pre-abstract-evolution (design §6/Plan 3), soundness for unguarded data-field facts rests on bounded INT_POOL sampling, not accrual semantics';

// Design §5 corrected 2-probe: consecution (inductive?) + reachability-from-real-init (¬I reachable?).
// Sound over the equal-records slice, to reachability bound N (see plan §fidelity caveat / design §10).
export async function classifyInvariant(
  m: DomainModel, inv: CandidateInvariant, peers: Candidate[], peerNames: string[], deps: SolverDeps,
  reachSteps = 6,
): Promise<Classification> {
  // Probe 1 — consecution (havoc indInit asserts peers ∧ I; one step): is I 1-step inductive?
  const cEm = astToQuintClassify(m, { invariant: inv.candidate, peers, probe: 'consecution', maxSteps: 1 });
  const consec = await deps.quintVerify(cEm, { init: 'indInit', invariant: cEm.invariantName, maxSteps: 1 });
  const inductive = !consec.violated;
  // Probe 2 — reachability from the REAL init (region states = @initial, so guards gate the path):
  // is a peer-consistent ¬I reachable within reachSteps? q_peersImpliesI from `init`.
  const rEm = astToQuintClassify(m, { invariant: inv.candidate, peers, probe: 'entailment', maxSteps: reachSteps });
  const reach = await deps.quintVerify(rEm, { init: 'init', invariant: 'q_peersImpliesI', maxSteps: reachSteps });
  if (reach.violated) return { invariant: inv.name, verdict: 'violated', tier: 'sound', witness: reach.witness, reachable: true };
  return inductive
    ? { invariant: inv.name, verdict: 'entailed', tier: 'sound', caveat: HONEST_CEILING_CAVEAT, pinnedBy: peerNames }
    : { invariant: inv.name, verdict: 'independent', tier: 'sound', caveat: HONEST_CEILING_CAVEAT, witness: consec.witness };
}
