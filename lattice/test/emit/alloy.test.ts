import { describe, it, expect } from 'vitest';
import { astToAlloy } from '../../src/emit/alloy.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { DomainModel } from '../../src/ast/domain.js';
import { traceAModel, invoiceLinesModel, someStatePredicateOnInvoice, someCardinalityOnInvoice, sumCandidate, periodModel } from '../fixtures.js';

const h1: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] };
const h2: Candidate = { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] };

describe('astToAlloy', () => {
  it('emits sigs, state sigs, candidate preds, and a distinguish run', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4 });
    expect(als).toContain('sig Subscription');
    expect(als).toContain('one sig Subscription_Access_Active');
    expect(als).toContain('Access_state: one Subscription_Access');
    expect(als).toContain('pred Hi');
    expect(als).toContain('pred Hj');
    expect(als).toContain('run q { (Hi and not Hj) or (not Hi and Hj) } for 4 but 5 Int');
  });
  it('emits exclusion shape predicates conjoined into the run', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: h1, exclusions: [[
      { dim: 'customer equal', value: true }, { dim: 'plan equal', value: false },
      { dim: 'plan.family equal', value: true }, { dim: 'inState count', value: 2 }
    ]], scope: 4 });
    expect(als).toContain('pred shape0');
    expect(als).toContain('a.customer = b.customer');
    expect(als).toContain('a.plan != b.plan');
    expect(als).toContain('a.plan.family = b.plan.family');
    expect(als).toContain('run q { (not Hi) and (not shape0) } for 4 but 5 Int');
  });
  it('probe-permit runs Hi with a non-vacuity witness pattern', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-permit', hi: h1, exclusions: [], scope: 4 });
    expect(als).toContain('pred nonVacuous');
    expect(als).toContain('run q { Hi and nonVacuous } for 4 but 5 Int');
  });

  // Regression coverage for golden trace A: a probe on H1 (unique per customer only) needs a
  // witness that also varies plan.family — a field H1 itself never references — so the human can
  // catch that H1 is coarser than the true per-(customer, plan.family) key. Left to a plain SAT
  // search, Kodkod's symmetry breaking always collapses `family` to a single reused atom since
  // nothing in `not Hi` forces otherwise (see task-17 report for the empirical trace). The
  // `varyUnreferenced` flag adds an explicit "some domain field H1 ignores must differ" conjunct.
  it('probe-forbid with varyUnreferenced forces a field the candidate ignores to differ', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: h1, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('some disj a, b: Subscription | (not Hi) and (a.plan.family != b.plan.family)');
  });
  it('probe-permit with varyUnreferenced forces a field the candidate ignores to differ', () => {
    const als = astToAlloy(traceAModel, { kind: 'probe-permit', hi: h1, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('some disj a, b: Subscription | Hi and nonVacuous and (a.plan.family != b.plan.family)');
  });
  it('falls back to varying the bare ref when its own deeper field is already referenced', () => {
    // This candidate already references plan.family, so the deeper path is excluded — the vary
    // clause falls back to the bare `plan` ref (still informative: a different plan in the same
    // family is a case this candidate's own key can't see either way).
    const perCustomerFamily: Candidate = { kind: 'unique', aggregate: 'Subscription',
      whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] };
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: perCustomerFamily, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('some disj a, b: Subscription | (not Hi) and (a.plan != b.plan)');
  });
  it('varyUnreferenced does not affect distinguish queries', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4, varyUnreferenced: true });
    expect(als).toContain('run q { (Hi and not Hj) or (not Hi and Hj) } for 4 but 5 Int');
  });

  // Regression: extractSalient now captures machine-state as a salient dim (`<Region>.state =
  // <value>`) so a statePredicate candidate differing from another only by an inState guard isn't
  // masked (see salient.ts's collectInStateRegions). Arithmetic-free statePredicates route to
  // Alloy, and shapeToPred's generic dotted-path branch would previously emit invalid Alloy for
  // this dim (`a.Access.state = Active` — there is no `.state` sub-relation on a region name).
  // It must instead target the `<Region>_state` relation with the `<Agg>_<Region>_<Value>` one-sig.
  it('rebuilds a machine-state exclusion dim (`<Region>.state = <value>`) into the region-state one-sig comparison, not a dotted field path', () => {
    const guarded: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      where: { kind: 'inState', owner: 'self', region: 'Access', states: ['Active'] },
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['customer'] }, right: { kind: 'field', owner: 'self', path: ['customer'] } } };
    const als = astToAlloy(traceAModel, { kind: 'probe-forbid', hi: guarded, exclusions: [[
      { dim: 'Access.state = Active', value: true }
    ]], scope: 4 });
    expect(als).toContain('a.Access_state = Subscription_Access_Active');
    expect(als).not.toContain('a.Access.state');
  });

  // Regression (live session .lattice-session-subscriptions, quint side; Alloy had the same
  // hole): solver queries must constrain witnesses to satisfy already-adopted invariants, or the
  // human is shown composite-invalid states they already ruled out. Adopted candidates arrive on
  // the query and are conjoined as extra preds in the run body.
  it('conjoins adopted invariant preds into the run body', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [], scope: 4, adopted: [h2] });
    expect(als).toContain('pred Adopted0');
    expect(als).toContain('run q { ((Hi and not Hj) or (not Hi and Hj)) and Adopted0 } for 4 but 5 Int');
  });
  // Alloy's `and` binds tighter than `or`: conjoining exclusions onto the distinguish disjunction
  // without parenthesizing it scoped them to the second disjunct only — `A or B and C` is
  // `A or (B and C)`, so a witness matching an excluded shape could still be returned via the
  // `(Hi and not Hj)` side. The disjunctive body must be wrapped before conjoining.
  it('distinguish exclusions apply to both disjuncts, not just the second (and/or precedence)', () => {
    const als = astToAlloy(traceAModel, { kind: 'distinguish', hi: h1, hj: h2, exclusions: [[
      { dim: 'customer equal', value: true }
    ]], scope: 4 });
    expect(als).toContain('run q { ((Hi and not Hj) or (not Hi and Hj)) and (not shape0) } for 4 but 5 Int');
  });

  // Task 7: owned collections (design §6.1/§6.3) — the child entity behind a `list` field becomes
  // its own sig with a by-construction `owner: one <Parent>` relation (containment, not a bare
  // ref); the parent sig itself carries NO relation for the list field (children point up, not
  // down — see emitOwnerSig, which already only matches ref/enum/prim fields and so silently
  // drops list fields with no branch change needed).
  it('emits owned children as sigs with one owner, and no list relation on the parent', () => {
    const src = astToAlloy(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], scope: 4 });
    expect(src).toContain('sig InvoiceLine {');
    expect(src).toContain('owner: one Invoice');
    expect(src).toContain('amount: one Int');
    expect(src).not.toContain('lines:');
  });

  // Task 9: sum-over-collection (design §6.2/§6.4) — adopted sums conjoin as an Alloy `sum`
  // comprehension over the owned child sig, and raise the bitwidth (3 children × values summed
  // can overflow the default 5-Int scope) to 7 Int.
  it('conjoins adopted sums with alloy sum and raises bitwidth to 7 Int', () => {
    const src = astToAlloy(invoiceLinesModel, { kind: 'probe-forbid', hi: someCardinalityOnInvoice,
      exclusions: [], adopted: [sumCandidate], scope: 4 });
    expect(src).toContain('x.totalDue = (sum l: { l: InvoiceLine | l.owner = x } | l.amount)');
    expect(src).toContain('but 7 Int');
  });
  it('keeps 5 Int without sums', () => {
    const src = astToAlloy(invoiceLinesModel, { kind: 'probe-forbid', hi: someCardinalityOnInvoice, exclusions: [], scope: 4 });
    expect(src).toContain('but 5 Int');
  });
  // Bitwidth policy checks q.hi, q.hj, AND adopted — not just hi. A distinguish query where only
  // hj (not hi) is the sumOverCollection candidate must still raise to 7 Int.
  it('raises bitwidth to 7 Int when only hj (not hi) is a sumOverCollection candidate', () => {
    const src = astToAlloy(invoiceLinesModel, {
      kind: 'distinguish', hi: someStatePredicateOnInvoice, hj: sumCandidate, exclusions: [], scope: 4,
    });
    expect(src).toContain('but 7 Int');
  });

  // Task 9: shapeToPred rebuilds a sum witness's salient dims (count/sum/total) as Alloy conjuncts
  // when the excluded shape's OWN subject is a sumOverCollection candidate — the child sig name
  // (`subject.child`) is only available then; a non-sum Alloy subject never carries sum dims.
  it('rebuilds sum salient dims (count/sum/total) into alloy exclusion conjuncts', () => {
    const src = astToAlloy(invoiceLinesModel, { kind: 'probe-forbid', hi: sumCandidate, exclusions: [[
      { dim: 'lines.count', value: 2 }, { dim: 'sum(lines.amount)', value: 7 }, { dim: 'totalDue value', value: 7 },
    ]], scope: 4 });
    expect(src).toContain('#{ l: InvoiceLine | l.owner = a } = 2');
    expect(src).toContain('(sum l: { l: InvoiceLine | l.owner = a } | l.amount) = 7');
    expect(src).toContain('a.totalDue = 7');
  });

  // Task 11: value objects (design §3.5) get real alloy encoding — a value-typed field flattens
  // to `<field>_<subfield>: one Int` sig relations (no nested sig: values are keyless/flat).
  describe('value fields — flattened field encoding', () => {
    const periodCand: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt',
        left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };

    it('emits the value field as underscore-flattened sig relations', () => {
      const src = astToAlloy(periodModel, { kind: 'probe-permit', hi: periodCand, exclusions: [], scope: 4 });
      expect(src).toContain('period_start: one Int');
      expect(src).toContain('period_end: one Int');
      expect(src).not.toContain('period:');
    });
    it('renders a value-hop path as the underscore-joined field, not a dotted path', () => {
      const src = astToAlloy(periodModel, { kind: 'probe-permit', hi: periodCand, exclusions: [], scope: 4 });
      expect(src).toContain('x.period_start');
      expect(src).toContain('x.period_end');
      expect(src).not.toContain('x.period.start');
    });
  });

  // Defense-in-depth below validateCandidate (which REJECTS any param-bearing candidate as
  // ill-typed — see test/ast/validate-services.test.ts): a param term must never reach alloy
  // emission either. termToAlloy's 'param' case throws rather than silently emitting nonsense
  // alloy source referencing a method parameter that doesn't exist as a sig relation. This test
  // calls astToAlloy directly, bypassing routeCandidate (a `ge` cmp actually routes to quint via
  // predNeedsArith), to pin the emitter's own defense-in-depth throw regardless of routing.
  it('astToAlloy throws on a param-bearing candidate — param terms never reach the emitter (validateCandidate rejects them upstream; this is the routing backstop)', () => {
    const paramLeak: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['customer'] }, right: { kind: 'param', name: 'delta' } } };
    expect(() => astToAlloy(traceAModel, { kind: 'probe-forbid', hi: paramLeak, exclusions: [], scope: 4 })).toThrow(/param terms/);
  });
});

