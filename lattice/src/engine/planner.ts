import type { Candidate, Predicate, Term } from '../ast/invariant.js';
import type { DomainModel } from '../ast/domain.js';
import { routeCandidate } from '../ast/grammar.js';
import type { AlloyQuery } from '../emit/alloy.js';
import type { QuintQuery } from '../emit/quint.js';
import { evaluateCandidate, type CaseState } from './evaluate.js';
import { activeCandidates } from './hypothesis.js';
import { extractSalient, renderWitnessTable } from './salient.js';
import type { LedgerEntry, SalientFact, SessionState } from './session.js';

export interface SolverDeps {
  alloy(m: DomainModel, q: AlloyQuery, max: number): Promise<{ sat: boolean; instances: CaseState[]; ms: number }>;
  quint(m: DomainModel, q: QuintQuery): Promise<{ violated: boolean; witness?: CaseState; ms: number }>;
}
export type PlannerOutput =
  | { type: 'question'; witnessId: string; purpose: 'distinguish' | 'probe-forbid' | 'probe-permit'; pair?: [string, string]; witness: CaseState; table: string; salient: SalientFact[]; ms: number }
  | { type: 'probe-options'; purpose: 'probe-forbid' | 'probe-permit'; options: { witnessId: string; witness: CaseState; table: string; salient: SalientFact[] }[]; ms: number }
  | { type: 'merged'; loser: string; winner: string }
  | { type: 'need-alternatives'; attemptsLeft: number }
  | { type: 'regenerate'; attemptsLeft: number }
  | { type: 'parked'; reason: string }
  | { type: 'converged' };

const verdicts = (ledger: LedgerEntry[]) => ledger.filter(e => e.kind === 'verdict') as Extract<LedgerEntry, { kind: 'verdict' }>[];
const openDecisionsWithWitness = (ledger: LedgerEntry[]) =>
  ledger.filter(e => e.kind === 'open-decision' && e.witness !== undefined) as Extract<LedgerEntry, { kind: 'open-decision' }>[];
// Exclusions must be recomputed against the CURRENT query's candidates, not reused from the
// ledger's stored `salient` field: that field was extracted with respect to whichever candidates
// were active when the verdict was recorded, and can be missing dims (e.g. a finer-grained field
// like plan.family) that a later, different candidate pair cares about. Reusing the stale,
// coarser shape as an exclusion silently over-excludes — it can rule out the *only* witness that
// distinguishes the new pair, even though the human was never shown or asked about that specific
// combination. Rebuilding from the raw stored witness, scoped to the live candidates, keeps the
// exclusion exactly as specific as what was actually shown.
// An `undecided` verdict is parked, not judged permit/forbid — but the witness itself was already
// shown to the human and must never be re-asked (that's the whole point of parking it). So its raw
// witness participates in exclusions the SAME way a verdict's witness does: recomputed fresh
// against the live candidates from the stored raw witness, never trusting the entry's stale
// `salient` (extracted w.r.t. whatever candidates were live when it was parked).
const exclusionsFrom = (ledger: LedgerEntry[], cands: Candidate[]): SalientFact[][] =>
  [...verdicts(ledger).map(v => v.witness), ...openDecisionsWithWitness(ledger).map(e => e.witness!)]
    .map(w => extractSalient(cands, w)).filter(s => s.length > 0);
// Monotonic per-session counter — never recomputed from ledger+pending counts, which can repeat an
// id once verdicts are pruned/cleared (e.g. sibling pendings cleared on verdict) while old witness
// ids remain referenced in the ledger and in prior UI state.
const wid = (s: SessionState) => `w${++s.witnessSeq}`;

// Alloy's enumeration order is first-SAT-found, not minimality — an early instance can carry
// gratuitous extra atoms (e.g. an unconstrained relation gets distinct values it didn't need to)
// that make the witness harder for a human to read than necessary (kill criterion 1: witnesses
// must be intelligible). Sorting by entity count prefers the most minimal instance among those
// enumerated — a ground-truth-agnostic, general intelligibility improvement, not case-specific.
function byMinimalSize(witnesses: CaseState[]): CaseState[] {
  return [...witnesses].sort((a, b) => a.entities.length - b.entities.length);
}

