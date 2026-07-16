import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { astToQuint } from '../../src/emit/quint.js';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { astToQuintGuard } from '../../src/emit/quint-guard.js';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { reachabilityResidual } from '../../src/engine/guard-structure.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';
import { subscriptionsModel, invoiceLinesModel, someStatePredicateOnInvoice } from '../fixtures.js';

// Emission-VALIDITY gate (as opposed to emission-SHAPE tests like quint.test.ts's `.toContain`
// assertions): runs `quint typecheck` (real quint parser/typechecker, no Apalache — ~1s) over the
// emitted source and asserts it is well-formed quint. This is the cheap layer the E2E verification
// found MISSING: unit/integration tests assert on emitted STRINGS, never on whether the string is
// even valid quint. All 3 E2E-surfaced bugs traced to one root cause — test fixtures (test/fixtures.ts)
// drifted from the committed real spec, most sharply `subscriptionsModel` explicitly DROPPING the
// `plan: ref Catalog.Plan` cross-context ref field (see the comment at test/fixtures.ts:200-209) —
// exactly the field whose (pre-fix) emission crashed real quint with `QNT404 Name 'CATALOG' not
// found`. A fixture that mirrors the committed spec minus its awkward parts can never catch that.
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

// A vacuous `0 == 0` probe — expressible on any aggregate, never referenced structurally, so it can
// stand in as `hi` for any model below without constraining which fields/states get exercised.
const trueProbe = (aggregate: string): Candidate => ({ kind: 'statePredicate', aggregate,
  body: { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } });

