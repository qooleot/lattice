import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';

/** Does this verdict ANCHOR this candidate? Anchoring is what adoption provenance may cite, what
 *  rescues a lone survivor from unanchored-survivor parking, and what counts as permit evidence —
 *  three call sites, one meaning (the review that motivated this found all three had drifted).
 *  Three clauses: (1) the witness must contain at least one instance of the candidate's aggregate
 *  — evaluateCandidate is vacuously 'permit' on a witness with zero subjects, and a vacuous permit
 *  is not evidence; this filter is unconditional. (2) A verdict judged at-or-after the candidate's
 *  registration anchors outright; missing registeredAt (pre-upgrade trackers persisted in
 *  state.json) waives the time filter. (3) A pre-registration verdict anchors by AGREEMENT only,
 *  and only for a candidate whose SOURCE is 'regen' or 'alternative' — see the inline comment
 *  below. */
export function anchorsCandidate(
  v: { at: string; judge: 'permit' | 'forbid'; witness: CaseState },
  c: Candidate, registeredAt?: string, source?: CandidateInvariant['source'],
): boolean {
  if (!v.witness.entities.some(e => e.type === c.aggregate)) return false;
  if (!registeredAt || v.at >= registeredAt) return true;   // ISO-8601 strings order lexically
  // A verdict judged BEFORE this candidate existed can still anchor it — by AGREEMENT only: the
  // candidate must rule the witness the same way the human did. This is the regeneration path's
  // guarantee (golden trace A is the canonical case: H3 is authored FROM the verdicts that pruned
  // its predecessors and converges with no further questions) — but that guarantee comes from a
  // specific admission check, not from agreement alone: admit() (hypothesis.ts) runs
  // ledgerConflicts against the WHOLE ledger before accepting a regen/alternative candidate, so
  // its agreement with a pre-registration verdict is proven, not coincidental. A cold-proposed
  // seed/template candidate (registerCandidates(), the `propose`/`init` path) never passes through
  // that check — it can agree with an old verdict purely by chance, and that verdict was never
  // drawn adversarially against it. Gate the arm on source accordingly.
  if (source !== 'regen' && source !== 'alternative') return false;
  return evaluateCandidate(c, v.witness) === v.judge;
}
