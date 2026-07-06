import type { DomainModel, AggregateDef, EntityDef } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';
import type { RenameSpec } from '../engine/renames.js';

export interface InvariantChange { name: string; before: CandidateInvariant; after: CandidateInvariant }
export interface ModelDiff {
  addedInvariants: CandidateInvariant[];
  changedInvariants: InvariantChange[];
  removedInvariants: CandidateInvariant[];
  renameProposals: RenameSpec[];
  structuralNotes: string[];
}

const cjson = (v: unknown) => JSON.stringify(v);
type Owner = AggregateDef | EntityDef;
const owners = (m: DomainModel): Owner[] => [...m.aggregates, ...m.entities];

/** Ledger entries that mention the old name (spec P4 — witness keys/values + invariant records). */
export function ledgerReferences(r: RenameSpec, ledger: LedgerEntry[]): string[] {
  const hits: string[] = [];
  const owner = r.path.split('.')[0]!;
  for (const e of ledger) {
    if (e.kind === 'verdict' || (e.kind === 'open-decision' && e.witness)) {
      const w = (e as any).witness as { entities: { type: string; fields: Record<string, unknown> }[] };
      const id = (e as any).witnessId ?? 'open-decision';
      const touched = w.entities.some(ent => {
        switch (r.scope) {
          case 'aggregate': case 'entity': return ent.type === r.from;
          case 'field': return ent.type === owner && r.from in ent.fields;
          case 'region': return ent.type === owner && `${r.path.split('.')[1]}.state` in ent.fields;
          case 'state': {
            const region = r.path.split('.')[1]!;
            return ent.type === owner && ent.fields[`${region}.state`] === r.from;
          }
          case 'enumValue': return Object.values(ent.fields).includes(r.from);
          default: return false;
        }
      });
      if (touched) hits.push(id);
    }
    if (r.scope === 'invariant' && (e.kind === 'adopted' || e.kind === 'declined')
        && (e as any).invariant.name === r.from)
      hits.push(`${e.kind}:${r.from}`);
  }
  return [...new Set(hits)];
}

interface NamedThing { scope: RenameSpec['scope']; owner?: string; region?: string; name: string; shape: string }
function namedThings(m: DomainModel): NamedThing[] {
  const out: NamedThing[] = [];
  for (const e of m.enums) {
    out.push({ scope: 'enum', name: e.name, shape: 'enum' });
    for (const v of e.values) out.push({ scope: 'enumValue', owner: e.name, name: v, shape: `enumValue:${e.name}` });
  }
  for (const o of owners(m)) {
    out.push({ scope: o.kind === 'entity' ? 'entity' : 'aggregate', name: o.name,
      shape: `owner:${o.fields.map(f => f.name).sort().join(',')}` });
    for (const f of o.fields) out.push({ scope: 'field', owner: o.name, name: f.name, shape: `field:${o.name}:${cjson(f.type)}` });
    const mach = o.kind === 'aggregate' ? o.machine : undefined;
    for (const r of mach?.regions ?? []) {
      out.push({ scope: 'region', owner: o.name, name: r.name, shape: `region:${o.name}` });
      for (const s of r.states) out.push({ scope: 'state', owner: o.name, region: r.name, name: s.name, shape: `state:${o.name}.${r.name}` });
    }
    for (const t of mach?.transitions ?? []) out.push({ scope: 'transition', owner: o.name, name: t.name, shape: `transition:${o.name}.${t.region}` });
  }
  for (const ev of m.events) out.push({ scope: 'event', name: ev.name, shape: 'event' });
  return out;
}
const qualify = (t: NamedThing): string =>
  t.scope === 'state' ? `${t.owner}.${t.region}.${t.name}` : t.owner ? `${t.owner}.${t.name}` : t.name;

/** For owner renames, shape-match on ≥ half shared field names instead of exact shape. */
const ownerShapeMatch = (a: NamedThing, b: NamedThing): boolean => {
  const fa = a.shape.split(':')[1]!.split(',').filter(Boolean);
  const fb = b.shape.split(':')[1]!.split(',').filter(Boolean);
  const shared = fa.filter(f => fb.includes(f)).length;
  return shared * 2 >= Math.max(fa.length, fb.length, 1);
};

export function diffModels(
  before: { model: DomainModel; canonical: CandidateInvariant[] },
  after: { model: DomainModel; canonical: CandidateInvariant[] },
  ledger: LedgerEntry[],
  _storedModel: DomainModel,
): ModelDiff {
  const notes: string[] = [];
  const proposals: RenameSpec[] = [];

  const b = namedThings(before.model), a = namedThings(after.model);
  const akeys = new Set(a.map(x => `${x.scope}|${qualify(x)}`));
  const bkeys = new Set(b.map(x => `${x.scope}|${qualify(x)}`));
  const removed = b.filter(x => !akeys.has(`${x.scope}|${qualify(x)}`));
  const added = a.filter(x => !bkeys.has(`${x.scope}|${qualify(x)}`));

  const consumedAdds = new Set<NamedThing>();
  for (const r of removed) {
    const candidates = added.filter(x => !consumedAdds.has(x) && x.scope === r.scope && x.owner === r.owner && x.region === r.region
      && (r.scope === 'aggregate' || r.scope === 'entity' ? ownerShapeMatch(r, x) : x.shape === r.shape));
    const spec: RenameSpec = { scope: r.scope, path: qualify(r), from: r.name, to: candidates[0]?.name ?? '' };
    if (candidates.length && ledgerReferences(spec, ledger).length) {
      proposals.push(spec);
      consumedAdds.add(candidates[0]!);
    } else {
      notes.push(`removed ${r.scope} ${qualify(r)}`);
    }
  }
  for (const x of added) if (!consumedAdds.has(x)) notes.push(`added ${x.scope} ${qualify(x)}`);

  // invariants by name
  const bInv = new Map(before.canonical.map(i => [i.name, i]));
  const aInv = new Map(after.canonical.map(i => [i.name, i]));
  let addedInvariants = [...aInv.values()].filter(i => !bInv.has(i.name));
  let removedInvariants = [...bInv.values()].filter(i => !aInv.has(i.name));
  const changedInvariants: InvariantChange[] = [...aInv.values()]
    .filter(i => bInv.has(i.name) && cjson(bInv.get(i.name)!.candidate) !== cjson(i.candidate))
    .map(i => ({ name: i.name, before: bInv.get(i.name)!, after: i }));

  // invariant rename: identical candidate, different name, old name ledger-referenced
  for (const rem of [...removedInvariants]) {
    const match = addedInvariants.find(ad => cjson(ad.candidate) === cjson(rem.candidate));
    if (!match) continue;
    const spec: RenameSpec = { scope: 'invariant', path: rem.name, from: rem.name, to: match.name };
    if (ledgerReferences(spec, ledger).length) {
      proposals.push(spec);
      addedInvariants = addedInvariants.filter(x => x !== match);
      removedInvariants = removedInvariants.filter(x => x !== rem);
    }
  }

  return { addedInvariants, changedInvariants, removedInvariants, renameProposals: proposals, structuralNotes: notes };
}
