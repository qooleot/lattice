import { describe, it, expect } from 'vitest';
import { matchTemplates, numericTagPath } from '../../src/engine/templates.js';
import { impliedInvariants, isImplied } from '../../src/engine/implied.js';
import { validateCandidate } from '../../src/ast/grammar.js';
import type { DomainModel, ValueDef } from '../../src/ast/domain.js';
import { periodModel, traceAModel, traceBModel } from '../fixtures.js';
import { astToCode } from '../../src/emit/code.js';
import { loadLatText } from '../../src/parse/fromLangium.js';

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

  it('#7 adopts no singleActive* for a refless @active aggregate in a multi-tenant shape', () => {
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
    expect(r.adopt.map(a => a.name)).not.toContain('singleActiveBiller');
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

// 18 of 30 renames in the real subscriptions session were a human hand-fixing these names to
// camelCase, and every emitted spec warned on reload. These two guards pin both halves: the
// ledger-visible name (which `apply` reconciles by, printed or not) and the emitted file.
describe('matchTemplates — invariant names follow the camelCase convention (spec P8)', () => {
  const CAMEL = /^[a-z][A-Za-z0-9]*$/;

  // revrecMini is NOT usable for the emit guard: its region `Lifecycle`, states `Open`/`Closed` and
  // enum values `Recognition`/`Correction` are PascalCase and produce 5 naming warnings of their
  // own. This model is convention-clean everywhere EXCEPT what matchTemplates names, so a warning
  // here can only be an invariant name.
  const cleanModel: DomainModel = {
    context: 'Billing', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Biller', fields: [{ name: 'billerId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'biller', type: { kind: 'ref', target: 'Biller' } },
      { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'amountDue', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
      machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
        { name: 'draft' }, { name: 'issued', tags: ['active'] }, { name: 'void', tags: ['terminal'] }] }],
        transitions: [] } }],
    events: [], services: []
  };

  it('every adopted and seeded name is camelCase', () => {
    const { adopt, seeds } = matchTemplates(revrecMini);
    expect([...adopt, ...seeds].filter(a => !CAMEL.test(a.name)).map(a => a.name)).toEqual([]);
  });

  it('an emitted spec reloads with zero naming-convention warnings', async () => {
    const { adopt } = matchTemplates(cleanModel);
    const r = await loadLatText(astToCode(cleanModel, adopt));
    // Narrow the LoadResult union with control flow (not `expect`) so the
    // compiler, not just the runtime assertion, knows `r.warnings` exists.
    if (!r.ok) throw new Error(`expected emitted spec to parse cleanly: ${JSON.stringify(r.diagnostics)}`);
    expect(r.warnings.filter(w => w.code === 'naming-convention')).toEqual([]);
  });

  it('uniquePer seeds are distinct per owner (not just per ref field)', () => {
    // two aggregates with a same-named ref field and an @active state must not collide
    const m: DomainModel = {
      context: 'Coll', ticksPerDay: 24, enums: [], values: [],
      entities: [{ kind: 'entity', name: 'Biller', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
      aggregates: (['Bill', 'Fee'] as const).map(n => ({
        kind: 'aggregate' as const, name: n,
        fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
                 { name: 'biller', type: { kind: 'ref' as const, target: 'Biller' } }],
        machine: { regions: [{ name: 'standing', initial: 'open', states: [{ name: 'open', tags: ['active' as const] }] }], transitions: [] }
      })),
      events: [], services: []
    };
    const names = matchTemplates(m).seeds.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('conservation sees through a value (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  const m: DomainModel = {
    context: 'L', enums: [], values: [amount], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'paid', type: { kind: 'value', value: 'Amount' }, tags: ['balance', 'unsigned'] },
      { name: 'due', type: { kind: 'value', value: 'Amount' }, tags: ['balance', 'unsigned'] },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['total', 'unsigned'] }] }],
  };

  it('emits two-segment paths through the value', () => {
    const c = matchTemplates(m).adopt.find(i => i.candidate.kind === 'conservation')!.candidate;
    expect(c).toEqual({ kind: 'conservation', aggregate: 'Bill',
      parts: [['paid', 'amount'], ['due', 'amount']], total: ['total', 'amount'] });
  });

  it('still emits single-segment paths for plain Money', () => {
    const flat: DomainModel = { ...m, values: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'paid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'due', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] }] };
    const c = matchTemplates(flat).adopt.find(i => i.candidate.kind === 'conservation')!.candidate;
    expect(c).toEqual({ kind: 'conservation', aggregate: 'Bill',
      parts: [['paid'], ['due']], total: ['total'] });
  });
});

describe('numericTagPath recurses through two value hops (slice B2 recursion decision)', () => {
  // total : Outer, Outer { inner : Amount }, Amount { amount : Money } — mirrors domain.ts's
  // moneyFieldPaths doc example. Non-recursive would stop after one hop and return null here,
  // silently dropping conservation on a field two value-levels deep even though quint's
  // pathToQuint already renders arbitrarily deep value paths (x.total.inner.amount).
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] };
  const outer: ValueDef = { kind: 'value', name: 'Outer', fields: [
    { name: 'inner', type: { kind: 'value', value: 'Amount' } }] };
  const m: DomainModel = {
    context: 'L', enums: [], values: [amount, outer], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'value', value: 'Outer' }, tags: ['total'] }] }],
  };

  it('resolves a two-hop value path to its single numeric leaf', () => {
    const f = m.aggregates[0]!.fields.find(x => x.name === 'total')!;
    expect(numericTagPath(m, f)).toEqual(['total', 'inner', 'amount']);
  });
});

