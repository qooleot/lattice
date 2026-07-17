import type { Diagnostic, Predicate, Term } from './invariant.js';
import type { DomainModel, Field, TypeRef } from './domain.js';
import { isQualifiedRef, moneyFieldPaths, numericFieldPaths, ownedCollectionChild } from './domain.js';
import { PRIM_NAMES, RESERVED_WORDS } from './reserved.js';

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Shared own-scope predicate walker (design §3.3/§3.5): every field path must be a single
 * segment naming a field in `fields`, and every inState clause must name a region/state pair in
 * `regions` (transition guards) — value invariants pass `regions: []` since values carry no
 * machine, so any inState clause is rejected the same way an unknown region would be. Multi-segment
 * paths (ref-hops or nested-value paths) are rejected wholesale under `crossCode`, parameterized so
 * transition guards keep their `guard-cross-aggregate` diagnostic while value invariants get their
 * own `value-cross-field` — same walker, distinct vocabulary per call site (§5.2.1). `label` is the
 * message prefix (e.g. "transition settle" or "value Period.wellOrdered"), `at` the diagnostic's
 * `at` location.
 *
 * `params` (design §3.6, Task 12): an optional param-name set makes `param` terms legal — any
 * `param` term whose name isn't in the set is `unknown-param`. When `fields` is empty AND `params`
 * is non-empty (a `read-only` method's guard, which has no target aggregate), an ordinary `field`
 * term is treated the same as a scope-leaving path (`crossCode`) rather than `unknown-path` — a
 * read-only method has no own scope to read fields FROM, so any field reference "leaves scope" by
 * construction, distinct from a performs/creates method that legitimately has zero fields.
 */
function checkScopedPred(fields: Field[], regions: { name: string; states: { name: string }[] }[],
    enums: Map<string, string[]>, label: string, at: string, p: Predicate, out: Diagnostic[], crossCode: string,
    params?: Set<string>, noOwnScope = false): void {
  const term = (tm: Term): void => {
    switch (tm.kind) {
      case 'field': {
        if (noOwnScope) {
          out.push({ code: crossCode, message: `${label}: path ${tm.path.join('.')} leaves the own scope — v1 reads own fields only`, at });
          return;
        }
        if (tm.path.length !== 1) {
          // multi-segment = ref-hop or nested-value path; scoped predicates are own-scalar-only in v1
          out.push({ code: crossCode, message: `${label}: path ${tm.path.join('.')} leaves the own scope — v1 reads own fields only`, at });
          return;
        }
        if (!fields.some(f => f.name === tm.path[0]))
          out.push({ code: 'unknown-path', message: `${label}: reads unknown field ${tm.path[0]}`, at });
        break;
      }
      case 'enumval': {
        const e = enums.get(tm.enum);
        if (!e) out.push({ code: 'unknown-enum', message: `${label}: no enum ${tm.enum}`, at });
        else if (!e.includes(tm.value)) out.push({ code: 'unknown-enum-value', message: `${label}: ${tm.enum} has no value ${tm.value}`, at });
        break;
      }
      case 'plus': term(tm.left); term(tm.right); break;
      case 'int': case 'now': break;
      case 'param': {
        if (!params || !params.has(tm.name))
          out.push({ code: 'unknown-param', message: `${label}: references unknown param ${tm.name}`, at });
        break;
      }
    }
  };
  const walk = (q: Predicate): void => {
    switch (q.kind) {
      case 'cmp': term(q.left); term(q.right); break;
      case 'inState': {
        const r = regions.find(x => x.name === q.region);
        if (!r) { out.push({ code: 'unknown-region', message: `${label}: names missing region ${q.region}`, at }); return; }
        for (const s of q.states) if (!r.states.some(x => x.name === s))
          out.push({ code: 'unknown-state', message: `${label}: names missing state ${s}`, at });
        break;
      }
      case 'and': case 'or': q.args.forEach(walk); break;
      case 'not': walk(q.arg); break;
      case 'implies': walk(q.left); walk(q.right); break;
    }
  };
  walk(p);
}

function checkGuard(a: { name: string; fields: Field[]; machine?: { regions: { name: string; states: { name: string }[] }[] } },
    enums: Map<string, string[]>, t: string, p: Predicate, out: Diagnostic[]): void {
  checkScopedPred(a.fields, a.machine?.regions ?? [], enums, `transition ${t}: guard`, t, p, out, 'guard-cross-aggregate');
}

export function validateModel(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const enumMap = new Map(m.enums.map(e => [e.name, e.values]));
  const checkName = (kind: string, value: string, at?: string) => {
    if (!IDENT_RE.test(value))
      out.push({ code: 'invalid-name', message: `${kind} name '${value}' is not a valid identifier (letters, digits, underscore; no spaces)`, at });
    else if (RESERVED_WORDS.has(value))
      out.push({ code: 'reserved-word', message: `${kind} name '${value}' is a .lat keyword and cannot be used as an identifier`, at });
  };

  /**
   * Declaration names in the type namespace — the enum/value/entity/aggregate pool that mapType
   * resolves a bare `NamedType` against. A prim name here is ambiguous, not merely confusing: the
   * grammar has one production for every named type, so a bare `Id` always resolves to the prim
   * and never to the declaration. For value/enum that breaks print∘parse outright; for
   * entity/aggregate it silently hijacks the bare form while `ref X` still works. See
   * ast/reserved.ts for why both are covered.
   *
   * Events and services deliberately use plain checkName — neither is reachable from a type
   * position, so `event Id {}` names nothing that `Id` could be confused with.
   */
  const checkTypeName = (kind: string, value: string, at?: string) => {
    checkName(kind, value, at);
    if (PRIM_NAMES.has(value))
      out.push({ code: 'reserved-prim-name', at,
        message: `${kind} name '${value}' is a built-in primitive type name — a field typed '${value}' always resolves to the primitive, so the declaration could never be reached by that name` });
  };

  checkName('context', m.context);
  for (const en of m.enums) {
    checkTypeName('enum', en.name, en.name);
    for (const v of en.values) checkName('enum value', v, `${en.name}.${v}`);
  }
  for (const v of m.values) {
    checkTypeName('value', v.name, v.name);
    for (const f of v.fields) checkName('field', f.name, `${v.name}.${f.name}`);
    for (const inv of v.invariants ?? []) checkName('invariant', inv.name, inv.name);
  }
  for (const e of m.entities) {
    checkTypeName('entity', e.name, e.name);
    for (const f of e.fields) checkName('field', f.name, `${e.name}.${f.name}`);
  }
  for (const a of m.aggregates) {
    checkTypeName('aggregate', a.name, a.name);
    for (const f of a.fields) checkName('field', f.name, `${a.name}.${f.name}`);
    for (const r of a.machine?.regions ?? []) {
      checkName('machine region', r.name, `${a.name}.${r.name}`);
      for (const s of r.states) checkName('state', s.name, `${a.name}.${r.name}.${s.name}`);
    }
    for (const t of a.machine?.transitions ?? []) checkName('transition', t.name, t.name);
  }
  for (const e of m.events) {
    checkName('event', e.name, e.name);
    for (const f of e.fields) checkName('field', f.name, `${e.name}.${f.name}`);
  }
  for (const s of m.services) {
    checkName('service', s.name, s.name);
    for (const mm of s.methods) {
      checkName('method', mm.name, `${s.name}.${mm.name}`);
      for (const p of mm.params) checkName('param', p.name, `${s.name}.${mm.name}.${p.name}`);
    }
  }

  const names = new Map<string, number>();
  const all = [...m.enums.map(e => e.name), ...m.values.map(v => v.name), ...m.entities.map(e => e.name), ...m.aggregates.map(a => a.name),
    ...m.aggregates.flatMap(a => (a.entities ?? []).map(e => e.name))];
  for (const n of all) names.set(n, (names.get(n) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) out.push({ code: 'duplicate-name', message: `name ${n} declared ${c} times` });

  const owners = new Set([...m.entities.map(e => e.name), ...m.aggregates.map(a => a.name),
    ...m.aggregates.flatMap(a => (a.entities ?? []).map(e => e.name))]);
  const enums = new Set(m.enums.map(e => e.name));
  const values = new Set(m.values.map(v => v.name));
  const events = new Set(m.events.map(e => e.name));

  /**
   * child entity name -> the aggregate that owns it. A nested child is inlined into its owner in
   * BOTH solver encodings (quint.ts's `f: int -> {…}` record; alloy.ts's child sig with `owner: one
   * <Parent>`), so it has no id and no `<TARGET>_IDS` pool to draw a ref from (quint.ts:407 declares
   * pools per TOP-LEVEL owner only). A ref naming one therefore emits invalid Quint — this rule is
   * the encoding being honest, and it matches the DDD notion the child encodes: an owned child has
   * no identity outside its owner, so nothing may reference it.
   */
  const childOwner = new Map<string, string>();
  for (const a of m.aggregates) for (const e of a.entities ?? []) childOwner.set(e.name, a.name);

  /**
   * `ownerAgg` is the aggregate whose body this field is declared in, or null (top-level entity,
   * event, value). The ONE legal ref-to-a-child is the owned-collection declaration itself —
   * `List<ref Child>` on the child's own owning aggregate (design §3.2, ownedCollectionChild) —
   * which checkType would otherwise walk into via its `list` recursion.
   */
  const checkRefTarget = (t: TypeRef, at: string, ownerAgg: string | null) => {
    if (t.kind === 'list') {
      // The ONE legal ref-to-a-child is the owned-collection declaration: `List<ref Child>` declared
      // DIRECTLY on the child's own owning aggregate (design §3.2 — ownedCollectionChild only ever
      // inspects an aggregate's OWN fields, and requires `of.kind === 'ref'`, so neither a deeper
      // list nor a child's own list is one). Recursing with ownerAgg: null is what keeps the
      // exception from re-firing at depth — `List<List<ref Child>>` is not an owned collection.
      if (ownerAgg !== null && t.of.kind === 'ref' && childOwner.get(t.of.target) === ownerAgg) return;
      checkRefTarget(t.of, at, null);
      return;
    }
    if (t.kind !== 'ref') return;
    const target = t.target;   // capture before isQualifiedRef narrows t (its predicate type equals
                                // this branch's narrowed type exactly, so the false branch is `never`)
    if (isQualifiedRef(t)) return;
    const owner = childOwner.get(target);
    if (owner)
      out.push({ code: 'ref-target-nested-child', at,
        message: `ref target ${target} is an entity owned by aggregate ${owner} — an owned child has no identity to reference (both solver encodings inline it into its owner, with no id pool to draw from). Reference ${owner} instead, or promote ${target} to a top-level entity.` });
  };

  const checkType = (t: TypeRef, at: string) => {
    if (t.kind === 'ref') {
      if (t.target.includes('.')) {
        const segs = t.target.split('.');
        // shape only — resolution happens at workspace level (spec §4.4)
        for (const s of segs) checkName('cross-context ref segment', s, at);
      } else if (!owners.has(t.target)) {
        out.push({ code: 'unresolved-ref', message: `ref target ${t.target} not declared`, at });
      }
    }
    if (t.kind === 'enum' && !enums.has(t.enum)) out.push({ code: 'unresolved-enum', message: `enum ${t.enum} not declared`, at });
    if (t.kind === 'value' && !values.has(t.value)) out.push({ code: 'unresolved-value', message: `value type ${t.value} not declared`, at });
    if (t.kind === 'list') checkType(t.of, at);
  };
  const checkReservedField = (f: Field, at: string) => {
    if (f.name === 'state')
      out.push({ code: 'reserved-field-name', message: `'state' is reserved for machine-state keys (<Region>.state)`, at });
  };
  const checkFields = (fs: Field[], owner: string, needKey: boolean, ownerAgg: string | null = null) => {
    fs.forEach(f => { checkType(f.type, `${owner}.${f.name}`); checkReservedField(f, `${owner}.${f.name}`);
      checkRefTarget(f.type, `${owner}.${f.name}`, ownerAgg);
      if (f.optional && f.key)
        out.push({ code: 'optional-key', message: `${owner}.${f.name} is a key field and cannot be optional — identity is never absent`, at: `${owner}.${f.name}` });
      if (f.optional && f.type.kind === 'list')
        out.push({ code: 'optional-list', message: `${owner}.${f.name} is a List and cannot be optional — an absent list and an empty list are the same fact; List<T> already means zero or more`, at: `${owner}.${f.name}` });
      if (f.optional && f.type.kind === 'value')
        out.push({ code: 'optional-value', message: `${owner}.${f.name} has a value type and cannot be optional — a value type flattens into its sub-fields for the solvers, so there is no single field for the optionality marker to attach to`, at: `${owner}.${f.name}` });
      if (f.optional && fs.some(g => g.name === `${f.name}Present`))
        out.push({ code: 'present-name-collision',
          message: `${owner}.${f.name}Present collides with the solver companion flag of optional field ${owner}.${f.name} — the Quint encoding emits '${f.name}Present' beside every optional field; rename one of them`,
          at: `${owner}.${f.name}Present` });
      // A @balance/@total tag must name exactly one summable number (slice B2). On a value-typed
      // field that means exactly one solver-numeric path reachable through it (domain.ts's
      // numericFieldPaths, recursing through however many value hops it takes — the same walk
      // templates.ts's numericTagPath uses to resolve the tag, so the two cannot disagree); zero or
      // several is ambiguous, and numericTagPath returns null there — so without this diagnostic the
      // tag would be silently accepted and do nothing, which is the inertness this slice exists to
      // remove.
      if ((f.tags?.includes('balance') || f.tags?.includes('total')) && f.type.kind === 'value') {
        const vdef = m.values.find(v => v.name === (f.type as { kind: 'value'; value: string }).value);
        const nums = numericFieldPaths(m, f).map(p => p.slice(1).join('.'));
        if (nums.length !== 1)
          out.push({ code: 'ambiguous-numeric-tag', at: `${owner}.${f.name}`,
            message: `${owner}.${f.name} is tagged @${f.tags?.includes('total') ? 'total' : 'balance'} but its value type ${vdef?.name ?? '?'} has ${nums.length} numeric sub-field${nums.length === 1 ? '' : 's'} (${nums.join(', ') || 'none'}) — the tag must name exactly one summable number. Tag a field whose value type has a single numeric sub-field.` });
      }
    });
    if (needKey && !fs.some(f => f.key)) out.push({ code: 'missing-key', message: `${owner} has no key field`, at: owner });
  };

  m.values.forEach(v => {
    for (const f of v.fields) {
      checkType(f.type, `${v.name}.${f.name}`);
      checkReservedField(f, `${v.name}.${f.name}`);
      checkRefTarget(f.type, `${v.name}.${f.name}`, null);
      if (f.key) out.push({ code: 'value-no-key', message: `value ${v.name}.${f.name}: value types are keyless — structural equality replaces identity (design §3.5)`, at: `${v.name}.${f.name}` });
      // Same rule as the field-level optional-value above, one level down and for the same reason:
      // the whole value flattens into `<field>_<sub>` sig relations, so a sub-field has no more of
      // its own multiplicity to carry than the value itself does. Alloy's sub-field loop emits
      // `one` regardless of the marker (making present(w.end) a tautology) while quint emits a real
      // nested `endPresent` flag — the two solvers then disagree on whether absence is reachable,
      // which is the divergence this code exists to forbid.
      if (f.optional) out.push({ code: 'optional-value', message: `value ${v.name}.${f.name} cannot be optional — a value type flattens into its sub-fields for the solvers, so there is no field for the optionality marker to attach to`, at: `${v.name}.${f.name}` });
      if (f.const) out.push({ code: 'value-no-const', message: `value ${v.name}.${f.name} cannot be const — value types are immutable by structure`, at: `${v.name}.${f.name}` });
      // Note: `const` on a KEY field (entity/aggregate) is deliberately tolerated silently — a key
      // is immutable by nature, so redundant `const` there is harmless and not worth a diagnostic.
      // Values nest (slice B2): quint's fieldQType already recurses (quint.ts:57) and alloy's
      // valueSubRelations now does too. `ref` stays out — a value is keyless and compared by
      // structure, so a reference from inside one has no identity to belong to; `list` stays out for
      // the same reason it does on a child (no quint list encoding).
      if (f.type.kind === 'ref' || f.type.kind === 'list')
        out.push({ code: 'value-flat', message: `value ${v.name}.${f.name}: a value's fields are prim, enum, or another value — not ${f.type.kind} (a value is keyless and structural; it has no identity for a reference to belong to)`, at: `${v.name}.${f.name}` });
      // Sign is a USE-SITE decision (slice B2): the same `value Amount` is @unsigned at Bill.total
      // and @signed at LedgerAccount.balance, so a tag here could not express both even in
      // principle — and implied.ts's moneyPaths reads the use site, so a tag here would be inert.
      if (f.tags?.includes('signed') || f.tags?.includes('unsigned'))
        out.push({ code: 'value-money-sign-inert', at: `${v.name}.${f.name}`,
          message: `value ${v.name}.${f.name} carries @signed/@unsigned, but money sign is decided where the value is USED, not where it is declared — the same value type may be non-negative at one field and signed at another. Tag the field typed '${v.name}' instead.` });
    }
    for (const inv of v.invariants ?? [])
      checkScopedPred(v.fields, [], enumMap, `value ${v.name}.${inv.name}`, `${v.name}.${inv.name}`, inv.body, out, 'value-cross-field');
  });

  /**
   * Value-type reference cycle (design precedent: `unowned-nested-entity` above is reported here,
   * at init, rather than left to an emission-time throw — same call, same reason). A value flattens
   * into its fields for both solver encodings (alloy.ts's valueSubRelations, quint.ts's fieldQType,
   * and ast/domain.ts's moneyFieldPaths), each recursing through nested value fields. A DAG flattens
   * to a finite tree (`Outer{inner:Amount}` -> `inner_amount`); a cycle (`A{b:B}` + `B{a:A}`, or a
   * self-cycle `A{a:A}`) has no finite flattening, so all three recursions stack-overflow instead —
   * verified by hand before this fix (`Maximum call stack size exceeded` in both emitters).
   *
   * DFS over the value -> value field-type edges, classic white/grey/black cycle detection: a
   * back-edge into a 'visiting' (grey) node closes a cycle. Reported ONCE per cycle, not once per
   * participant or per field — a 3-value chain has 3 back-edges into the same loop if you count
   * naively, and would otherwise flood the output 3x. The representative location is the
   * ALPHABETICALLY-FIRST value name among the cycle's participants: it is a property of the cycle's
   * node SET, not of which value happened to be visited first by this forEach (declaration order),
   * so reordering the file's `value` blocks does not change which name the diagnostic points at or
   * how the path reads. The cycle is rotated (not re-traversed) to start at that name, so the
   * printed path is deterministic too — e.g. always "A -> B -> A", never "B -> A -> B" for the same
   * cycle. Once a node finishes DFS ('done'/black) it is never revisited, so the same cycle cannot
   * be found a second time from a different starting point either.
   */
  {
    const byName = new Map(m.values.map(v => [v.name, v]));
    const state = new Map<string, 'visiting' | 'done'>();
    const path: string[] = [];
    const visit = (name: string): void => {
      const st = state.get(name);
      if (st === 'done') return;
      if (st === 'visiting') {
        const start = path.indexOf(name);
        const participants = path.slice(start);   // the loop, in traversal order, name not repeated
        let minIdx = 0;
        for (let i = 1; i < participants.length; i++) if (participants[i]! < participants[minIdx]!) minIdx = i;
        const rotated = [...participants.slice(minIdx), ...participants.slice(0, minIdx)];
        const rep = rotated[0]!;
        const cyclePath = [...rotated, rep].join(' -> ');
        out.push({ code: 'value-cycle', at: rep,
          message: `value ${rep} is part of a value-type cycle: ${cyclePath} — a value is a structural type flattened into its fields, and a cycle has no finite flattening; both solver encodings (alloy's valueSubRelations, quint's fieldQType) recurse through nested values and would stack-overflow on this shape. Break the cycle by removing one of the fields in the chain.` });
        return;
      }
      state.set(name, 'visiting');
      path.push(name);
      const v = byName.get(name);
      if (v) for (const f of v.fields) if (f.type.kind === 'value' && byName.has(f.type.value)) visit(f.type.value);
      path.pop();
      state.set(name, 'done');
    };
    for (const v of m.values) visit(v.name);
  }

  m.entities.forEach(e => checkFields(e.fields, e.name, true));
  m.events.forEach(e => e.fields.forEach(f => { checkType(f.type, `${e.name}.${f.name}`); checkReservedField(f, `${e.name}.${f.name}`); checkRefTarget(f.type, `${e.name}.${f.name}`, null); }));
  m.aggregates.forEach(a => {
    checkFields(a.fields, a.name, true, a.name);
    for (const child of a.entities ?? []) {
      // nested children share the type namespace (duplicate-name pool above, `owners` below), so a
      // prim-named child has its bare form hijacked exactly as a top-level entity's would be
      checkTypeName('entity', child.name, `${a.name}.${child.name}`);
      checkFields(child.fields, `${a.name}.${child.name}`, true, null);   // missing-key covers child-key-required
      for (const f of child.fields) {
        // `ref` and value-typed child fields are structurally legal as of this slice — List is the
        // one remaining rejection below. A child's ref must name a TOP-LEVEL owner —
        // checkRefTarget's ref-target-nested-child (already in this file) enforces that.
        //
        // `List` stays rejected: quint has no list encoding at all (fieldQType returns null), so a
        // collection inside a collection needs nested bounded maps, an OWNED_BOUND^2 state blowup,
        // and a revisit of the bitwidth policy that already rises to 7 for a single-level sum
        // (alloy.ts:385-391). That is its own slice — see the design doc's "Not in this slice".
        if (f.type.kind === 'list')
          out.push({ code: 'nested-entity-flat', message: `nested entity ${a.name}.${child.name}.${f.name}: a child cannot own a collection — List inside an aggregate-owned child is not yet encodable (quint has no list encoding; see design B2 "Not in this slice")`, at: `${a.name}.${child.name}.${f.name}` });
        // Checked here, not in the shared checkFields — this is the only site that knows a field
        // belongs to an aggregate-owned child rather than a top-level entity, where `Type?` is legal.
        // alloy.ts's emitChildSigs has no multiplicity to vary: it emits `one` whatever the marker
        // says (real Alloy on `entity Line { discount : Money? }` in an owned collection: sat=false
        // for a Line lacking its discount — a state the TS judge permits), while quint.ts's
        // owned-child record emits no `${f}Present` companion at all. Relaxing Alloy to `lone`
        // trades this for a worse divergence: its `sum` over an empty join contributes 0 and
        // convicts where the judge skips the aggregate. No evidence in this slice needs an optional
        // child field, so it is rejected rather than half-encoded — same call as optional-list and
        // optional-value.
        if (f.optional)
          out.push({ code: 'optional-owned-child', message: `${a.name}.${child.name}.${f.name} is a field of an aggregate-owned child and cannot be optional — the solver encodings give a child's field no multiplicity of its own, so absence is unrepresentable there`, at: `${a.name}.${child.name}.${f.name}` });
      }
      // A child is reachable ONLY through an owned collection: quint inlines it into its owner as
      // `<coll>: int -> {…}` (no var, no id pool of its own — see emit/quint.ts's owners/pools), and
      // alloy emits its sig only for a child an owned collection ranges over. Nothing may reference
      // one either (checkRefTarget's ref-target-nested-child). So a child no `List<...>` field owns
      // is unreachable in every encoding — a dead declaration. Reported here rather than left to
      // childContext's emission-time throw, so it lands at init with every other structural error.
      if (!a.fields.some(f => ownedCollectionChild(a, f)?.name === child.name))
        out.push({ code: 'unowned-nested-entity', at: `${a.name}.${child.name}`,
          message: `nested entity ${a.name}.${child.name} is not owned by any collection — give ${a.name} a 'List<${child.name}>' field, or declare ${child.name} at context level. A nested entity is reachable only through its owner's owned collection, so nothing can read or constrain this one.` });
    }
    const collectionOwners = new Map<string, string>();   // child entity name -> first owning field
    for (const f of a.fields) {
      const child = ownedCollectionChild(a, f);
      if (!child) continue;
      const prior = collectionOwners.get(child.name);
      if (prior) {
        out.push({ code: 'duplicate-owned-collection-target', message: `aggregate ${a.name}: fields ${prior} and ${f.name} both own collections of ${child.name} — one owned collection per child entity (the solver encodings key children by entity name)`, at: `${a.name}.${f.name}` });
      } else {
        collectionOwners.set(child.name, f.name);
      }
    }
    for (const r of a.machine?.regions ?? []) {
      if (!r.states.some(s => s.name === r.initial))
        out.push({ code: 'unknown-initial-state', message: `region ${a.name}.${r.name} initial ${r.initial} not a state`, at: r.name });
    }
    for (const t of a.machine?.transitions ?? []) {
      const r = a.machine!.regions.find(x => x.name === t.region);
      if (!r) { out.push({ code: 'unknown-region', message: `transition ${t.name} names missing region ${t.region}`, at: t.name }); continue; }
      for (const s of [...t.from, t.to]) if (!r.states.some(x => x.name === s))
        out.push({ code: 'unknown-transition-state', message: `transition ${t.name}: no state ${s} in ${a.name}.${t.region}`, at: t.name });
      if (new Set(t.from).size !== t.from.length)
        out.push({ code: 'duplicate-source', message: `transition ${t.name}: repeated source state`, at: t.name });
      if (t.from.includes(t.to))
        out.push({ code: 'self-loop', message: `transition ${t.name}: target ${t.to} is also a source — self-loops need evidence before the grammar admits them (design §5.2)`, at: t.name });
      if (t.when && !events.has(t.when))
        out.push({ code: 'unknown-event', message: `transition ${t.name} triggered by undeclared event ${t.when}`, at: t.name });
      if (t.requires) checkGuard(a, enumMap, t.name, t.requires, out);
      if (t.emits && !events.has(t.emits))
        out.push({ code: 'unknown-event', message: `transition ${t.name} emits undeclared event ${t.emits}`, at: t.name });
    }
  });

  // Services (design §3.6, Task 12): carried structure only — never solver-encoded. Each method
  // names exactly one target (read-only query, `performs` a declared transition, or `creates` an
  // aggregate); `requires` is a method-level guard over params + (for performs/creates) the target
  // aggregate's own fields/states, reusing the shared checkScopedPred walker with a param-name set.
  m.services.forEach(s => {
    for (const mm of s.methods) {
      const at = `${s.name}.${mm.name}`;
      for (const p of mm.params) checkType(p.type, `${at}.${p.name}`);
      if (mm.returns) checkType(mm.returns, `${at}.returns`);
      const paramNames = new Set(mm.params.map(p => p.name));

      if ('performs' in mm.kind) {
        const { aggregate, transition } = mm.kind.performs;
        const agg = m.aggregates.find(a => a.name === aggregate);
        if (!agg) { out.push({ code: 'unknown-aggregate', message: `method ${at}: performs names missing aggregate ${aggregate}`, at }); continue; }
        const t = agg.machine?.transitions.find(x => x.name === transition);
        if (!t) { out.push({ code: 'unknown-transition', message: `method ${at}: performs names missing transition ${aggregate}.${transition}`, at }); continue; }
        if (mm.requires)
          checkScopedPred(agg.fields, agg.machine?.regions ?? [], enumMap, `method ${at}: requires`, at, mm.requires, out, 'guard-cross-aggregate', paramNames);
      } else if ('creates' in mm.kind) {
        const aggregate = mm.kind.creates;
        const agg = m.aggregates.find(a => a.name === aggregate);
        if (!agg) { out.push({ code: 'unknown-aggregate', message: `method ${at}: creates names missing aggregate ${aggregate}`, at }); continue; }
        if (mm.requires)
          checkScopedPred(agg.fields, agg.machine?.regions ?? [], enumMap, `method ${at}: requires`, at, mm.requires, out, 'guard-cross-aggregate', paramNames);
      } else {
        // read-only: no target aggregate — requires may reference params only
        if (mm.requires)
          checkScopedPred([], [], enumMap, `method ${at}: requires`, at, mm.requires, out, 'guard-cross-aggregate', paramNames, true);
      }
    }
  });
  // Contradictory @signed+@unsigned tags are ill-formed on every path (unlike undecidedness,
  // which stays init-only to preserve the language's Money ⇒ non-negative default on load).
  out.push(...contradictoryMoneySigns(m));
  return out;
}

// Shared by contradictoryMoneySigns and undecidedMoneySigns: values are NOT owners here (slice
// B2), sign is decided at each USE SITE. m.values was in this list while implied.ts's owner list
// excluded it, so init demanded a decision the engine then ignored — the two lists disagreed and
// this one was wrong.
const moneySignOwners = (m: DomainModel): { name: string; fields: Field[] }[] => [
  ...m.entities,
  ...m.aggregates.flatMap(a => [a as { name: string; fields: Field[] }, ...(a.entities ?? [])]),
];
// A sign site is any field that IS money or CARRIES money: a `Money` prim, or a value type with at
// least one `Money` sub-field. Shares domain.ts's moneyFieldPaths with implied.ts's moneyPaths (the
// DERIVATION side) so the two cannot independently drift on the same shape fact.
const carriesMoney = (m: DomainModel, f: Field): boolean => moneyFieldPaths(m, f).length > 0;

/**
 * @signed+@unsigned on one field contradicts itself regardless of authoring path — unlike
 * undecidedness (init-only; the language has a Money⇒non-negative default), a contradiction is
 * never a legal default, so it belongs with the other tag rules in validateModel.
 *
 * Uses the same owners enumeration and carriesMoney predicate as undecidedMoneySigns, so a
 * use-site contradiction on a value-typed Money-carrying field is caught identically to one on a
 * bare Money prim field.
 */
export function contradictoryMoneySigns(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const o of moneySignOwners(m)) {
    const contradictory = o.fields
      .filter(f => carriesMoney(m, f))
      .filter(f => f.tags?.includes('signed') && f.tags?.includes('unsigned'))
      .map(f => f.name);
    if (contradictory.length)
      out.push({ code: 'money-sign-contradictory', at: o.name,
        message: `${o.name}: Money field(s) ${contradictory.join(', ')} are tagged both @signed and @unsigned — the tags contradict. @signed and @unsigned are mutually exclusive: pick the one that is true of the field.` });
  }
  return out;
}

/**
 * Money fields whose sign was never decided (spec: Slice A design §2). Deliberately NOT part of
 * validateModel: loadLatText calls that (fromLangium.ts), and the language keeps its Money ⇒
 * non-negative default for hand-written .lat and every doc example. This gate is for the
 * elicitation path only, where the model is machine-authored and an unconsidered default silently
 * becomes an adopted rule that constrains every witness the solver draws.
 *
 * A both-tagged field is contradictory (see contradictoryMoneySigns, in validateModel), never
 * undecided — the two are disjoint by construction. One diagnostic per owner, naming every
 * undecided field — the caller elicits per cluster, so a per-field list is what it needs to ask
 * one question instead of N.
 */
export function undecidedMoneySigns(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const o of moneySignOwners(m)) {
    const undecided = o.fields
      .filter(f => carriesMoney(m, f))
      .filter(f => !f.tags?.includes('signed') && !f.tags?.includes('unsigned'))
      .map(f => f.name);
    if (undecided.length)
      out.push({ code: 'money-sign-undecided', at: o.name,
        message: `${o.name}: Money field(s) ${undecided.join(', ')} have no sign decision — tag each @signed (may go negative) or @unsigned (may not). The engine will not guess.` });
  }
  return out;
}
