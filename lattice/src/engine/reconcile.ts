import type { DomainModel } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { LedgerEntry } from './session.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';
import { impliedInvariants, canonicalCandidate } from './implied.js';
import { renameEntries, resolveWitness, applyRenamesToModel, applyRenamesToInvariant,
  type RenameSpec } from './renames.js';
import { diffModels } from '../parse/diff.js';

export interface ReconcileInput {
  parsed: { model: DomainModel; invariants: CandidateInvariant[] };
  storedModel: DomainModel;
  storedExplicit: CandidateInvariant[];
  ledger: LedgerEntry[];
  confirmedRenames: RenameSpec[];
  forceRemove: string[];
  at: string;
}
export interface Refusal {
  code: 'needs-rename-confirmation' | 'needs-force-remove' | 'contradicts-verdict' | 'template-only-kind'
    | 'unmatched-rename-confirmation';
  message: string; invariant?: string; witnessId?: string; verdict?: 'permit' | 'forbid'; judgedAt?: string;
  rename?: RenameSpec;
}
export type ReconcileOutcome =
  | { ok: true; model: DomainModel; adopted: CandidateInvariant[]; ledgerAppends: LedgerEntry[];
      applied: string[]; warnings: string[] }
  | { ok: false; refusals: Refusal[]; warnings: string[] };

const cjson = (v: unknown) => canonicalCandidate(v);   // key-order-insensitive (review follow-up)
/** explicit ∪ implied under DERIVED names: explicit entries whose candidate matches an implied
 *  rule are replaced by the derived-name version. Without this, the pre-migration session (whose
 *  state.json still lists the 13 template invariants under old names) would diff as 13 renames
 *  on every apply. Ledger adopted entries keep the old names — explain still finds them. */
function canonicalSet(model: DomainModel, explicit: CandidateInvariant[]): CandidateInvariant[] {
  const derived = impliedInvariants(model);
  const derivedShapes = new Set(derived.map(d => cjson(d.candidate)));
  return [...explicit.filter(i => !derivedShapes.has(cjson(i.candidate))), ...derived];
}

