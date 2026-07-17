import type { Candidate } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';

/** Does this verdict ANCHOR this candidate? Anchoring is what adoption provenance may cite, what
 *  rescues a lone survivor from unanchored-survivor parking, and what counts as permit evidence —
 *  three call sites, one meaning (the review that motivated this found all three had drifted).
 *  A verdict anchors iff (a) it was judged at-or-after the candidate was registered — a candidate
 *  proposed after a verdict cannot have been vetted by it — and (b) its witness contains at least
 *  one instance of the candidate's aggregate: evaluateCandidate is vacuously 'permit' on a witness
 *  with zero subjects, and a vacuous permit is not evidence. Missing registeredAt (pre-upgrade
 *  trackers persisted in state.json) waives the time filter only. */
export function anchorsCandidate(
  v: { at: string; judge: 'permit' | 'forbid'; witness: CaseState },
  c: Candidate, registeredAt?: string,
): boolean {
  if (registeredAt && v.at < registeredAt) return false;   // ISO-8601 strings order lexically
  return v.witness.entities.some(e => e.type === c.aggregate);
}
