import { describe, it, expect } from 'vitest';
import { validateModel, undecidedMoneySigns } from '../../src/ast/validate.js';
import type { DomainModel, Field } from '../../src/ast/domain.js';

const model = (fields: Field[]): DomainModel => ({
  context: 'Ledger', ticksPerDay: 24, enums: [], values: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Account',
    fields: [{ name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true }, ...fields] }],
  events: [], services: []
});
const money = (name: string, tags?: string[]): Field =>
  ({ name, type: { kind: 'prim', prim: 'Money' }, ...(tags ? { tags } : {}) });

describe('undecidedMoneySigns', () => {
  it('flags a Money field with no sign decision', () => {
    const d = undecidedMoneySigns(model([money('balance')]));
    expect(d.map(x => x.code)).toEqual(['money-sign-undecided']);
    expect(d[0]!.message).toContain('balance');
    expect(d[0]!.at).toBe('Account');
  });

  it('accepts @signed and @unsigned', () => {
    expect(undecidedMoneySigns(model([money('balance', ['signed']), money('fees', ['unsigned'])]))).toEqual([]);
  });

  it('reports one diagnostic per owner, naming every undecided field', () => {
    const d = undecidedMoneySigns(model([money('balance'), money('fees')]));
    expect(d.length).toBe(1);
    expect(d[0]!.message).toContain('balance');
    expect(d[0]!.message).toContain('fees');
  });

  it('ignores non-Money fields', () => {
    const m = model([{ name: 'seats', type: { kind: 'prim', prim: 'Int' } }]);
    expect(undecidedMoneySigns(m)).toEqual([]);
  });

  it('covers nested entities inside an aggregate', () => {
    const m = model([]);
    m.aggregates[0]!.entities = [{ kind: 'entity', name: 'Posting',
      fields: [{ name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true }, money('amount')] }];
    expect(undecidedMoneySigns(m).map(d => d.at)).toEqual(['Posting']);
  });

  // THE load path must not change: this is the whole reason the check is separate.
  it('validateModel does NOT emit it — the language keeps its default', () => {
    expect(validateModel(model([money('balance')])).map(d => d.code)).not.toContain('money-sign-undecided');
    expect(validateModel(model([money('balance')]))).toEqual([]);
  });

  it('flags a Money field tagged both @signed and @unsigned as contradictory', () => {
    const d = undecidedMoneySigns(model([money('balance', ['signed', 'unsigned'])]));
    expect(d.map(x => x.code)).toEqual(['money-sign-contradictory']);
    expect(d[0]!.message).toContain('balance');
    expect(d[0]!.at).toBe('Account');
  });

  it('does not also report a contradictory field as undecided', () => {
    const d = undecidedMoneySigns(model([money('balance', ['signed', 'unsigned'])]));
    expect(d.map(x => x.code)).not.toContain('money-sign-undecided');
  });

  // Same pinning as the load-path test above: the contradictory check must stay off the load path too.
  it('validateModel does NOT emit money-sign-contradictory either', () => {
    const m = model([money('balance', ['signed', 'unsigned'])]);
    expect(validateModel(m).map(d => d.code)).not.toContain('money-sign-contradictory');
    expect(validateModel(m)).toEqual([]);
  });
});