export function reconcile(input: ReconcileInput): ReconcileOutcome {
  const { parsed, storedModel, storedExplicit, ledger, confirmedRenames, forceRemove, at } = input;
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const appends: LedgerEntry[] = [];
  const applied: string[] = [];

  const after = { model: parsed.model, canonical: canonicalSet(parsed.model, parsed.invariants) };

  // detection diff on the RAW stored side — this is where rename proposals come from
  const rawBefore = { model: storedModel, canonical: canonicalSet(storedModel, storedExplicit) };
  const detection = diffModels(rawBefore, after, ledger, storedModel);
  const confirmedKey = new Set(confirmedRenames.map(r => `${r.scope}|${r.from}|${r.to}`));
  for (const p of detection.renameProposals) {
    if (confirmedKey.has(`${p.scope}|${p.from}|${p.to}`)) continue;
    refusals.push({ code: 'needs-rename-confirmation', rename: p,
      message: `'${p.from}' → '${p.to}' looks like a rename of ledger-referenced ${p.scope} ${p.path}; ` +
        `confirm with --rename ${p.path}=${p.to} (or --force-remove if it is really a delete+add)` });
  }
  // a confirmation matching NO detected proposal is not a rename at all — appending it would
  // silently rewrite historical witnesses (resolveWitness) and poison all future replay
  const detectedKey = new Set(detection.renameProposals.map(p => `${p.scope}|${p.path}|${p.from}|${p.to}`));
  const unmatchedRenames = confirmedRenames.filter(r => !detectedKey.has(`${r.scope}|${r.path}|${r.from}|${r.to}`));
  for (const r of unmatchedRenames) {
    refusals.push({ code: 'unmatched-rename-confirmation', rename: r,
      message: `--rename ${r.path}=${r.to} does not correspond to any detected rename in this edit — ` +
        `remove the flag or re-check the edit` });
  }
  // only MATCHED confirmations get ledgered — an unmatched one is refused above, never applied
  const matchedRenames = confirmedRenames.filter(r => !unmatchedRenames.includes(r));
  for (const r of matchedRenames)
    appends.push({ kind: 'rename', at, scope: r.scope, path: r.path, from: r.from, to: r.to });

  // normalization: renames are name changes, not semantic edits (spec §5.5 as amended) —
  // apply confirmed (MATCHED only) renames to the stored side, then diff again for the real change set
  const normModel = applyRenamesToModel(storedModel, matchedRenames);
  const normExplicit = storedExplicit.map(i => applyRenamesToInvariant(i, matchedRenames));
  const before = { model: normModel, canonical: canonicalSet(normModel, normExplicit) };
  const diff = diffModels(before, after, ledger, storedModel);

  // removals (spec §5.6) — tag edits surface here as removed implied invariants
  for (const rem of diff.removedInvariants) {
    if (forceRemove.includes(rem.name)) {
      appends.push({ kind: 'declined', at, invariant: rem, reason: 'hand-removed via --force-remove' });
      applied.push(`removed invariant ${rem.name}`);
    } else {
      refusals.push({ code: 'needs-force-remove', invariant: rem.name,
        message: `invariant ${rem.name} is ledger-backed; removing it overrules the record — acknowledge with --force-remove ${rem.name}` });
    }
  }

  // template-only kinds (spec §3.2)
  for (const add of diff.addedInvariants.filter(i => i.candidate.kind === 'leadsTo')) {
    refusals.push({ code: 'template-only-kind', invariant: add.name,
      message: `invariant ${add.name}: 'leads to' invariants are template-instantiated only (slice-1 §6.1); they cannot be hand-written` });
  }

  // verdict replay (spec §5.5, asymmetric + delta rule)
  const allRenames = [...renameEntries(ledger), ...matchedRenames];
  const verdicts = ledger.filter(e => e.kind === 'verdict') as Extract<LedgerEntry, { kind: 'verdict' }>[];
  const judgeable = (i: CandidateInvariant) => i.candidate.kind !== 'leadsTo';
  const changedOrAdded = [...diff.addedInvariants, ...diff.changedInvariants.map(c => c.after)].filter(judgeable);
  for (const v of verdicts) {
    const w: CaseState = resolveWitness(v.witness, allRenames, parsed.model);
    if (v.judge === 'permit') {
      const refused = new Set<string>();
      // delta rule: refuse only forbids INTRODUCED by this edit
      for (const inv of diff.addedInvariants.filter(judgeable))
        if (evaluateCandidate(inv.candidate, w) === 'forbid') {
          refused.add(inv.name);
          refusals.push({ code: 'contradicts-verdict', invariant: inv.name, witnessId: v.witnessId,
            verdict: 'permit', judgedAt: v.at,
            message: `invariant ${inv.name} forbids the state in ${v.witnessId}, judged permit on ${v.at.slice(0, 10)} — re-judge with the domain expert or revert` });
        }
      for (const ch of diff.changedInvariants.filter(c => judgeable(c.after)))
        if (evaluateCandidate(ch.before.candidate, w) === 'permit'
            && evaluateCandidate(ch.after.candidate, w) === 'forbid') {
          refused.add(ch.name);
          refusals.push({ code: 'contradicts-verdict', invariant: ch.name, witnessId: v.witnessId,
            verdict: 'permit', judgedAt: v.at,
            message: `invariant ${ch.name} now forbids the state in ${v.witnessId}, judged permit on ${v.at.slice(0, 10)} — re-judge with the domain expert or revert` });
        }
      for (const inv of after.canonical.filter(i => judgeable(i) && !refused.has(i.name)))
        if (evaluateCandidate(inv.candidate, w) === 'forbid')
          warnings.push(`baseline: ${inv.name} forbids ${v.witnessId} (judged permit) — pre-existing, not this edit`);
    } else {
      const forbids = (set: CandidateInvariant[]) =>
        set.some(i => judgeable(i) && evaluateCandidate(i.candidate, w) === 'forbid');
      if (forbids(before.canonical) && !forbids(after.canonical))
        refusals.push({ code: 'contradicts-verdict', witnessId: v.witnessId, verdict: 'forbid', judgedAt: v.at,
          message: `this edit permits the state in ${v.witnessId}, judged forbid on ${v.at.slice(0, 10)} — re-judge with the domain expert or revert` });
    }
  }

  if (refusals.length) return { ok: false, refusals, warnings };

  // adoption records for added/changed invariants (spec §5.5)
  const wids = verdicts.map(v => v.witnessId).join(', ');
  const storedByName = new Map(normExplicit.map(i => [i.name, i]));
  const adopted = parsed.invariants.map(i => {
    const prev = storedByName.get(i.name);
    return prev ? { ...i, id: prev.id, prior: prev.prior, source: prev.source } : i;
  });
  for (const inv of changedOrAdded) {
    const final = adopted.find(a => a.name === inv.name) ?? inv;
    // structure-implied additions (spec §3.4) are derived, not hand-authored — they get NO
    // adoption ceremony in the ledger, even though verdict replay above still covers them
    // (they can introduce forbidders just like any other invariant).
    if (final.id.startsWith('implied-')) {
      applied.push(`implied invariant ${inv.name} (derived from structure)`);
      continue;
    }
    appends.push({ kind: 'adopted', at, invariant: final,
      provenance: `hand-edited ${at.slice(0, 10)}, consistent with ${wids || 'no judged cases'}` });
    applied.push(`invariant ${inv.name}`);
  }
  applied.push(...diff.structuralNotes, ...matchedRenames.map(r => `renamed ${r.scope} ${r.path} → ${r.to}`));
  return { ok: true, model: parsed.model, adopted, ledgerAppends: appends, applied, warnings };
}
