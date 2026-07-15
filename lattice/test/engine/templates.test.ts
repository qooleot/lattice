import { describe, it, expect } from 'vitest';
import { matchTemplates } from '../../src/engine/templates.js';
import { impliedInvariants, isImplied } from '../../src/engine/implied.js';
import type { DomainModel } from '../../src/ast/domain.js';
import { periodModel } from '../fixtures.js';

const revrecMini: DomainModel = {
  context: 'RevRec', ticksPerDay: 24,
  enums: [{ name: 'EntryKind', values: ['Recognition', 'Correction'] }], values: [],
  entities: [
    { kind: 'entity', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'monotonic'] },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] },
    { kind: 'entity', name: 'RevenueEntry', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'obligation', type: { kind: 'ref', target: 'Obligation' } },
      { name: 'kind', type: { kind: 'enum', enum: 'EntryKind' } }] }
  ],
  aggregates: [{ kind: 'aggregate', name: 'AccountingPeriod', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }],
    machine: { regions: [{ name: 'Lifecycle', initial: 'Open', states: [{ name: 'Open', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }], transitions: [] } }],
  events: [], services: []
};

describe('matchTemplates', () => {
  const { adopt, seeds } = matchTemplates(revrecMini);
  const kinds = adopt.map(a => a.candidate.kind);

  it('#1 conservation from @balance/@total tags', () =>
    expect(adopt.some(a => a.candidate.kind === 'conservation' && a.candidate.aggregate === 'Obligation')).toBe(true));
  it('#2 non-negative for every Money field', () =>
    expect(adopt.filter(a => a.name.startsWith('NonNegative')).length).toBe(3));
  // @signed suppression is covered by the dedicated describe block below, which also pins the
  // stronger property: that this derivation and implied.ts agree.
  it('#3 terminal for @terminal states', () =>
    expect(adopt.some(a => a.candidate.kind === 'terminal' && (a.candidate as any).state === 'Closed')).toBe(true));
  // Catalog (docs/plan.md §10.2 row 7) defines #7 as `@active` on a CHILD COLLECTION -> the
  // per-parent `unique` form. The old no-refs arm fired when that trigger FAILED, asserting a
  // platform-wide singleton from a shape coincidence. "No refs" was a discriminator fitted to
  // revrecMini's AccountingPeriod, never a singleton signal. See the 2026-07-14 design doc.
  it('#7 adopts NO cardinality for a refless @active aggregate', () =>
    expect(adopt.some(a => a.candidate.kind === 'cardinality')).toBe(false));

  it('#7 adopts no SingleActive_* for a refless @active aggregate in a multi-tenant shape', () => {
    const billerModel: DomainModel = {
      context: 'BillPayments', ticksPerDay: 24, enums: [], values: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Biller', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'name', type: { kind: 'prim', prim: 'Text' } }],
        machine: { regions: [{ name: 'Lifecycle', initial: 'Active', states: [
          { name: 'Active', tags: ['active'] }, { name: 'Retired', tags: ['terminal'] }] }], transitions: [] } }],
      events: [], services: []
    };
    const r = matchTemplates(billerModel);
    expect(r.adopt.map(a => a.name)).not.toContain('SingleActive_Biller');
    expect(r.adopt.some(a => a.candidate.kind === 'cardinality')).toBe(false);
  });
  it('#8 monotonic from @monotonic tag', () =>
    expect(adopt.some(a => a.candidate.kind === 'monotonic')).toBe(true));
  it('#9 refsResolve for owners with refs', () =>
    expect(adopt.some(a => a.candidate.kind === 'refsResolve' && a.candidate.aggregate === 'RevenueEntry')).toBe(true));
  it('#9 refsResolve carries the same-context ref field names', () => {
    const c = adopt.find(a => a.candidate.kind === 'refsResolve' && a.candidate.aggregate === 'RevenueEntry')!.candidate;
    expect(c).toEqual({ kind: 'refsResolve', aggregate: 'RevenueEntry', fields: ['obligation'] });
  });
  it('all adopted have template source + deterministic ids', () => {
    expect(adopt.every(a => a.source === 'template')).toBe(true);
    expect(new Set(adopt.map(a => a.id)).size).toBe(adopt.length);
  });
  it('#7-unique seeds fire for @active aggregates WITH refs (trace A model)', async () => {
    const { traceAModel } = await import('../fixtures.js');
    const r = matchTemplates(traceAModel);
    expect(r.seeds.some(s => s.candidate.kind === 'unique')).toBe(true);
  });
});

