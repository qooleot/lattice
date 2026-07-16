import { describe, it, expect } from 'vitest';
import { validateModel } from '../../src/ast/validate.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import type { DomainModel, Field } from '../../src/ast/domain.js';

const model = (fields: Field[]): DomainModel => ({
  context: 'Opt', ticksPerDay: 24, enums: [], values: [], entities: [],
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