// Every query must carry the session's already-ADOPTED invariants so the solver can't present a
// witness in a state the human has already ruled out (live bug: after adopting a `unique` on
// Invoice drafts, a quint distinguish for unrelated Subscription candidates returned two Draft
// invoices for one subscription — a faithful `forbid` would prune a correct live candidate,
// `permit` would contradict the adoption). Filtered per engine to what its emitter can express
// as a state constraint:
//  - quint: statePredicate/conservation/cardinality/unique. Trace-history kinds (terminal,
//    monotonic, leadsTo) are path properties a single-state constraint can't encode; refsResolve
//    mis-evaluates on quint's pool-drawn refs (see UNELICITABLE_KINDS in cli.ts).
//  - alloy: unique/cardinality, and statePredicates not mentioning `now` (termToAlloy's only hard
//    inexpressible). Note this is EXPRESSIBILITY, not routeCandidate's solving preference: an
//    arith `ge 0` statePredicate routes to quint as a query subject but is still a fine alloy
//    constraint. conservation stays quint-only (candidateToPred has no rendering for it).
export function expressibleAdopted(engine: 'alloy' | 'quint', adopted: Candidate[]): Candidate[] {
  const termHasNow = (t: Term): boolean => t.kind === 'now' || (t.kind === 'plus' && (termHasNow(t.left) || termHasNow(t.right)));
  const predHasNow = (p: Predicate): boolean => {
    switch (p.kind) {
      case 'cmp': return termHasNow(p.left) || termHasNow(p.right);
      case 'inState': return false;
      case 'and': case 'or': return p.args.some(predHasNow);
      case 'not': return predHasNow(p.arg);
      case 'implies': return predHasNow(p.left) || predHasNow(p.right);
    }
  };
  if (engine === 'quint') return adopted.filter(c => ['statePredicate', 'conservation', 'cardinality', 'unique'].includes(c.kind));
  return adopted.filter(c => c.kind === 'unique' || c.kind === 'cardinality' ||
    (c.kind === 'statePredicate' && !(c.where ? predHasNow(c.where) : false) && !predHasNow(c.body)));
}
export const adoptedConstraints = (s: SessionState): Candidate[] =>
  s.candidates.filter(c => c.status === 'adopted').map(c => c.inv.candidate);

async function solve(m: DomainModel, hi: Candidate, hj: Candidate | undefined,
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit', exclusions: SalientFact[][],
  allAdopted: Candidate[], deps: SolverDeps, max: number,
): Promise<{ witnesses: CaseState[]; ms: number }> {
  const engine = hj && routeCandidate(hj) === 'quint' ? 'quint' : routeCandidate(hi);
  const adopted = expressibleAdopted(engine, allAdopted);
  if (engine === 'alloy') {
    // Boundary probes first ask for a witness that also varies a domain field the candidate
    // itself ignores (see AlloyQuery.varyUnreferenced) — more thorough, but that extra
    // conjunct can occasionally be unsatisfiable on its own even though the plain probe isn't
    // (e.g. too few atoms at this scope). Falling back keeps the probe itself infallible; the
    // nudge is a best-effort quality improvement, never a correctness requirement.
    const isProbe = kind === 'probe-forbid' || kind === 'probe-permit';
    if (isProbe) {
      const r1 = await deps.alloy(m, { kind, hi, hj, exclusions, adopted, scope: 4, varyUnreferenced: true }, max);
      if (r1.sat) return { witnesses: byMinimalSize(r1.instances), ms: r1.ms };
      const r = await deps.alloy(m, { kind, hi, hj, exclusions, adopted, scope: 4 }, max);
      return { witnesses: r.sat ? byMinimalSize(r.instances) : [], ms: r1.ms + r.ms };
    }
    const r = await deps.alloy(m, { kind, hi, hj, exclusions, adopted, scope: 4 }, max);
    return { witnesses: r.sat ? byMinimalSize(r.instances) : [], ms: r.ms };
  }
  const r = await deps.quint(m, { kind, hi, hj, exclusions, adopted, maxSteps: 10 });
  return { witnesses: r.violated && r.witness ? [r.witness] : [], ms: r.ms };
}

export async function checkDistinct(survivor: Candidate, alt: Candidate, m: DomainModel, deps: SolverDeps, adopted: Candidate[] = []): Promise<boolean> {
  const { witnesses } = await solve(m, survivor, alt, 'distinguish', [], adopted, deps, 1);
  return witnesses.length > 0;
}

