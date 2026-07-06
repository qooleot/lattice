import fc from 'fast-check';
import type { DomainModel, AggregateDef, Field, EventDef } from '../../src/ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term, Cmp } from '../../src/ast/invariant.js';

const RESERVED = new Set(['context', 'enum', 'entity', 'aggregate', 'event', 'machine', 'region', 'states',
  'transition', 'from', 'to', 'when', 'invariant', 'on', 'where', 'unique', 'while', 'by', 'refs', 'resolve',
  'count', 'terminal', 'monotonic', 'conserve', 'leads', 'under', 'fairness', 'state', 'now', 'ref', 'List',
  'key', 'ticksPerDay', 'in']);
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

function fieldArb(name: string, enumNames: string[]): fc.Arbitrary<Field> {
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

const cmpOps: Cmp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
function predArb(agg: AggregateDef, enums: { name: string; values: string[] }[], depth: number): fc.Arbitrary<Predicate> {
  const numFields = agg.fields.filter(f => f.type.kind === 'prim' && ['Int', 'Money', 'Date', 'Duration'].includes((f.type as any).prim));
  const enumFields = agg.fields.filter(f => f.type.kind === 'enum');
  const term: fc.Arbitrary<Term> = fc.oneof(
    fc.constantFrom(...(numFields.length ? numFields : agg.fields)).map(f => ({ kind: 'field' as const, owner: 'self', path: [f.name] })),
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

function candidateArb(agg: AggregateDef, enums: { name: string; values: string[] }[]): fc.Arbitrary<Candidate> {
  const paths = agg.fields.map(f => [f.name]);
  const arbs: fc.Arbitrary<Candidate>[] = [
    fc.tuple(predArb(agg, enums, 2), fc.option(predArb(agg, enums, 1), { nil: undefined }))
      .map(([body, where]) => {
        const c: Candidate = { kind: 'statePredicate', aggregate: agg.name, body };
        if (where) (c as any).where = where;
        return c;
      }),
    fc.tuple(fc.option(predArb(agg, enums, 1), { nil: null }), fc.integer({ min: 0, max: 9 }))
      .map(([where, atMost]) => ({ kind: 'cardinality' as const, aggregate: agg.name, where, atMost })),
    fc.constantFrom(...paths).map(field => ({ kind: 'monotonic' as const, aggregate: agg.name, field })),
    // refsResolve is round-trippable as an EXPLICIT invariant only when the aggregate has no ref
    // fields (fieldArb never generates 'ref' types, so every aggregate qualifies today); otherwise
    // loadLatText would drop it as structure-implied (implied.ts) and the round-trip helper would
    // compare against a filtered-out invariant.
    fc.constant({ kind: 'refsResolve' as const, aggregate: agg.name }),
  ];
  if (paths.length >= 3) arbs.push(fc.constant({ kind: 'conservation' as const, aggregate: agg.name,
    parts: [paths[0]!, paths[1]!], total: paths[2]! }));
  if (agg.machine) {
    const r = agg.machine.regions[0]!;
    arbs.push(fc.uniqueArray(fc.constantFrom(...r.states.map(s => s.name)), { minLength: 1, maxLength: 2 })
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

// event field: simple prim-typed field, no ref/enum wiring (validateModel only checks `when`
// references, which we never generate — see events below).
const eventFieldArb = (name: string): fc.Arbitrary<Field> =>
  fc.constantFrom('Int', 'Money', 'Date', 'Duration', 'Text', 'Id')
    .map(prim => ({ name, type: { kind: 'prim' as const, prim: prim as any } }));

const eventArb = (name: string): fc.Arbitrary<EventDef> =>
  uniqNames(camel, 0, 2).chain(fieldNames =>
    fc.tuple(...fieldNames.map(fn => eventFieldArb(fn))))
    .map(fields => ({ name, fields }));

export const arbSpec: fc.Arbitrary<{ model: DomainModel; invariants: CandidateInvariant[] }> =
  fc.tuple(pascal, uniqNames(pascal, 0, 2), fc.option(docText, { nil: undefined }))
    .chain(([ctx, enumNames, topDoc]) =>
      fc.tuple(
        fc.constant(ctx), fc.constant(topDoc),
        fc.array(fc.tuple(fc.constant(0), uniqNames(camel, 1, 3)), { minLength: enumNames.length, maxLength: enumNames.length })
          .map(vals => enumNames.map((name, i) => ({ name, values: vals[i]![1] }))),
        uniqNames(pascal.filter(n => !enumNames.includes(n)), 1, 2))
      .chain(([context, doc, enums, aggNames]) =>
        fc.tuple(...aggNames.map(name =>
          fc.tuple(uniqNames(camel.filter(n => n !== 'state'), 2, 4), fc.boolean(), fc.option(docText, { nil: undefined }))
            .chain(([fieldNames, hasMachine, aggDoc]) =>
              fc.tuple(...fieldNames.slice(1).map(fn => fieldArb(fn, enums.map(e => e.name))))
                .chain(rest => {
                  const fields: Field[] = [{ name: fieldNames[0]!, type: { kind: 'prim', prim: 'Id' }, key: true }, ...rest];
                  const base: AggregateDef = { kind: 'aggregate', name, fields };
                  if (aggDoc) base.doc = aggDoc;
                  if (!hasMachine) return fc.constant(base);
                  return fc.tuple(camel.filter(n => !fieldNames.includes(n)), uniqNames(camel, 2, 4), camel)
                    .map(([regionName, stateNames, transName]) => ({ ...base, machine: {
                      regions: [{ name: regionName, initial: stateNames[0]!, states: stateNames.map((s, i) => {
                        const st: any = { name: s };
                        if (i === stateNames.length - 1) st.tags = ['terminal'];
                        return st;
                      }) }],
                      transitions: [{ name: transName, region: regionName, from: stateNames[0]!, to: stateNames[1]! }] } } as AggregateDef));
                }))))
        .chain(aggs =>
          fc.tuple(
            uniqNames(pascal.filter(n => !enumNames.includes(n) && !aggNames.includes(n)), 0, 2),
            fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }))
          .chain(([eventNames, ticksPerDay]) =>
            fc.tuple(...eventNames.map(name => eventArb(name)))
              .map((events): [AggregateDef[], EventDef[], number | undefined] => [aggs, events, ticksPerDay])))
        .chain(([aggs, events, ticksPerDay]) => {
          const model: DomainModel = { context, enums, entities: [], aggregates: [...aggs], events };
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
        })));
