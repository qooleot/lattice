import type { GenInput } from './types.js';
import type { AggregateDef, EventDef, Field, Region, TransitionDef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';

export interface Anchors { specElement: string; provenance: string[]; witnessIds: string[]; }
export interface PlanInvariant { name: string; doc?: string; candidate: Candidate; aggregate: string; anchors: Anchors; }
export interface PlanTransition { name: string; region: string; from: string[]; to: string; requires?: Predicate; emits?: string; anchors: Anchors; }
export interface PlanAggregate { name: string; fields: Field[]; regions: Region[]; transitions: PlanTransition[]; invariants: PlanInvariant[]; doc?: string; }
export interface GenPlan { context: string; aggregates: PlanAggregate[]; events: EventDef[]; }

function invariantAnchors(name: string, ledger: LedgerEntry[]): Anchors {
  const provenance = ledger.filter((e): e is Extract<LedgerEntry, { kind: 'adopted' }> =>
    e.kind === 'adopted' && e.invariant.name === name).map(e => e.provenance);
  // verdict entries do not name the candidate directly; a verdict anchors an invariant when the
  // invariant's aggregate appears in the witness. Conservative attach: witnesses whose entities
  // include this invariant's aggregate. (Refine only if the differential test needs tighter scoping.)
  return { specElement: `invariant ${name}`, provenance, witnessIds: [] };
}

export function buildPlan(input: GenInput): GenPlan {
  const { model, adopted, ledger } = input;
  const byAgg = (agg: string): CandidateInvariant[] => adopted.filter(i => i.candidate.aggregate === agg);
  const verdicts = ledger.filter((e): e is Extract<LedgerEntry, { kind: 'verdict' }> => e.kind === 'verdict');

  const aggregates: PlanAggregate[] = model.aggregates.map((a: AggregateDef) => {
    const regions = a.machine?.regions ?? [];
    const transitions: PlanTransition[] = (a.machine?.transitions ?? []).map((t: TransitionDef) => ({
      name: t.name, region: t.region, from: t.from, to: t.to, requires: t.requires, emits: t.emits,
      anchors: { specElement: `transition ${t.name}`, provenance: [], witnessIds: [] },
    }));
    const invariants: PlanInvariant[] = byAgg(a.name).map(i => {
      const anchors = invariantAnchors(i.name, ledger);
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
