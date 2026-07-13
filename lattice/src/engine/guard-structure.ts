import type { AggregateDef, DomainModel, TransitionDef } from '../ast/domain.js';

export interface GuardSite { owner: string; region: string; state: string }

const isTerminal = (states: { name: string; tags?: string[] }[], state: string): boolean =>
  !!states.find(s => s.name === state)?.tags?.includes('terminal');

/** Non-terminal states whose EVERY out-transition (in the same region, with the state among its
 *  `from`) carries a `requires` guard — including states with zero out-transitions. A state with any
 *  UNGUARDED out-transition can always escape, so it is never stuck and is dropped here. */
export function stuckCandidates(m: DomainModel): GuardSite[] {
  const out: GuardSite[] = [];
  for (const a of m.aggregates as AggregateDef[]) {
    const machine = a.machine;
    if (!machine) continue;
    for (const r of machine.regions) {
      const trans = machine.transitions.filter(t => t.region === r.name);
      for (const st of r.states) {
        if (isTerminal(r.states, st.name)) continue;
        const outs = trans.filter(t => t.from.includes(st.name));
        const anyUnguarded = outs.some(t => !t.requires);
        if (!anyUnguarded) out.push({ owner: a.name, region: r.name, state: st.name });
      }
    }
  }
  return out;
}

/** States NOT reachable from the region's `initial` following UNGUARDED transitions only (a sound
 *  under-approximation of reachability: an unguarded transition can always fire). The residual is
 *  what the solver must actually probe. */
export function reachabilityResidual(m: DomainModel): GuardSite[] {
  const out: GuardSite[] = [];
  for (const a of m.aggregates as AggregateDef[]) {
    const machine = a.machine;
    if (!machine) continue;
    for (const r of machine.regions) {
      const unguarded = machine.transitions.filter((t: TransitionDef) => t.region === r.name && !t.requires);
      const reached = new Set<string>([r.initial]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of unguarded) {
          if (t.from.some(f => reached.has(f)) && !reached.has(t.to)) { reached.add(t.to); grew = true; }
        }
      }
      for (const st of r.states) if (!reached.has(st.name)) out.push({ owner: a.name, region: r.name, state: st.name });
    }
  }
  return out;
}