describe('emission typecheck-validity gate (quint typecheck, no solver)', () => {
  // (a) THE #1 case: a QUALIFIED (cross-context) ref field. Before the 0fd3fae fix, fieldQType's
  // qualified-ref branch rendered an init draw from a non-existent `<TARGET>_IDS` pool
  // (`oneOf(CATALOG.PLAN_IDS)`), which `quint typecheck` rejects with `QNT404 Name 'CATALOG' not
  // found` — the exact crash the E2E run hit on the real committed model. This is the regression
  // that would have caught bug #1 instantly, had it existed before the fix.
  describe('(a) cross-context qualified ref', () => {
    const crossContextRefModel: DomainModel = {
      context: 'Subscriptions',
      aggregates: [{
        kind: 'aggregate', name: 'Subscription',
        fields: [
          { name: 'subId', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'plan', type: { kind: 'ref', target: 'Catalog.Plan' } },   // qualified / cross-context
          { name: 'latestInvoice', type: { kind: 'ref', target: 'Invoice' } }, // same-context, for contrast
        ],
        machine: { regions: [{ name: 'status', initial: 'trialing', states: [{ name: 'trialing' }, { name: 'active' }] }], transitions: [] },
      }, {
        kind: 'aggregate', name: 'Invoice',
        fields: [{ name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true }],
        machine: { regions: [{ name: 'settlement', initial: 'draft', states: [{ name: 'draft' }] }], transitions: [] },
      }],
      entities: [], enums: [], values: [], events: [], services: [],
    } as unknown as DomainModel;

    it('astToQuint emits typecheck-clean quint', async () => {
      const em = astToQuint(crossContextRefModel, { kind: 'probe-permit', hi: trueProbe('Subscription'), exclusions: [], maxSteps: 1 });
      const r = await typechecks(em.source);
      expect(r.ok, r.stderr).toBe(true);
    });
  });

  // (b) a multi-conjunct (`and`-body) invariant — the #2 E2E-surfaced shape. Mirrors the committed
  // Invoice invariant `neverOverpaidAndPaidExact` (specs/subscriptions/spec.lat:75): `amountPaid <=
  // totalDue && (paid => amountPaid == totalDue)`.
  describe('(b) multi-conjunct invariant', () => {
    const multiConjunctInvariant: Candidate = {
      kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'and', args: [
        { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
        { kind: 'implies',
          left: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
          right: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } },
      ] },
    };

    it('astToQuintClassify emits typecheck-clean quint', async () => {
      const em = astToQuintClassify(subscriptionsModel, { invariant: multiConjunctInvariant, peers: [], probe: 'consecution', maxSteps: 1 });
      const r = await typechecks(em.source);
      expect(r.ok, r.stderr).toBe(true);
    });
  });

  // (c) an owned-collection (`List<...>`) field — invoiceLinesModel's Invoice.lines: List<InvoiceLine>.
  it('(c) owned collection: astToQuint emits typecheck-clean quint', async () => {
    const em = astToQuint(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], maxSteps: 1 });
    const r = await typechecks(em.source);
    expect(r.ok, r.stderr).toBe(true);
  });

  // (c2) optional fields + present() — the `${f}Present: bool` companion encoding. Shape tests
  // (quint-optional.test.ts) assert the flag appears; only this gate answers whether the emission is
  // valid quint. It is the layer that catches a present() whose rendered path names a flag that was
  // never declared: pathToQuint walks a ref hop through a map-get (`methods.get(x.method).feePresent`
  // — flag on the TARGET record) and a value hop as a plain dotted accessor (`x.window.endPresent` —
  // flag INSIDE the nested record), so all three sites must declare it. Covers all three at once.
  it('(c2) optional fields: astToQuint emits typecheck-clean quint for present() over own/ref-hop/value-hop paths', async () => {
    const optModel: DomainModel = {
      context: 'Opt', ticksPerDay: 24, enums: [],
      values: [{ kind: 'value', name: 'Window', fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Int' } },
        { name: 'end', type: { kind: 'prim', prim: 'Int' }, optional: true }] }],
      entities: [{ kind: 'entity', name: 'Method', fields: [
        { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'fee', type: { kind: 'prim', prim: 'Money' }, optional: true }] }],
      aggregates: [{ kind: 'aggregate', name: 'Payment', fields: [
        { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'method', type: { kind: 'ref', target: 'Method' }, optional: true },
        { name: 'window', type: { kind: 'value', value: 'Window' } },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }],
        machine: { regions: [{ name: 'intent', initial: 'pending', states: [{ name: 'pending' }, { name: 'done' }] }], transitions: [] } }],
      events: [], services: [],
    };
    const body: Candidate = { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'and', args: [
        { kind: 'present', path: ['method'] },              // own optional ref
        { kind: 'present', path: ['method', 'fee'] },       // ref hop into the target's optional field
        { kind: 'present', path: ['window', 'end'] },       // value hop into an optional sub-field
      ] } };
    const em = astToQuint(optModel, { kind: 'probe-permit', hi: body, exclusions: [], maxSteps: 1 });
    const r = await typechecks(em.source);
    expect(r.ok, r.stderr).toBe(true);
  });

  // (d) the committed REAL model — parsed straight from specs/subscriptions/spec.lat via the same
  // loadLatText() the `apply`/`docs` CLI paths use, so this test tracks the canonical source (not a
  // hand-transcribed fixture that can silently drift, as test/fixtures.ts's subscriptionsModel did).
  describe('(d) the committed real model (specs/subscriptions/spec.lat)', () => {
    const latPath = join(import.meta.dirname, '../../../specs/subscriptions/spec.lat');
    const parsedSpec = loadLatText(readFileSync(latPath, 'utf8'));
    if (!parsedSpec.ok) throw new Error(`failed to parse committed spec.lat: ${JSON.stringify(parsedSpec.diagnostics)}`);
    const committedModel = parsedSpec.model;
    const committedInvariants = parsedSpec.invariants;

    it('astToQuint (probe-permit) emits typecheck-clean quint', async () => {
      const em = astToQuint(committedModel, { kind: 'probe-permit', hi: trueProbe('Subscription'), exclusions: [], maxSteps: 1 });
      const r = await typechecks(em.source);
      expect(r.ok, r.stderr).toBe(true);
    });

    it('astToQuintClassify emits typecheck-clean quint for the real neverOverpaidAndPaidExact (multi-conjunct) invariant', async () => {
      const inv = committedInvariants.find(i => i.name === 'neverOverpaidAndPaidExact');
      expect(inv).toBeDefined();
      const em = astToQuintClassify(committedModel, { invariant: inv!.candidate, peers: [], probe: 'consecution', maxSteps: 1 });
      const r = await typechecks(em.source);
      expect(r.ok, r.stderr).toBe(true);
    });

    it('astToQuintGuard (reach) emits typecheck-clean quint for a real guard-gated site', async () => {
      const sites = reachabilityResidual(committedModel);
      expect(sites.length).toBeGreaterThan(0);   // sanity: the committed model does have guard-gated states
      const em = astToQuintGuard(committedModel, sites[0]!, 'reach');
      const r = await typechecks(em.source);
      expect(r.ok, r.stderr).toBe(true);
    });
  });

  // astToQuintGuard's 'stuck' kind: the committed model has NO stuck candidates (every non-terminal
  // state has an unguarded escape — see test/engine/guard-structure.test.ts), so this uses a
  // synthetic tiny model whose only exit is guarded (mirrors guard-structure.test.ts's fixture).
  it('astToQuintGuard (stuck) emits typecheck-clean quint on a synthetic stuck site', async () => {
    const stuckModel: DomainModel = {
      context: 'T',
      aggregates: [{
        kind: 'aggregate', name: 'W',
        fields: [{ name: 'wId', type: { kind: 'prim', prim: 'Id' }, key: true },
                 { name: 'n', type: { kind: 'prim', prim: 'Int' } }],
        machine: {
          regions: [{ name: 's', initial: 'a', states: [{ name: 'a' }, { name: 'b', tags: ['terminal'] }] }],
          transitions: [{ name: 'go', region: 's', from: ['a'], to: 'b',
            requires: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['n'] }, right: { kind: 'int', value: 1 } } }],
        },
      }],
      entities: [], enums: [], values: [], events: [], services: [],
    } as unknown as DomainModel;

    const em = astToQuintGuard(stuckModel, { owner: 'W', region: 's', state: 'a' }, 'stuck');
    const r = await typechecks(em.source);
    expect(r.ok, r.stderr).toBe(true);
  });
});
