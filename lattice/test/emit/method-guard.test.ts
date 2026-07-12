import { describe, it, expect } from 'vitest';
import { predToQuintParam, astToMethodGuardQuery } from '../../src/emit/method-guard.js';
import { subscriptionsModel } from '../fixtures.js';
import type { Predicate } from '../../src/ast/invariant.js';

// Param-aware renderer (Plan 2b Task 5): a `requires` may carry `param` terms (legal ONLY in a
// MethodDef.requires — design §3.6). The ordinary termToQuint/predToQuint THROW on `param`
// (quint.ts:80/138); predToQuintParam resolves a `param` to its drawn nondet/state var instead.
describe('predToQuintParam', () => {
  it('resolves a param term to its drawn var (never throws)', () => {
    const p: Predicate = { kind: 'cmp', op: 'ge',
      left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] },
      right: { kind: 'param', name: 'minCount' } };
    const rendered = predToQuintParam(subscriptionsModel, p, 'x', 'Subscription', { minCount: 'param_minCount' });
    expect(rendered).toBe('(x.paidInvoiceCount >= param_minCount)');
  });

  it('renders own fields exactly as predToQuint does (mirrors structure)', () => {
    const p: Predicate = { kind: 'cmp', op: 'ge',
      left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] },
      right: { kind: 'int', value: 1 } };
    expect(predToQuintParam(subscriptionsModel, p, 'x', 'Subscription', {}))
      .toBe('(x.paidInvoiceCount >= 1)');
  });

  it('composes params inside and/or/implies/not without throwing', () => {
    const p: Predicate = { kind: 'and', args: [
      { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] }, right: { kind: 'param', name: 'lo' } },
      { kind: 'not', arg: { kind: 'cmp', op: 'lt', left: { kind: 'field', owner: 'self', path: ['seats'] }, right: { kind: 'param', name: 'hi' } } }] };
    const r = predToQuintParam(subscriptionsModel, p, 'x', 'Subscription', { lo: 'param_lo', hi: 'param_hi' });
    expect(r).toContain('param_lo');
    expect(r).toContain('param_hi');
    expect(r).toContain('(not(');
  });
});

// Harness emission shape (mirroring test/emit/quint.test.ts's `.toContain` style).
describe('astToMethodGuardQuery', () => {
  it('emits a havoc indInit + guard implication invariant over the transition aggregate', () => {
    // activate: no requires (methodReq undefined), guard `paidInvoiceCount >= 1`.
    const em = astToMethodGuardQuery(subscriptionsModel, 'Subscription', 'activate', undefined, [], 'method-implies-guard');
    expect(em.source).toContain('action indInit');
    expect(em.invariantName).toBe('q_methodGuard');
    expect(em.source).toContain('val q_methodGuard =');
    // region state havoced (not fixed to the @initial literal), so an arbitrary state is drawn
    expect(em.source).toMatch(/status_state: nd_/);
    // undefined methodReq is the weakest antecedent (true); the implication reduces to the guard
    expect(em.source).toContain('(true) implies (');
    expect(em.source).toContain('paidInvoiceCount >= 1');
    // the machine is still emitted so the module typechecks
    expect(em.source).toContain('action init =');
    expect(em.source).toContain('action step =');
    expect(em.varTypes).toMatchObject({ subscriptions: 'Subscription' });
  });

  it('guard-implies-method direction flips the implication', () => {
    const em = astToMethodGuardQuery(subscriptionsModel, 'Subscription', 'activate', undefined, [], 'guard-implies-method');
    // guard on the left, method (true) on the right — reduces to `guard implies true`
    expect(em.source).toContain('implies (true)');
    expect(em.source).toContain('paidInvoiceCount >= 1');
  });

  it('draws one nondet + state var per encodable param and resolves it in the invariant', () => {
    // a synthetic requires referencing a param, with an Int param (encodable → drawn)
    const methodReq: Predicate = { kind: 'cmp', op: 'ge',
      left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] },
      right: { kind: 'param', name: 'minCount' } };
    const em = astToMethodGuardQuery(subscriptionsModel, 'Subscription', 'activate', methodReq,
      [{ name: 'minCount', type: { kind: 'prim', prim: 'Int' } }], 'method-implies-guard');
    expect(em.source).toContain('nondet nd_param_minCount = oneOf(Set(0, 24, 72, 100))');
    expect(em.source).toContain('var param_minCount: int');
    expect(em.source).toContain("param_minCount' = nd_param_minCount");
    // the invariant reads the param STATE var (so it persists into the --max-steps 0 check)
    expect(em.source).toMatch(/q_methodGuard =[\s\S]*param_minCount/);
  });
});
