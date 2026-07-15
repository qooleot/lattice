// Tier 1 conformance check (spec plan §4): evaluate every PlanInvariant over the observed
// entities and, on a 'forbid' verdict, pin the offending row ids by re-evaluating against
// single-subject slices (the subject plus every other-aggregate entity, so ref-hops still
// resolve). Adopted guard-kind candidates are transition-enablement conditions (pre-state
// semantics, §8.1) — never always-properties — so Tier 1 skips them entirely; Tier 2 owns
// transition-shaped conformance.
import { evaluateCandidate, type CaseEntity } from '../engine/evaluate.js';
import type { GenPlan, PlanInvariant } from '../generate/plan.js';
import type { ConformViolation } from './types.js';

export interface OptOut { invariant: string; reason: string }

// Kinds whose 'forbid' verdict is a property of the whole subject set, not any single row —
// slicing down to one subject at a time would misreport the violation as row-scoped when it
// isn't (a duplicate key or an over-count needs at least two rows to exist at all).
const SET_LEVEL_KINDS = new Set(['unique', 'cardinality', 'sumOverCollection']);

function witnessesFor(inv: PlanInvariant, entities: CaseEntity[]): { ids: string[]; detail: string } {
  const subjects = entities.filter(e => e.type === inv.aggregate);
  if (SET_LEVEL_KINDS.has(inv.candidate.kind)) {
    return { ids: subjects.map(s => s.id), detail: 'set-level violation' };
  }
  const others = entities.filter(e => e.type !== inv.aggregate);
  const bad = subjects.filter(s =>
    evaluateCandidate(inv.candidate, { entities: [s, ...others] }) === 'forbid');
  return { ids: bad.map(b => b.id), detail: `violated by ${bad.length}/${subjects.length} ${inv.aggregate} row(s)` };
}

export function checkInvariants(entities: CaseEntity[], plan: GenPlan, optOuts: OptOut[],
  source: string): ConformViolation[] {
  const invariants = plan.aggregates.flatMap(a => a.invariants);
  const invariantNames = new Set(invariants.map(i => i.name));
  // Validate all opt-outs up front — a reasonless opt-out is a config error, not a per-invariant
  // concern, and must fail loudly before any evaluation happens. Same for a phantom opt-out
  // naming an invariant absent from the plan: it skips nothing, but the report still prints an
  // OPT-OUT line for it, giving false comfort — treat it as a config error too, not a silent cap.
  for (const o of optOuts) {
    if (!o.reason.trim()) throw new Error(`conform: opt-out for '${o.invariant}' requires a non-empty reason`);
    if (!invariantNames.has(o.invariant))
      throw new Error(`conform: opt-out names unknown invariant '${o.invariant}' — not in the plan`);
  }
  const skipped = new Set(optOuts.map(o => o.invariant));
  const out: ConformViolation[] = [];
  for (const inv of invariants) {
    if (skipped.has(inv.name)) continue;
    if (inv.candidate.kind === 'guard') continue; // pre-state transition-enablement — Tier 2, not Tier 1
    if (evaluateCandidate(inv.candidate, { entities }) === 'forbid') {
      const w = witnessesFor(inv, entities);
      out.push({
        invariant: inv.name,
        specElement: inv.anchors.specElement,
        anchors: [...inv.anchors.provenance, ...inv.anchors.witnessIds],
        witnessIds: w.ids,
        source,
        detail: w.detail,
      });
    }
  }
  return out;
}
