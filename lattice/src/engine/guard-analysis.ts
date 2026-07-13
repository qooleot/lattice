import type { DomainModel } from '../ast/domain.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { reachabilityResidual, stuckCandidates } from './guard-structure.js';
import { astToQuintGuard } from '../emit/quint-guard.js';

export interface GuardFinding {
  finding: 'stuck' | 'unreachable';
  owner: string; region: string; state: string;
  witness?: CaseState;
  boundedN: number;
}

export async function analyzeGuards(m: DomainModel, deps: SolverDeps, reachSteps = 6): Promise<GuardFinding[]> {
  const findings: GuardFinding[] = [];
  // Stuck: structural filter → solver-confirm reachability of the stuck config.
  for (const site of stuckCandidates(m)) {
    const em = astToQuintGuard(m, site, 'stuck');
    const r = await deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps });
    if (r.violated) findings.push({ finding: 'stuck', ...site, witness: r.witness, boundedN: reachSteps });
  }
  // Reachability: residual → solver. A NON-violation (q_not_reach holds) ⇒ unreachable within N.
  for (const site of reachabilityResidual(m)) {
    const em = astToQuintGuard(m, site, 'reach');
    const r = await deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps });
    if (!r.violated) findings.push({ finding: 'unreachable', ...site, boundedN: reachSteps });
  }
  return findings;
}
