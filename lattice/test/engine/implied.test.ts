import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { impliedInvariants, isImplied, canonicalCandidate, valueLawInstances, derivedNameCollisions } from '../../src/engine/implied.js';
import type { DomainModel, ValueDef } from '../../src/ast/domain.js';
import { validateModel } from '../../src/ast/validate.js';
import { periodModel } from '../fixtures.js';
import { astToCode } from '../../src/emit/code.js';
import { astToQuint, candidateToQuint } from '../../src/emit/quint.js';

// Mirrors test/emit/quint-emission-valid.test.ts's own `typechecks` helper (not shared/exported —
// this is the same cheap `quint typecheck` gate, applied here to a child-owner's derived value law).
async function typechecks(source: string): Promise<{ ok: boolean; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'qnt-'));
  const f = join(dir, 'm.qnt');
  writeFileSync(f, source);
  const exec = promisify(execFile);
  try {
    await exec('npx', ['quint', 'typecheck', f], { cwd: process.cwd() });
    return { ok: true, stderr: '' };
  } catch (e: any) {
    return { ok: false, stderr: String(e.stderr ?? e.stdout ?? e.message) };
  }
}

const m: DomainModel = {
  context: 'C', enums: [], values: [], events: [], services: [],
  entities: [{ kind: 'entity', name: 'Plan', fields: [
    { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'licenseFee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'adjustment', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
  aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
    { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'plan', type: { kind: 'ref', target: 'Plan' } },
    { name: 'totalDue', type: { kind: 'prim', prim: 'Money' }, tags: ['total'] }],
    machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
      { name: 'draft' }, { name: 'paid', tags: ['terminal'] }, { name: 'void', tags: ['terminal'] }] }],
      transitions: [] } }],
};

