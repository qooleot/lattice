import type { CaseState, CaseEntity } from './evaluate.js';
import type { DomainModel } from '../ast/domain.js';
import type { LedgerEntry } from './session.js';

export type RenameScope = 'field' | 'state' | 'transition' | 'enumValue' | 'enum' | 'entity'
  | 'aggregate' | 'event' | 'invariant' | 'region';
export interface RenameSpec { scope: RenameScope; path: string; from: string; to: string }

export const renameEntries = (ledger: LedgerEntry[]): RenameSpec[] =>
  ledger.filter(e => e.kind === 'rename')
    .map(e => ({ scope: (e as any).scope, path: (e as any).path, from: (e as any).from, to: (e as any).to }));

/** Owner of an owner-qualified path: 'Job.count' → 'Job'; 'Job.run.waiting' → 'Job'. */
const pathOwner = (p: string): string => p.split('.')[0]!;

function applyOne(e: CaseEntity, r: RenameSpec, m: DomainModel): CaseEntity {
  const fields: Record<string, string | number | boolean> = {};
  const owner = pathOwner(r.path);
  switch (r.scope) {
    case 'entity': case 'aggregate':
      for (const [k, v] of Object.entries(e.fields)) fields[k] = v;
      return { ...e, type: e.type === r.from ? r.to : e.type, fields };
    case 'field':
      for (const [k, v] of Object.entries(e.fields)) fields[e.type === owner && k === r.from ? r.to : k] = v;
      return { ...e, fields };
    case 'region': {
      const [, region] = r.path.split('.');
      for (const [k, v] of Object.entries(e.fields))
        fields[e.type === owner && k === `${region}.state` ? `${r.to}.state` : k] = v;
      return { ...e, fields };
    }
    case 'state': {
      const [, region] = r.path.split('.');
      for (const [k, v] of Object.entries(e.fields))
        fields[k] = e.type === owner && k === `${region}.state` && v === r.from ? r.to : v;
      return { ...e, fields };
    }
    case 'enumValue': {
      const enumName = pathOwner(r.path);
      const def = m.aggregates.find(a => a.name === e.type) ?? m.entities.find(x => x.name === e.type);
      for (const [k, v] of Object.entries(e.fields)) {
        const f = def?.fields.find(x => x.name === k);
        fields[k] = f?.type.kind === 'enum' && f.type.enum === enumName && v === r.from ? r.to : v;
      }
      return { ...e, fields };
    }
    default: {  // transition | enum | event | invariant: nothing witness-visible
      for (const [k, v] of Object.entries(e.fields)) fields[k] = v;
      return { ...e, fields };
    }
  }
}

/** Map a witness recorded under old names to current names. Renames apply sequentially (ledger order). */
export function resolveWitness(w: CaseState, renames: RenameSpec[], current: DomainModel): CaseState {
  const mapEntity = (e: CaseEntity) => renames.reduce((acc, r) => applyOne(acc, r, current), e);
  return { ...w, entities: w.entities.map(mapEntity),
    trace: w.trace?.map(step => step.map(mapEntity)) };
}

export function currentInvariantName(oldName: string, renames: RenameSpec[]): string {
  return renames.reduce((n, r) => r.scope === 'invariant' && r.from === n ? r.to : n, oldName);
}

