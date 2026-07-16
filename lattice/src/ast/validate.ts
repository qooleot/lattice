import type { Diagnostic, Predicate, Term } from './invariant.js';
import type { DomainModel, Field, TypeRef } from './domain.js';
import { ownedCollectionChild } from './domain.js';
import { RESERVED_WORDS } from './reserved.js';

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

  checkName('context', m.context);
  for (const en of m.enums) {
    checkName('enum', en.name, en.name);
    for (const v of en.values) checkName('enum value', v, `${en.name}.${v}`);
  }
  for (const v of m.values) {
    checkName('value', v.name, v.name);
    for (const f of v.fields) checkName('field', f.name, `${v.name}.${f.name}`);
    for (const inv of v.invariants ?? []) checkName('invariant', inv.name, inv.name);
  }
  for (const e of m.entities) {
    checkName('entity', e.name, e.name);
    for (const f of e.fields) checkName('field', f.name, `${e.name}.${f.name}`);
  }
  for (const a of m.aggregates) {
    checkName('aggregate', a.name, a.name);
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
  const checkFields = (fs: Field[], owner: string, needKey: boolean) => {
    fs.forEach(f => { checkType(f.type, `${owner}.${f.name}`); checkReservedField(f, `${owner}.${f.name}`);
      if (f.optional && f.key)
        out.push({ code: 'optional-key', message: `${owner}.${f.name} is a key field and cannot be optional — identity is never absent`, at: `${owner}.${f.name}` });
      if (f.optional && f.type.kind === 'list')
        out.push({ code: 'optional-list', message: `${owner}.${f.name} is a List and cannot be optional — an absent list and an empty list are the same fact; List<T> already means zero or more`, at: `${owner}.${f.name}` });
      if (f.optional && f.type.kind === 'value')
        out.push({ code: 'optional-value', message: `${owner}.${f.name} has a value type and cannot be optional — a value type flattens into its sub-fields for the solvers, so there is no single field for the optionality marker to attach to`, at: `${owner}.${f.name}` });
    });
    if (needKey && !fs.some(f => f.key)) out.push({ code: 'missing-key', message: `${owner} has no key field`, at: owner });
  };

  m.values.forEach(v => {
    for (const f of v.fields) {
      checkType(f.type, `${v.name}.${f.name}`);
      checkReservedField(f, `${v.name}.${f.name}`);
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
      if (f.type.kind !== 'prim' && f.type.kind !== 'enum')
        out.push({ code: 'value-flat', message: `value ${v.name}.${f.name}: value fields carry prim/enum types only in v1`, at: `${v.name}.${f.name}` });
    }
    for (const inv of v.invariants ?? [])
      checkScopedPred(v.fields, [], enumMap, `value ${v.name}.${inv.name}`, `${v.name}.${inv.name}`, inv.body, out, 'value-cross-field');
  });

  m.entities.forEach(e => checkFields(e.fields, e.name, true));
  m.events.forEach(e => e.fields.forEach(f => { checkType(f.type, `${e.name}.${f.name}`); checkReservedField(f, `${e.name}.${f.name}`); }));
  m.aggregates.forEach(a => {
    checkFields(a.fields, a.name, true);
    for (const child of a.entities ?? []) {
      checkName('entity', child.name, `${a.name}.${child.name}`);
      checkFields(child.fields, `${a.name}.${child.name}`, true);   // missing-key covers child-key-required
      for (const f of child.fields)
        if (f.type.kind === 'ref' || f.type.kind === 'list' || f.type.kind === 'value')
          out.push({ code: 'nested-entity-flat', message: `nested entity ${a.name}.${child.name}.${f.name}: children carry prim/enum fields only in v1 (design §5.2)`, at: `${a.name}.${child.name}.${f.name}` });
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
  return out;
}

/**
 * Money fields whose sign was never decided, or decided both ways (spec: Slice A design §2).
 * Deliberately NOT part of validateModel: loadLatText calls that (fromLangium.ts), and the
 * language keeps its Money ⇒ non-negative default for hand-written .lat and every doc example.
 * This gate is for the elicitation path only, where the model is machine-authored and an
 * unconsidered — or self-contradictory — default silently becomes an adopted rule that
 * constrains every witness the solver draws.
 *
 * @signed and @unsigned are mutually exclusive by construction: a field carrying both is reported
 * as contradictory, never as undecided — the two lists are disjoint. One diagnostic per owner per
 * list, naming every offending field — the caller elicits per cluster, so a per-field list is what
 * it needs to ask one question instead of N.
 */
export function undecidedMoneySigns(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const owners: { name: string; fields: Field[] }[] = [
    ...m.entities, ...m.values,
    ...m.aggregates.flatMap(a => [a as { name: string; fields: Field[] }, ...(a.entities ?? [])]),
  ];
  for (const o of owners) {
    const moneyFields = o.fields.filter(f => f.type.kind === 'prim' && f.type.prim === 'Money');
    const contradictory = moneyFields
      .filter(f => f.tags?.includes('signed') && f.tags?.includes('unsigned'))
      .map(f => f.name);
    if (contradictory.length)
      out.push({ code: 'money-sign-contradictory', at: o.name,
        message: `${o.name}: Money field(s) ${contradictory.join(', ')} are tagged both @signed and @unsigned — the tags contradict. @signed and @unsigned are mutually exclusive: pick the one that is true of the field.` });
    const undecided = moneyFields
      .filter(f => !f.tags?.includes('signed') && !f.tags?.includes('unsigned'))
      .map(f => f.name);
    if (undecided.length)
      out.push({ code: 'money-sign-undecided', at: o.name,
        message: `${o.name}: Money field(s) ${undecided.join(', ')} have no sign decision — tag each @signed (may go negative) or @unsigned (may not). The engine will not guess.` });
  }
  return out;
}
