import { readFileSync } from 'node:fs';
import { loadState, readLedger } from '../engine/session.js';
import type { LedgerEntry } from '../engine/session.js';
import { loadLatText } from '../parse/fromLangium.js';
import type { ParseDiagnostic } from '../parse/parse.js';
import { rehydrateIds } from '../engine/reconcile.js';
import type { DomainModel } from '../ast/domain.js';
import type { GenInput } from './types.js';

// Loader seam: today the session store; after slice 3 a parse(spec.lat) variant yields the same GenInput.
export function loadGenInput(dir: string): GenInput {
  const s = loadState(dir);
  if (!s.model) throw new Error(`no model in session at ${dir}`);
  const adopted = s.candidates.filter(c => c.status === 'adopted').map(c => c.inv);
  return { model: s.model as DomainModel, adopted, ledger: readLedger(dir) };
}

/** Thrown by loadGenInputFromLat on a parse failure — carries the parser's structured diagnostics
 *  rather than collapsing to a bare message string, so a caller (cli.ts's `generate` command) can
 *  surface the same `{ error: 'parse-failed', diagnostics }` shape `apply`/`sync` already use,
 *  instead of falling through to the generic internal-error catch-all. */
export class LatParseFailure extends Error {
  readonly diagnostics: ParseDiagnostic[];
  constructor(diagnostics: ParseDiagnostic[]) {
    super(`spec.lat parse failed: ${diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')}`);
    this.diagnostics = diagnostics;
  }
}

// .lat-canonical variant of loadGenInput (slice-3 seam, closed): the model and invariants come
// straight from parsing spec.lat, not the session store. Anchors/provenance still need a ledger —
// when `ledgerDir` names a session, the freshly-parsed invariants (which carry no stable id of
// their own) are rehydrated to that session's ids by name via rehydrateIds, the same by-name
// lookup `apply`/reconcile.ts uses to reattach identity after a hand edit. That lets plan.ts's
// existing id-keyed ledger lookup (invariantAnchors) resolve the real provenance chain unchanged
// — no anchor logic is duplicated here. With no ledger there is nothing to anchor to: a synthetic
// one-entry-per-invariant ledger supplies the honest `from .lat (no ledger)` provenance text
// through that same unchanged lookup, rather than silently reporting 'none'.
export function loadGenInputFromLat(specLatPath: string, ledgerDir?: string): GenInput {
  const text = readFileSync(specLatPath, 'utf8');
  const loaded = loadLatText(text);
  if (!loaded.ok) throw new LatParseFailure(loaded.diagnostics);
  const { model, invariants } = loaded;

  if (ledgerDir) {
    const stored = loadState(ledgerDir).candidates.filter(c => c.status === 'adopted').map(c => c.inv);
    const adopted = rehydrateIds(invariants, stored);
    return { model, adopted, ledger: readLedger(ledgerDir) };
  }

  const noLedgerAt = new Date(0).toISOString();
  const ledger: LedgerEntry[] = invariants.map(invariant =>
    ({ kind: 'adopted', at: noLedgerAt, invariant, provenance: 'from .lat (no ledger)' }));
  return { model, adopted: invariants, ledger };
}
