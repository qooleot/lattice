import type { AggregateDef, DomainModel, EntityDef, Field } from '../ast/domain.js';
import { ownedCollectionChild } from '../ast/domain.js';
import type { Candidate, Cmp, Path, Predicate, Term } from '../ast/invariant.js';
import type { SalientFact } from '../engine/session.js';
import { OWNED_BOUND, childVarKey } from '../engine/owned.js';

export interface QuintQuery {
  kind: 'distinguish' | 'probe-forbid' | 'probe-permit';
  hi: Candidate; hj?: Candidate;
  exclusions: SalientFact[][];
  // Already-ADOPTED invariants (any kind the emitter can express as a state constraint — the
  // planner filters; see expressibleAdopted). Conjoined as `adoptedAll implies q_inv`, so every
  // witness (= violation of q_inv) additionally satisfies the adopted spec. Without this, the
  // solver can surface a composite-invalid state (e.g. two Draft invoices for one subscription
  // after a `unique` adoption) and force the human into a corrupting verdict: a faithful `forbid`
  // prunes a live candidate whose subject matter is unrelated, `permit` contradicts the adoption.
  adopted?: Candidate[];
  maxSteps: number;
  // Plan 3 Task 1 (design §6.2/§6.3): when set, every non-`const` numeric field gets a monotone-up
  // evolve action (nondet non-negative increase) gated on the owner being non-terminal, added to
  // `step` — a sound over-approximation of accrual (real payments are a subset of "arbitrary
  // non-negative increases"). Unset (default) — no evolve_ actions at all: byte-identical to today.
  abstractEvolution?: boolean;
}
export interface QuintEmission { source: string; invariantName: string; varTypes: Record<string, string> }

export const varName = (n: string) => n.charAt(0).toLowerCase() + n.slice(1) + 's';
export const isIntPrim = (p: string) => ['Int', 'Money', 'Date', 'Duration'].includes(p);
// Single source of truth for "which fields take abstract monotone-up evolve steps" (D1+D2). Narrower
// than isIntPrim (the Quint TYPE mapping, above, keeps Date/Duration as int): only Int/Money evolve;
// Date/Duration are temporal and must NOT take arbitrary monotone-up steps. Also drives the tier gate
// (engine/tier.ts) so the emission filter and the abstract-tier verdict share one definition.
export const isEvolvingPrim = (p: string) => ['Int', 'Money'].includes(p);
export const isEvolvingField = (f: Field) => f.type.kind === 'prim' && isEvolvingPrim(f.type.prim) && !f.const;
export const INT_POOL = 'Set(0, 24, 72, 100)';
export const owners = (m: DomainModel): (AggregateDef | EntityDef)[] => [...m.aggregates, ...m.entities];

function fieldQType(m: DomainModel, f: Field): string | null {
  if (f.key) return null;
  // qualified refs (spec §4.2) also land here: opaque str, never traversed (validateCandidate rejects such paths)
  if (f.type.kind === 'ref') return 'str';
  if (f.type.kind === 'enum') return 'str';
  if (f.type.kind === 'prim') return isIntPrim(f.type.prim) ? 'int' : null;   // Text/Id dropped
  // Value fields (design §3.5): a keyless, flat structural type embeds inline as a nested record —
  // e.g. `period: { start: int, end: int }` — never a map hop (values have no identity to look up
  // by). Sub-fields with no quint encoding (Text/Id) are dropped from the record, same as any
  // other owner's fields; a value with zero encodable sub-fields degenerates to `{}`.
  if (f.type.kind === 'value') {
    const valueName = f.type.value;
    const vdef = m.values.find(v => v.name === valueName);
    if (!vdef) return null;
    const subs = vdef.fields.map(sf => { const t = fieldQType(m, sf); return t ? `${sf.name}: ${t}` : null; }).filter(Boolean);
    return `{ ${subs.join(', ')} }`;
  }
  return null;   // lists unsupported in slice-1 quint emission
}
function initValue(m: DomainModel, f: Field, nondets: string[], tag: string): string | null {
  const t = fieldQType(m, f);
  if (!t) return null;
  const nd = `nd_${tag}_${f.name}`;
  if (f.type.kind === 'enum') {
    const vals = m.enums.find(e => e.name === (f.type as any).enum)!.values.map(v => `"${v}"`).join(', ');
    nondets.push(`nondet ${nd} = oneOf(Set(${vals}))`);
  } else if (f.type.kind === 'ref') {
    nondets.push(`nondet ${nd} = oneOf(${(f.type as any).target.toUpperCase()}_IDS)`);
  } else if (f.type.kind === 'value') {
    // Per-subfield nondet draws (design §3.5): each sub-field gets its own `nondet` at the SAME
    // tag scope as a plain field (init/create/owned-slot — wherever initValue is itself called),
    // then the record literal composes them — mirrors the owned-collection per-index draws above.
    const valueName = f.type.value;
    const vdef = m.values.find(v => v.name === valueName)!;
    const subs: string[] = [];
    for (const sf of vdef.fields) {
      const sndKind = fieldQType(m, sf);
      if (!sndKind) continue;
      const sndName = initValue(m, sf, nondets, `${tag}_${f.name}`);
      if (sndName) subs.push(`${sf.name}: ${sndName}`);
    }
    return `{ ${subs.join(', ')} }`;
  } else nondets.push(`nondet ${nd} = oneOf(${INT_POOL})`);
  return nd;
}