describe('impliedInvariants', () => {
  const derived = impliedInvariants(m);
  const names = derived.map(d => d.name).sort();

  it('derives terminal, refsResolve, nonNegative with deterministic names', () => {
    expect(names).toEqual(['nonNegativeInvoiceTotalDue', 'nonNegativePlanLicenseFee',
      'refsResolveInvoice', 'terminalInvoiceSettlementPaid', 'terminalInvoiceSettlementVoid'].sort());
  });

  it('suppresses nonNegative for @signed Money fields', () => {
    expect(names).not.toContain('nonNegativePlanAdjustment');
  });

  it('candidates carry the exact closed-grammar shapes', () => {
    const t = derived.find(d => d.name === 'terminalInvoiceSettlementPaid')!;
    expect(t.candidate).toEqual({ kind: 'terminal', aggregate: 'Invoice', region: 'settlement', state: 'paid' });
    const n = derived.find(d => d.name === 'nonNegativeInvoiceTotalDue')!;
    expect(n.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'int', value: 0 } } });
    expect(t.id).toBe('implied-terminalInvoiceSettlementPaid');
  });

  it('isImplied matches by candidate shape, ignoring metadata', () => {
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Invoice' }, m)).toBe(true);
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Plan' }, m)).toBe(false);
  });

  it('derives refsResolve for an entity with a ref field (owners are entities ∪ aggregates)', () => {
    const m2: DomainModel = { ...m, entities: [...m.entities,
      { kind: 'entity', name: 'Order', fields: [
        { name: 'orderId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'plan', type: { kind: 'ref', target: 'Plan' } }] }] };
    const d = impliedInvariants(m2).find(x => x.name === 'refsResolveOrder')!;
    expect(d.candidate).toEqual({ kind: 'refsResolve', aggregate: 'Order', fields: ['plan'] });
    expect(isImplied({ kind: 'refsResolve', aggregate: 'Order' }, m2)).toBe(true);
  });

  it('isImplied dedup: a stored refsResolve WITHOUT fields still matches a newly-derived one WITH fields', () => {
    // Regression for task 16: adopted candidates recorded before the `fields` addition have no
    // `fields` key. Newly-derived candidates now carry `fields`. isImplied's shape comparison must
    // normalize (strip `fields`) so a legacy stored candidate is still recognized as implied —
    // otherwise it would double-print/reprint on regeneration.
    const m2: DomainModel = { ...m, entities: [...m.entities,
      { kind: 'entity', name: 'Order', fields: [
        { name: 'orderId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'plan', type: { kind: 'ref', target: 'Plan' } }] }] };
    const legacyStored = { kind: 'refsResolve' as const, aggregate: 'Order' }; // no `fields`
    expect(isImplied(legacyStored, m2)).toBe(true);
  });

  it('derives a terminal rule per tagged state across multiple regions', () => {
    const m2: DomainModel = JSON.parse(JSON.stringify(m));
    m2.aggregates[0]!.machine!.regions.push({ name: 'dunning', initial: 'idle',
      states: [{ name: 'idle' }, { name: 'closed', tags: ['terminal'] }] });
    const names2 = impliedInvariants(m2).map(d => d.name);
    expect(names2).toEqual(expect.arrayContaining(
      ['terminalInvoiceSettlementPaid', 'terminalInvoiceSettlementVoid', 'terminalInvoiceDunningClosed']));
    const t = impliedInvariants(m2).find(d => d.name === 'terminalInvoiceDunningClosed')!;
    expect(t.candidate).toEqual({ kind: 'terminal', aggregate: 'Invoice', region: 'dunning', state: 'closed' });
  });

  it('isImplied distinguishes different cmp bodies on the same aggregate (deep canonicalization)', () => {
    expect(isImplied({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['totalDue'] }, right: { kind: 'int', value: 1 } } } }, m)).toBe(false);
    expect(isImplied({ kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['totalDue'] },
        right: { kind: 'int', value: 0 } } }, m)).toBe(true);
  });

  it('canonicalCandidate is key-order-insensitive (raw JSON compare was not)', () => {
    const ordered: any = { kind: 'statePredicate', aggregate: 'Box',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } } };
    const jumbled: any = { body: { right: { value: 0, kind: 'int' }, left: { path: ['amount'], owner: 'self', kind: 'field' }, op: 'ge', kind: 'cmp' },
      aggregate: 'Box', kind: 'statePredicate' };
    expect(JSON.stringify(ordered)).not.toBe(JSON.stringify(jumbled));
    expect(canonicalCandidate(ordered)).toBe(canonicalCandidate(jumbled));
  });
});

// Local fixture (tests don't import across test files): an Order aggregate whose only ref
// field is a qualified cross-context ref to `target` (e.g. 'Catalog.Plan', spec §4.2).
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

// Task 11: type-carried laws (design §3.5/§6) — a value type's own invariant is instantiated as a
// statePredicate candidate on every OWNER field of that value type, with every path prefixed
// [fieldName, ...]. periodModel: Subscription.period: Period, Period.wellOrdered { start < end }.
describe('impliedInvariants — type-carried value laws', () => {
  it('instantiates a value invariant as a prefixed statePredicate candidate per use site', () => {
    const laws = impliedInvariants(periodModel).filter(i => i.id.includes('val'));
    expect(laws.length).toBe(1);
    expect(laws[0]!.candidate).toMatchObject({ kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt', left: { kind: 'field', path: ['period', 'start'] }, right: { kind: 'field', path: ['period', 'end'] } } });
  });

  it('valueLawInstances is the sole derivation of value laws; impliedInvariants is its only caller', () => {
    const instances = valueLawInstances(periodModel);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.owner.name).toBe('Subscription');
    expect(instances[0]!.field).toBe('period');
    expect(instances[0]!.value.name).toBe('Period');
    expect(instances[0]!.inv.name).toBe('wellOrdered');
  });

  it('isImplied matches the per-site instantiated law by shape', () => {
    const c = impliedInvariants(periodModel).find(i => i.id.includes('val'))!.candidate;
    expect(isImplied(c, periodModel)).toBe(true);
  });

  it('a value law never prints per-site (as a Subscription invariant), even when explicitly adopted — only the value block\'s own declaration prints', () => {
    const law = impliedInvariants(periodModel).find(i => i.id.includes('val'))!;
    const code = astToCode(periodModel, [law]);
    // The value block's own `invariant wellOrdered { start < end }` declaration is expected —
    // what must NOT appear is a second, per-site printed copy on the Subscription aggregate
    // (which would read `period.start < period.end`, the prefixed candidate body).
    expect(code).not.toContain('period.start < period.end');
    const subscriptionBlock = code.slice(code.indexOf('aggregate Subscription'));
    expect(subscriptionBlock).not.toContain('invariant');
  });
});

// Task: valueLawInstances' owner list was top-level-only (aggregates ∪ entities), twelve lines
// above impliedInvariants' owner list which also includes aggregate-owned children — so
// Sub.term : Period derived wellOrdered while Leg.window : Period (a child field of the SAME
// aggregate, same value type) silently derived nothing, even though the field is legal and
// encoded in both solvers (Alloy flattens it onto the child sig; Quint nests it in the child
// record). This model mirrors the gap's own repro: aggregate Sub owns both a top-level
// value-typed field (term) and a child (Leg) with its own value-typed field (window).
const childValueLawModel: DomainModel = {
  context: 'C', ticksPerDay: 24, enums: [], events: [], services: [], entities: [],
  values: [{
    kind: 'value', name: 'Period',
    fields: [
      { name: 'start', type: { kind: 'prim', prim: 'Date' } },
      { name: 'end', type: { kind: 'prim', prim: 'Date' } }],
    invariants: [{ name: 'wellOrdered', body: { kind: 'cmp', op: 'lt',
      left: { kind: 'field', owner: 'self', path: ['start'] }, right: { kind: 'field', owner: 'self', path: ['end'] } } }],
  }],
  aggregates: [{
    kind: 'aggregate', name: 'Sub',
    fields: [
      { name: 'sid', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'term', type: { kind: 'value', value: 'Period' } },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Leg' } } }],
    entities: [{ kind: 'entity', name: 'Leg', fields: [
      { name: 'lid', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'window', type: { kind: 'value', value: 'Period' } }] }],
  }],
};

describe('impliedInvariants — a value law holds at a CHILD use site too (not just top-level)', () => {
  it("derives the CHILD's value law — Leg.window : Period instantiates wellOrdered on Leg", () => {
    // Exact name per impliedInvariants' minting: `val${value}${cap(owner)}${cap(field)}${cap(inv)}`
    // — val + Period + Leg + Window + WellOrdered. This is the derived (unfolded) name; it has no
    // underscores, so toCamelName (templates.ts's fold, applied on the way OUT to a session) is a
    // no-op on it and the folded name is identical.
    const leg = impliedInvariants(childValueLawModel).find(d => d.name === 'valPeriodLegWindowWellOrdered');
    expect(leg).toBeDefined();
    expect(leg!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Leg',
      body: { kind: 'cmp', op: 'lt', left: { kind: 'field', owner: 'self', path: ['window', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['window', 'end'] } } });
  });

  it("still derives the AGGREGATE's own use-site law — Sub.term : Period (no regression)", () => {
    const sub = impliedInvariants(childValueLawModel).find(d => d.name === 'valPeriodSubTermWellOrdered');
    expect(sub).toBeDefined();
    expect(sub!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Sub',
      body: { kind: 'cmp', op: 'lt', left: { kind: 'field', owner: 'self', path: ['term', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['term', 'end'] } } });
  });

  it('valueLawInstances itself (not just impliedInvariants) reports both the child and the aggregate site', () => {
    const instances = valueLawInstances(childValueLawModel);
    const byOwner = instances.map(i => `${i.owner.name}.${i.field}`).sort();
    expect(byOwner).toEqual(['Leg.window', 'Sub.term']);
  });

  it("the derived CHILD law emits valid Quint — walks the owner's child map, names no undeclared var", async () => {
    const legLaw = impliedInvariants(childValueLawModel).find(d => d.name === 'valPeriodLegWindowWellOrdered')!;
    const src = candidateToQuint(childValueLawModel, legLaw.candidate, 'legLaw0');
    // A child has no quint var of its own (design §6.1/§B2's overChildren) — the rendered body
    // must walk the OWNER's map (subs) and the child's slot accessor (o.legs.get(i)...), never a
    // bare `legs`/`legLaw`-named var, or Quint rejects it as undeclared.
    expect(src).toContain('subs.keys().forall');
    expect(src).toContain('legsCount');
    expect(src).toContain('o.legs.get(i).window.start < o.legs.get(i).window.end');
    // A child has no top-level quint var — the bug this branch exists to prevent would have
    // rendered a bare `legs.keys().forall(...)` (varName(c.aggregate) on the child name), which
    // is not a declared var. The only `.keys()` call here must be on the OWNER's map.
    expect(src).not.toMatch(/\blegs\.keys\(\)/);

    const em = astToQuint(childValueLawModel, { kind: 'probe-permit', exclusions: [], maxSteps: 1,
      hi: { kind: 'statePredicate', aggregate: 'Sub',
        body: { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } },
      adopted: [legLaw.candidate] });
    // Every var the body names must be one the module actually declares (`var <name>:`) — the
    // regression this whole slice (childContext/overChildren) exists to prevent.
    const declared = new Set([...em.source.matchAll(/var (\w+):/g)].map(x => x[1]!));
    for (const used of new Set([...em.source.matchAll(/(\w+)\.keys\(\)/g)].map(x => x[1]!)))
      expect([...declared], `body names undeclared var ${used}`).toContain(used);

    const r = await typechecks(em.source);
    expect(r.ok, r.stderr).toBe(true);
  });
});

describe('impliedInvariants — qualified-ref exclusion (spec §4.2)', () => {
  it('impliedInvariants skips refs-resolve when the only ref is qualified', () => {
    const m = base('Catalog.Plan');
    expect(impliedInvariants(m).some(i => i.candidate.kind === 'refsResolve')).toBe(false);
  });

  it('impliedInvariants still derives refs-resolve for a local ref', () => {
    const m = base('Catalog.Plan');
    m.entities.push({ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'who', type: { kind: 'ref', target: 'Customer' } });
    expect(impliedInvariants(m).some(i => i.candidate.kind === 'refsResolve')).toBe(true);
  });

  it('the derived refsResolve candidate carries only the same-context (unqualified) ref field names', () => {
    // Order has both a qualified ref (plan: Catalog.Plan, excluded per spec §4.2) and a local ref
    // (who: Customer) — the derived candidate's `fields` must list only `who`.
    const m = base('Catalog.Plan');
    m.entities.push({ kind: 'entity', name: 'Customer', fields: [{ name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true }] });
    m.aggregates[0]!.fields.push({ name: 'who', type: { kind: 'ref', target: 'Customer' } });
    const d = impliedInvariants(m).find(i => i.candidate.kind === 'refsResolve')!;
    expect(d.candidate).toEqual({ kind: 'refsResolve', aggregate: 'Order', fields: ['who'] });
  });
});

describe('money sign is a use-site decision (slice B2)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };

  it('THE case: one value, two use sites, opposite signs', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [amount], events: [], services: [],
      entities: [{ kind: 'entity', name: 'LedgerAccount', fields: [
        { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'balance', type: { kind: 'value', value: 'Amount' }, tags: ['signed'] }] }],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['unsigned'] }] }],
    };
    const names = impliedInvariants(m).map(i => i.name);
    expect(names).toContain('nonNegativeBillTotalAmount');          // @unsigned use site
    expect(names.filter(n => n.startsWith('nonNegativeLedgerAccount'))).toEqual([]);  // @signed
  });

  it('derives through a value to the Money sub-field only, not the Text one', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [amount], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' } }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativeBillTotalAmount')!.candidate;
    expect(c).toEqual({ kind: 'statePredicate', aggregate: 'Bill',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['total', 'amount'] },
              right: { kind: 'int', value: 0 } } });
  });

  it('derives non-negativity through Money nested TWO levels deep, once tagged @unsigned (slice B2 follow-up)', () => {
    // Outer wraps Amount, which wraps Money — legal only as of the value-in-value commit this
    // follows up. moneyFieldPaths must recurse through both hops, and impliedInvariants must
    // derive the guard once the use-site field is tagged @unsigned.
    const outer: ValueDef = { kind: 'value', name: 'Outer', fields: [
      { name: 'inner', type: { kind: 'value', value: 'Amount' } }] };
    const m: DomainModel = {
      context: 'L', enums: [], values: [amount, outer], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Outer' }, tags: ['unsigned'] }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativeBillTotalInnerAmount')!.candidate;
    expect(c).toEqual({ kind: 'statePredicate', aggregate: 'Bill',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['total', 'inner', 'amount'] },
              right: { kind: 'int', value: 0 } } });
  });

  it('derives a CHILD\'s plain Money non-negativity — the half the brief missed, inert today', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
        { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
        entities: [{ kind: 'entity', name: 'Posting', fields: [
          { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativePostingAmount')!.candidate;
    expect(c).toEqual({ kind: 'statePredicate', aggregate: 'Posting',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] },
              right: { kind: 'int', value: 0 } } });
  });

  it('a derived child rule emits valid Quint (the Task 6 regression)', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
        { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
        entities: [{ kind: 'entity', name: 'Posting', fields: [
          { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }],
    };
    const c = impliedInvariants(m).find(i => i.name === 'nonNegativePostingAmount')!.candidate;
    expect(candidateToQuint(m, c, 'P')).toContain('legsCount');
    expect(candidateToQuint(m, c, 'P')).not.toMatch(/\bpostings\b/);
  });

  it('@signed still opts a plain Money field out', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'A', fields: [
        { name: 'aId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'bal', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
    };
    expect(impliedInvariants(m).map(i => i.name)).not.toContain('nonNegativeABal');
  });
});

