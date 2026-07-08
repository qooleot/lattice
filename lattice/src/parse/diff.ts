import type { DomainModel, AggregateDef, EntityDef } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';
import type { RenameSpec } from '../engine/renames.js';
import { canonicalCandidate } from '../engine/implied.js';

export interface InvariantChange { name: string; before: CandidateInvariant; after: CandidateInvariant }
export interface ModelDiff {
  addedInvariants: CandidateInvariant[];
  changedInvariants: InvariantChange[];
  removedInvariants: CandidateInvariant[];
  renameProposals: RenameSpec[];
  structuralNotes: string[];
}

// Key-order-insensitive canonical shape equality — candidates/types cross construction sites
// (parser vs session JSON), so raw JSON.stringify would misclassify equal shapes as different.
const cjson = (v: unknown) => canonicalCandidate(v);
type Owner = AggregateDef | EntityDef;
const owners = (m: DomainModel): Owner[] => [...m.aggregates, ...m.entities];

/** Enum values referenced inside a candidate's terms (for adopted-body rename detection). */
function enumvalRefs(c: Candidate): { enum: string; value: string }[] {
  const out: { enum: string; value: string }[] = [];
  const term = (t: Term): void => {
    if (t.kind === 'enumval') out.push({ enum: t.enum, value: t.value });
    if (t.kind === 'plus') { term(t.left); term(t.right); }
  };
  const pred = (p: Predicate | null | undefined): void => {
    if (!p) return;
    switch (p.kind) {
      case 'cmp': term(p.left); term(p.right); break;
      case 'and': case 'or': p.args.forEach(a => pred(a)); break;
      case 'not': pred(p.arg); break;
      case 'implies': pred(p.left); pred(p.right); break;
      case 'inState': break;
    }
  };
  switch (c.kind) {
    case 'statePredicate': pred(c.where); pred(c.body); break;
    case 'cardinality': pred(c.where); break;
    case 'leadsTo': pred(c.from); pred(c.to); break;
    default: break;
  }
  return out;
}

/** Ledger entries that mention the old name (design §5 step 4 — witness keys/values, invariant
 *  records, adopted candidate bodies, provenance text). */
export function ledgerReferences(r: RenameSpec, ledger: LedgerEntry[], storedModel: DomainModel): string[] {
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
          case 'enumValue': {
            // only fields whose declared type IS this enum count — value-string collisions with
            // unrelated fields must not fabricate ledger references
            const def = storedModel.aggregates.find(a => a.name === ent.type)
              ?? storedModel.entities.find(x => x.name === ent.type);
            return Object.entries(ent.fields).some(([k, v]) => {
              const f = def?.fields.find(x => x.name === k);
              return f?.type.kind === 'enum' && f.type.enum === owner && v === r.from;
            });
          }
          default: return false;
        }
      });
      if (touched) hits.push(id);
    }
    if (e.kind === 'adopted' || e.kind === 'declined') {
      if (r.scope === 'invariant' && e.invariant.name === r.from) hits.push(`${e.kind}:${r.from}`);
      // adopted candidate BODIES: enum values live inside terms, not witness fields
      const evs = enumvalRefs(e.invariant.candidate);
      if ((r.scope === 'enumValue' && evs.some(x => x.enum === owner && x.value === r.from))
          || (r.scope === 'enum' && evs.some(x => x.enum === r.from)))
        hits.push(`${e.kind}:${e.invariant.name}`);
      // provenance text carries names too (e.g. template ids embed the aggregate name)
      if (e.kind === 'adopted'
          && new RegExp(`\\b${r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(e.provenance))
        hits.push(`${e.kind}:${e.invariant.name}`);
    }
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
  for (const a of m.aggregates) for (const child of a.entities ?? []) {
    out.push({ scope: 'entity', owner: a.name, name: child.name,
      shape: `owner:${child.fields.map(f => f.name).sort().join(',')}` });
    for (const f of child.fields) out.push({ scope: 'field', owner: child.name, name: f.name, shape: `field:${child.name}:${cjson(f.type)}` });
  }
  for (const ev of m.events) out.push({ scope: 'event', name: ev.name, shape: 'event' });
  return out;
}
// state paths keep the state name as a 3rd segment (duplicating RenameSpec.from) so the path is
// exactly the --rename flag's left-hand side — see the RenameSpec doc in engine/renames.ts
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
  storedModel: DomainModel,
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
    if (candidates.length && ledgerReferences(spec, ledger, storedModel).length) {
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
    if (ledgerReferences(spec, ledger, storedModel).length) {
      proposals.push(spec);
      addedInvariants = addedInvariants.filter(x => x !== match);
      removedInvariants = removedInvariants.filter(x => x !== rem);
    }
  }

  // Services (design §3.6, Task 12): structural notes only — services deliberately do NOT join
  // namedThings (no rename proposals in v1; no ledger references exist for methods/params).
  const bSvc = new Map(before.model.services.map(s => [s.name, s]));
  const aSvc = new Map(after.model.services.map(s => [s.name, s]));
  for (const [n] of aSvc) if (!bSvc.has(n)) notes.push(`added service ${n}`);
  for (const [n] of bSvc) if (!aSvc.has(n)) notes.push(`removed service ${n}`);
  for (const [n, sa] of aSvc) {
    const sb = bSvc.get(n);
    if (!sb) continue;
    const bm = new Map(sb.methods.map(x => [x.name, x])), am = new Map(sa.methods.map(x => [x.name, x]));
    for (const [mn] of am) if (!bm.has(mn)) notes.push(`added method ${n}.${mn}`);
    for (const [mn] of bm) if (!am.has(mn)) notes.push(`removed method ${n}.${mn}`);
    for (const [mn, mv] of am) if (bm.has(mn) && cjson(mv) !== cjson(bm.get(mn))) notes.push(`changed method ${n}.${mn}`);
  }

  return { addedInvariants, changedInvariants, removedInvariants, renameProposals: proposals, structuralNotes: notes };
}
