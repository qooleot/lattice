// Tier 2 (design §4.4): per observed row × machine region, decide whether the row's outbox
// events + observed final state correspond to a path the machine allows. Declared-emit
// transitions must align exactly with their events; silent transitions are free moves; a
// declared-emit transition can never fire silently. Guards (`requires`) need pre-state at event
// time, which passive mode does not observe — they are REPORTED as unevaluated, never silently
// claimed (no-silent-caps).
import type { CaseEntity } from '../engine/evaluate.js';
import type { PlanAggregate, PlanTransition } from '../generate/plan.js';
import type { Region } from '../ast/domain.js';
import type { ConformViolation } from './types.js';

export interface ObservedEvent { seq: number; eventType: string; aggregateId: string }
export interface TraceResult {
  violations: ConformViolation[];
  rowsChecked: number;
  guardedTransitions: string[];
}

interface Stuck { index: number; states: string[] } // furthest event index reached + states there

/** BFS over (state, consumedEvents). Returns null on acceptance, else the furthest-stuck frontier. */
function admits(region: Region, transitions: PlanTransition[], rowEvents: ObservedEvent[],
  finalState: string): Stuck | null {
  const n = rowEvents.length;
  const seen = new Set<string>();
  let frontier: [string, number][] = [[region.initial, 0]];
  seen.add(`${region.initial}|0`);
  let best: Stuck = { index: 0, states: [region.initial] };
  while (frontier.length > 0) {
    const next: [string, number][] = [];
    for (const [state, i] of frontier) {
      if (i === n && state === finalState) return null;
      if (i > best.index) best = { index: i, states: [state] };
      else if (i === best.index && !best.states.includes(state)) best.states.push(state);
      for (const t of transitions) {
        if (!t.from.includes(state)) continue;
        const move: [string, number] | null =
          t.emits === undefined ? [t.to, i]
          : (i < n && rowEvents[i]!.eventType === t.emits) ? [t.to, i + 1]
          : null;
        if (!move) continue;
        const key = `${move[0]}|${move[1]}`;
        if (!seen.has(key)) { seen.add(key); next.push(move); }
      }
    }
    frontier = next;
  }
  return best;
}

export function checkTraces(entities: CaseEntity[], events: ObservedEvent[],
  aggregates: PlanAggregate[], source: string): TraceResult {
  const violations: ConformViolation[] = [];
  const byId = new Map(entities.map(e => [e.id, e]));
  const aggByName = new Map(aggregates.map(a => [a.name, a]));

  // Orphan events: an outbox row whose aggregate never made it into observed state — the
  // canonical emit-outside-transaction symptom (the insert rolled back, the event survived).
  for (const e of events) {
    if (!byId.has(e.aggregateId)) {
      violations.push({
        invariant: '', specElement: 'outbox', anchors: ['spec:outbox (design §13: events commit atomically with state)'],
        witnessIds: [e.aggregateId], source,
        detail: `orphan event: ${e.eventType} (outbox seq ${e.seq}) references aggregate '${e.aggregateId}' which is not present in observed state`,
      });
    }
  }

  let rowsChecked = 0;
  const guarded = new Set<string>();
  for (const entity of entities) {
    const agg = aggByName.get(entity.type);
    if (!agg || agg.regions.length === 0) continue;
    rowsChecked++;
    const rowEvents = events.filter(e => e.aggregateId === entity.id).sort((a, b) => a.seq - b.seq);

    // Undeclared events: type not declared by any transition of any region of this aggregate.
    const declared = new Set(agg.transitions.map(t => t.emits).filter((x): x is string => !!x));
    for (const e of rowEvents) {
      if (!declared.has(e.eventType)) {
        violations.push({
          invariant: '', specElement: `event ${e.eventType}`,
          anchors: [`spec:machine ${agg.name}`], witnessIds: [entity.id], source,
          detail: `undeclared event: ${agg.name} '${entity.id}' emitted ${e.eventType} (outbox seq ${e.seq}), which no transition of ${agg.name} declares`,
        });
      }
    }

    for (const region of agg.regions) {
      const regionTransitions = agg.transitions.filter(t => t.region === region.name);
      for (const t of regionTransitions) if (t.requires) guarded.add(t.name);
      const regionEmits = new Set(regionTransitions.map(t => t.emits).filter((x): x is string => !!x));
      const regionEvents = rowEvents.filter(e => regionEmits.has(e.eventType));
      const finalState = entity.fields[`${region.name}.state`];
      if (typeof finalState !== 'string') {
        violations.push({
          invariant: '', specElement: `machine ${agg.name}.${region.name}`,
          anchors: [`spec:machine ${agg.name}.${region.name}`], witnessIds: [entity.id], source,
          detail: `observed state missing: field '${region.name}.state' absent on ${agg.name} '${entity.id}'`,
        });
        continue;
      }
      const stuck = admits(region, regionTransitions, regionEvents, finalState);
      if (stuck !== null) {
        const atEvent = stuck.index < regionEvents.length
          ? `stuck at event #${stuck.index + 1} (${regionEvents[stuck.index]!.eventType}, outbox seq ${regionEvents[stuck.index]!.seq}) from state(s) {${stuck.states.join(', ')}}`
          : `all ${regionEvents.length} event(s) consumed, reachable state(s) {${stuck.states.join(', ')}} do not include observed final '${finalState}'`;
        violations.push({
          invariant: '', specElement: `machine ${agg.name}.${region.name}`,
          anchors: regionTransitions.flatMap(t => t.anchors.provenance.length ? t.anchors.provenance : [t.anchors.specElement]),
          witnessIds: [entity.id], source,
          detail: `no legal path: ${agg.name} '${entity.id}' region '${region.name}' — ${atEvent}; events=[${regionEvents.map(e => e.eventType).join(', ')}]`,
        });
      }
    }
  }
  return { violations, rowsChecked, guardedTransitions: [...guarded].sort() };
}