// Task 11: type-carried laws (design §3.5/§6) — mirrors the Money non-negativity pattern (#2
// above) exactly: adopted here for enforcement + template provenance, and the SAME candidate
// shape is separately derived by implied.ts for parse-dedup/never-printed. Both derive from the
// shared valueLawInstances helper (implied.ts), so they can never drift apart.
describe('matchTemplates — type-carried value laws', () => {
  const { adopt } = matchTemplates(periodModel);
  const law = adopt.find(a => a.id.startsWith('tpl-val-'));

  it('adopts a value invariant as a prefixed statePredicate at its use site', () => {
    expect(law).toBeDefined();
    expect(law!.id).toBe('tpl-val-Period-Subscription-period-wellOrdered');
    expect(law!.name).toBe('ValueLaw_Subscription_period_wellOrdered');
    expect(law!.candidate).toMatchObject({ kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt', left: { kind: 'field', path: ['period', 'start'] }, right: { kind: 'field', path: ['period', 'end'] } } });
  });

  it('the adopted value-law candidate matches an implied candidate by shape (same source of truth)', () => {
    expect(isImplied(law!.candidate, periodModel)).toBe(true);
    const impliedLaw = impliedInvariants(periodModel).find(i => i.id.includes('val'))!;
    expect(impliedLaw.candidate).toEqual(law!.candidate);
  });

  it('all adopted value laws have template source + deterministic ids', () => {
    expect(adopt.every(a => a.source === 'template')).toBe(true);
    expect(new Set(adopt.map(a => a.id)).size).toBe(adopt.length);
  });
});

// #2 non-negativity is derived in two places for two purposes (adopt-for-enforcement here,
// dedup-for-printing in implied.ts). They drifted once: templates.ts ignored @signed, so a
// `balance : Money @signed` was adopted as `balance >= 0` — constraining every witness the solver
// drew, AND (since isImplied consults implied.ts, which honoured @signed) printed by astToCode as
// an explicit invariant contradicting the tag three lines above it. Both callers now share
// nonNegativeMoneyFields; these tests pin the agreement rather than either implementation.
describe('matchTemplates — #2 non-negativity honours @signed (no drift with implied.ts)', () => {
  const signedModel: DomainModel = {
    context: 'Ledger', ticksPerDay: 24, enums: [], values: [], entities: [],
    aggregates: [{ kind: 'aggregate', name: 'Account', fields: [
      { name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'balance', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] },
      { name: 'lifetimeFees', type: { kind: 'prim', prim: 'Money' } }] }],
    events: [], services: []
  };
  const { adopt } = matchTemplates(signedModel);

  it('adopts no non-negative rule for a @signed Money field', () =>
    expect(adopt.some(a => a.name === 'NonNegative_Account_balance')).toBe(false));

  it('still adopts one for an unsigned Money field alongside it', () =>
    expect(adopt.some(a => a.name === 'NonNegative_Account_lifetimeFees')).toBe(true));

  // The drift guard proper: anything astToCode would print (adopted ∧ ¬isImplied) is a rule the
  // two modules disagree about. This is the assertion that fails if either derivation moves alone.
  it('every adopted non-negative candidate is recognized as implied', () => {
    const nonNeg = adopt.filter(a => a.name.startsWith('NonNegative'));
    expect(nonNeg.length).toBeGreaterThan(0);
    expect(nonNeg.filter(a => !isImplied(a.candidate, signedModel))).toEqual([]);
  });

  it('holds for the richer revrec fixture too', () => {
    const nonNeg = matchTemplates(revrecMini).adopt.filter(a => a.name.startsWith('NonNegative'));
    expect(nonNeg.filter(a => !isImplied(a.candidate, revrecMini))).toEqual([]);
  });
});

describe('matchTemplates — qualified-ref exclusion (spec §4.2)', () => {
  // Local fixture (tests don't import across test files): an Order aggregate whose only ref
  // field is a qualified cross-context ref.
  const base = (target: string): DomainModel => ({
    context: 'Billing', ticksPerDay: 24,
    enums: [], values: [],
    entities: [],
    aggregates: [{
      kind: 'aggregate', name: 'Order',
      fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'plan', type: { kind: 'ref', target } }
      ]
    }],
    events: [], services: []
  });

  it('adopts no tpl-9 (refsResolve) invariant when the only ref field is qualified', () => {
    const m = base('Catalog.Plan');
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'refsResolve')).toBe(false);
  });

  it('tpl-9 fields list excludes a qualified ref alongside a local one', () => {
    const m = base('Catalog.Plan');
    m.entities.push({ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'who', type: { kind: 'ref', target: 'Customer' } });
    const { adopt } = matchTemplates(m);
    const c = adopt.find(a => a.candidate.kind === 'refsResolve')!.candidate;
    expect(c).toEqual({ kind: 'refsResolve', aggregate: 'Order', fields: ['who'] });
  });
});
