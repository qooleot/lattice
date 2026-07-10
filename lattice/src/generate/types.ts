import type { DomainModel } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';

export interface GenInput {
  model: DomainModel;
  adopted: CandidateInvariant[];
  ledger: LedgerEntry[];
}