describe('child sigs carry refs and value fields (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [{ name: 'Currency', values: ['usd', 'eur'] }],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'currency', type: { kind: 'enum', enum: 'Currency' } }] }],
    entities: [{ kind: 'entity', name: 'Account', fields: [
      { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'code', type: { kind: 'prim', prim: 'Int' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'account', type: { kind: 'ref', target: 'Account' } },
        { name: 'amount', type: { kind: 'value', value: 'Amount' } }] }] }],
    events: [], services: [],
  };
  const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
    hi: { kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] } });

  it('emits a child ref as `one <Target>`', () => {
    expect(src).toMatch(/sig Posting \{[^}]*account: one Account/s);
  });
  it('flattens a child value field to underscore-joined relations', () => {
    expect(src).toMatch(/sig Posting \{[^}]*amount_amount: one Int/s);
    expect(src).toMatch(/sig Posting \{[^}]*amount_currency: one Currency/s);
  });
  it('keeps the by-construction owner relation', () => {
    expect(src).toMatch(/sig Posting \{\s*owner: one Txn/s);
  });
  it('declares a sig for the ref target', () => {
    expect(src).toMatch(/sig Account \{/);
  });
});

describe('nested value flattening and path rendering (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], events: [], services: [], entities: [],
    values: [
      { kind: 'value', name: 'Amount', fields: [{ name: 'amount', type: { kind: 'prim', prim: 'Money' } }] },
      { kind: 'value', name: 'TaxedAmount', fields: [
        { name: 'net', type: { kind: 'value', value: 'Amount' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
      { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'line', type: { kind: 'value', value: 'TaxedAmount' } }] }],
  };

  it('flattens a nested value recursively', () => {
    const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
      hi: { kind: 'statePredicate', aggregate: 'Bill',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['line', 'net', 'amount'] },
                right: { kind: 'int', value: 0 } } } });
    expect(src).toMatch(/sig Bill \{[^}]*line_net_amount: one Int/s);
  });

  it('renders a deep value path as the flattened relation, not a dotted join', () => {
    const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
      hi: { kind: 'statePredicate', aggregate: 'Bill',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['line', 'net', 'amount'] },
                right: { kind: 'int', value: 0 } } } });
    expect(src).toContain('.line_net_amount');
    expect(src).not.toContain('.line.net.amount');
  });
});

