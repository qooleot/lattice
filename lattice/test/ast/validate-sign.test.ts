import { describe, it, expect } from 'vitest';
import { validateModel, undecidedMoneySigns } from '../../src/ast/validate.js';
import { moneyPaths } from '../../src/engine/implied.js';
import { moneyFieldPaths } from '../../src/ast/domain.js';
import type { DomainModel, Field, ValueDef } from '../../src/ast/domain.js';

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

describe('sign is a use-site decision (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  // Cloned per call (not the shared `amount` reference): one test mutates a returned model's value
  // field tags in place, which must not leak into any other test's fixture.
  const withValue = (tags?: string[]): DomainModel => ({
    context: 'L', enums: [], values: [{ ...amount, fields: amount.fields.map(f => ({ ...f })) }], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, ...(tags ? { tags } : {}) }] }],
  });

  it('demands a sign at the USE SITE of a value with a Money sub-field', () => {
    const d = undecidedMoneySigns(withValue());
    expect(d.map(x => x.code)).toEqual(['money-sign-undecided']);
    expect(d[0]!.at).toBe('Bill');           // the use site, NOT 'Amount'
    expect(d[0]!.message).toContain('total');
  });

  it('is satisfied by a tag on the use-site field', () => {
    expect(undecidedMoneySigns(withValue(['unsigned']))).toEqual([]);
  });

  it('no longer demands a sign on the value DECLARATION itself', () => {
    expect(undecidedMoneySigns(withValue(['unsigned'])).map(x => x.at)).not.toContain('Amount');
  });

  it('rejects a sign tag inside a value declaration (value-money-sign-inert)', () => {
    const m = withValue(['unsigned']);
    m.values[0]!.fields[0]!.tags = ['signed'];
    const d = validateModel(m);
    expect(d.map(x => x.code)).toContain('value-money-sign-inert');
    expect(d.find(x => x.code === 'value-money-sign-inert')!.at).toBe('Amount.amount');
  });

  it('still keeps money-sign checks OFF the load path', () => {
    expect(validateModel(withValue()).map(d => d.code)).not.toContain('money-sign-undecided');
    expect(validateModel(withValue())).toEqual([]);
  });
});

describe('demand and derivation agree on what carries money (drift-proofing)', () => {
  // This is the property the domain.ts extraction exists to guarantee: validate.ts's
  // undecidedMoneySigns (DEMAND — does this field need a sign decision?) and implied.ts's
  // moneyPaths (DERIVATION — what non-negative candidates fall out of this field?) both read
  // domain.ts's moneyFieldPaths for "what carries money", so they cannot independently drift on
  // the same shape fact. Before the extraction, they were two hand-written copies of the same
  // predicate that happened to agree — nothing enforced it.
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  const empty: ValueDef = { kind: 'value', name: 'Empty', fields: [
    { name: 'note', type: { kind: 'prim', prim: 'Text' } }] };
  // Money two levels deep (slice B2 follow-up): Outer wraps Amount, which wraps Money. Legal only
  // as of the value-in-value commit this task follows up — moneyFieldPaths must recurse through it.
  const outer: ValueDef = { kind: 'value', name: 'Outer', fields: [
    { name: 'inner', type: { kind: 'value', value: 'Amount' } }] };

  const cases: { label: string; field: Field }[] = [
    { label: 'plain Money', field: { name: 'balance', type: { kind: 'prim', prim: 'Money' } } },
    { label: 'value-typed with a Money sub-field', field: { name: 'total', type: { kind: 'value', value: 'Amount' } } },
    { label: 'value-typed with no Money sub-field', field: { name: 'meta', type: { kind: 'value', value: 'Empty' } } },
    { label: 'plain non-money', field: { name: 'seats', type: { kind: 'prim', prim: 'Int' } } },
    { label: 'value-typed TWO LEVELS deep to a Money sub-field', field: { name: 'total', type: { kind: 'value', value: 'Outer' } } },
  ];

  // Each case is read off the SAME field on both sides (no message-format coupling):
  // `demanded` = does undecidedMoneySigns flag money-sign-undecided when the field is left
  // untagged? `derived` = does moneyPaths yield a path for the same field once tagged @unsigned —
  // a sign that IS decided, so only the shape (not the use-site @signed skip) can make it non-empty.
  it.each(cases)('$label: undecidedMoneySigns demands a decision iff moneyPaths would derive one', ({ field }) => {
    const untagged: DomainModel = {
      context: 'Ledger', enums: [], values: [amount, empty, outer], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Account', fields: [
        { name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true }, field] }],
      events: [], services: [],
    };
    const demanded = undecidedMoneySigns(untagged).some(d => d.code === 'money-sign-undecided');

    const tagged: DomainModel = {
      ...untagged,
      aggregates: [{ ...untagged.aggregates[0]!, fields: [
        untagged.aggregates[0]!.fields[0]!, { ...field, tags: ['unsigned'] }] }],
    };
    const derived = moneyPaths(tagged, tagged.aggregates[0]!).length > 0;

    expect(derived).toBe(demanded);
  });
});

describe('moneyFieldPaths recurses through nested values (slice B2 follow-up)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  const outer: ValueDef = { kind: 'value', name: 'Outer', fields: [
    { name: 'inner', type: { kind: 'value', value: 'Amount' } }] };
  const twoLevelModel: DomainModel = {
    context: 'Ledger', enums: [], values: [amount, outer], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'value', value: 'Outer' } }] }],
  };

  it('yields the full two-hop path for Money nested two levels deep', () => {
    const totalField = twoLevelModel.aggregates[0]!.fields[1]!;
    expect(moneyFieldPaths(twoLevelModel, totalField)).toEqual([['total', 'inner', 'amount']]);
  });

  it('a one-level value still yields exactly the one-hop path (pins pre-existing behaviour)', () => {
    const oneLevelModel: DomainModel = {
      context: 'Ledger', enums: [], values: [amount], entities: [], events: [], services: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' } }] }],
    };
    const totalField = oneLevelModel.aggregates[0]!.fields[1]!;
    expect(moneyFieldPaths(oneLevelModel, totalField)).toEqual([['total', 'amount']]);
  });

  it('two levels deep is DEMANDED by undecidedMoneySigns when untagged', () => {
    const d = undecidedMoneySigns(twoLevelModel);
    expect(d.map(x => x.code)).toEqual(['money-sign-undecided']);
    expect(d[0]!.at).toBe('Bill');
    expect(d[0]!.message).toContain('total');
  });

  it('a value CYCLE does not hang — moneyFieldPaths terminates and returns no path through the cycle', () => {
    // value A { b : B } + value B { a : A }: validateModel does not reject this today (checked:
    // value fields may be prim/enum/value; there is no cycle check anywhere in ast/ or engine/).
    // moneyFieldPaths must not loop forever — a visited-value-names guard stops recursion instead.
    const valueA: ValueDef = { kind: 'value', name: 'A', fields: [
      { name: 'b', type: { kind: 'value', value: 'B' } }] };
    const valueB: ValueDef = { kind: 'value', name: 'B', fields: [
      { name: 'a', type: { kind: 'value', value: 'A' } }] };
    const cyclicModel: DomainModel = {
      context: 'Ledger', enums: [], values: [valueA, valueB], entities: [], events: [], services: [],
      aggregates: [{ kind: 'aggregate', name: 'Thing', fields: [
        { name: 'thingId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'root', type: { kind: 'value', value: 'A' } }] }],
    };
    const rootField = cyclicModel.aggregates[0]!.fields[1]!;
    expect(moneyFieldPaths(cyclicModel, rootField)).toEqual([]);
  });
});
