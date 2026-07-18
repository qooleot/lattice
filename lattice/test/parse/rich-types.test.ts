import { describe, it, expect } from 'vitest';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { astToCode } from '../../src/emit/code.js';
import type { AggregateDef } from '../../src/ast/domain.js';

// Slice 2: the rich CML type surface is now WRITABLE in .lat source (grammar + parser), not just
// representable in the AST (Slice 1). Optional<T>, Map<K,V>, generics (Ctor<…>), unions (A | B), and
// opaque `builtin` carriers parse, resolve, validate their element types, and round-trip through
// astToCode. The carried tier is still dropped from solving — these tests exercise parse/validate/
// print only, never the solver.

const SPEC = `context Rich {
  builtin Metadata
  builtin Currency

  value Amount {
    amount   : Money
    currency : Currency
  }

  entity DraftWithBill { draftId : Id key }
  entity DraftWithInvoice { draftId : Id key }

  aggregate Ledger {
    ledgerId : Id key
    meta     : Metadata
    approved : Optional<Money>
    balances : Map<Id, Amount>
    settle   : Result<Amount, Metadata>
    draft    : DraftWithBill | DraftWithInvoice
    holds    : Map<Id, Optional<Money>>
  }
}
`;

describe('rich field types — parse & resolve', () => {
  const r = loadLatText(SPEC);
  it('loads without diagnostics', () => {
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
  });

  const fields = () => (r as any).model.aggregates.find((a: AggregateDef) => a.name === 'Ledger').fields;
  const field = (n: string) => fields().find((f: any) => f.name === n);

  it('records declared builtins on the model', () => {
    if (!r.ok) return;
    expect(r.model.builtins).toEqual([{ name: 'Metadata' }, { name: 'Currency' }]);
  });

  it('resolves a bare builtin name to a carrier (not an unresolved enum)', () => {
    if (!r.ok) return;
    expect(field('meta').type).toEqual({ kind: 'carrier', name: 'Metadata' });
  });

  it('normalizes a head Optional<T> to the ? flag with the inner type', () => {
    if (!r.ok) return;
    const f = field('approved');
    expect(f.optional).toBe(true);
    expect(f.type).toEqual({ kind: 'prim', prim: 'Money' });
  });

  it('parses Map<K, V> with resolved key and value types', () => {
    if (!r.ok) return;
    expect(field('balances').type).toEqual({
      kind: 'map', key: { kind: 'prim', prim: 'Id' }, of: { kind: 'value', value: 'Amount' } });
  });

  it('parses a generic ctor with resolved args (ctor opaque)', () => {
    if (!r.ok) return;
    expect(field('settle').type).toEqual({ kind: 'generic', ctor: 'Result',
      args: [{ kind: 'value', value: 'Amount' }, { kind: 'carrier', name: 'Metadata' }] });
  });

  it('parses a union into flat arms (refs to top-level entities)', () => {
    if (!r.ok) return;
    expect(field('draft').type).toEqual({ kind: 'union', arms: [
      { kind: 'ref', target: 'DraftWithBill' }, { kind: 'ref', target: 'DraftWithInvoice' }] });
  });

  it('keeps a NESTED Optional as a TypeRef (only the head form normalizes to ?)', () => {
    if (!r.ok) return;
    const f = field('holds');
    expect(f.optional).toBeUndefined();
    expect(f.type).toEqual({ kind: 'map', key: { kind: 'prim', prim: 'Id' },
      of: { kind: 'optional', of: { kind: 'prim', prim: 'Money' } } });
  });

  it('flattens a left-assoc 3-arm union A | B | C into one union of three', () => {
    const r3 = loadLatText(`context C {
  builtin A builtin B builtin D
  aggregate G { gId : Id key  pick : A | B | D }
}`);
    expect(r3.ok, JSON.stringify(!r3.ok && r3.diagnostics)).toBe(true);
    if (!r3.ok) return;
    const pick = r3.model.aggregates[0]!.fields.find(f => f.name === 'pick')!;
    expect(pick.type).toEqual({ kind: 'union', arms: [
      { kind: 'carrier', name: 'A' }, { kind: 'carrier', name: 'B' }, { kind: 'carrier', name: 'D' }] });
  });
});

