// Conform observer (spec plan §4): projects bound rows + overrides into spec-shaped
// CaseEntity[] for evaluateCandidate. One CaseEntity per row per bound aggregate. A ref field
// carries the referenced row's key value (string) so the ref-hop in evaluate.ts's resolveValue
// (`entities.find(x => x.id === v)`) works unmodified. Total or loud: SQL NULL in a nullable
// ref auto-binding is the one legal absence (the field key is omitted); every other NULL, and
// every override returning null/undefined, is a hard error naming aggregate/field/row id — a
// lying projection must fail, not coerce (design drift class 6/11 depends on this).
import type Database from 'better-sqlite3';
import type { DomainModel } from '../ast/domain.js';
import type { CaseEntity } from '../engine/evaluate.js';
import type { BindingManifest, OverridesModule } from './types.js';

export function observeEntities(db: Database.Database, model: DomainModel,
  manifest: BindingManifest, overrides: OverridesModule): CaseEntity[] {
  const out: CaseEntity[] = [];
  for (const agg of manifest.aggregates) {
    const spec = model.aggregates.find(a => a.name === agg.aggregate)!;
    // Ref-typed spec fields are the only fields where a live SQL NULL is a legal absence
    // (an unset foreign key) rather than a lying projection — see module doc above.
    const nullableRefs = new Set(spec.fields.filter(f => f.type.kind === 'ref').map(f => f.name));
    const rows = db.prepare(`SELECT * FROM ${agg.table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row[agg.keyColumn]);
      const fields: CaseEntity['fields'] = {};
      for (const fb of agg.fields) {
        const v = fb.kind === 'auto'
          ? row[fb.column!]
          : overrides[agg.aggregate]![fb.field]!(db, row);
        if (v === null || v === undefined) {
          if (fb.kind === 'auto' && nullableRefs.has(fb.field)) continue; // absent optional ref: omit key
          throw new Error(
            `conform observe: ${agg.aggregate}.${fb.field} is null/undefined for row ${id} — ` +
            `projection must be total or the field overridden`);
        }
        fields[fb.field] = v as string | number | boolean;
      }
      out.push({ type: agg.aggregate, id, fields });
    }
  }
  return out;
}