function termToQuint(m: DomainModel, t: Term, self: string, ownerName: string): string {
  switch (t.kind) {
    case 'int': return String(t.value);
    case 'enumval': return `"${t.value}"`;
    case 'now': return 'now';
    case 'plus': return `${termToQuint(m, t.left, self, ownerName)} + ${termToQuint(m, t.right, self, ownerName)}`;
    case 'field': return pathToQuint(m, t.path, self, ownerName);
    case 'param': throw new Error('param terms never reach solvers/evaluator — method guards are carried structure');
  }
}
export function pathToQuint(m: DomainModel, path: Path, self: string, ownerName: string): string {
  let expr = self, owner = ownerName;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    // Ref-hop machine-state segment: '<Region>.state' reads the owner's region-state field
    // directly (rendered `_state` per astToQuint's `${r.name}_state` var naming) — it is never
    // a declared field, so it must skip the def/field lookup and the map-hop logic below.
    const stateMatch = seg.match(/^(\w+)\.state$/);
    if (stateMatch && i === path.length - 1) return `${expr}.${stateMatch[1]}_state`;
    const def = owners(m).find(o => o.name === owner)!;
    const f = def.fields.find(x => x.name === seg)!;
    expr = `${expr}.${seg}`;
    if (i < path.length - 1 && f.type.kind === 'ref') {
      owner = f.type.target;
      expr = `${varName(owner)}.get(${expr})`;
    }
  }
  return expr;
}

