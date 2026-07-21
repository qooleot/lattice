import { describe, it, expect } from 'vitest';
import { impliedInvariants } from '../../src/engine/implied.js';
import { astToCode } from '../../src/emit/code.js';
import { isCarriedType, unwrapOptional } from '../../src/ast/domain.js';
import type { DomainModel, TypeRef } from '../../src/ast/domain.js';

// Slice 1: the full CML rich type surface is REPRESENTED (map/generic/union/optional/carrier) and
// round-trips through the AST + serializer. Derivation still reaches Money/refs through the SOLVED
// core (prim/value/list/ref/optional) but DROPS the CARRIED containers (map/generic/union/carrier),
// exactly as a non-owned List<Int> is dropped today. Deriving OVER a collection (∀ entries) is a
// later slice.

const AMOUNT: TypeRef = { kind: 'value', value: 'Amount' };
const money: TypeRef = { kind: 'prim', prim: 'Money' };

const m: DomainModel = {
  context: 'Rich', ticksPerDay: 24, enums: [],
  values: [{ kind: 'value', name: 'Amount', fields: [{ name: 'amount', type: money }] }],
  entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Ledger', fields: [
    { name: 'ledgerId', type: { kind: 'prim', prim: 'Id' }, key: true },
    // head Optional expressed as a TYPE (not the Field.optional flag) — the fold must see through it
    { name: 'approved', type: { kind: 'optional', of: money } },
    // Optional<value Amount> — the fold hops the optional AND the value to reach the Money leaf
    { name: 'reserved', type: { kind: 'optional', of: AMOUNT } },
    // CARRIED containers: their Money leaves must NOT derive a flat non-negative in Slice 1
    { name: 'balances', type: { kind: 'map', key: { kind: 'prim', prim: 'Id' }, of: AMOUNT } },
    { name: 'history', type: { kind: 'list', of: AMOUNT } },
    { name: 'settle', type: { kind: 'generic', ctor: 'Result', args: [AMOUNT, { kind: 'carrier', name: 'Err' }] } },
    { name: 'either', type: { kind: 'union', arms: [AMOUNT, money] } },
  ] }],
  events: [], services: [],
};

describe('rich TypeRef — derivation folds through the solved core, drops the carried surface', () => {
  const d = impliedInvariants(m);

  it('derives a guarded non-negative through a head Optional<Money> TYPE', () => {
    const n = d.find(i => i.name === 'nonNegativeLedgerApproved')!;
    expect(n?.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Ledger',
      body: { kind: 'implies',
        left: { kind: 'present', path: ['approved'] },
        right: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['approved'] }, right: { kind: 'int', value: 0 } } } });
  });

  it('folds through Optional<value> to the nested Money leaf, still guarded', () => {
    const n = d.find(i => i.name === 'nonNegativeLedgerReservedAmount')!;
    expect(n?.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Ledger',
      body: { kind: 'implies',
        left: { kind: 'present', path: ['reserved'] },
        right: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['reserved', 'amount'] }, right: { kind: 'int', value: 0 } } } });
  });

  it('drops Money leaves inside carried containers (map / list / generic / union)', () => {
    for (const field of ['balances', 'history', 'settle', 'either']) {
      const leaked = d.filter(i => JSON.stringify(i.candidate).includes(field));
      expect(leaked, `no derived candidate should reference carried field '${field}'`).toEqual([]);
    }
  });
});

describe('rich TypeRef — helpers', () => {
  it('unwrapOptional strips head optionals only', () => {
    expect(unwrapOptional({ kind: 'optional', of: money })).toEqual(money);
    expect(unwrapOptional({ kind: 'optional', of: { kind: 'optional', of: money } })).toEqual(money);
    expect(unwrapOptional(money)).toEqual(money);
  });

  it('isCarriedType marks the carried surface, sees through optional', () => {
    expect(isCarriedType({ kind: 'map', key: money, of: money })).toBe(true);
    expect(isCarriedType({ kind: 'generic', ctor: 'Result', args: [money] })).toBe(true);
    expect(isCarriedType({ kind: 'union', arms: [money, AMOUNT] })).toBe(true);
    expect(isCarriedType({ kind: 'carrier', name: 'Metadata' })).toBe(true);
    expect(isCarriedType({ kind: 'optional', of: { kind: 'map', key: money, of: money } })).toBe(true);
    // solved core
    expect(isCarriedType(money)).toBe(false);
    expect(isCarriedType(AMOUNT)).toBe(false);
    expect(isCarriedType({ kind: 'list', of: money })).toBe(false);
    expect(isCarriedType({ kind: 'optional', of: money })).toBe(false);
  });
});

describe('rich TypeRef — round-trips faithfully through the .lat serializer', () => {
  const rt: DomainModel = {
    context: 'RT', ticksPerDay: 24, enums: [], values: [], entities: [],
    aggregates: [{ kind: 'aggregate', name: 'Order', fields: [
      { name: 'orderId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'meta', type: { kind: 'carrier', name: 'Metadata' } },
      { name: 'approved', type: { kind: 'optional', of: money } },
      { name: 'balances', type: { kind: 'map', key: { kind: 'prim', prim: 'Id' }, of: money } },
      { name: 'settle', type: { kind: 'generic', ctor: 'Result',
        args: [{ kind: 'carrier', name: 'Contract' }, { kind: 'carrier', name: 'ContractError' }] } },
      { name: 'draft', type: { kind: 'union',
        arms: [{ kind: 'carrier', name: 'DraftWithBill' }, { kind: 'carrier', name: 'DraftWithInvoice' }] } },
    ] }],
    events: [], services: [],
  };
  const code = astToCode(rt, []);

  it('emits every rich type kind in .lat surface syntax', () => {
    expect(code).toMatch(/meta\s+: Metadata/);   // opaque carrier renders as its bare name
    expect(code).toContain('Optional<Money>');
    expect(code).toContain('Map<Id, Money>');
    expect(code).toContain('Result<Contract, ContractError>');
    expect(code).toContain('DraftWithBill | DraftWithInvoice');
  });
});
