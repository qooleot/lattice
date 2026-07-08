import fc from 'fast-check';
import type { DomainModel, AggregateDef, EntityDef, Field, EventDef, Machine, StateDef,
  TransitionDef, TypeRef } from '../../src/ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term, Cmp } from '../../src/ast/invariant.js';
import { RESERVED_WORDS as RESERVED } from '../../src/ast/reserved.js';
import type { ContextMapModel, Relationship, RelationshipKind, Role } from '../../src/ast/contextmap.js';
import { defaultPath } from '../../src/ast/contextmap.js';

const lower = 'abcdefghijklmnopqrstuvwxyz';
const ident = (first: string) => fc.tuple(
  fc.constantFrom(...first.split('')),
  fc.string({ unit: fc.constantFrom(...(lower + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').split('')), maxLength: 6 }))
  .map(([a, b]) => a + b).filter(s => !RESERVED.has(s));
const camel = ident(lower);
const pascal = ident('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const uniqNames = (arb: fc.Arbitrary<string>, min: number, max: number) =>
  fc.uniqueArray(arb, { minLength: min, maxLength: max });

const docText = fc.string({ unit: fc.constantFrom(...'abc XYZ,.'.split('')), minLength: 1, maxLength: 30 })
  .map(s => s.trim()).filter(s => s.length > 0);

// AGGREGATE fields: prim/enum only — never 'ref'. candidateArb's refsResolve arm depends on
// this (see its comment); roundtrip.test.ts asserts the invariant executably.
export function fieldArb(name: string, enumNames: string[]): fc.Arbitrary<Field> {
  const prim = fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id').map(p => ({ kind: 'prim' as const, prim: p as any }));
  const type = enumNames.length
    ? fc.oneof({ weight: 3, arbitrary: prim }, { weight: 1, arbitrary: fc.constantFrom(...enumNames).map(e => ({ kind: 'enum' as const, enum: e })) })
    : prim;
  return fc.record({
    type,
    tags: fc.option(fc.constantFrom(['total'], ['balance'], ['signed']), { nil: undefined }),
  }).map(({ type, tags }) => {
    const f: Field = { name, type };
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
  return fc.oneof(...options).map(type => ({ name, type }));
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
  const enumFields = agg.fields.filter(f => f.type.kind === 'enum');
  // No fallback to agg.fields when there are no numeric fields: the remaining fields are key /
  // Text/Id (out-of-grammar as paths — see `representable`) or enums (covered by cmpEnum below),
  // so field terms are simply omitted and cmpNum draws from int/now terms only.
  const term: fc.Arbitrary<Term> = fc.oneof(
    ...(numFields.length ? [fc.constantFrom(...numFields).map(f => ({ kind: 'field' as const, owner: 'self' as const, path: [f.name] }))] : []),
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
  const atoms = [cmpNum, ...(cmpEnum ? [cmpEnum] : []), ...(inState ? [inState] : [])];
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
const representable = (f: Field) =>
  !f.key && !(f.type.kind === 'prim' && ['Text', 'Id'].includes((f.type as any).prim));

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
// depends on exactly that), one transition, optionally triggered by a declared event and/or
// guarded by a simple `numField >= <int>` predicate over the owning aggregate's own numeric
// fields (guards are own-scalar-only in v1 — design §3.3/§5.2.1, matches checkGuard).
const machineArb = (fieldNames: string[], eventNames: string[], numFieldNames: string[]): fc.Arbitrary<Machine> =>
  uniqNames(camel.filter(n => !fieldNames.includes(n)), 1, 2).chain(regionNames =>
    fc.tuple(
      fc.tuple(...regionNames.map(() => uniqNames(camel, 2, 4))),
      uniqNames(camel, regionNames.length, regionNames.length),
      fc.tuple(...regionNames.map(() => eventNames.length
        ? fc.option(fc.constantFrom(...eventNames), { nil: undefined }) : fc.constant(undefined))),
      fc.tuple(...regionNames.map(() => fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }))),
    ).map(([statesPer, transNames, whens, guards]) => ({
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
        return t;
      }),
    })));

const aggArb = (name: string, enums: { name: string; values: string[] }[], eventNames: string[]): fc.Arbitrary<AggregateDef> =>
  fc.tuple(uniqNames(camel.filter(n => n !== 'state'), 2, 4), fc.boolean(), fc.option(docText, { nil: undefined }))
    .chain(([fieldNames, hasMachine, aggDoc]) =>
      fc.tuple(...fieldNames.slice(1).map(fn => fieldArb(fn, enums.map(e => e.name))))
        .chain(rest => {
          const fields: Field[] = [{ name: fieldNames[0]!, type: { kind: 'prim', prim: 'Id' }, key: true }, ...rest];
          const base: AggregateDef = { kind: 'aggregate', name, fields };
          if (aggDoc) base.doc = aggDoc;
          if (!hasMachine) return fc.constant(base);
          return machineArb(fieldNames, eventNames, rest.filter(isNumericPrim).map(f => f.name))
            .map(machine => ({ ...base, machine }));
        }));

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

export const arbSpec: fc.Arbitrary<{ model: DomainModel; invariants: CandidateInvariant[] }> =
  fc.tuple(pascal, uniqNames(pascal, 0, 2), fc.option(docText, { nil: undefined }))
    .chain(([ctx, enumNames, topDoc]) =>
      fc.tuple(
        fc.constant(ctx), fc.constant(topDoc),
        fc.array(fc.tuple(fc.constant(0), uniqNames(camel, 1, 3)), { minLength: enumNames.length, maxLength: enumNames.length })
          .map(vals => enumNames.map((name, i) => ({ name, values: vals[i]![1] }))),
        uniqNames(pascal.filter(n => !enumNames.includes(n)), 1, 2))
      .chain(([context, doc, enums, aggNames]) =>
        // owner/event NAMES first (all mutually disjoint) so machines can reference events
        // via `when` and entity fields can `ref` any owner
        fc.tuple(
          uniqNames(pascal.filter(n => !enumNames.includes(n) && !aggNames.includes(n)), 0, 2),
          fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }))
        .chain(([entityNames, ticksPerDay]) =>
          uniqNames(pascal.filter(n => !enumNames.includes(n) && !aggNames.includes(n) && !entityNames.includes(n)), 0, 2)
          .chain(eventNames =>
            fc.tuple(
              fc.tuple(...aggNames.map(name => aggArb(name, enums, eventNames))),
              fc.tuple(...entityNames.map(name =>
                entityArb(name, enums.map(e => e.name), [...aggNames, ...entityNames]))),
              fc.tuple(...eventNames.map(name => eventArb(name))))
            .chain(([aggs, entities, events]) => {
              const model: DomainModel = { context, enums, entities: [...entities], aggregates: [...aggs], events: [...events] };
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
            })))));

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
  ).map(([n, rels, explicit]) => ({
    name: 'MapUnderTest',
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