export async function nextQuestion(s: SessionState, ledger: LedgerEntry[], m: DomainModel, deps: SolverDeps): Promise<PlannerOutput> {
  const active = () => activeCandidates(s);
  const adopted = adoptedConstraints(s);

  // 1. Distinguish highest-combined-prior separable pair
  while (active().length >= 2) {
    const sorted = [...active()].sort((a, b) => b.inv.prior - a.inv.prior);
    let advanced = false;
    for (let i = 0; i < sorted.length && !advanced; i++) for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i]!, sorted[j]!];
      const exclusions = exclusionsFrom(ledger, [a.inv.candidate, b.inv.candidate]);
      const { witnesses, ms } = await solve(m, a.inv.candidate, b.inv.candidate, 'distinguish', exclusions, adopted, deps, 5);
      if (witnesses.length === 0) {                          // equivalent over scope ⇒ merge, never ask
        const [win, lose] = a.inv.prior >= b.inv.prior ? [a, b] : [b, a];
        lose.status = 'merged'; lose.mergedInto = win.inv.id;
        return { type: 'merged', loser: lose.inv.id, winner: win.inv.id };
      }
      const witness = witnesses[0]!;
      const salient = extractSalient(active().map(c => c.inv.candidate), witness);
      const witnessId = wid(s);
      s.pendingWitnesses[witnessId] = { witness, purpose: 'distinguish', pair: [a.inv.id, b.inv.id], salient };
      s.phase = 'distinguish';
      return { type: 'question', witnessId, purpose: 'distinguish', pair: [a.inv.id, b.inv.id], witness, salient,
        table: renderWitnessTable(witness, m.ticksPerDay), ms };
    }
    if (!advanced) break;
  }

  // 5. Empty space → regenerate (capped)
  if (active().length === 0) {
    if (s.regenAttempts >= 3) return { type: 'parked', reason: 'regen cap reached — record an open decision' };
    s.phase = 'regenerate';
    return { type: 'regenerate', attemptsLeft: 3 - s.regenAttempts };
  }

  // 2–3. Sole survivor: probes for a-priori candidates only
  const H = active()[0]!;
  const apriori = H.inv.source === 'seed' || H.inv.source === 'template';
  // Probes may reuse exclusions scoped to H alone (recomputed fresh from each raw stored witness
  // via exclusionsFrom, never the ledger's stale `salient` field extracted w.r.t. whichever OTHER
  // pair was live when it was recorded) ONLY for candidate kinds whose extractSalient extraction
  // captures ordering/arith dims, enum-eq dims, and (as of trace-B review) field-field eq/ne dims;
  // exclusion reuse is gated to statePredicate/conservation where the captured dims characterize
  // the violation region for slice-1 candidates. For those, if a witness already got a verdict that,
  // reprojected onto H alone, reproduces H's violation shape exactly, going tautologically UNSAT
  // on a later probe is correct: it means every way H can be violated has already been shown and
  // judged, so there is nothing new left to probe for.
  // `unique` candidates must NOT reuse exclusions this way (Task 17's masking bug): extractSalient
  // only records pairwise by-key equality booleans, never unconstrained domain fields (e.g.
  // plan.family) that a distinguish verdict's witness happened to leave fixed. Reprojecting that
  // verdict onto H alone reproduces a shape matching `not Hi` on the dims it happens to check, but
  // silently misses the dimension a real, still-outstanding refutation needs to vary — masking it
  // behind a tautological `Hi or shape0`, exactly the bug Task 17 fixed by using no exclusions.
  const probeExclusionsSafe = H.inv.candidate.kind === 'statePredicate' || H.inv.candidate.kind === 'conservation';
  if (apriori && !s.probesAsked.forbid) {
    const exclusions = probeExclusionsSafe ? exclusionsFrom(ledger, [H.inv.candidate]) : [];
    const { witnesses, ms } = await solve(m, H.inv.candidate, undefined, 'probe-forbid', exclusions, adopted, deps, 3);
    s.probesAsked.forbid = true;
    if (witnesses.length > 0) {
      s.phase = 'probe-forbid';
      const options = witnesses.map(w => {
        const salient = extractSalient([H.inv.candidate], w);
        const witnessId = wid(s);
        s.pendingWitnesses[witnessId] = { witness: w, purpose: 'probe-forbid', salient };
        return { witnessId, witness: w, table: renderWitnessTable(w, m.ticksPerDay), salient };
      });
      return { type: 'probe-options', purpose: 'probe-forbid', options, ms };
    }
  }
  const hasPermitEvidence = verdicts(ledger).some(v => v.judge === 'permit' && evaluateCandidate(H.inv.candidate, v.witness) === 'permit');
  if (apriori && !s.probesAsked.permit && !hasPermitEvidence) {
    const exclusions = probeExclusionsSafe ? exclusionsFrom(ledger, [H.inv.candidate]) : [];
    const { witnesses, ms } = await solve(m, H.inv.candidate, undefined, 'probe-permit', exclusions, adopted, deps, 3);
    s.probesAsked.permit = true;
    if (witnesses.length > 0) {
      s.phase = 'probe-permit';
      const options = witnesses.map(w => {
        const salient = extractSalient([H.inv.candidate], w);
        const witnessId = wid(s);
        s.pendingWitnesses[witnessId] = { witness: w, purpose: 'probe-permit', salient };
        return { witnessId, witness: w, table: renderWitnessTable(w, m.ticksPerDay), salient };
      });
      return { type: 'probe-options', purpose: 'probe-permit', options, ms };
    }
  }

  // 4. Alternatives phase → converged after 2 failed attempts
  if (s.alternativeAttempts >= 2) { s.phase = 'converged'; return { type: 'converged' }; }
  s.phase = 'alternatives';
  return { type: 'need-alternatives', attemptsLeft: 2 - s.alternativeAttempts };
}