// Every `<var>.get(<expr>)` sub-expression a multi-hop path passes through when crossing a ref
// (mirrors pathToQuint's own ref-hop detection). Non-machine aggregates/entities start with
// `exists: false` and are only ever populated by a `create_*` action (see initValue/emitOwnerSig
// above) — but Quint's map model still returns a concrete (nondeterministically chosen) value for
// every key regardless of that flag, since field access is never itself gated on `exists`. Without
// requiring each hop's target to actually exist, Apalache is free to "read" a never-created
// record's placeholder fields to manufacture a counterexample that refers to data that was never
// instantiated — a spurious witness, not a real violation. refHopsInTerm/predToQuint's `cmp` case
// below use these to gate each comparison on its ref targets actually existing.
export function refHopsIn(m: DomainModel, path: Path, self: string, ownerName: string): string[] {
  const hops: string[] = [];
  let expr = self, owner = ownerName;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    // Ref-hop machine-state segment: not a declared field, so it can't be looked up on `def` —
    // but the hop to reach `owner` (e.g. `period`) was already pushed onto `hops` on a prior
    // iteration, so the existence gate on that referenced record still composes correctly.
    const stateMatch = seg.match(/^(\w+)\.state$/);
    if (stateMatch && i === path.length - 1) { expr = `${expr}.${stateMatch[1]}_state`; break; }
    const def = owners(m).find(o => o.name === owner)!;
    const f = def.fields.find(x => x.name === seg)!;
    expr = `${expr}.${seg}`;
    if (i < path.length - 1 && f.type.kind === 'ref') {
      owner = f.type.target;
      expr = `${varName(owner)}.get(${expr})`;
      hops.push(expr);
    }
  }
  return hops;
}
function refHopsInTerm(m: DomainModel, t: Term, self: string, ownerName: string): string[] {
  switch (t.kind) {
    case 'field': return refHopsIn(m, t.path, self, ownerName);
    case 'plus': return [...refHopsInTerm(m, t.left, self, ownerName), ...refHopsInTerm(m, t.right, self, ownerName)];
    case 'int': case 'enumval': case 'now': return [];
    case 'param': throw new Error('param terms never reach solvers/evaluator — method guards are carried structure');
  }
}
export function predToQuint(m: DomainModel, p: Predicate, self: string, ownerName: string): string {
  switch (p.kind) {
    case 'cmp': {
      const ops: Record<Cmp, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      const cmp = `(${termToQuint(m, p.left, self, ownerName)} ${ops[p.op]} ${termToQuint(m, p.right, self, ownerName)})`;
      // Match evaluate.ts's evalPred('cmp'): "unknown facts don't convict" — if either side reads
      // through a ref to a record that was never created (see refHopsIn above), the comparison's
      // operands are meaningless placeholder data, not a real fact, so this node must evaluate to
      // true (vacuously) exactly like the TS judge does, rather than let Apalache read through to
      // a never-created record to manufacture a spurious counterexample.
      const hops = [...refHopsInTerm(m, p.left, self, ownerName), ...refHopsInTerm(m, p.right, self, ownerName)];
      if (hops.length === 0) return cmp;
      const allExist = [...new Set(hops)].map(h => `${h}.exists`).join(' and ');
      return `((${allExist}) implies ${cmp})`;
    }
    case 'inState': return '(' + p.states.map(s => `${self}.${p.region}_state == "${s}"`).join(' or ') + ')';
    case 'and': return '(' + p.args.map(a => predToQuint(m, a, self, ownerName)).join(' and ') + ')';
    case 'or': return '(' + p.args.map(a => predToQuint(m, a, self, ownerName)).join(' or ') + ')';
    case 'not': return `(not(${predToQuint(m, p.arg, self, ownerName)}))`;
    case 'implies': return `(${predToQuint(m, p.left, self, ownerName)} implies ${predToQuint(m, p.right, self, ownerName)})`;
  }
}

// Per-owner init-record construction (design §3.5/§6.1), shared by astToQuint (Task 2, this
// module) and astToQuintClassify (Task 3, sibling emitter — havoc initial state for the
// solver-induction spike). `stateDraw` controls only the region-state field: 'fixed' reproduces
// today's astToQuint behavior (the region's declared `initial` literal); 'havoc' instead draws it
// from a `nondet oneOf(Set(...))` over every declared state name, so the classifier can start
// Apalache from an arbitrary (not necessarily reachable) region state. Owned-collection init (the
// `Map(...)` + `Count` draws) never branches on `stateDraw` — a havoc initial state still needs
// the same per-slot field draws as the fixed path.
export function buildOwnerInit(
  m: DomainModel, o: AggregateDef | EntityDef, tag: string, stateDraw: 'fixed' | 'havoc',
): { inits: string[]; nondets: string[] } {
  const machine = (o as AggregateDef).machine;
  const nondets: string[] = [];
  const inits: string[] = [`exists: ${machine ? 'true' : 'false'}`];   // machine-bearing exist from init; plain entities are created
  for (const f of o.fields) {
    const nd = initValue(m, f, nondets, tag);
    if (nd) inits.push(`${f.name}: ${nd}`);
  }
  for (const r of machine?.regions ?? []) {
    if (stateDraw === 'fixed') {
      inits.push(`${r.name}_state: "${r.initial}"`);
    } else {
      const nd = `nd_${tag}_${r.name}_state`;
      nondets.push(`nondet ${nd} = oneOf(Set(${r.states.map(s => `"${s.name}"`).join(', ')}))`);
      inits.push(`${r.name}_state: ${nd}`);
    }
  }
  // Owned collections (design §6.1): per-index nondet draws at init. Action-scope `nondet` can't
  // be drawn per-element inside a fold, so each of the OWNED_BOUND slots gets its own flat draw
  // (every bounded map is still reachable — see design deviation note in the commit body).
  const ownedFields = (o.kind === 'aggregate' ? o.fields.filter(f => ownedCollectionChild(o, f)) : []);
  for (const f of ownedFields) {
    const child = ownedCollectionChild(o as AggregateDef, f)!;
    const entries: string[] = [];
    for (let i = 0; i < OWNED_BOUND; i++) {
      const kv: string[] = [];
      for (const cf of child.fields) {
        const nd = initValue(m, cf, nondets, `${tag}_${f.name}_${i}`);
        if (nd) kv.push(`${cf.name}: ${nd}`);
      }
      entries.push(`${i} -> { ${kv.join(', ')} }`);
    }
    nondets.push(`nondet nd_${tag}_${f.name}Count = oneOf(0.to(${OWNED_BOUND}))`);
    inits.push(`${f.name}: Map(${entries.join(', ')})`, `${f.name}Count: nd_${tag}_${f.name}Count`);
  }
  return { inits, nondets };
}

