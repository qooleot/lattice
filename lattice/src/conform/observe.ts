// Conform observer (spec plan §4): projects bound rows + overrides into spec-shaped
// CaseEntity[] for evaluateCandidate. One CaseEntity per row per bound aggregate. A ref field
// carries the referenced row's key value (string) so the ref-hop in evaluate.ts's resolveValue
// (`entities.find(x => x.id === v)`) works unmodified. Total or loud: SQL NULL in a nullable
// ref field is the one legal absence (the field key is omitted) — whether the value comes from
// an auto-bound column read or an override function computing the same nullable foreign key
// (e.g. a semantic rename); every other NULL, and every override returning null/undefined for a
// non-ref field, is a hard error naming aggregate/field/row id — a lying projection must fail,
// not coerce (design drift class 6/11 depends on this).
import type Database from 'better-sqlite3';
import type { DomainModel } from '../ast/domain.js';
import type { CaseEntity } from '../engine/evaluate.js';
import type { AggregateBinding, BindingManifest, OverridesModule } from './types.js';

/** Project one already-fetched row into a spec-shaped CaseEntity per its binding. Shared by
 *  observeEntities (all rows, all aggregates) and observeScoped (one row + its ref closure) —
 *  behavior-identical between the two callers, see module doc above for the null/override/
 *  region-key rules this enforces. */
function projectRow(db: Database.Database, model: DomainModel, agg: AggregateBinding,
  row: Record<string, unknown>, overrides: OverridesModule): CaseEntity {
  const spec = model.aggregates.find(a => a.name === agg.aggregate)!;
  // Ref-typed spec fields are the only fields where a live SQL NULL is a legal absence
  // (an unset foreign key) rather than a lying projection — see module doc above.
  const nullableRefs = new Set(spec.fields.filter(f => f.type.kind === 'ref').map(f => f.name));
  // Region members (spec.machine.regions — bindAggregate folds them into agg.fields
  // alongside spec fields, see bind.ts) project under the evaluator's witness-key
  // convention '<region>.state' (evaluate.ts's inState/whileStates read
  // `self.fields['${region}.state']`), never the bare region name — for both auto-bound
  // and overridden region members alike.
  const regionNames = new Set((spec.machine?.regions ?? []).map(r => r.name));
  const id = String(row[agg.keyColumn]);
  const fields: CaseEntity['fields'] = {};
  for (const fb of agg.fields) {
    const v = fb.kind === 'auto'
      ? row[fb.column!]
      : overrides[agg.aggregate]![fb.field]!(db, row);
    if (v === null || v === undefined) {
      if (nullableRefs.has(fb.field)) continue; // absent optional ref: omit key (auto or override)
      throw new Error(
        `conform observe: ${agg.aggregate}.${fb.field} is null/undefined for row ${id} — ` +
        `projection must be total or the field overridden`);
    }
    const key = regionNames.has(fb.field) ? `${fb.field}.state` : fb.field;
    fields[key] = v as string | number | boolean;
  }
  return { type: agg.aggregate, id, fields };
}

// NOTE (drive walk per-step check, human ruling 2026-07-16, SCOPE WIDENED same day): this module
// used to export `observeAggregateScoped` — full row set of ONE aggregate + one-hop ref closure
// — for `walk.ts`'s per-step invariant re-check. That touched-aggregate scoping was found to
// relocate the c09 cadence gap onto whichever aggregate a driver mutates WITHOUT its intention
// naming it (e.g. a Subscription-bound `changePlanOp` driver that also writes Invoice rows). The
// fix widened the per-step check to every bound aggregate at once, which made
// `observeAggregateScoped` exactly equivalent to `observeEntities` below (every bound aggregate's
// full row set already contains anything a one-hop ref could have reached) — so `walk.ts` now
// calls `observeEntities` directly and the narrower helper was removed rather than left unused.

export function observeEntities(db: Database.Database, model: DomainModel,
  manifest: BindingManifest, overrides: OverridesModule): CaseEntity[] {
  const out: CaseEntity[] = [];
  for (const agg of manifest.aggregates) {
    const rows = db.prepare(`SELECT * FROM ${agg.table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      out.push(projectRow(db, model, agg, row, overrides));
    }
  }
  return out;
}

/** Project ONE row (by key value) plus the transitive closure of its ref fields.
 *  Returns entities in closure order (target row first). Throws if the id is absent.
 *
 *  Bound: recurses ONE level only. The spec's guards traverse at most one ref hop, so a
 *  single hop of ref resolution is sufficient for guard evaluation at drive-walk time — this
 *  is a deliberate scoping bound for the per-step legality oracle, not a general-purpose graph
 *  walk. A ref field on the *target* of a hop is not itself followed. */
export function observeScoped(db: Database.Database, model: DomainModel,
  manifest: BindingManifest, overrides: OverridesModule,
  aggregate: string, id: string): CaseEntity[] {
  const agg = manifest.aggregates.find(a => a.aggregate === aggregate)!;
  const spec = model.aggregates.find(a => a.name === aggregate)!;
  const row = db.prepare(`SELECT * FROM ${agg.table} WHERE ${agg.keyColumn} = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`conform observeScoped: ${aggregate} id ${id} not found in ${agg.table}`);
  }
  const target = projectRow(db, model, agg, row, overrides);
  const out: CaseEntity[] = [target];

  for (const field of spec.fields) {
    if (field.type.kind !== 'ref') continue;
    const targetAggName = field.type.target;
    const refId = target.fields[field.name];
    if (refId === undefined) continue; // absent optional ref (SQL NULL/override null): no closure to follow

    const targetSpecAgg = model.aggregates.find(a => a.name === targetAggName);
    if (!targetSpecAgg) continue; // ref target not defined in the model: nothing to resolve
    const refAgg = manifest.aggregates.find(a => a.aggregate === targetSpecAgg.name);
    if (!refAgg) continue; // ref target aggregate has no binding: skip (unbound, nothing to observe)

    const refRow = db.prepare(`SELECT * FROM ${refAgg.table} WHERE ${refAgg.keyColumn} = ?`).get(String(refId)) as
      Record<string, unknown> | undefined;
    if (!refRow) {
      throw new Error(
        `conform observeScoped: ${refAgg.aggregate} id ${String(refId)} ` +
        `(referenced by ${aggregate}.${field.name}) not found in ${refAgg.table}`);
    }
    out.push(projectRow(db, model, refAgg, refRow, overrides));
  }

  return out;
}
