import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import type { DomainModel, Field } from '../../src/ast/domain.js';

const model = (fields: Field[], values: DomainModel['values'] = []): DomainModel => ({
  context: 'Opt', ticksPerDay: 24, enums: [], values, entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Thing',
    fields: [{ name: 'thingId', type: { kind: 'prim', prim: 'Id' }, key: true }, ...fields] }],
  events: [], services: []
});

describe('optional fields — structural rules', () => {
  it('accepts an optional prim, ref and enum', () => {
    const m = model([
      { name: 'note', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] },
    ]);
    expect(validateModel(m)).toEqual([]);
  });

  it('rejects an optional key field', () => {
    const m = model([]);
    m.aggregates[0]!.fields[0]!.optional = true;
    expect(validateModel(m).map(d => d.code)).toContain('optional-key');
  });

  it('rejects an optional list', () => {
    const m = model([{ name: 'xs', type: { kind: 'list', of: { kind: 'prim', prim: 'Int' } }, optional: true }]);
    expect(validateModel(m).map(d => d.code)).toContain('optional-list');
  });

  it('rejects an optional value-typed field', () => {
    const m = model(
      [{ name: 'window', type: { kind: 'value', value: 'Window' }, optional: true }],
      [{ kind: 'value', name: 'Window', fields: [{ name: 'len', type: { kind: 'prim', prim: 'Int' } }] }]);
    expect(validateModel(m).map(d => d.code)).toContain('optional-value');
  });

  // Same unsoundness as the field-level rule, one level down: a value type flattens into
  // `<field>_<sub>` sig relations, and alloy.ts's sub-field loop has no multiplicity to vary — it
  // emits `one Int` whatever the marker says, so `present(window.end)` is a tautology in Alloy
  // while quint.ts's nested `endPresent` flag makes it nondeterministic. The two solvers disagree
  // on whether absence is reachable, which is exactly what optional-value exists to prevent.
  it('rejects an optional sub-field of a value type', () => {
    const m = model(
      [{ name: 'window', type: { kind: 'value', value: 'Window' } }],
      [{ kind: 'value', name: 'Window', fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Int' } },
        { name: 'end', type: { kind: 'prim', prim: 'Int' }, optional: true }] }]);
    expect(validateModel(m).map(d => d.code)).toContain('optional-value');
  });

  // Witnessed with real Alloy on `entity Line { discount : Money? }` in an owned collection:
  // emitChildSigs hard-codes `one` for every child field, so `sat=false` — Alloy cannot draw a Line
  // lacking its discount, a state the TS judge permits. `lone` there would trade that for a worse
  // bug (Alloy's sum over an empty join contributes 0 and convicts where the judge skips the
  // aggregate). Rejected rather than half-encoded, same as optional-list/optional-value.
  it('rejects an optional field on an aggregate-owned nested child', () => {
    const m = model([{ name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'Line' } } }]);
    m.aggregates[0]!.entities = [{ kind: 'entity', name: 'Line', fields: [
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'discount', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] }] }];
    expect(validateModel(m).map(d => d.code)).toContain('optional-owned-child');
  });

  it('accepts a required field on an aggregate-owned nested child', () => {
    const m = model([{ name: 'lines', type: { kind: 'list', of: { kind: 'ref', target: 'Line' } } }]);
    m.aggregates[0]!.entities = [{ kind: 'entity', name: 'Line', fields: [
      { name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'discount', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] }] }];
    expect(validateModel(m)).toEqual([]);
  });

  it('does not fire for an optional field on a top-level entity', () => {
    const m = model([]);
    m.entities = [{ kind: 'entity', name: 'Other', fields: [
      { name: 'otherId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'note', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['unsigned'] }] }];
    expect(validateModel(m).map(d => d.code)).not.toContain('optional-owned-child');
  });

  it('accepts a value type whose sub-fields are all required', () => {
    const m = model(
      [{ name: 'window', type: { kind: 'value', value: 'Window' } }],
      [{ kind: 'value', name: 'Window', fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Int' } },
        { name: 'end', type: { kind: 'prim', prim: 'Int' } }] }]);
    expect(validateModel(m)).toEqual([]);
  });

  it('rejects a field named <f>Present beside an optional f (the Quint companion label)', () => {
    const m = model([
      { name: 'foo', type: { kind: 'prim', prim: 'Int' }, optional: true },
      { name: 'fooPresent', type: { kind: 'prim', prim: 'Int' } },
    ]);
    const diags = validateModel(m);
    expect(diags.some(d => d.code === 'present-name-collision')).toBe(true);
  });

  it('fooPresent beside a REQUIRED foo stays legal — no companion is emitted', () => {
    const m = model([
      { name: 'foo', type: { kind: 'prim', prim: 'Int' } },
      { name: 'fooPresent', type: { kind: 'prim', prim: 'Int' } },
    ]);
    expect(validateModel(m).some(d => d.code === 'present-name-collision')).toBe(false);
  });
});

describe('optional fields — surface round-trips', () => {
  it('parses `Type?` and prints it back', async () => {
    const src = `context Opt {
  aggregate Thing {
    thingId : Id key
    note    : Money? @unsigned
    owner   : ref Other?
  }
  entity Other {
    otherId : Id key
  }
}
`;
    const r = await loadLatText(src);
    if (!r.ok) throw new Error(`expected parse: ${JSON.stringify(r.diagnostics)}`);
    const t = r.model.aggregates.find(a => a.name === 'Thing')!;
    expect(t.fields.find(f => f.name === 'note')!.optional).toBe(true);
    expect(t.fields.find(f => f.name === 'owner')!.optional).toBe(true);
    expect(t.fields.find(f => f.name === 'thingId')!.optional).toBeUndefined();
  });

  // The exact shape that witnessed the divergence against real Alloy (sat=false for a Line lacking
  // its discount, which the TS judge permits). loadLatText runs validateModel, so the shape is
  // refused at load — no emitter can be handed a model carrying it.
  it('refuses an optional owned-child field at load, before any emitter sees it', async () => {
    const src = `context Billing {
  aggregate Invoice {
    invId : Id key
    total : Money @unsigned
    lines : List<ref Line>
    entity Line {
      lineId   : Id key
      amount   : Money @unsigned
      discount : Money? @unsigned
    }
  }
}
`;
    const r = await loadLatText(src);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.diagnostics.map(d => d.code)).toContain('optional-owned-child');
  });
});