describe('conservation on a child subject (owners widened, slice B2)', () => {
  // A child-subject conservation now has a real Quint encoding (Task 6's candidateToQuint
  // childContext/overChildren branch), so tagging a nested-entity's fields is no longer silently
  // unmatched by templates.ts's owner list the way it would have been before that encoding existed.
  const m: DomainModel = {
    context: 'L', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'paid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'due', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] }] }],
  };

  it('matches conservation on the nested child entity, not just top-level owners', () => {
    const c = matchTemplates(m).adopt.find(i => i.candidate.kind === 'conservation')!.candidate;
    expect(c).toEqual({ kind: 'conservation', aggregate: 'Posting',
      parts: [['paid'], ['due']], total: ['total'] });
  });
});

// Task 5: matchTemplates must never author a candidate validateCandidate would reject from a
// human proposer (absence-undecided: monotonic field, conservation parts/total, unique by-path
// ends). Before this fix, matchTemplates derived these shapes from optional-tagged fields without
// filtering, so `init` (cli.ts) adopted candidates that `propose` would refuse outright — the
// engine enforced rules its own grammar called undecided.
describe('matchTemplates — optional fields are absence-undecided, so templates skip them', () => {
  it('does not adopt monotonic over an optional @monotonic field (absence-undecided shape)', () => {
    const m: DomainModel = {
      context: 'M', ticksPerDay: 24, enums: [], values: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Approval', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'approvedAt', type: { kind: 'prim', prim: 'Date' }, optional: true, tags: ['monotonic'] }] }],
      events: [], services: []
    };
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'monotonic')).toBe(false);
  });

  it('skips conservation entirely when any @balance/@total field is optional', () => {
    const m: DomainModel = {
      context: 'M', ticksPerDay: 24, enums: [], values: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'a', type: { kind: 'prim', prim: 'Money' }, tags: ['balance', 'unsigned'] },
        { name: 'b', type: { kind: 'prim', prim: 'Money' }, optional: true, tags: ['balance', 'unsigned'] },
        { name: 't', type: { kind: 'prim', prim: 'Money' }, tags: ['total', 'unsigned'] }] }],
      events: [], services: []
    };
    const { adopt } = matchTemplates(m);
    expect(adopt.some(a => a.candidate.kind === 'conservation')).toBe(false);
  });

  it('unique seeds never key on an optional ref (by-path would be rejected at propose)', () => {
    const m: DomainModel = {
      context: 'Billing', ticksPerDay: 24, enums: [], values: [],
      entities: [{ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
      aggregates: [{ kind: 'aggregate', name: 'Subscription', fields: [
        { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'customer', type: { kind: 'ref', target: 'Customer' }, optional: true }],
        machine: { regions: [{ name: 'Access', initial: 'Trialing', states: [
          { name: 'Trialing' }, { name: 'Active', tags: ['active'] }] }], transitions: [] } }],
      events: [], services: []
    };
    const { seeds } = matchTemplates(m);
    expect(seeds.some(s => s.candidate.kind === 'unique')).toBe(false);
  });

  // Every model this test file (and fixtures.ts, via import) builds — the property this pins is
  // structural: whatever matchTemplates derives from ANY of these shapes must already be
  // something a human could `propose` without tripping absence-undecided. Recreated here (rather
  // than reaching into other describe blocks' closures) because those fixtures are declared
  // inside `it`/`describe` callbacks and are not in scope at this point in the file.
  const billerModel: DomainModel = {
    context: 'BillPayments', ticksPerDay: 24, enums: [], values: [], entities: [],
    aggregates: [{ kind: 'aggregate', name: 'Biller', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'name', type: { kind: 'prim', prim: 'Text' } }],
      machine: { regions: [{ name: 'Lifecycle', initial: 'Active', states: [
        { name: 'Active', tags: ['active'] }, { name: 'Retired', tags: ['terminal'] }] }], transitions: [] } }],
    events: [], services: []
  };
  const signedModel: DomainModel = {
    context: 'Ledger', ticksPerDay: 24, enums: [], values: [], entities: [],
    aggregates: [{ kind: 'aggregate', name: 'Account', fields: [
      { name: 'accountId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'balance', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] },
      { name: 'lifetimeFees', type: { kind: 'prim', prim: 'Money' } }] }],
    events: [], services: []
  };
  const cleanModel: DomainModel = {
    context: 'Billing', ticksPerDay: 24, enums: [], values: [],
    entities: [{ kind: 'entity', name: 'Biller', fields: [{ name: 'billerId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'biller', type: { kind: 'ref', target: 'Biller' } },
      { name: 'amountPaid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'amountDue', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
      { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
      machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
        { name: 'draft' }, { name: 'issued', tags: ['active'] }, { name: 'void', tags: ['terminal'] }] }],
        transitions: [] } }],
    events: [], services: []
  };
  const valueAmount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };
  const valueConservationModel: DomainModel = {
    context: 'L', enums: [], values: [valueAmount], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'paid', type: { kind: 'value', value: 'Amount' }, tags: ['balance', 'unsigned'] },
      { name: 'due', type: { kind: 'value', value: 'Amount' }, tags: ['balance', 'unsigned'] },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['total', 'unsigned'] }] }],
  };
  const childSubjectModel: DomainModel = {
    context: 'L', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'paid', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'due', type: { kind: 'prim', prim: 'Money' }, tags: ['balance'] },
        { name: 'total', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }] }] }],
  };

  const allTemplateFixtureModels: DomainModel[] = [
    revrecMini, billerModel, signedModel, cleanModel, valueConservationModel, childSubjectModel,
    periodModel, traceAModel, traceBModel
  ];

  it('every template-authored candidate passes validateCandidate', () => {
    for (const m of allTemplateFixtureModels) {
      const { adopt, seeds } = matchTemplates(m);
      for (const i of [...adopt, ...seeds])
        expect(validateCandidate(i.candidate, m), i.id).toEqual([]);
    }
  });
});
