import fc from 'fast-check';
import type { DomainModel, AggregateDef, EntityDef, Field, EventDef, Machine, StateDef,
  TransitionDef, TypeRef, ValueDef, ServiceDef, MethodDef, ParamDef } from '../../src/ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term, Cmp } from '../../src/ast/invariant.js';
import { ownedCollectionChild } from '../../src/ast/domain.js';
import { PRIM_NAMES, RESERVED_WORDS as RESERVED } from '../../src/ast/reserved.js';
import type { ContextMapModel, Relationship, RelationshipKind, Role } from '../../src/ast/contextmap.js';
import { defaultPath } from '../../src/ast/contextmap.js';

const lower = 'abcdefghijklmnopqrstuvwxyz';
const ident = (first: string) => fc.tuple(
  fc.constantFrom(...first.split('')),
  fc.string({ unit: fc.constantFrom(...(lower + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').split('')), maxLength: 6 }))
  .map(([a, b]) => a + b).filter(s => !RESERVED.has(s));
const camel = ident(lower);
const pascal = ident('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
/**
 * Names of things a bare type expression can resolve to (enum/value/entity/aggregate). Prim names
 * are excluded for the same reason `ident` excludes RESERVED_WORDS — validateModel rejects them
 * (`reserved-prim-name`), so drawing one produces an invalid model, and the round-trip property
 * would fail on a spec the language does not admit. Scoped to declaration names rather than folded
 * into `pascal` on purpose: enum *values* also draw from `pascal` and are not in the type
 * namespace, so `enum E { Id }` stays legal and stays covered.
 */
const typeName = pascal.filter(n => !PRIM_NAMES.has(n));
const uniqNames = (arb: fc.Arbitrary<string>, min: number, max: number) =>
  fc.uniqueArray(arb, { minLength: min, maxLength: max });

const docText = fc.string({ unit: fc.constantFrom(...'abc XYZ,.'.split('')), minLength: 1, maxLength: 30 })
  .map(s => s.trim()).filter(s => s.length > 0);

// const (Plan 3a): drawn ~1/4 of the time — low weight so most fields stay non-const, but
// frequent enough that the round-trip property (roundtrip.test.ts) reliably exercises the
// printer's const-placement ordering (key, then const, then @tags — src/emit/code.ts fieldLines).
// Shared by fieldArb (AGGREGATE fields) and entityFieldArb (ENTITY fields).
const constDrawArb = fc.oneof({ weight: 3, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) });

// AGGREGATE fields: prim/enum/value only — never 'ref'/'list'. candidateArb's refsResolve arm
// depends on there being no ref fields (see its comment); roundtrip.test.ts asserts the invariant
// executably. `valueNames` (optional, Task 10) lets a field draw a declared value type — kept a
// low-weight option since value fields are excluded from every invariant path (see `representable`
// above): no solver encoding yet, so they must never end up load-bearing in a generated candidate.
export function fieldArb(name: string, enumNames: string[], valueNames: string[] = []): fc.Arbitrary<Field> {
  const prim = fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id').map(p => ({ kind: 'prim' as const, prim: p as any }));
  const options: fc.WeightedArbitrary<TypeRef>[] = [{ weight: 4, arbitrary: prim }];
  if (enumNames.length) options.push({ weight: 1,
    arbitrary: fc.constantFrom(...enumNames).map(e => ({ kind: 'enum' as const, enum: e })) });
  if (valueNames.length) options.push({ weight: 1,
    arbitrary: fc.constantFrom(...valueNames).map(v => ({ kind: 'value' as const, value: v })) });
  const type = fc.oneof(...options);
  return fc.record({
    type,
    isConst: constDrawArb,
    isOptional: fc.boolean(),
    tags: fc.option(fc.constantFrom(['total'], ['balance'], ['signed']), { nil: undefined }),
  }).map(({ type, isConst, isOptional, tags }) => {
    const f: Field = { name, type };
    if (isConst) f.const = true;
    // `?` is illegal on a key field (optional-key), on a list (optional-list) and on a value-typed
    // field (optional-value); this generator never emits key fields here, so only the list and
    // value cases need excluding.
    if (isOptional && type.kind !== 'list' && type.kind !== 'value') f.optional = true;
    if (tags) f.tags = tags;
    return f;
  });
}

// ENTITY fields additionally cover ref and List types (entities carry no explicit invariants,
// so the refsResolve-arm constraint above does not apply to them).
function entityFieldArb(name: string, enumNames: string[], ownerNames: string[]): fc.Arbitrary<Field> {
  const prim: fc.Arbitrary<TypeRef> = fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id')
    .map(p => ({ kind: 'prim' as const, prim: p as any }));
  const scalar: fc.WeightedArbitrary<TypeRef>[] = [{ weight: 4, arbitrary: prim }];
  if (enumNames.length) scalar.push({ weight: 1,
    arbitrary: fc.constantFrom(...enumNames).map(e => ({ kind: 'enum' as const, enum: e })) });
  const options: fc.WeightedArbitrary<TypeRef>[] = [...scalar,
    { weight: 1, arbitrary: fc.oneof(...scalar).map(of => ({ kind: 'list' as const, of })) }];
  if (ownerNames.length) options.push({ weight: 1,
    arbitrary: fc.constantFrom(...ownerNames).map(t => ({ kind: 'ref' as const, target: t })) });
  return fc.tuple(fc.oneof(...options), constDrawArb).map(([type, c]) => {
    const f: Field = { name, type };
    if (c) f.const = true;
    return f;
  });
}

const entityArb = (name: string, enumNames: string[], ownerNames: string[]): fc.Arbitrary<EntityDef> =>
  fc.tuple(uniqNames(camel.filter(n => n !== 'state'), 2, 4), fc.option(docText, { nil: undefined }))
    .chain(([fieldNames, entDoc]) =>
      fc.tuple(...fieldNames.slice(1).map(fn => entityFieldArb(fn, enumNames, ownerNames)))
        .map(rest => {
          const def: EntityDef = { kind: 'entity', name,
            fields: [{ name: fieldNames[0]!, type: { kind: 'prim', prim: 'Id' }, key: true }, ...rest] };
          if (entDoc) def.doc = entDoc;
          return def;
        }));

const cmpOps: Cmp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
function predArb(agg: AggregateDef, enums: { name: string; values: string[] }[], depth: number): fc.Arbitrary<Predicate> {
  const numFields = agg.fields.filter(f => f.type.kind === 'prim' && ['Int', 'Money', 'Date', 'Duration'].includes((f.type as any).prim));
  // Required-only for the same reason as cmpFields below: cmpEnum reads this path inside a cmp,
  // and fieldArb marks enum-typed fields `?` as freely as prim ones.
  const enumFields = agg.fields.filter(f => f.type.kind === 'enum' && !f.optional);
  // Operand pool for cmp/plus terms: required numerics only. An optional path read inside a cmp is
  // `absence-undecided` unless a present() syntactically dominates it (grammar.ts checkAbsence);
  // this generator draws its atoms independently and so never builds that dominance, making any
  // cmp over an optional path a spec the validator rejects. `present` below is the deliberate
  // exception — deciding absence is precisely what it is for, so it keeps the full pool.
  const cmpFields = numFields.filter(f => !f.optional);
  // No fallback to agg.fields when there are no numeric fields: the remaining fields are key /
  // Text/Id (out-of-grammar as paths — see `representable`) or enums (covered by cmpEnum below),
  // so field terms are simply omitted and cmpNum draws from int/now terms only.
  const term: fc.Arbitrary<Term> = fc.oneof(
    ...(cmpFields.length ? [fc.constantFrom(...cmpFields).map(f => ({ kind: 'field' as const, owner: 'self' as const, path: [f.name] }))] : []),
    fc.integer({ min: 0, max: 999 }).map(value => ({ kind: 'int' as const, value })),
    fc.constant({ kind: 'now' as const }));
  const sum: fc.Arbitrary<Term> = fc.oneof({ weight: 4, arbitrary: term },
    { weight: 1, arbitrary: fc.tuple(term, term).map(([left, right]) => ({ kind: 'plus' as const, left, right })) });
  const cmpNum: fc.Arbitrary<Predicate> = fc.tuple(fc.constantFrom(...cmpOps), sum, sum)
    .map(([op, left, right]) => ({ kind: 'cmp' as const, op, left, right }));
  const cmpEnum: fc.Arbitrary<Predicate> | null = enumFields.length ? fc.constantFrom(...enumFields).chain(f => {
    const e = enums.find(x => x.name === (f.type as any).enum)!;
    return fc.constantFrom(...e.values).map(v => ({ kind: 'cmp' as const, op: 'eq' as const,
      left: { kind: 'field' as const, owner: 'self', path: [f.name] },
      right: { kind: 'enumval' as const, enum: e.name, value: v } }));
  }) : null;
  const inState: fc.Arbitrary<Predicate> | null = agg.machine ? fc.constantFrom(...agg.machine.regions).chain(r =>
    fc.uniqueArray(fc.constantFrom(...r.states.map(s => s.name)), { minLength: 1, maxLength: r.states.length })
      .map(states => ({ kind: 'inState' as const, owner: 'self', region: r.name, states }))) : null;
  // present(f): the mirror image of cmpFields — OPTIONAL-only, where that pool is required-only.
  // present() carries no absence obligation of its own (checkAbsence ignores it), but it asks a
  // question a required field cannot answer two ways, which grammar.ts rejects as
  // `present-not-optional`. This is the only shape that exercises `?` fields in a generated
  // predicate at all. The pool must stay numeric-prim: any wider and it risks a key/Text/Id path,
  // which checkPath rejects as key-path/unrepresentable-path.
  const presentFields = numFields.filter(f => f.optional);
  const present: fc.Arbitrary<Predicate> | null = presentFields.length
    ? fc.constantFrom(...presentFields).map(f => ({ kind: 'present' as const, path: [f.name] }))
    : null;
  const atoms = [cmpNum, ...(cmpEnum ? [cmpEnum] : []), ...(inState ? [inState] : []), ...(present ? [present] : [])];
  const atom = fc.oneof(...atoms);
  if (depth <= 0) return atom;
  const sub = predArb(agg, enums, depth - 1);
  const differentKind = (kind: 'and' | 'or') => (args: Predicate[]) => args.every(a => a.kind !== kind);
  return fc.oneof({ weight: 4, arbitrary: atom },
    { weight: 1, arbitrary: fc.array(sub, { minLength: 2, maxLength: 3 }).filter(differentKind('and')).map(args => ({ kind: 'and' as const, args })) },
    { weight: 1, arbitrary: fc.array(sub, { minLength: 2, maxLength: 3 }).filter(differentKind('or')).map(args => ({ kind: 'or' as const, args })) },
    { weight: 1, arbitrary: sub.map(arg => ({ kind: 'not' as const, arg })) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([left, right]) => ({ kind: 'implies' as const, left, right })) });
}

// validateCandidate rejects paths terminating in solver-dropped fields (`key-path` /
// `unrepresentable-path` — keys and Text/Id prims are absent from the solver-facing model), and
// loadLatText treats those diagnostics as parse failures. Generated invariants must only draw
// paths from representable fields or the round-trip property generates unparseable specs.
// Value-typed fields are excluded outright: Task 10 adds surface/AST/printer support only, no
// solver encoding yet (fieldQType/emitOwnerSig drop them, like lists), so a path into one would
// generate an invariant the emitters can't faithfully represent.
// Optional fields are excluded for the same reason at one remove: every form candidateArb draws
// these paths into — monotonic's field, unique's by, conservation's parts/total,
// sumOverCollection's total — has no predicate in which a present() could sit, so validateCandidate
// rejects an optional path outright (`absence-undecided`, grammar.ts). A statePredicate CAN carry
// an optional path legally, under a dominating present(); candidateArb never builds that guard, so
// this pool stays required-only rather than teaching it to.
const representable = (f: Field) =>
  !f.key && !f.optional && f.type.kind !== 'value' && !(f.type.kind === 'prim' && ['Text', 'Id'].includes((f.type as any).prim));

function candidateArb(agg: AggregateDef, enums: { name: string; values: string[] }[]): fc.Arbitrary<Candidate> {
  const paths = agg.fields.filter(representable).map(f => [f.name]);
  const arbs: fc.Arbitrary<Candidate>[] = [
    fc.tuple(predArb(agg, enums, 2), fc.option(predArb(agg, enums, 1), { nil: undefined }))
      .map(([body, where]) => {
        const c: Candidate = { kind: 'statePredicate', aggregate: agg.name, body };
        if (where) (c as any).where = where;
        return c;
      }),
    fc.tuple(fc.option(predArb(agg, enums, 1), { nil: null }), fc.integer({ min: 0, max: 9 }))
      .map(([where, atMost]) => ({ kind: 'cardinality' as const, aggregate: agg.name, where, atMost })),
    // refsResolve is round-trippable as an EXPLICIT invariant only when the aggregate has no ref
    // fields (fieldArb never generates 'ref' types, so every aggregate qualifies today); otherwise
    // loadLatText would drop it as structure-implied (implied.ts) and the round-trip helper would
    // compare against a filtered-out invariant.
    fc.constant({ kind: 'refsResolve' as const, aggregate: agg.name }),
  ];
  if (paths.length) arbs.push(
    fc.constantFrom(...paths).map(field => ({ kind: 'monotonic' as const, aggregate: agg.name, field })));
  if (paths.length >= 3) arbs.push(fc.constant({ kind: 'conservation' as const, aggregate: agg.name,
    parts: [paths[0]!, paths[1]!], total: paths[2]! }));
  const owned = agg.fields.map(f => ({ f, child: ownedCollectionChild(agg, f) })).filter(x => x.child);
  // sumOverCollection's `total` (an own field) rejects an optional path outright — the position has
  // no predicate a present() could sit in (grammar.ts) — so that pool is required-only, for the same
  // reason `representable` above is. The child-field pool needs no such filter: nestedArb strips `?`
  // from child fields because validateModel forbids it there (optional-owned-child) whatever the
  // candidate does with them.
  const required = (f: Field) => !f.optional;
  const numPaths = agg.fields.filter(isNumericPrim).filter(required).map(f => [f.name]);
  if (owned.length && numPaths.length) {
    const numChildFields = owned[0]!.child!.fields.filter(isNumericPrim).map(f => f.name);
    if (numChildFields.length) arbs.push(fc.constantFrom<'eq' | 'le' | 'ge'>('eq', 'le', 'ge').map(op =>
      ({ kind: 'sumOverCollection' as const, aggregate: agg.name, collection: owned[0]!.f.name,
         child: owned[0]!.child!.name, field: numChildFields[0]!, op, total: numPaths[0]! })));
  }
  if (agg.machine) {
    const r = agg.machine.regions[0]!;
    if (paths.length) arbs.push(fc.uniqueArray(fc.constantFrom(...r.states.map(s => s.name)), { minLength: 1, maxLength: 2 })
      .chain(states => fc.uniqueArray(fc.constantFrom(...paths.map(p => p.join('.'))), { minLength: 1, maxLength: 2 })
        .map(by => ({ kind: 'unique' as const, aggregate: agg.name,
          whileStates: { region: r.name, states }, by: by.map(s => s.split('.')) }))));
    arbs.push(fc.tuple(predArb(agg, enums, 1), predArb(agg, enums, 1), docText)
      .map(([from, to, fairness]) => ({ kind: 'leadsTo' as const, aggregate: agg.name, from, to, fairness })));
    // terminal is only round-trippable (as explicit) on a state NOT already tagged terminal — the
    // machine arb below tags exactly the LAST state 'terminal', so pick among the others (always
    // >=1 since states has minLength 2). Property order matches src/engine/templates.ts's { kind, aggregate, region, state }.
    const nonTerminal = r.states.slice(0, -1).map(s => s.name);
    arbs.push(fc.constantFrom(...nonTerminal).map(state =>
      ({ kind: 'terminal' as const, aggregate: agg.name, region: r.name, state })));
  }
  return fc.oneof(...arbs);
}

// AGGREGATE fields eligible as guard operands: prim numeric types only, matching validate's
// own-scalar-only rule (checkGuard) and predArb's numFields filter above.
const isNumericPrim = (f: Field): boolean =>
  f.type.kind === 'prim' && ['Int', 'Money', 'Date', 'Duration'].includes((f.type as any).prim);

// 1–2 regions; per region: 2–4 states (the LAST tagged @terminal — candidateArb's terminal arm
// depends on exactly that), one transition, optionally triggered by a declared event, optionally
// emitting a declared event, and/or guarded by a simple `numField >= <int>` predicate over the
// owning aggregate's own numeric fields (guards are own-scalar-only in v1 — design §3.3/§5.2.1,
// matches checkGuard).
const machineArb = (fieldNames: string[], eventNames: string[], numFieldNames: string[]): fc.Arbitrary<Machine> =>
  uniqNames(camel.filter(n => !fieldNames.includes(n)), 1, 2).chain(regionNames =>
    fc.tuple(
      fc.tuple(...regionNames.map(() => uniqNames(camel, 2, 4))),
      uniqNames(camel, regionNames.length, regionNames.length),
      fc.tuple(...regionNames.map(() => eventNames.length
        ? fc.option(fc.constantFrom(...eventNames), { nil: undefined }) : fc.constant(undefined))),
      fc.tuple(...regionNames.map(() => fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }))),
      fc.tuple(...regionNames.map(() => eventNames.length
        ? fc.option(fc.constantFrom(...eventNames), { nil: undefined }) : fc.constant(undefined))),
    ).map(([statesPer, transNames, whens, guards, emitses]) => ({
      regions: regionNames.map((name, i) => ({ name, initial: statesPer[i]![0]!,
        states: statesPer[i]!.map((s, j): StateDef =>
          j === statesPer[i]!.length - 1 ? { name: s, tags: ['terminal'] } : { name: s }) })),
      transitions: regionNames.map((region, i) => {
        const t: TransitionDef = { name: transNames[i]!, region, from: [statesPer[i]![0]!], to: statesPer[i]![1]! };
        if (whens[i]) t.when = whens[i];
        if (guards[i] !== undefined && numFieldNames.length)
          t.requires = { kind: 'cmp', op: 'ge',
            left: { kind: 'field', owner: 'self', path: [numFieldNames[0]!] },
            right: { kind: 'int', value: guards[i]! } };
        if (emitses[i]) t.emits = emitses[i];
        return t;
      }),
    })));

// Nested entity + owned collection: when `childName` is supplied (caller decides, with
// probability ~1/3, from a name pool disjoint across ALL aggregates — see arbSpec), attach one
// flat child entity to the aggregate and a parent field ranging over it (`List<Child>` → owned
// collection per ownedCollectionChild). Child fields reuse fieldArb (prim/enum only — nested
// children carry no ref/list per nested-entity-flat) with a forced keyed first field, mirroring
// aggArb's own shape.
//
// The `?` marker is stripped from every child field: fieldArb draws it freely, but a field of an
// aggregate-owned child may not be optional (validateModel's optional-owned-child — the solver
// encodings give a child's field no multiplicity of its own). Left in, it would fail the
// round-trip property on a spec the validator rejects, not on parse ∘ print.
const nestedArb = (childName: string | undefined, enums: { name: string; values: string[] }[], fieldNames: string[]): fc.Arbitrary<{ child: EntityDef; collectionField: Field } | null> => {
  if (!childName) return fc.constant(null);
  return fc.tuple(
    camel.filter(n => n !== 'state' && !fieldNames.includes(n)),
    uniqNames(camel.filter(n => n !== 'state'), 1, 3))
    .chain(([collectionFieldName, childFieldNames]) =>
      fc.tuple(...childFieldNames.slice(1).map(fn => fieldArb(fn, enums.map(e => e.name))))
        .map(rest => {
          const required = rest.map(({ optional: _drop, ...f }) => f as Field);
          const child: EntityDef = { kind: 'entity', name: childName,
            fields: [{ name: childFieldNames[0]!, type: { kind: 'prim', prim: 'Id' }, key: true }, ...required] };
          const collectionField: Field = { name: collectionFieldName,
            type: { kind: 'list', of: { kind: 'ref', target: childName } } };
          return { child, collectionField };
        }));
};

// Value type (design §3.5): flat prim fields only (no enum in v1's own generation — kept simple),
// plus an optional own-field invariant when there are >= 2 numeric fields, in the
// `firstNumeric < secondNumeric`-style shape the brief calls out (mirrors Period.wellOrdered).
const valueArb = (name: string): fc.Arbitrary<ValueDef> =>
  fc.tuple(uniqNames(camel, 2, 3), fc.option(docText, { nil: undefined }))
    .chain(([fieldNames, valDoc]) =>
      fc.tuple(...fieldNames.map(fn => fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id')
        .map(p => ({ name: fn, type: { kind: 'prim' as const, prim: p as any } } as Field))))
        .chain(fields => {
          const numeric = fields.filter(isNumericPrim).map(f => f.name);
          const wantsInvariant = numeric.length >= 2;
          return fc.tuple(wantsInvariant ? fc.boolean() : fc.constant(false), camel)
            .map(([addInv, invName]) => {
              const def: ValueDef = { kind: 'value', name, fields };
              if (valDoc) def.doc = valDoc;
              if (addInv) def.invariants = [{ name: invName,
                body: { kind: 'cmp', op: 'lt',
                  left: { kind: 'field', owner: 'self', path: [numeric[0]!] },
                  right: { kind: 'field', owner: 'self', path: [numeric[1]!] } } }];
              return def;
            });
        }));

const aggArb = (name: string, enums: { name: string; values: string[] }[], eventNames: string[], childName?: string, valueName?: string): fc.Arbitrary<AggregateDef> =>
  fc.tuple(uniqNames(camel.filter(n => n !== 'state'), 2, 4), fc.boolean(), fc.option(docText, { nil: undefined }))
    .chain(([fieldNames, hasMachine, aggDoc]) =>
      fc.tuple(...fieldNames.slice(1).map(fn => fieldArb(fn, enums.map(e => e.name), valueName ? [valueName] : [])))
        .chain(rest =>
          nestedArb(childName, enums, fieldNames).chain(nested => {
            const fields: Field[] = [{ name: fieldNames[0]!, type: { kind: 'prim', prim: 'Id' }, key: true }, ...rest];
            const base: AggregateDef = { kind: 'aggregate', name, fields };
            if (nested) { base.fields = [...fields, nested.collectionField]; base.entities = [nested.child]; }
            if (aggDoc) base.doc = aggDoc;
            if (!hasMachine) return fc.constant(base);
            return machineArb(fieldNames, eventNames, rest.filter(isNumericPrim).map(f => f.name))
              .map(machine => ({ ...base, machine }));
          })));

// event field: simple prim-typed field, no ref/enum wiring.
const eventFieldArb = (name: string): fc.Arbitrary<Field> =>
  fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id')
    .map(prim => ({ name, type: { kind: 'prim' as const, prim: prim as any } }));

const eventArb = (name: string): fc.Arbitrary<EventDef> =>
  fc.tuple(uniqNames(camel, 0, 2), fc.option(docText, { nil: undefined }))
    .chain(([fieldNames, evDoc]) =>
      fc.tuple(...fieldNames.map(fn => eventFieldArb(fn)))
        .map(fields => {
          const ev: EventDef = { name, fields };
          if (evDoc) ev.doc = evDoc;
          return ev;
        }));

// Service (design §3.6, Task 12): carried structure only — every `performs` method targets a
// transition drawn from the generated aggregates (so it always round-trips), plus one `read-only`
// method with no target. A param-guard is drawn only when the target aggregate has a numeric field
// (matching validate's own-scalar-only rule): `field >= param`, mirroring machineArb's own
// `numField >= <int>` guard shape one level up.
const paramArb: fc.Arbitrary<ParamDef> = fc.tuple(camel, fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Id'))
  .map(([n, prim]) => ({ name: n, type: { kind: 'prim' as const, prim: prim as any } }));

// read-only method: params only, no target aggregate — no field guard is possible (validate
// treats any field reference in a read-only guard as scope-leaving), so its optional guard (when
// present) draws a param+param or param+int comparison only.
const readOnlyMethodArb = (name: string): fc.Arbitrary<MethodDef> =>
  fc.tuple(uniqNames(camel, 0, 2)).chain(([paramNames]) =>
    fc.tuple(...paramNames.map(() => paramArb)).chain(params => {
      const numericParams = params.filter(p => p.type.kind === 'prim' && ['Int', 'Money', 'Date', 'Duration'].includes(p.type.prim));
      const guardArb: fc.Arbitrary<Predicate | null> = numericParams.length
        ? fc.option(fc.constantFrom(...numericParams).map(p => ({ kind: 'cmp' as const, op: 'ge' as const,
            left: { kind: 'param' as const, name: p.name }, right: { kind: 'int' as const, value: 0 } })), { nil: null })
        : fc.constant(null);
      return guardArb.map(requires => {
        const def: MethodDef = { name, params, kind: { readOnly: true } };
        if (requires) def.requires = requires;
        return def;
      });
    }));

function methodArb(name: string, aggs: AggregateDef[]): fc.Arbitrary<MethodDef> {
  const targets = aggs.filter(a => a.machine && a.machine.transitions.length > 0);
  if (!targets.length) return readOnlyMethodArb(name);   // no aggregate has a machine to perform against
  return fc.constantFrom(...targets).chain(agg => {
    const t = agg.machine!.transitions[0]!;
    const numFields = agg.fields.filter(isNumericPrim);
    // param name must be disjoint from the target aggregate's own field names — a same-named
    // param and field are both legal individually, but `field >= param` prints as `o >= o` (both
    // sides identically spelled) and re-parses as param-shadows-field on BOTH occurrences,
    // an irrecoverable surface-syntax collision (params shadow fields — service.md).
    const fieldNames = new Set(agg.fields.map(f => f.name));
    const distinctParamArb = paramArb.filter(p => !fieldNames.has(p.name));
    const guardArb: fc.Arbitrary<{ param: ParamDef; requires: Predicate } | null> = numFields.length
      ? fc.option(fc.tuple(distinctParamArb, fc.constantFrom(...numFields)).map(([param, f]) => ({ param,
          requires: { kind: 'cmp' as const, op: 'ge' as const,
            left: { kind: 'field' as const, owner: 'self', path: [f.name] },
            right: { kind: 'param' as const, name: param.name } } })), { nil: null })
      : fc.constant(null);
    return guardArb.map(guard => {
      const params = guard ? [guard.param] : [];
      const def: MethodDef = { name, params, kind: { performs: { aggregate: agg.name, transition: t.name } } };
      if (guard) def.requires = guard.requires;
      return def;
    });
  });
}

const serviceArb = (name: string, aggs: AggregateDef[]): fc.Arbitrary<ServiceDef> =>
  fc.tuple(uniqNames(camel.filter(n => n !== 'peek'), 1, 2), fc.option(docText, { nil: undefined }))
    .chain(([methodNames, svcDoc]) =>
      fc.tuple(...methodNames.map(mn => methodArb(mn, aggs)), readOnlyMethodArb('peek'))
        .map(methods => {
          const def: ServiceDef = { name, methods };
          if (svcDoc) def.doc = svcDoc;
          return def;
        }));

// Final stage of arbSpec's chain (Task 10 pulled it out to a named function to keep the deep
// fc.tuple/.chain nesting above it manageable): given every drawn name-scoped piece, generates the
// per-aggregate candidate invariants and assembles { model, invariants }.
function finalSpecArb(context: string, doc: string | undefined, ticksPerDay: number | undefined,
    enums: { name: string; values: string[] }[], aggs: AggregateDef[], entities: EntityDef[],
    events: EventDef[], values: ValueDef[], services: ServiceDef[]): fc.Arbitrary<{ model: DomainModel; invariants: CandidateInvariant[] }> {
  const model: DomainModel = { context, enums, values, entities: [...entities], aggregates: [...aggs], events: [...events], services };
  if (doc) model.doc = doc;
  if (ticksPerDay !== undefined) model.ticksPerDay = ticksPerDay;
  return fc.tuple(...aggs.map(a =>
    fc.array(fc.tuple(camel, fc.option(docText, { nil: undefined }), candidateArb(a, enums)), { maxLength: 2 })))
    .map(perAgg => {
      const used = new Set<string>();
      const invariants: CandidateInvariant[] = [];
      for (const list of perAgg) for (const [nm, d, candidate] of list) {
        if (used.has(nm)) continue;
        used.add(nm);
        const inv: CandidateInvariant = { id: `hand-${nm}`, name: nm, prior: 1, source: 'template', candidate };
        if (d) inv.doc = d;
        invariants.push(inv);
      }
      return { model, invariants };
    });
}

export const arbSpec: fc.Arbitrary<{ model: DomainModel; invariants: CandidateInvariant[] }> =
  // context name stays `pascal`: a context is not a type, so `context Id {}` is unambiguous
  fc.tuple(pascal, uniqNames(typeName, 0, 2), fc.option(docText, { nil: undefined }))
    .chain(([ctx, enumNames, topDoc]) =>
      fc.tuple(
        fc.constant(ctx), fc.constant(topDoc),
        fc.array(fc.tuple(fc.constant(0), uniqNames(camel, 1, 3)), { minLength: enumNames.length, maxLength: enumNames.length })
          .map(vals => enumNames.map((name, i) => ({ name, values: vals[i]![1] }))),
        uniqNames(typeName.filter(n => !enumNames.includes(n)), 1, 2))
      .chain(([context, doc, enums, aggNames]) =>
        // owner/event NAMES first (all mutually disjoint) so machines can reference events
        // via `when` and entity fields can `ref` any owner
        fc.tuple(
          uniqNames(typeName.filter(n => !enumNames.includes(n) && !aggNames.includes(n)), 0, 2),
          fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }))
        .chain(([entityNames, ticksPerDay]) =>
          // event names stay `pascal` (not `typeName`): no type expression resolves to an event, so
          // a prim-named event is unambiguous and validateModel allows it — worth covering
          uniqNames(pascal.filter(n => !enumNames.includes(n) && !aggNames.includes(n) && !entityNames.includes(n)), 0, 2)
          .chain(eventNames =>
            // nested-entity child names: disjoint from every top-level name AND from each other
            // (validate's duplicate-name pool is flat across enum/entity/aggregate/nested-entity
            // names), one optional slot per aggregate, each drawn ~1/3 of the time.
            uniqNames(typeName.filter(n => !enumNames.includes(n) && !aggNames.includes(n)
              && !entityNames.includes(n) && !eventNames.includes(n)), 0, aggNames.length)
            .chain(childNamePool =>
            // optional single value type (Task 10, design §3.5), name disjoint from every other
            // top-level name; drawn ~1/2 the time and, when present, made eligible as a field type
            // on every aggregate (fieldArb decides per-field, at low weight, whether to use it).
            fc.option(typeName.filter(n => !enumNames.includes(n) && !aggNames.includes(n)
              && !entityNames.includes(n) && !eventNames.includes(n) && !childNamePool.includes(n)),
              { nil: undefined })
            .chain(valueName =>
            // optional single service (design §3.6, Task 12), name disjoint from every other
            // top-level name (incl. the value name); drawn ~1/2 the time. Its methods are
            // generated AFTER the aggregates (see the .chain below) so `performs` always targets
            // a transition that actually exists.
            fc.option(pascal.filter(n => !enumNames.includes(n) && !aggNames.includes(n)
              && !entityNames.includes(n) && !eventNames.includes(n) && !childNamePool.includes(n) && n !== valueName),
              { nil: undefined })
            .chain(serviceName => {
              const valuesArb: fc.Arbitrary<ValueDef[]> = valueName ? valueArb(valueName).map(v => [v]) : fc.constant([]);
              return fc.tuple(...aggNames.map(() => fc.boolean()))
                .chain(wantsChild => {
                  let pi = 0;
                  const childNames = wantsChild.map(w => w && pi < childNamePool.length ? childNamePool[pi++] : undefined);
                  return fc.tuple(
                    fc.tuple(...aggNames.map((name, i) => aggArb(name, enums, eventNames, childNames[i], valueName))),
                    fc.tuple(...entityNames.map(name =>
                      entityArb(name, enums.map(e => e.name), [...aggNames, ...entityNames]))),
                    fc.tuple(...eventNames.map(name => eventArb(name))),
                    valuesArb);
                })
                .chain(([aggs, entities, events, values]) => {
                  const servicesArb: fc.Arbitrary<ServiceDef[]> = serviceName ? serviceArb(serviceName, aggs).map(s => [s]) : fc.constant([]);
                  return servicesArb.chain(services =>
                    finalSpecArb(context, doc, ticksPerDay, enums, aggs, entities, events, values, services));
                });
            })))))));

export const arbContextMap: fc.Arbitrary<ContextMapModel> = (() => {
  const name = (i: number) => `Ctx${i}`;
  return fc.tuple(
    fc.integer({ min: 2, max: 5 }),                      // context count
    fc.array(fc.record({
      li: fc.nat(4), ri: fc.nat(4),
      kind: fc.constantFrom<RelationshipKind>('upstreamDownstream', 'partnership', 'sharedKernel'),
      up: fc.subarray<Role>(['openHost', 'publishedLanguage']),
      down: fc.subarray<Role>(['anticorruption', 'conformist']),
      exposes: fc.subarray(['Alpha', 'Beta', 'Gamma']),
      doc: fc.option(fc.constant('a relationship doc'), { nil: undefined }),
    }), { maxLength: 4 }),
    fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),   // explicit-path flags
    fc.option(docText, { nil: undefined }),                   // top-level map doc
  ).map(([n, rels, explicit, mapDoc]) => ({
    name: 'MapUnderTest',
    ...(mapDoc ? { doc: mapDoc } : {}),
    contexts: Array.from({ length: n }, (_, i) => ({
      name: name(i), path: explicit[i] ? `custom/p${i}` : defaultPath(name(i)) })),
    relationships: rels
      .map(r => ({ ...r, li: r.li % n, ri: r.ri % n }))
      .filter(r => r.li !== r.ri)
      .map(r => {
        const rel: Relationship = { kind: r.kind, left: name(r.li), right: name(r.ri) };
        if (r.kind === 'upstreamDownstream') {
          if (r.up.length) rel.upstreamRoles = r.up;
          if (r.down.length) rel.downstreamRoles = r.down;
        }
        if (r.exposes.length) rel.exposes = r.exposes;
        if (r.doc) rel.doc = r.doc;
        return rel;
      }),
  }));
})();
