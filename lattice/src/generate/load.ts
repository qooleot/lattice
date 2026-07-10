import { loadState, readLedger } from '../engine/session.js';
import type { DomainModel } from '../ast/domain.js';
import type { GenInput } from './types.js';

// Loader seam: today the session store; after slice 3 a parse(spec.lat) variant yields the same GenInput.
export function loadGenInput(dir: string): GenInput {
  const s = loadState(dir);
  if (!s.model) throw new Error(`no model in session at ${dir}`);
  const adopted = s.candidates.filter(c => c.status === 'adopted').map(c => c.inv);
  return { model: s.model as DomainModel, adopted, ledger: readLedger(dir) };
}
