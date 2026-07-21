import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import { PRIM_NAMES } from '../../src/ast/reserved.js';
import { astToCode } from '../../src/emit/code.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import type { DomainModel } from '../../src/ast/domain.js';

const good: DomainModel = {
  context: 'Billing', ticksPerDay: 24,
  enums: [{ name: 'Status', values: ['Paid', 'Unpaid'] }], values: [],
  entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
  aggregates: [{
    kind: 'aggregate', name: 'Subscription',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
      { name: 'status', type: { kind: 'enum', enum: 'Status' } }
    ],
    machine: {
      regions: [{ name: 'Access', initial: 'Trialing', states: [{ name: 'Trialing' }, { name: 'Active', tags: ['active'] }, { name: 'Ended', tags: ['terminal'] }] }],
      transitions: [{ name: 'activate', region: 'Access', from: ['Trialing'], to: 'Active', when: 'PaymentSucceeded' }]
    }
  }],
  events: [{ name: 'PaymentSucceeded', fields: [] }], services: []
};

describe('validateModel rejects grammar-keyword identifiers (spec §3.4 conformance)', () => {
  it('allows a field named "count" (in the FieldName carve-out)', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields.push({ name: 'count', type: { kind: 'prim', prim: 'Int' } });
    expect(validateModel(m).map(d => d.code)).not.toContain('reserved-word');
  });

  it('still rejects a field named "entity" (a reserved word NOT in the FieldName carve-out)', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields.push({ name: 'entity', type: { kind: 'prim', prim: 'Int' } });
    const d = validateModel(m).find(x => x.code === 'reserved-word');
    expect(d).toBeDefined();
    expect(d!.message).toContain("'entity'");
  });

  it('rejects a "state" field on a machine-bearing aggregate but allows it on a machineless type', () => {
    const onAgg = structuredClone(good);
    onAgg.aggregates[0]!.fields.push({ name: 'state', type: { kind: 'prim', prim: 'Text' } });
    expect(validateModel(onAgg).map(d => d.code)).toContain('reserved-field-name');

    const onEntity = structuredClone(good);
    onEntity.entities[0]!.fields.push({ name: 'state', type: { kind: 'prim', prim: 'Text' } });
    const entityCodes = validateModel(onEntity).map(d => d.code);
    expect(entityCodes).not.toContain('reserved-field-name');
    expect(entityCodes).not.toContain('reserved-word');
  });

  it('rejects an aggregate named "terminal"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.name = 'terminal';
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('rejects an enum value named "from"', () => {
    const m = structuredClone(good);
    m.enums[0]!.values.push('from');
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('rejects a machine region named "state"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.regions[0]!.name = 'state';
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('rejects a transition named "to"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.machine!.transitions[0]!.name = 'to';
    expect(validateModel(m).map(d => d.code)).toContain('reserved-word');
  });

  it('accepts the well-formed model with no reserved names', () => {
    expect(validateModel(good).map(d => d.code)).not.toContain('reserved-word');
  });
});

/**
 * A prim name used as a declaration name is genuinely ambiguous in the surface syntax, not merely
 * awkward: lat.langium has no prim production at all — every named type parses as one
 * `NamedType: name=ID`, and the prim/declared split happens after parsing in fromLangium's mapType,
 * which resolves prim-first. So `value Id {...}` makes the type expression `Id` denote two things
 * with no spelling that separates them, and the declared one is unreachable. Distinct from
 * `reserved-word`: those names cannot lex as ID, these lex fine but resolve to the wrong type.
 */
describe('validateModel rejects prim names as declaration names (round-trip ambiguity)', () => {
  it('rejects a value named "Id" — the collision the round-trip property surfaces', () => {
    const m = structuredClone(good);
    m.values.push({ kind: 'value', name: 'Id', fields: [{ name: 'a', type: { kind: 'prim', prim: 'Int' } }] });
    const diags = validateModel(m);
    expect(diags.map(d => d.code)).toContain('reserved-prim-name');
    const d = diags.find(x => x.code === 'reserved-prim-name')!;
    expect(d.message).toContain("'Id'");
  });

  it('rejects every prim name across each declaration kind in the type namespace', () => {
    for (const p of PRIM_NAMES) {
      const enumM = structuredClone(good);
      enumM.enums.push({ name: p, values: ['A'] });
      expect(validateModel(enumM).map(d => d.code), `enum ${p}`).toContain('reserved-prim-name');

      const valueM = structuredClone(good);
      valueM.values.push({ kind: 'value', name: p, fields: [{ name: 'a', type: { kind: 'prim', prim: 'Int' } }] });
      expect(validateModel(valueM).map(d => d.code), `value ${p}`).toContain('reserved-prim-name');

      const entityM = structuredClone(good);
      entityM.entities[0]!.name = p;
      entityM.aggregates[0]!.fields[1]!.type = { kind: 'ref', target: p };
      expect(validateModel(entityM).map(d => d.code), `entity ${p}`).toContain('reserved-prim-name');

      const aggM = structuredClone(good);
      aggM.aggregates[0]!.name = p;
      expect(validateModel(aggM).map(d => d.code), `aggregate ${p}`).toContain('reserved-prim-name');
    }
  });

  it('rejects an aggregate-nested entity named "Money"', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.entities = [{ kind: 'entity', name: 'Money',
      fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }];
    expect(validateModel(m).map(d => d.code)).toContain('reserved-prim-name');
  });

  it('reports a nested entity name once — the prim rule shares the one existing check site', () => {
    // the child name is checked inside the aggregate field walk, not the declaration loop; adding a
    // second call site there would double-report every reserved-word on a nested child
    const m = structuredClone(good);
    m.aggregates[0]!.entities = [{ kind: 'entity', name: 'count',
      fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }];
    expect(validateModel(m).filter(d => d.code === 'reserved-word')).toHaveLength(1);
  });

  it('covers entity/aggregate to stop the bare-form trap, not to fix a round-trip', () => {
    // Unlike value/enum, a ref prints as `ref Id` (emit/code.ts), which is unambiguous — so a
    // prim-named entity would survive print∘parse. It is rejected anyway because mapType's
    // bare-name `owners` branch is unreachable for it: `foo : Id` meaning the entity silently
    // yields prim Id. This test pins the *reason*, so narrowing the rule stays a deliberate choice.
    const m = structuredClone(good);
    m.entities[0]!.name = 'Id';
    m.aggregates[0]!.fields[1]!.type = { kind: 'ref', target: 'Id' };
    expect(validateModel(m).map(d => d.code)).toContain('reserved-prim-name');

    // the unambiguous spelling the rule forgoes: `ref Id` prints and would parse straight back
    const withoutRule = astToCode({ ...m, entities: [{ ...m.entities[0]!, name: 'Legacy' }],
      aggregates: [{ ...m.aggregates[0]!, fields: m.aggregates[0]!.fields.map(f =>
        f.name === 'customer' ? { ...f, type: { kind: 'ref' as const, target: 'Legacy' } } : f) }] }, []);
    expect(withoutRule).toContain('ref Legacy');
  });

  it('allows a prim name as a field name — fields are not a type position, so nothing is ambiguous', () => {
    const m = structuredClone(good);
    m.aggregates[0]!.fields.push({ name: 'Money', type: { kind: 'prim', prim: 'Money' } });
    expect(validateModel(m).map(d => d.code)).not.toContain('reserved-prim-name');
  });

  it('allows an event and a service named "Id" — neither is reachable from a type position', () => {
    const m = structuredClone(good);
    m.events.push({ name: 'Id', fields: [] });
    m.services.push({ name: 'Date', methods: [] });
    expect(validateModel(m).map(d => d.code)).not.toContain('reserved-prim-name');
  });

  it('accepts the well-formed model, whose fields legitimately use prims as types', () => {
    expect(validateModel(good).map(d => d.code)).not.toContain('reserved-prim-name');
  });

  it('is the rule that makes round-trip identity recoverable for the colliding model', () => {
    // Before this rule, validateModel accepted this model and astToCode printed `pN4rvd1 : Id key`
    // and `mY5B : Id const` — byte-identical type expressions denoting prim Id and value Id. The
    // print∘parse fixed point is unrecoverable for it at any layer, so rejecting it is the fix.
    const m: DomainModel = {
      context: 'T2', ticksPerDay: 2, enums: [], entities: [], events: [], services: [],
      values: [{ kind: 'value', name: 'Id', fields: [{ name: 'a', type: { kind: 'prim', prim: 'Int' } }] }],
      aggregates: [{ kind: 'aggregate', name: 'SXdW', fields: [
        { name: 'pN4rvd1', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'mY5B', type: { kind: 'value', value: 'Id' }, const: true }] }]
    };
    expect(validateModel(m).map(d => d.code)).toContain('reserved-prim-name');

    // The ambiguity is real and unfixable downstream: astToCode has no spelling that separates the
    // two, so it prints the key field (prim Id) and the const field (value Id) identically.
    const text = astToCode(m, []);
    expect(text).toContain('pN4rvd1 : Id key');
    expect(text).toContain('mY5B    : Id const');

    // Since loadLatText runs validateModel, the rule also guards the parse boundary — a
    // hand-authored .lat declaring `value Id` is rejected rather than silently resolving to the
    // prim. That closes the same hole for text the generator never produced.
    const r = loadLatText(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.map(d => d.code)).toContain('reserved-prim-name');
  });
});
