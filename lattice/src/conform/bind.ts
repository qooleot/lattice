// Conform auto-binder (spec plan §4): maps spec fields/regions onto live SQLite columns by
// convention, validates every candidate binding against sampled live rows, and routes
// overridden fields around convention search. Loud on any unresolved gap — never partial-silent.
import type Database from 'better-sqlite3';
import type { AggregateDef, DomainModel, Field, Region } from '../ast/domain.js';
import type { AggregateBinding, BindingManifest, FieldBinding, OverridesModule } from './types.js';

export class ConformBindError extends Error {
  constructor(public manifest: BindingManifest) {
    super('conform: unbound spec fields — add typed overrides or fix naming:\n' +
      manifest.aggregates.filter(a => a.unbound.length)
        .map(a => `  ${a.aggregate} (table ${a.table || 'NOT FOUND'}): ${a.unbound.join(', ')}`).join('\n'));
    this.name = 'ConformBindError';
  }
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

interface Col { name: string; pk: number }

function tableFor(db: Database.Database, agg: string): { table: string; cols: Col[] } | undefined {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map(t => t.name);
  const want = [agg, agg.toLowerCase(), snake(agg), `${agg.toLowerCase()}s`, `${snake(agg)}s`];
  const table = want.find(w => tables.includes(w));
  if (!table) return undefined;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
  return { table, cols };
}

function sample(db: Database.Database, table: string, column: string): unknown[] {
  return (db.prepare(`SELECT ${column} v FROM ${table} LIMIT 100`).all() as { v: unknown }[]).map(r => r.v);
}

// Numeric spec types: their live column must hold JS numbers on every sampled row.
const NUMERIC_PRIMS = new Set(['Int', 'Money', 'Date', 'Duration']);

function validates(vals: unknown[], f: Field | undefined, region: Region | undefined): string | null {
  if (vals.length === 0) return null; // vacuous — noted by caller
  if (region) {
    const domain = new Set(region.states.map(s => s.name));
    return vals.every(v => typeof v === 'string' && domain.has(v)) ? null : 'live values outside region domain';
  }
  const t = f!.type;
  if (t.kind === 'prim' && NUMERIC_PRIMS.has(t.prim)) {
    return vals.every(v => typeof v === 'number') ? null : 'non-numeric live values for numeric spec type';
  }
  return null;
}

function candidateColumns(f: Field | undefined, region: Region | undefined, cols: Col[]): string[] {
  const names = cols.map(c => c.name);
  const out: string[] = [];
  if (f?.key) { const pk = cols.find(c => c.pk > 0); if (pk) out.push(pk.name); }
  const base = f ? f.name : region!.name;
  for (const cand of [base, snake(base)]) if (names.includes(cand) && !out.includes(cand)) out.push(cand);
  if (f && f.type.kind === 'ref') {
    for (const cand of [`${snake(base)}_id`, `${snake(base)}_code`])
      if (names.includes(cand) && !out.includes(cand)) out.push(cand);
  }
  if (region) {
    const cand = `${region.name}_state`;
    if (names.includes(cand) && !out.includes(cand)) out.push(cand);
  }
  return out;
}

function bindAggregate(db: Database.Database, a: AggregateDef, overrides: OverridesModule): AggregateBinding {
  const found = tableFor(db, a.name);
  const ov = overrides[a.name] ?? {};
  const fields: FieldBinding[] = [];
  const unbound: string[] = [];
  const members: { name: string; field?: Field; region?: Region }[] = [
    ...a.fields.map(f => ({ name: f.name, field: f })),
    ...(a.machine?.regions ?? []).map(r => ({ name: r.name, region: r })),
  ];
  for (const m of members) {
    if (ov[m.name]) { fields.push({ field: m.name, kind: 'override' }); continue; }
    if (!found) { unbound.push(m.name); continue; }
    let bound = false;
    for (const col of candidateColumns(m.field, m.region, found.cols)) {
      const vals = sample(db, found.table, col);
      const reject = validates(vals, m.field, m.region);
      if (!reject) {
        fields.push({ field: m.name, kind: 'auto', column: col,
          ...(vals.length === 0 ? { note: 'unvalidated: no rows' } : {}) });
        bound = true;
        break;
      }
    }
    if (!bound) unbound.push(m.name);
  }
  const pk = found?.cols.find(c => c.pk > 0);
  return { aggregate: a.name, table: found?.table ?? '', keyColumn: pk?.name ?? '', fields, unbound };
}

export function bindSchema(db: Database.Database, model: DomainModel, overrides: OverridesModule): BindingManifest {
  const manifest: BindingManifest = { aggregates: model.aggregates.map(a => bindAggregate(db, a, overrides)) };
  if (manifest.aggregates.some(a => a.unbound.length > 0)) throw new ConformBindError(manifest);
  return manifest;
}