export function candidateToQuint(m: DomainModel, c: Candidate, name: string): string {
  if (c.kind === 'guard') throw new Error('candidateToQuint: a guard candidate is a transition enablement, not an always-property — conjoin it into its trans_ action, do not render it as a val');
  const v = varName(c.aggregate);
  if (c.kind === 'statePredicate') {
    const guard = c.where ? `${predToQuint(m, c.where, 'x', c.aggregate)} implies ` : '';
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${guard}${predToQuint(m, c.body, 'x', c.aggregate)}) })`;
  }
  if (c.kind === 'conservation') {
    const parts = c.parts.map(p => pathToQuint(m, p, 'x', c.aggregate)).join(' + ');
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${parts} == ${pathToQuint(m, c.total, 'x', c.aggregate)}) })`;
  }
  if (c.kind === 'cardinality') {
    const guard = c.where ? predToQuint(m, c.where, 'x', c.aggregate) : 'true';
    return `val ${name} = ${v}.keys().filter(k => { val x = ${v}.get(k) x.exists and (${guard}) }).size() <= ${c.atMost}`;
  }
  if (c.kind === 'unique') {
    // Alloy-routed as a query subject, but needed here as an ADOPTED constraint (QuintQuery.
    // adopted) so quint witnesses can't violate an adoption like One_Draft_Invoice_Per_
    // Subscription. Pairwise over map keys, inlined `get()`s (no block-vals — one line per pred).
    // Ref-hop existence gates the by-key comparison the same way predToQuint's cmp case gates
    // reads through refs: a key read through a never-created record is not a real fact and must
    // not convict the pair.
    const rec = (k: string) => `${v}.get(${k})`;
    const inS = (k: string) => '(' + c.whileStates.states.map(st => `${rec(k)}.${c.whileStates.region}_state == "${st}"`).join(' or ') + ')';
    const hops = [...new Set(c.by.flatMap(p => [...refHopsIn(m, p, rec('k1'), c.aggregate), ...refHopsIn(m, p, rec('k2'), c.aggregate)]))];
    const eqs = c.by.map(p => `(${pathToQuint(m, p, rec('k1'), c.aggregate)} == ${pathToQuint(m, p, rec('k2'), c.aggregate)})`);
    const collides = [`${rec('k1')}.exists`, `${rec('k2')}.exists`, inS('k1'), inS('k2'), ...hops.map(h => `${h}.exists`), ...eqs].join(' and ');
    return `val ${name} = ${v}.keys().forall(k1 => ${v}.keys().forall(k2 => k1 == k2 or not(${collides})))`;
  }
  if (c.kind === 'sumOverCollection') {
    // Design §6.2: bounded fold over the owned-collection map (design §6.1's `f: int -> {…}` +
    // `fCount: int` encoding) — walks every slot up to OWNED_BOUND, only counting slots below the
    // live count. Mirrors evaluate.ts's sumOverCollection judge (sum of live children's field,
    // compared with `total` on the left — see QuintQuery.adopted / the op-flip note there).
    const fold = `range(0, ${OWNED_BOUND}).foldl(0, (acc, i) => if (i < x.${c.collection}Count) acc + x.${c.collection}.get(i).${c.field} else acc)`;
    const ops = { eq: '==', le: '<=', ge: '>=' } as const;
    return `val ${name} = ${v}.keys().forall(k => { val x = ${v}.get(k) not(x.exists) or (${pathToQuint(m, c.total, 'x', c.aggregate)} ${ops[c.op]} ${fold}) })`;
  }
  throw new Error(`${c.kind} is never solver-queried on quint in slice-1 (template auto-adopt only)`);
}