describe('builtin external ref + Boolean prim (Slice 4 Phase A)', () => {
  it('captures a builtin external ref and round-trips it', () => {
    const src = `context C {
  builtin Amount = "Opus::Monetary::Core::Types::Amount"
  builtin Metadata
  aggregate A { aId : Id key  amt : Amount  meta : Metadata }
}
`;
    const r = loadLatText(src);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.model.builtins).toEqual([{ name: 'Amount', ref: 'Opus::Monetary::Core::Types::Amount' }, { name: 'Metadata' }]);
    const printed = astToCode(r.model, r.invariants);
    expect(printed).toContain('builtin Amount = "Opus::Monetary::Core::Types::Amount"');
    expect(printed).toContain('builtin Metadata');
    const re = loadLatText(printed);
    expect(re.ok, JSON.stringify(!re.ok && re.diagnostics)).toBe(true);
    if (re.ok) expect(re.model.builtins).toEqual(r.model.builtins);
  });

  it('resolves a Boolean field as a prim (dropped from the solver, like Text/Id)', () => {
    const r = loadLatText('context C { aggregate A { aId : Id key\n active : Boolean } }');
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const f = r.model.aggregates[0]!.fields.find(x => x.name === 'active')!;
    expect(f.type).toEqual({ kind: 'prim', prim: 'Boolean' });
  });

  it('rejects a declaration named like the Boolean prim (reserved-prim-name)', () => {
    const bad = loadLatText('context C { enum Boolean { a }\n aggregate A { aId : Id key } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'reserved-prim-name')).toBe(true);
  });
});

describe('rich field types — validation', () => {
  it('reports an unresolved ref buried inside a Map value', () => {
    const bad = loadLatText('context C { aggregate A { aId : Id key\n m : Map<Id, ref Nowhere> } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'unresolved-ref' && d.message.includes('Nowhere'))).toBe(true);
  });

  it('reports an unresolved enum arm buried inside a union', () => {
    const bad = loadLatText('context C { builtin Ok\n aggregate A { aId : Id key\n u : Ok | Nope } }');
    // `Nope` matches no declaration → unresolved-enum fallback, reported through the union recursion.
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'unresolved-enum' && d.message.includes('Nope'))).toBe(true);
  });

  it('rejects a ref to an aggregate-owned child inside a Map (not an owned collection)', () => {
    const bad = loadLatText(`context C {
  aggregate Inv {
    invId : Id key
    lines : List<Line>
    byId  : Map<Id, ref Line>
    entity Line { lineId : Id key }
  }
}`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'ref-target-nested-child')).toBe(true);
  });

  it('rejects a builtin name that collides with a prim (reserved-prim-name)', () => {
    const bad = loadLatText('context C { builtin Money\n aggregate A { aId : Id key } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'reserved-prim-name')).toBe(true);
  });

  it('rejects a builtin name that duplicates an enum (duplicate-name)', () => {
    const bad = loadLatText('context C { enum Foo { a }\n builtin Foo\n aggregate A { aId : Id key } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'duplicate-name')).toBe(true);
  });
});

describe('rich field types — round-trip through astToCode', () => {
  it('re-emits builtins + every rich kind and reparses to the same model', () => {
    const r = loadLatText(SPEC);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const printed = astToCode(r.model, r.invariants);
    expect(printed).toContain('builtin Metadata');
    expect(printed).toContain('Map<Id, Amount>');
    expect(printed).toContain('Result<Amount, Metadata>');
    // bare entity names in the union resolved to refs, so each arm prints with its `ref` keyword
    expect(printed).toContain('ref DraftWithBill | ref DraftWithInvoice');
    expect(printed).toContain('Map<Id, Optional<Money>>');
    // head Optional<Money> normalized to the ? flag prints back as `Money?`
    expect(printed).toMatch(/approved\s+: Money\?/);
    const reparsed = loadLatText(printed);
    expect(reparsed.ok, JSON.stringify(!reparsed.ok && reparsed.diagnostics)).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.model.builtins).toEqual(r.model.builtins);
    expect(reparsed.model.aggregates).toEqual(r.model.aggregates);
  });
});
