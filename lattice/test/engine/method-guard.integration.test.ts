import { describe, it, expect } from 'vitest';
import { checkMethodGuard } from '../../src/engine/method-guard.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel } from '../fixtures.js';
import type { DomainModel } from '../../src/ast/domain.js';

// Real quint end-to-end (design §5 worked example): SubscriptionService.activate declares NO
// `requires` while the `activate` transition requires `paidInvoiceCount >= 1`. A method weaker
// than its guard advertises calls that will always be rejected → `weaker-than-guard`. The verdict
// comes back from a real `runQuintVerify` at --init indInit --max-steps 0, not asserted structurally.
describe('checkMethodGuard (integration, real quint)', () => {
  it('activate (no requires) vs paidInvoiceCount >= 1 guard ⇒ weaker-than-guard', async () => {
    const r = await checkMethodGuard(subscriptionsModel, 'SubscriptionService', 'activate', realDeps);
    expect(r.verdict).toBe('weaker-than-guard');
  }, 180_000);
});

// Plan 2b Task 5 hardening: a `subscriptionsModel` variant with two extra SubscriptionService
// methods, both `performs`-ing the same `activate` transition (guard `paidInvoiceCount >= 1`,
// INT_POOL = {0, 24, 72, 100}) but with different `requires`, probing the other two
// checkMethodGuard verdicts (method-guard.ts's two-probe entailment: probe 1 method⇒guard violated
// ⇒ weaker-than-guard (covered above); probe 2 guard⇒method violated ⇒ stronger-than-guard;
// neither violated ⇒ consistent).
const guardVariantModel: DomainModel = {
  ...subscriptionsModel,
  services: [{
    name: 'SubscriptionService',
    methods: [
      ...subscriptionsModel.services.find(s => s.name === 'SubscriptionService')!.methods,
      {
        name: 'activateConsistent',
        params: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }],
        kind: { performs: { aggregate: 'Subscription', transition: 'activate' } },
        // Syntactically identical to activate's guard ⇒ both entailment probes hold ⇒ consistent.
        requires: {
          kind: 'cmp', op: 'ge',
          left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] },
          right: { kind: 'int', value: 1 },
        },
      },
      {
        name: 'activateStronger',
        params: [{ name: 'subId', type: { kind: 'prim', prim: 'Id' } }],
        kind: { performs: { aggregate: 'Subscription', transition: 'activate' } },
        // paidInvoiceCount == 24 strictly implies the guard's >= 1 (probe 1 holds: 24 >= 1 always)
        // but excludes the guard-permitted 72/100 (probe 2 violated: guard true, method false at
        // paidInvoiceCount = 72/100) ⇒ stronger-than-guard. 24 is drawn from the same INT_POOL the
        // harness uses, so this is a reachable value, not a vacuous/unsatisfiable predicate.
        requires: {
          kind: 'cmp', op: 'eq',
          left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] },
          right: { kind: 'int', value: 24 },
        },
      },
    ],
  }],
};

describe('checkMethodGuard (integration, real quint) — consistent / stronger-than-guard', () => {
  it('activateConsistent (requires == guard, paidInvoiceCount >= 1) ⇒ consistent', async () => {
    const r = await checkMethodGuard(guardVariantModel, 'SubscriptionService', 'activateConsistent', realDeps);
    expect(r.verdict).toBe('consistent');
  }, 120_000);

  it('activateStronger (requires paidInvoiceCount == 24, guard >= 1) ⇒ stronger-than-guard', async () => {
    const r = await checkMethodGuard(guardVariantModel, 'SubscriptionService', 'activateStronger', realDeps);
    expect(r.verdict).toBe('stronger-than-guard');
  }, 120_000);
});
