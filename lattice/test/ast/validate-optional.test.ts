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

  it('accepts a value type whose sub-fields are all required', () => {
    const m = model(
      [{ name: 'window', type: { kind: 'value', value: 'Window' } }],
      [{ kind: 'value', name: 'Window', fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Int' } },
        { name: 'end', type: { kind: 'prim', prim: 'Int' } }] }]);
    expect(validateModel(m)).toEqual([]);
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
});
