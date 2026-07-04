import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import type { DomainModel } from '../ast/domain.js';
import { validateCandidate } from '../ast/grammar.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';
import type { LedgerEntry, SessionState, TrackedCandidate } from './session.js';

export function registerCandidates(s: SessionState, invs: CandidateInvariant[]): void {
  for (const inv of invs) s.candidates.push({ inv, status: 'active' });
}
export const activeCandidates = (s: SessionState): TrackedCandidate[] =>
  s.candidates.filter(c => c.status === 'active');

export function pruneOnVerdict(s: SessionState, witness: CaseState, judge: 'permit' | 'forbid'): { pruned: string[]; empty: boolean } {
  const pruned: string[] = [];
  for (const c of activeCandidates(s)) {
    if (evaluateCandidate(c.inv.candidate, witness) !== judge) { c.status = 'pruned'; pruned.push(c.inv.id); }
  }
  return { pruned, empty: activeCandidates(s).length === 0 };
}

export function ledgerConflicts(c: Candidate, ledger: LedgerEntry[]): string[] {
  return ledger.filter(e => e.kind === 'verdict' && evaluateCandidate(c, e.witness) !== e.judge)
    .map(e => (e as any).witnessId);
}

export function admit(s: SessionState, inv: CandidateInvariant, m: DomainModel, ledger: LedgerEntry[]): { ok: true } | { ok: false; reason: string } {
  if (inv.source === 'regen' && s.regenAttempts >= 3)
    return { ok: false, reason: 'regen cap (3) reached — park as open decision' };
  if (inv.source === 'alternative' && s.alternativeAttempts >= 2)
    return { ok: false, reason: 'alternatives exhausted — converged' };
  const bump = () => { if (inv.source === 'regen') s.regenAttempts++; else if (inv.source === 'alternative') s.alternativeAttempts++; };

  const gram = validateCandidate(inv.candidate, m);
  if (gram.length) { bump(); return { ok: false, reason: `out of grammar: ${gram.map(d => d.code).join(', ')}` }; }
  const conflicts = ledgerConflicts(inv.candidate, ledger);
  if (conflicts.length) { bump(); return { ok: false, reason: `contradicts verdicts: ${conflicts.join(', ')}` }; }
  bump();
  s.candidates.push({ inv, status: 'active' });
  return { ok: true };
}

export function markMerged(s: SessionState, loserId: string, winnerId: string): void {
  const c = s.candidates.find(x => x.inv.id === loserId);
  if (c) { c.status = 'merged'; c.mergedInto = winnerId; }
}