// renderTerm (salient.ts) flattens a field path to a dot-joined string for the salient-fact `dim`
// key (e.g. ['period', 'Lifecycle.state'] -> "period.Lifecycle.state"). A naive `.split('.')` to
// invert that would over-split the trailing ref-hop machine-state segment ('Lifecycle.state') back
// into two path elements ('Lifecycle', 'state'), which isn't a real field and crashes pathToQuint's
// lookup. Only the LAST path segment can ever be a compound `<Region>.state` (resolveFieldPath only
// accepts it there), so re-merge a trailing `Word.state` pair produced by the naive split.
// This merge is only unambiguous because a real field can never be named bare `state`:
// validateModel (src/ast/validate.ts) now emits a `reserved-field-name` diagnostic for any field
// literally named `state`, so a dot-joined path ending in `.state` can only ever be the synthetic
// `<Region>.state` machine-state accessor, never a genuine `<something>.state` field access.
function splitPathStr(s: string): string[] {
  const parts = s.split('.');
  if (parts.length >= 2 && parts[parts.length - 1] === 'state') {
    return [...parts.slice(0, -2), `${parts[parts.length - 2]}.state`];
  }
  return parts;
}

/** Rebuild judged shapes: match salient dims against the candidates' comparisons + enum-eq facts. */
function shapeToQuint(m: DomainModel, facts: SalientFact[], cands: Candidate[], name: string): string {
  const agg = cands[0]!.aggregate;
  const v = varName(agg);
  const conj: string[] = [];
  for (const f of facts) {
    // Sum-over-collection dims (design §6.2/§6.4 — see salient.ts's extractSalient sumOverCollection
    // branch) must be matched BEFORE the generic `<path> = <value>`/comparison branches below: e.g.
    // `sum(lines.amount)` would otherwise mis-parse as a bare dotted path.
    const mCount = f.dim.match(/^(\w+)\.count$/);
    if (mCount) { conj.push(`x.${mCount[1]}Count == ${f.value}`); continue; }
    const mSum = f.dim.match(/^sum\((\w+)\.(\w+)\)$/);
    if (mSum) { conj.push(`range(0, ${OWNED_BOUND}).foldl(0, (acc, i) => if (i < x.${mSum[1]}Count) acc + x.${mSum[1]}.get(i).${mSum[2]} else acc) == ${f.value}`); continue; }
    const mTot = f.dim.match(/^([\w.]+) value$/);
    if (mTot) { conj.push(`${pathToQuint(m, splitPathStr(mTot[1]!), 'x', agg)} == ${f.value}`); continue; }
    const mVal = f.dim.match(/^([\w.]+) = (\w+)$/);
    if (mVal) { conj.push(`${pathToQuint(m, splitPathStr(mVal[1]!), 'x', agg)} == "${mVal[2]}"`); continue; }
    const mCmp = f.dim.match(/^(.+) (eq|ne|lt|le|gt|ge) (.+)$/);
    if (mCmp) {
      const ops: Record<string, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      const render = (s: string) => s.split(' + ').map(part => part === 'now' || /^\d+$/.test(part) ? part : pathToQuint(m, splitPathStr(part), 'x', agg)).join(' + ');
      conj.push(`(${render(mCmp[1]!)} ${ops[mCmp[2]!]} ${render(mCmp[3]!)}) == ${f.value}`);
    }
  }
  return `val ${name} = ${v}.keys().exists(k => { val x = ${v}.get(k) x.exists and ${conj.join(' and ') || 'true'} })`;
}

