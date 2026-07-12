import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { DomainModel } from '../ast/domain.js';
import type { CaseState } from './evaluate.js';

export interface SalientFact { dim: string; value: string | number | boolean }
export type CandidateStatus = 'active' | 'pruned' | 'merged' | 'refuted' | 'adopted' | 'parked';
export type Phase = 'structure' | 'distinguish' | 'probe-forbid' | 'probe-permit' | 'alternatives' | 'regenerate' | 'converged';
export interface TrackedCandidate { inv: CandidateInvariant; status: CandidateStatus; mergedInto?: string }
export interface PendingWitness { witness: CaseState; purpose: 'distinguish' | 'probe-forbid' | 'probe-permit'; pair?: [string, string]; salient: SalientFact[] }
export interface SessionState {
  model: DomainModel | null;
  candidates: TrackedCandidate[];
  phase: Phase;
  regenAttempts: number;
  alternativeAttempts: number;
  probesAsked: { forbid: boolean; permit: boolean };
  pendingWitnesses: Record<string, PendingWitness>;
  witnessSeq: number;   // monotonic witness-id counter — never reused, unlike ledger+pending counts
}
export type LedgerEntry =
  | { kind: 'verdict'; at: string; witnessId: string; witness: CaseState; salient: SalientFact[]; judge: 'permit' | 'forbid'; question: string }
  | { kind: 'open-decision'; at: string; topic: string; note: string; witnessId?: string; salient?: SalientFact[]; witness?: CaseState }
  | { kind: 'adopted'; at: string; invariant: CandidateInvariant; provenance: string }
  | { kind: 'declined'; at: string; invariant: CandidateInvariant; reason: string }
  | { kind: 'structure'; at: string; question: string; answer: string }
  | { kind: 'rename'; at: string; scope: import('./renames.js').RenameScope; path: string; from: string; to: string }
  | { kind: 'classified'; at: string; invariant: string; conjunct?: string;
      verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';
      tier: 'sound' | 'abstract'; caveat?: string;
      witness?: CaseState; reachable?: boolean; pinnedBy?: string[]; provenance: string };

/** Calendar day of an ISO timestamp — the human-facing date in provenance and refusal text. */
export const isoDay = (at: string): string => at.slice(0, 10);

export function newSession(): SessionState {
  return { model: null, candidates: [], phase: 'structure', regenAttempts: 0, alternativeAttempts: 0,
    probesAsked: { forbid: false, permit: false }, pendingWitnesses: {}, witnessSeq: 0 };
}
const stateFile = (dir: string) => join(dir, 'state.json');
const ledgerFile = (dir: string) => join(dir, 'ledger.jsonl');

export function loadState(dir: string): SessionState {
  if (!existsSync(stateFile(dir))) return newSession();
  const s = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  if (typeof s.witnessSeq !== 'number') s.witnessSeq = 0;   // old sessions predate the counter
  return s;
}
export function saveState(dir: string, s: SessionState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(dir), JSON.stringify(s, null, 2));
}
export function appendLedger(dir: string, e: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(ledgerFile(dir), JSON.stringify(e) + '\n');
}
export function readLedger(dir: string): LedgerEntry[] {
  if (!existsSync(ledgerFile(dir))) return [];
  return readFileSync(ledgerFile(dir), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
export function readClassifications(dir: string): Extract<LedgerEntry, { kind: 'classified' }>[] {
  return readLedger(dir).filter((e): e is Extract<LedgerEntry, { kind: 'classified' }> => e.kind === 'classified');
}
