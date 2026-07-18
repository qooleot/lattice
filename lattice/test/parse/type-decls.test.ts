import { describe, it, expect } from 'vitest';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { astToCode } from '../../src/emit/code.js';
import { renderTsTypes } from '../../src/generate/render/ts-types.js';

// Slice 4 Phase B: the TypeScript-style `type` construct — `type X = T` aliases (inlined at use
// sites, like CML; declaration retained for round-trip) and `type X = { … }` free-form carried
// structs (records). Records are NOT solver-restricted (unlike `value`): their fields may be
// lists/optionals/refs/generics. A field referencing a record resolves to a `carrier` TypeRef.

describe('type aliases', () => {
  const SPEC = `context C {
  type CustomerId = Id
  type MetaMap = Map<Id, Text>
  aggregate Order {
    orderId  : Id key
    customer : CustomerId
    meta     : MetaMap
  }
}
`;
  const r = loadLatText(SPEC);

  it('stores alias declarations with their resolved target', () => {
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.model.typeAliases).toEqual([
      { name: 'CustomerId', target: { kind: 'prim', prim: 'Id' } },
      { name: 'MetaMap', target: { kind: 'map', key: { kind: 'prim', prim: 'Id' }, of: { kind: 'prim', prim: 'Text' } } },
    ]);
  });

  it('inlines the alias at the use site (CML semantics — no alias TypeRef)', () => {
    if (!r.ok) return;
    const order = r.model.aggregates[0]!;
    expect(order.fields.find(f => f.name === 'customer')!.type).toEqual({ kind: 'prim', prim: 'Id' });
    expect(order.fields.find(f => f.name === 'meta')!.type).toEqual({ kind: 'map', key: { kind: 'prim', prim: 'Id' }, of: { kind: 'prim', prim: 'Text' } });
  });

  it('round-trips the alias declaration through astToCode', () => {
    if (!r.ok) return;
    const printed = astToCode(r.model, r.invariants);
    expect(printed).toContain('type CustomerId = Id');
    expect(printed).toContain('type MetaMap = Map<Id, Text>');
    const re = loadLatText(printed);
    expect(re.ok, JSON.stringify(!re.ok && re.diagnostics)).toBe(true);
    if (re.ok) { expect(re.model.typeAliases).toEqual(r.model.typeAliases); expect(re.model.aggregates).toEqual(r.model.aggregates); }
  });

  it('resolves an alias whose target names another alias (transitive)', () => {
    const r2 = loadLatText(`context C {
  type A = Id
  type B = A
  aggregate G { gId : Id key  x : B }
}`);
    expect(r2.ok, JSON.stringify(!r2.ok && r2.diagnostics)).toBe(true);
    if (!r2.ok) return;
    expect(r2.model.aggregates[0]!.fields.find(f => f.name === 'x')!.type).toEqual({ kind: 'prim', prim: 'Id' });
  });

  it('reports an alias cycle', () => {
    const bad = loadLatText(`context C {
  type A = B
  type B = A
  aggregate G { gId : Id key  x : A }
}`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'alias-cycle')).toBe(true);
  });
});

