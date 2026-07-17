import { readFileSync } from 'node:fs';
import { loadState, readLedger } from '../engine/session.js';
import type { LedgerEntry } from '../engine/session.js';
import { loadLatText } from '../parse/fromLangium.js';
import type { ParseDiagnostic } from '../parse/parse.js';
import { rehydrateIds } from '../engine/reconcile.js';
import { derivedNameCollisions } from '../engine/implied.js';
import type { Diagnostic } from '../ast/invariant.js';
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

/** Thrown by loadGenInputFromLat when the spec parses fine but its DERIVED invariant names collide.
 *  A sibling of LatParseFailure rather than a reuse of it: the file parsed, so there are no
 *  ParseDiagnostics to carry — no line/col to point at — and calling a collision 'parse-failed'
 *  would report one condition under two codes depending on which door it came through. These are
 *  `Diagnostic`s, and cli.ts maps this to the same `{ error: 'ill-formed-model', diagnostics }`
 *  shape `init` and `apply` already return for exactly this condition. */
export class LatModelInvalid extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(`spec.lat is ill-formed: ${diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')}`);
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

  // The derived-name gate for the THIRD door a model enters the engine by. `init` gates the --model
  // JSON, `apply` gates the .lat, and this — `generate --spec` — reaches impliedInvariants with no
  // gate at all: plan.ts's canonicalSet -> reconcile.ts's impliedInvariants. loadLatText's own
  // validateModel does not include the check (it is a claim about DERIVED names, not the model's
  // well-formedness), so without this line a colliding spec generates clean.
  //
  // This door is the one that most needs it. init and apply produce a session and a prose
  // projection; `generate` emits runtime CHECK CODE — a shipped artifact carrying one check where
  // two distinct rules were meant, with nothing downstream to notice. The guard's own docstring
  // argues that silently shadowing a rule is the worst available outcome; leaving the code-emitting
  // door open was the sharpest instance of exactly that.
  const collisions = derivedNameCollisions(model);
  if (collisions.length) throw new LatModelInvalid(collisions);

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
