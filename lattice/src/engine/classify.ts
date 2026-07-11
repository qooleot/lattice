import type { DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { astToQuintClassify } from '../emit/quint-classify.js';

export interface Classification {
  invariant: string; conjunct?: string;
  verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';  // classifier emits entailed/independent/violated; 'not-inductive' kept in the union for fwd-compat
  tier: 'sound';
  witness?: CaseState;
  reachable?: boolean;   // true on 'violated' (reachable ¬I)
  pinnedBy?: string[];   // peer names, when entailed (guard-level attribution is future work)
}

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
    ? { invariant: inv.name, verdict: 'entailed', tier: 'sound', pinnedBy: peerNames }
    : { invariant: inv.name, verdict: 'independent', tier: 'sound', witness: consec.witness };
}
