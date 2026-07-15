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
  it('#2 non-negative is delegated to implied.ts (camelCase, implied- ids)', () => {
    const nonNegative = adopt.filter(a => a.name.startsWith('nonNegative'));
    expect(nonNegative.length).toBe(3);
    expect(nonNegative.every(a => a.id.startsWith('implied-'))).toBe(true);
  });
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

describe('matchTemplates — structure-implied families are delegated, not re-derived', () => {
  const { adopt } = matchTemplates(revrecMini);
  const implied = impliedInvariants(revrecMini);

  it('adopts every implied invariant verbatim (same id, name, and candidate)', () => {
    for (const i of implied) {
      const found = adopt.find(a => a.id === i.id);
      expect(found, `implied ${i.name} not adopted`).toBeDefined();
      expect(found!.name).toBe(i.name);
      expect(found!.candidate).toEqual(i.candidate);
    }
  });

  it('derives no non-negative / refsResolve / terminal / value-law candidate of its own', () => {
    const impliedIds = new Set(implied.map(i => i.id));
    const ownDerived = adopt.filter(a => !impliedIds.has(a.id));
    expect(ownDerived.every(a => a.id.startsWith('tpl-')), 'template-owned ids must be tpl-*').toBe(true);
    // Obligation's conservation + monotonic are the whole template-owned set. No cardinality:
    // 9bc1ed5 dropped tpl-7's no-refs arm, so a refless @active aggregate (AccountingPeriod)
    // adopts nothing. Verified against main at cb01d6a — do not "correct" this to include
    // cardinality without re-running matchTemplates first.
    expect(ownDerived.map(a => a.candidate.kind).sort())
      .toEqual(['conservation', 'monotonic']);
  });
});

// Task 11: type-carried laws (design §3.5/§6). impliedInvariants is the sole derivation of these
// candidates; matchTemplates adopts its output verbatim (see the delegation comment atop
// matchTemplates), so drift between "enforced" and "printed" shapes is now structurally
// impossible rather than merely tested for.
describe('matchTemplates — type-carried value laws', () => {
  const { adopt } = matchTemplates(periodModel);
  const law = adopt.find(a => a.id.startsWith('implied-val'));

  it('adopts a value invariant as a prefixed statePredicate at its use site', () => {
    expect(law).toBeDefined();
    expect(law!.id).toBe('implied-valPeriodSubscriptionPeriodWellOrdered');
    expect(law!.name).toBe('valPeriodSubscriptionPeriodWellOrdered');
    expect(law!.candidate).toMatchObject({ kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt', left: { kind: 'field', path: ['period', 'start'] }, right: { kind: 'field', path: ['period', 'end'] } } });
  });

  it('the adopted value law IS the implied one, not a copy of it', () => {
    expect(isImplied(law!.candidate, periodModel)).toBe(true);
    expect(impliedInvariants(periodModel).find(i => i.id.startsWith('implied-val'))).toEqual(law);
  });

  it('all adopted value laws have template source + deterministic ids', () => {
    expect(adopt.every(a => a.source === 'template')).toBe(true);
    expect(new Set(adopt.map(a => a.id)).size).toBe(adopt.length);
  });
});

// #2 non-negativity used to be derived in two places for two purposes (adopt-for-enforcement
// here, dedup-for-printing in implied.ts). They drifted once: templates.ts ignored @signed, so a
// `balance : Money @signed` was adopted as `balance >= 0` — constraining every witness the solver
// drew, AND (since isImplied consults implied.ts, which honoured @signed) printed by astToCode as
// an explicit invariant contradicting the tag three lines above it. Now templates.ts adopts
// impliedInvariants verbatim, so @signed suppression surviving delegation is what these tests
// pin — agreement is structural (one derivation), not merely asserted.
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
    expect(adopt.some(a => a.name === 'nonNegativeAccountBalance')).toBe(false));

  it('still adopts one for an unsigned Money field alongside it', () =>
    expect(adopt.some(a => a.name === 'nonNegativeAccountLifetimeFees')).toBe(true));

  // The drift guard proper: anything astToCode would print (adopted ∧ ¬isImplied) is a rule the
  // two modules disagree about. This is the assertion that fails if either derivation moves alone.
  it('every adopted non-negative candidate is recognized as implied', () => {
    const nonNeg = adopt.filter(a => a.name.startsWith('nonNegative'));
    expect(nonNeg.length).toBeGreaterThan(0);
    expect(nonNeg.filter(a => !isImplied(a.candidate, signedModel))).toEqual([]);
  });

  it('holds for the richer revrec fixture too', () => {
    const nonNeg = matchTemplates(revrecMini).adopt.filter(a => a.name.startsWith('nonNegative'));
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

  it('adopts no refsResolve invariant when the only ref field is qualified', () => {
    const m = base('Catalog.Plan');
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'refsResolve')).toBe(false);
  });

  it('the refsResolve fields list excludes a qualified ref alongside a local one', () => {
    const m = base('Catalog.Plan');
    m.entities.push({ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'who', type: { kind: 'ref', target: 'Customer' } });
    const { adopt } = matchTemplates(m);
    const c = adopt.find(a => a.candidate.kind === 'refsResolve')!.candidate;
    expect(c).toEqual({ kind: 'refsResolve', aggregate: 'Order', fields: ['who'] });
  });
});