describe('derived names must not collide (review finding)', () => {
  const amount: ValueDef = { kind: 'value', name: 'Amount', fields: [
    { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
    { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] };

  /** `totalAmount : Money` and `total : Amount{amount : Money}` on one owner. The derived scheme
   *  joins segments with no separator, so both mint `nonNegativeInvoiceTotalAmount`. */
  const collidingModel: DomainModel = {
    context: 'L', enums: [], events: [], services: [], entities: [], values: [amount],
    aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'totalAmount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'total', type: { kind: 'value', value: 'Amount' } }] }],
  };

  it('THE case: two distinct money paths folding onto one name are reported, naming both', () => {
    // Precondition: the collision is real — two entries, one name, different bodies.
    const names = impliedInvariants(collidingModel).map(i => i.name);
    expect(names.filter(n => n === 'nonNegativeInvoiceTotalAmount')).toHaveLength(2);

    const diags = derivedNameCollisions(collidingModel);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('derived-name-collision');
    expect(diags[0]!.at).toBe('Invoice');
    // Both colliding paths and the owner must be nameable from the message alone.
    expect(diags[0]!.message).toContain('nonNegativeInvoiceTotalAmount');
    expect(diags[0]!.message).toContain('Invoice.totalAmount');
    expect(diags[0]!.message).toContain('Invoice.total.amount');
  });

  it('near-miss: the value-typed field ALONE does not false-positive', () => {
    const m: DomainModel = { ...collidingModel,
      aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' } }] }] };
    expect(impliedInvariants(m).map(i => i.name)).toContain('nonNegativeInvoiceTotalAmount');
    expect(derivedNameCollisions(m)).toEqual([]);
  });

  it('near-miss: the plain Money field ALONE does not false-positive', () => {
    const m: DomainModel = { ...collidingModel,
      aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'totalAmount', type: { kind: 'prim', prim: 'Money' } }] }] };
    expect(impliedInvariants(m).map(i => i.name)).toContain('nonNegativeInvoiceTotalAmount');
    expect(derivedNameCollisions(m)).toEqual([]);
  });

  it('near-miss: two value-typed fields with distinct names do not false-positive', () => {
    const m: DomainModel = { ...collidingModel,
      aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' } },
        { name: 'discount', type: { kind: 'value', value: 'Amount' } }] }] };
    const names = impliedInvariants(m).map(i => i.name);
    expect(names).toContain('nonNegativeInvoiceTotalAmount');
    expect(names).toContain('nonNegativeInvoiceDiscountAmount');
    expect(derivedNameCollisions(m)).toEqual([]);
  });

  it('a clean model derives no collisions at all', () => {
    expect(derivedNameCollisions(m)).toEqual([]);
    expect(derivedNameCollisions(periodModel)).toEqual([]);
  });

  it('the same collision through @signed on one side is NOT reported — one path is gone', () => {
    const m: DomainModel = { ...collidingModel,
      aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
        { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'totalAmount', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] },
        { name: 'total', type: { kind: 'value', value: 'Amount' } }] }] };
    expect(derivedNameCollisions(m)).toEqual([]);
  });

  it('terminal names collide the same way and are caught by the same guard', () => {
    // region `a` + state `bC` vs region `aB` + state `c` → both `terminalXABC`.
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'X', fields: [
        { name: 'xId', type: { kind: 'prim', prim: 'Id' }, key: true }],
        machine: { regions: [
          { name: 'a', initial: 'q', states: [{ name: 'q' }, { name: 'bC', tags: ['terminal'] }] },
          { name: 'aB', initial: 'r', states: [{ name: 'r' }, { name: 'c', tags: ['terminal'] }] }],
          transitions: [] } }],
    };
    const diags = derivedNameCollisions(m);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('terminalXABC');
    expect(diags[0]!.message).toContain('X.a.bC');
    expect(diags[0]!.message).toContain('X.aB.c');
  });

  // The `distinct` dedup (grouping by canonical candidate before counting) is what separates "one
  // name, two DIFFERENT rules" — a real ambiguity — from "one name, the same rule twice", which is
  // harmless: whichever copy wins, the session gets the identical invariant. It is reachable, not
  // theoretical: validateModel does not reject duplicate field names, so a model with two `fee :
  // Money` fields on one owner reaches impliedInvariants and derives the same rule twice.
  it('a rule derived TWICE IDENTICALLY is not a collision — dedup by canonical candidate', () => {
    const m: DomainModel = {
      context: 'L', enums: [], values: [], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'X', fields: [
        { name: 'xId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'fee', type: { kind: 'prim', prim: 'Money' } },
        { name: 'fee', type: { kind: 'prim', prim: 'Money' } }] }],
    };
    // Reachability: nothing upstream rejects the duplicate field, so this model really does arrive.
    expect(validateModel(m)).toEqual([]);
    // Precondition: the name IS minted twice — the dedup, not an empty group, is what saves it.
    const derived = impliedInvariants(m).filter(i => i.name === 'nonNegativeXFee');
    expect(derived).toHaveLength(2);
    // ...and the two are the same rule, so there is nothing for an author to disambiguate.
    expect(new Set(derived.map(i => canonicalCandidate(i.candidate))).size).toBe(1);

    expect(derivedNameCollisions(m)).toEqual([]);
  });

  it('the readable name for the ordinary single case does not regress', () => {
    // Pin: the fix must not tax the 99% non-colliding case with a separator or suffix.
    const m: DomainModel = {
      context: 'L', enums: [], values: [amount], events: [], services: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Bill', fields: [
        { name: 'billId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'total', type: { kind: 'value', value: 'Amount' } }] }],
    };
    expect(impliedInvariants(m).map(i => i.name)).toContain('nonNegativeBillTotalAmount');
    expect(impliedInvariants(m).map(i => i.id)).toContain('implied-nonNegativeBillTotalAmount');
  });
});

describe('refsResolve on an owned child (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], values: [], events: [], services: [],
    entities: [{ kind: 'entity', name: 'Account', fields: [
      { name: 'accId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'account', type: { kind: 'ref', target: 'Account' } }] }] }],
  };

  it('derives refsResolve with the CHILD as its own subject', () => {
    expect(impliedInvariants(m).find(i => i.name === 'refsResolvePosting')!.candidate)
      .toEqual({ kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] });
  });
});