/** Apply renames to the model itself (defs + internal references). Pure; input untouched. */
export function applyRenamesToModel(m: DomainModel, renames: RenameSpec[]): DomainModel {
  let cur: DomainModel = JSON.parse(JSON.stringify(m));
  for (const r of renames) {
    const owner = pathOwner(r.path);
    const ren = (n: string, match: string) => (n === match ? r.to : n);
    switch (r.scope) {
      case 'aggregate': case 'entity':
        for (const o of [...cur.aggregates, ...cur.entities]) {
          o.name = ren(o.name, r.from);
          for (const f of o.fields) if (f.type.kind === 'ref') f.type.target = ren(f.type.target, r.from);
        }
        break;
      case 'field': {
        const def = cur.aggregates.find(a => a.name === owner) ?? cur.entities.find(e => e.name === owner);
        for (const f of def?.fields ?? []) f.name = ren(f.name, r.from);
        break;
      }
      case 'region': {
        const def = cur.aggregates.find(a => a.name === owner);
        for (const reg of def?.machine?.regions ?? []) reg.name = ren(reg.name, r.from);
        for (const t of def?.machine?.transitions ?? []) t.region = ren(t.region, r.from);
        break;
      }
      case 'state': {
        const [, regionName] = r.path.split('.');
        const def = cur.aggregates.find(a => a.name === owner);
        const reg = def?.machine?.regions.find(x => x.name === regionName);
        if (reg) {
          reg.initial = ren(reg.initial, r.from);
          for (const s of reg.states) s.name = ren(s.name, r.from);
        }
        for (const t of def?.machine?.transitions.filter(t => t.region === regionName) ?? []) {
          t.from = ren(t.from, r.from); t.to = ren(t.to, r.from);
        }
        break;
      }
      case 'transition': {
        const def = cur.aggregates.find(a => a.name === owner);
        for (const t of def?.machine?.transitions ?? []) t.name = ren(t.name, r.from);
        break;
      }
      case 'enum':
        for (const e of cur.enums) e.name = ren(e.name, r.from);
        for (const o of [...cur.aggregates, ...cur.entities, ...cur.events])
          for (const f of o.fields) if (f.type.kind === 'enum') f.type.enum = ren(f.type.enum, r.from);
        break;
      case 'enumValue': {
        const e = cur.enums.find(x => x.name === owner);
        if (e) e.values = e.values.map(v => ren(v, r.from));
        break;
      }
      case 'event':
        for (const ev of cur.events) ev.name = ren(ev.name, r.from);
        for (const a of cur.aggregates) for (const t of a.machine?.transitions ?? [])
          if (t.when) t.when = ren(t.when, r.from);
        break;
      case 'invariant': break;   // not a model construct
    }
  }
  return cur;
}

/** Apply renames inside a candidate invariant (paths, states, enum values, its own name).
 *  Field renames rewrite the FIRST path segment only when the rename's owner is the candidate's
 *  aggregate — every committed invariant uses single-segment paths; multi-hop renames out of scope. */
export function applyRenamesToInvariant(i: import('../ast/invariant.js').CandidateInvariant,
    renames: RenameSpec[]): import('../ast/invariant.js').CandidateInvariant {
  const inv = JSON.parse(JSON.stringify(i)) as typeof i;
  for (const r of renames) {
    const owner = pathOwner(r.path);
    if (r.scope === 'invariant' && inv.name === r.from) inv.name = r.to;
    const c: any = inv.candidate;
    const renPath = (p: string[]) => { if (owner === c.aggregate && p[0] === r.from && r.scope === 'field') p[0] = r.to; };
    const walkTerm = (t: any) => {
      if (!t) return;
      if (t.kind === 'field') renPath(t.path);
      if (t.kind === 'enumval' && r.scope === 'enumValue' && t.enum === owner && t.value === r.from) t.value = r.to;
      if (t.kind === 'enumval' && r.scope === 'enum' && t.enum === r.from) t.enum = r.to;
      if (t.kind === 'plus') { walkTerm(t.left); walkTerm(t.right); }
    };
    const walkPred = (p: any) => {
      if (!p) return;
      switch (p.kind) {
        case 'cmp': walkTerm(p.left); walkTerm(p.right); break;
        case 'inState':
          if (owner === c.aggregate) {
            if (r.scope === 'region' && p.region === r.from) p.region = r.to;
            if (r.scope === 'state' && p.region === r.path.split('.')[1])
              p.states = p.states.map((s: string) => (s === r.from ? r.to : s));
          }
          break;
        case 'and': case 'or': p.args.forEach(walkPred); break;
        case 'not': walkPred(p.arg); break;
        case 'implies': walkPred(p.left); walkPred(p.right); break;
      }
    };
    switch (c.kind) {
      case 'statePredicate': walkPred(c.where); walkPred(c.body); break;
      case 'unique':
        if (owner === c.aggregate) {
          if (r.scope === 'region' && c.whileStates.region === r.from) c.whileStates.region = r.to;
          if (r.scope === 'state' && c.whileStates.region === r.path.split('.')[1])
            c.whileStates.states = c.whileStates.states.map((s: string) => (s === r.from ? r.to : s));
        }
        c.by.forEach(renPath);
        break;
      case 'cardinality': walkPred(c.where); break;
      case 'terminal':
        if (owner === c.aggregate) {
          if (r.scope === 'region' && c.region === r.from) c.region = r.to;
          if (r.scope === 'state' && c.region === r.path.split('.')[1] && c.state === r.from) c.state = r.to;
        }
        break;
      case 'monotonic': renPath(c.field); break;
      case 'conservation': c.parts.forEach(renPath); renPath(c.total); break;
      case 'leadsTo': walkPred(c.from); walkPred(c.to); break;
    }
    if ((r.scope === 'aggregate' || r.scope === 'entity') && c.aggregate === r.from) c.aggregate = r.to;
  }
  return inv;
}