// The latent bug the alloyFieldPath rewrite fixes, guarded directly. The old renderer special-cased
// a value at segment 0 ONLY, so a value reached THROUGH a ref hop rendered `x.plan.period.start` —
// a relation no sig declares (Plan's sig declares the FLATTENED `period_start`). resolveFieldPath
// accepts this path, and it is reachable on the alloy route via a `unique` by-path or an enum-eq
// statePredicate, so the emitter could hand Alloy an undeclared relation. Independent of value
// NESTING: this model's Period is a plain one-level value.
describe('alloyFieldPath: a value reached through a ref hop (latent bug)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], events: [], services: [],
    values: [{ kind: 'value', name: 'Period', fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }] }],
    entities: [{ kind: 'entity', name: 'Plan', fields: [
      { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'period', type: { kind: 'value', value: 'Period' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Sub', fields: [
      { name: 'subId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'plan', type: { kind: 'ref', target: 'Plan' } }] }],
  };
  const src = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4,
    hi: { kind: 'statePredicate', aggregate: 'Sub',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['plan', 'period', 'start'] },
              right: { kind: 'int', value: 0 } } } });

  it('renders the ref hop with `.` and the value hop with `_`', () => {
    expect(src).toContain('x.plan.period_start');
    expect(src).not.toContain('x.plan.period.start');
  });
  it('emits the relation it renders — Plan declares period_start', () => {
    expect(src).toMatch(/sig Plan \{[^}]*period_start: one Int/s);
  });
});
