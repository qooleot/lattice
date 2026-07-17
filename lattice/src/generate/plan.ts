import type { GenInput } from './types.js';
import type { AggregateDef, EventDef, Field, Region, TransitionDef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';
import { canonicalSet, declinedShapes } from '../engine/reconcile.js';

export interface Anchors { specElement: string; provenance: string[]; witnessIds: string[]; }
export interface PlanInvariant { name: string; doc?: string; candidate: Candidate; aggregate: string; anchors: Anchors; }
export interface PlanTransition { name: string; region: string; from: string[]; to: string; requires?: Predicate; emits?: string; anchors: Anchors; }
export interface PlanAggregate { name: string; fields: Field[]; regions: Region[]; transitions: PlanTransition[]; invariants: PlanInvariant[]; doc?: string; }
export interface GenPlan { context: string; aggregates: PlanAggregate[]; events: EventDef[]; }

function invariantAnchors(name: string, id: string, ledger: LedgerEntry[]): Anchors {
  // Match the ledger 'adopted' entry by the invariant's stable id, not its (possibly renamed)
  // name — invariant names can change during elicitation while the id stays fixed, and matching
  // by name would silently drop real provenance for any renamed invariant.
  const provenance = ledger.filter((e): e is Extract<LedgerEntry, { kind: 'adopted' }> =>
    e.kind === 'adopted' && e.invariant.id === id).map(e => e.provenance);
  // verdict entries do not name the candidate directly; a verdict anchors an invariant when the
  // invariant's aggregate appears in the witness. Conservative attach: witnesses whose entities
  // include this invariant's aggregate. (Refine only if the differential test needs tighter scoping.)
  return { specElement: `invariant ${name}`, provenance, witnessIds: [] };
}

export function buildPlan(input: GenInput): GenPlan {
  const { model, adopted, ledger } = input;
  // explicit ∪ implied at the single generation gate: derived-class invariants (Money
  // non-negativity, terminal, refsResolve, value laws) are implied by the model and never stored
  // in post-migration sessions nor printed in .lat — without this union, generated services
  // enforced NO derived invariant (found live by the pipeline-from-scratch test: a negative
  // Money balance committed cleanly). Renderers still compile only the kinds they support
  // (statePredicate rows, unique tables); implied entries of other kinds pass through harmlessly.
  // Implied entries of kinds the v1 compiler doesn't support (terminal, refsResolve — the
  // documented design-§5 boundary) are excluded here rather than failing compileInvariantCheck
  // loud: they are auto-derived, not user-adopted, so silently-not-enforced is the recorded v1
  // scope, while an EXPLICITLY adopted unsupported kind still fails loud downstream by design.
  const GEN_COMPILABLE = new Set(['statePredicate', 'unique']);
  // declinedShapes: a derived rule whose latest ledger word is 'declined' must stay out of the
  // generated service's checks too — this is the third re-derivation site alongside reconcile's
  // replay sets and the prose projection. Ledger-less .lat loads synthesize adopted-only entries
  // (load.ts), so the declined set is empty there and every derived rule is enforced, as before.
  const canonical = canonicalSet(model, adopted, declinedShapes(ledger))
    .filter(i => !i.id.startsWith('implied-') || GEN_COMPILABLE.has(i.candidate.kind));
  const byAgg = (agg: string): CandidateInvariant[] => canonical.filter(i => i.candidate.aggregate === agg);
  const verdicts = ledger.filter((e): e is Extract<LedgerEntry, { kind: 'verdict' }> => e.kind === 'verdict');

  const aggregates: PlanAggregate[] = model.aggregates.map((a: AggregateDef) => {
    const regions = a.machine?.regions ?? [];
    const transitions: PlanTransition[] = (a.machine?.transitions ?? []).map((t: TransitionDef) => ({
      name: t.name, region: t.region, from: t.from, to: t.to, requires: t.requires, emits: t.emits,
      anchors: { specElement: `transition ${t.name}`, provenance: [], witnessIds: [] },
    }));
    const invariants: PlanInvariant[] = byAgg(a.name).map(i => {
      const anchors = invariantAnchors(i.name, i.id, ledger);
      // attach witnessIds whose witness touches this aggregate
      anchors.witnessIds = verdicts
        .filter(v => v.witness.entities.some(e => e.type === a.name))
        .map(v => v.witnessId);
      return { name: i.name, doc: i.doc, candidate: i.candidate, aggregate: a.name, anchors };
    });
    return { name: a.name, fields: a.fields, regions, transitions, invariants, doc: a.doc };
  });

  return { context: model.context, aggregates, events: model.events };
}