export function astToQuint(m: DomainModel, q: QuintQuery): QuintEmission {
  const varTypes: Record<string, string> = {};
  const decls: string[] = ['var now: int'];
  const pools: string[] = [];
  const initNondets: string[] = [];
  const initSets: string[] = [`now' = 0`];
  const allVars = ['now', ...owners(m).map(o => varName(o.name))];
  const frame = (changed: string[]) => allVars.filter(v => !changed.includes(v)).map(v => `${v}' = ${v}`);
  const actions: string[] = [];

  for (const o of owners(m)) {
    const v = varName(o.name);
    varTypes[v] = o.name;
    const fields = o.fields.map(f => { const t = fieldQType(m, f); return t ? `${f.name}: ${t}` : null; }).filter(Boolean) as string[];
    const machine = (o as AggregateDef).machine;
    for (const r of machine?.regions ?? []) fields.push(`${r.name}_state: str`);
    // Owned collections (design §6.1): a bounded map `f: int -> {childFields}` plus a companion
    // `fCount: int` inside the owner record. Only aggregates can own nested entities.
    const ownedFields = (o.kind === 'aggregate' ? o.fields.filter(f => ownedCollectionChild(o, f)) : []);
    for (const f of ownedFields) {
      const child = ownedCollectionChild(o as AggregateDef, f)!;
      const childFields = child.fields.map(cf => { const t = fieldQType(m, cf); return t ? `${cf.name}: ${t}` : null; }).filter(Boolean) as string[];
      fields.push(`${f.name}: int -> { ${childFields.join(', ')} }`, `${f.name}Count: int`);
      varTypes[childVarKey(v, f.name)] = child.name;
    }
    decls.push(`var ${v}: str -> { exists: bool, ${fields.join(', ')} }`);
    pools.push(`val ${o.name.toUpperCase()}_IDS = Set("${o.name.toLowerCase()}1", "${o.name.toLowerCase()}2")`);

    const { inits, nondets } = buildOwnerInit(m, o, o.name.toLowerCase(), 'fixed');
    initNondets.push(...nondets);
    initSets.push(`${v}' = ${o.name.toUpperCase()}_IDS.mapBy(id => { ${inits.join(', ')} })`);

    // actions: declared transitions; generic region mutator when a region has none; create for non-machine entities; enum mutators
    for (const r of machine?.regions ?? []) {
      const declared = (machine!.transitions ?? []).filter(t => t.region === r.name);
      for (const t of declared) {
        const fromChk = `(${t.from.map(f => `${v}.get(id).${r.name}_state == "${f}"`).join(' or ')})`;
        const guard = t.requires ? `, ${predToQuint(m, t.requires, `${v}.get(id)`, o.name)}` : '';
        actions.push(
          `action trans_${o.name}_${t.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) all { ${fromChk}${guard}, ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", "${t.to}")), ${frame([v]).join(', ')} } }`);
      }
      if (declared.length === 0) actions.push(
        `action set_${o.name}_${r.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet s = oneOf(Set(${r.states.map(x => `"${x.name}"`).join(', ')})) all { ${v}' = ${v}.set(id, ${v}.get(id).with("${r.name}_state", s)), ${frame([v]).join(', ')} } }`);
    }
    if (!machine) {
      const nds: string[] = []; const sets: string[] = ['exists: true'];
      for (const f of o.fields) { const nd = initValue(m, f, nds, `c_${o.name.toLowerCase()}`); if (nd) sets.push(`${f.name}: ${nd}`); }
      // A fresh record literal must match the declared row type exactly (Quint's row-typing
      // rejects a `.set(id, {...})` missing fields the var's type carries) — so a create action
      // for an aggregate with owned collections needs the same bounded-map + count fields as init.
      for (const f of ownedFields) {
        const child = ownedCollectionChild(o as AggregateDef, f)!;
        const entries: string[] = [];
        for (let i = 0; i < OWNED_BOUND; i++) {
          const kv: string[] = [];
          for (const cf of child.fields) {
            const nd = initValue(m, cf, nds, `c_${o.name.toLowerCase()}_${f.name}_${i}`);
            if (nd) kv.push(`${cf.name}: ${nd}`);
          }
          entries.push(`${i} -> { ${kv.join(', ')} }`);
        }
        nds.push(`nondet nd_c_${o.name.toLowerCase()}_${f.name}Count = oneOf(0.to(${OWNED_BOUND}))`);
        sets.push(`${f.name}: Map(${entries.join(', ')})`, `${f.name}Count: nd_c_${o.name.toLowerCase()}_${f.name}Count`);
      }
      actions.push(`action create_${o.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) ${nds.join(' ')} all { ${v}' = ${v}.set(id, { ${sets.join(', ')} }), ${frame([v]).join(', ')} } }`);
    }
    for (const f of o.fields.filter(f => f.type.kind === 'enum')) {
      const vals = m.enums.find(e => e.name === (f.type as any).enum)!.values.map(x => `"${x}"`).join(', ');
      actions.push(`action mut_${o.name}_${f.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet nv = oneOf(Set(${vals})) all { ${v}' = ${v}.set(id, ${v}.get(id).with("${f.name}", nv)), ${frame([v]).join(', ')} } }`);
    }

    // Plan 3 Task 1 (design §6.2): sound over-approximate accrual — every non-const numeric field
    // may nondeterministically increase by a non-negative amount, but only while the owner is
    // non-terminal (frozen once terminal). Flag-gated: absent, no evolve_ actions at all.
    if (q.abstractEvolution) {
      const machine = (o as AggregateDef).machine;
      // non-terminal guard: the drawn id is not in any region's @terminal state (frozen once terminal).
      const termConj = (machine?.regions ?? []).flatMap(r =>
        r.states.filter(s => s.tags?.includes('terminal'))
          .map(s => `${v}.get(id).${r.name}_state != "${s.name}"`));
      const nonTerminal = termConj.length ? `(${termConj.join(' and ')})` : 'true';
      for (const f of o.fields.filter(isEvolvingField)) {
        actions.push(`action evolve_${o.name}_${f.name} = { nondet id = oneOf(${o.name.toUpperCase()}_IDS) nondet dv = oneOf(${INT_POOL}) all { ${nonTerminal}, ${v}' = ${v}.set(id, ${v}.get(id).with("${f.name}", ${v}.get(id).${f.name} + dv)), ${frame([v]).join(', ')} } }`);
      }
    }
  }
  actions.push(`action tick = { nondet dt = oneOf(Set(1, 5, 24, 120)) all { now' = now + dt, ${frame(['now']).join(', ')} } }`);

  const preds: string[] = [candidateToQuint(m, q.hi, 'Hi')];
  if (q.hj) preds.push(candidateToQuint(m, q.hj, 'Hj'));
  q.exclusions.forEach((facts, i) => preds.push(shapeToQuint(m, facts, [q.hi, ...(q.hj ? [q.hj] : [])], `shape${i}`)));
  const adopted = q.adopted ?? [];
  adopted.forEach((c, i) => preds.push(candidateToQuint(m, c, `adopted${i}`)));
  const shapes = q.exclusions.map((_, i) => `shape${i}`);
  const bare = q.kind === 'distinguish' ? ['iff(Hi, Hj)', ...shapes].join(' or ')
    : q.kind === 'probe-forbid' ? ['Hi', ...shapes].join(' or ')
    : `not(${['Hi', ...shapes.map(s => `not(${s})`)].join(' and ')})`;
  // A violation of `adoptedAll implies bare` is a state satisfying every adopted invariant AND
  // violating the bare query — witnesses stay inside the spec the human has already committed to
  // (see QuintQuery.adopted). Only the violating (last, presented) state is so constrained;
  // intermediate trace states are not, which is all the elicitation UI shows.
  const inv = adopted.length ? `(${adopted.map((_, i) => `adopted${i}`).join(' and ')}) implies (${bare})` : bare;
  preds.push(`val q_inv = ${inv}`);

  const actionNames = actions.map(a => a.split(' ')[1]!);
  const source = `module lattice_q {
${decls.map(d => '  ' + d).join('\n')}

${pools.map(p => '  ' + p).join('\n')}

  action init = { ${initNondets.join(' ')} all { ${initSets.join(', ')} } }

${actions.map(a => '  ' + a).join('\n')}

  action step = any { ${actionNames.join(', ')} }

${preds.map(p => '  ' + p).join('\n')}
}
`;
  return { source, invariantName: 'q_inv', varTypes };
}