describe('type records (free-form carried structs)', () => {
  const SPEC = `context C {
  entity Plan { planId : Id key }
  type LineItem = {
    itemId : Id
    amount : Money
    tags   : List<Text>
    plan   : ref Plan
    note   : Text?
  }
  aggregate Order {
    orderId : Id key
    lines   : List<LineItem>
  }
}
`;
  const r = loadLatText(SPEC);

  it('stores the record with its free-form fields (list/ref/optional all allowed)', () => {
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.model.records).toEqual([{ name: 'LineItem', fields: [
      { name: 'itemId', type: { kind: 'prim', prim: 'Id' } },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'tags', type: { kind: 'list', of: { kind: 'prim', prim: 'Text' } } },
      { name: 'plan', type: { kind: 'ref', target: 'Plan' } },
      { name: 'note', type: { kind: 'prim', prim: 'Text' }, optional: true },
    ] }]);
  });

  it('resolves a field referencing a record to a carrier', () => {
    if (!r.ok) return;
    expect(r.model.aggregates[0]!.fields.find(f => f.name === 'lines')!.type)
      .toEqual({ kind: 'list', of: { kind: 'carrier', name: 'LineItem' } });
  });

  it('round-trips the record through astToCode', () => {
    if (!r.ok) return;
    const printed = astToCode(r.model, r.invariants);
    expect(printed).toContain('type LineItem = {');
    expect(printed).toMatch(/lines\s+: List<LineItem>/);
    const re = loadLatText(printed);
    expect(re.ok, JSON.stringify(!re.ok && re.diagnostics)).toBe(true);
    if (re.ok) { expect(re.model.records).toEqual(r.model.records); expect(re.model.aggregates).toEqual(r.model.aggregates); }
  });

  it('emits a TS interface for the record and embeds it in a list (not a foreign id)', () => {
    if (!r.ok) return;
    const ts = renderTsTypes(r.model);
    expect(ts).toContain('export interface LineItem {\n  itemId: string;\n  amount: number;\n  tags: string[];\n  plan: string;\n  note?: string;\n}');
    expect(ts).toContain('  lines: LineItem[];');
  });

  it('rejects a record whose name duplicates another declaration', () => {
    const bad = loadLatText(`context C {
  value LineItem { amount : Money }
  type LineItem = { itemId : Id }
  aggregate G { gId : Id key }
}`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'duplicate-name')).toBe(true);
  });
});

describe('sum-type (payload) enums', () => {
  const SPEC = `context C {
  builtin Amount = "Opus::Monetary::Core::Types::Amount"
  type CustomUnit = { unitId : Id  qty : Int }
  enum Mode { fast, slow }
  enum CreditGrantAmount { monetary(Amount), customPricingUnit(CustomUnit), none }
  aggregate Grant {
    grantId : Id key
    mode    : Mode
    amount  : CreditGrantAmount
  }
}
`;
  const r = loadLatText(SPEC);

  it('parses variant names into values and payloads into a payload map', () => {
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const sum = r.model.enums.find(e => e.name === 'CreditGrantAmount')!;
    expect(sum.values).toEqual(['monetary', 'customPricingUnit', 'none']);
    expect(sum.payloads).toEqual({
      monetary: { kind: 'carrier', name: 'Amount' },
      customPricingUnit: { kind: 'carrier', name: 'CustomUnit' },
    });
  });

  it('leaves a plain enum with no payloads key', () => {
    if (!r.ok) return;
    const plain = r.model.enums.find(e => e.name === 'Mode')!;
    expect(plain).toEqual({ name: 'Mode', values: ['fast', 'slow'] });
  });

  it('round-trips variant payloads through astToCode', () => {
    if (!r.ok) return;
    const printed = astToCode(r.model, r.invariants);
    expect(printed).toContain('enum CreditGrantAmount { monetary(Amount), customPricingUnit(CustomUnit), none }');
    const re = loadLatText(printed);
    expect(re.ok, JSON.stringify(!re.ok && re.diagnostics)).toBe(true);
    if (re.ok) expect(re.model.enums).toEqual(r.model.enums);
  });

  it('lowers a sum-type enum to a TS discriminated union, plain enum to a string union', () => {
    if (!r.ok) return;
    const ts = renderTsTypes(r.model);
    expect(ts).toContain("export type Mode = 'fast' | 'slow';");
    expect(ts).toContain("export type CreditGrantAmount = { kind: 'monetary'; value: Amount } | { kind: 'customPricingUnit'; value: CustomUnit } | { kind: 'none' };");
  });

  it('reports an unresolved payload type', () => {
    const bad = loadLatText('context C { enum E { a(Nope) }\n aggregate G { gId : Id key } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'unresolved-enum' && d.message.includes('Nope'))).toBe(true);
  });
});
