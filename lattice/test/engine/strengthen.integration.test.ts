import { describe, it, expect } from 'vitest';
import { strengthenInvariant } from '../../src/engine/strengthen.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel } from '../fixtures.js';
import type { AggregateDef, DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant, Candidate } from '../../src/ast/invariant.js';

// The §8.2 payoff, on real quint. `paidExact` (paid ⇒ amountPaid==totalDue) is only forced by
// `settle`'s authored guard (`requires amountPaid==totalDue`); on the COMMITTED model that guard
// makes the invariant hold, so there is nothing to strengthen. To exercise the engine's RE-DERIVATION
// of that guard we build a model VARIANT with `settle`'s `requires` stripped — now the invariant is
// genuinely violated (abstract accrual reaches `paid` with amountPaid<totalDue) and the engine must
// regenerate `{eq,le,ge}` on `settle`, prune to `==` alone, and auto-adopt.
const paidExact: CandidateInvariant = {
  id: 'pe', name: 'paidExact', prior: 1, source: 'template',
  candidate: {
    kind: 'statePredicate', aggregate: 'Invoice',
    where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
    body: {
      kind: 'cmp', op: 'eq',
      left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
      right: { kind: 'field', owner: 'self', path: ['totalDue'] },
    },
  },
};

// Deep-clone the committed model and REMOVE settle's `requires`, so `paidExact` is genuinely violated.
function stripSettleGuard(m: DomainModel): DomainModel {
  const variant = structuredClone(m);
  const invoice = (variant.aggregates as AggregateDef[]).find(a => a.name === 'Invoice')!;
  const settle = invoice.machine!.transitions.find(t => t.name === 'settle')!;
  delete settle.requires;
  return variant;
}

describe('strengthenInvariant (integration, real quint)', () => {
  it('overpayment boundary → one surviving guard → auto-adopt (==)', async () => {
    const variant = stripSettleGuard(subscriptionsModel);
    // adopted peer: amountPaid <= totalDue (the committed `neverOverpaid` conjunct).
    const neverOverpaid: Candidate = {
      kind: 'statePredicate', aggregate: 'Invoice',
      body: {
        kind: 'cmp', op: 'le',
        left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
        right: { kind: 'field', owner: 'self', path: ['totalDue'] },
      },
    };
    const res = await strengthenInvariant(variant, paidExact, [neverOverpaid], realDeps, 6);
    expect(res.kind).toBe('auto-adopt');
    if (res.kind === 'auto-adopt') {
      expect(res.guard.transition).toBe('settle');
      expect(res.guard.predicate.kind).toBe('cmp');
      if (res.guard.predicate.kind === 'cmp') expect(res.guard.predicate.op).toBe('eq');
    }
  }, 240_000);
});
