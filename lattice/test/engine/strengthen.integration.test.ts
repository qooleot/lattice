import { describe, it, expect } from 'vitest';
import { strengthenInvariant } from '../../src/engine/strengthen.js';
import { conjunctsOf } from '../../src/engine/tier.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel, paidImpliesExactConjunct, amountPaidAtMostTotalConjunct } from '../fixtures.js';
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

  // Carried fix (i): step 1's CTI probe MUST carry prior adopted guards. On the stripped variant a
  // PRIOR adopted guard on `settle` (amountPaid==totalDue) already prevents paidExact's violation, so
  // there is nothing to strengthen. The old astToQuintClassify step-1 path dropped adopted guards
  // (they can only ride into the machine via astToQuint's `adopted` channel), so it would report a
  // SPURIOUS CTI and re-derive a guard for `settle`. With the guard-bearing probe-forbid step 1, the
  // guard rides into settle's trans_ action → no reachable peer-consistent ¬paidExact → no-transition.
  it('a prior adopted guard that already fixes the invariant yields no-transition (no spurious CTI)', async () => {
    const variant = stripSettleGuard(subscriptionsModel);
    const neverOverpaid: Candidate = {
      kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'le',
        left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
        right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
    };
    // The prior adopted guard equivalent to settle's stripped authored `requires`.
    const settleGuard: Candidate = {
      kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
      predicate: { kind: 'cmp', op: 'eq',
        left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
        right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
    };
    const res = await strengthenInvariant(variant, paidExact, [neverOverpaid, settleGuard], realDeps, 6);
    expect(res.kind).toBe('no-transition');
  }, 240_000);
});

// E2E finding #2: CTI-guided strengthening is per-INVARIANT (strengthenInvariant), but classification
// is per-CONJUNCT (classifyAdopted/classifyInvariant, tier.ts's conjunctsOf). Handing the WHOLE
// `and`-bodied invariant to strengthenInvariant makes invariantCmp (strengthen.ts) return null (an
// `and` body is neither a bare cmp nor an implies-consequent), so guardVariants finds nothing and the
// engine bails with `no-transition "no own-field cmp to shape a guard from"` — the headline
// strengthening feature never fires on a realistic multi-conjunct invariant like the committed
// Never_Overpaid_And_Paid_Exact. This proves the bug on real quint, then proves the fix: handing
// strengthenInvariant the single VIOLATED conjunct (built via conjunctsOf) lets it see a clean
// cmp/implies body and auto-adopt the guard.
describe('strengthenInvariant on a multi-conjunct invariant (integration, real quint) — E2E #2', () => {
  // Reassemble the committed Never_Overpaid_And_Paid_Exact as the `and` of its two committed conjunct
  // fixtures (same reassembly as classify.integration.test.ts): amountPaid<=totalDue, and
  // inState(paid) ⇒ amountPaid==totalDue.
  const neverOverpaidAndPaidExact: Candidate = {
    kind: 'statePredicate', aggregate: 'Invoice',
    body: { kind: 'and', args: [
      (amountPaidAtMostTotalConjunct as Extract<Candidate, { kind: 'statePredicate' }>).body,
      (paidImpliesExactConjunct as Extract<Candidate, { kind: 'statePredicate' }>).body,
    ] },
  };
  const inv: CandidateInvariant = {
    id: 'never-overpaid', name: 'neverOverpaidAndPaidExact', prior: 1, source: 'template',
    candidate: neverOverpaidAndPaidExact,
  };

  // On real quint the shortest CTI for the WHOLE `and` body is via conjunct 0 (amountPaid<=totalDue,
  // violable by pure accrual alone, no transition needed) rather than via conjunct 1's settle-guarded
  // violation — so step 1's site lookup fails first ("CTI reached via accrual with no declared
  // transition") rather than reaching guardVariants' "no own-field cmp" rejection. Both notes are the
  // SAME underlying bug: handing the whole `and` body to strengthenInvariant can never auto-adopt,
  // because either (a) ctiTransition finds no site (this case), or (b) invariantCmp returns null on
  // the `and` body once a site IS found (see strengthen.ts's invariantCmp / guardVariants). Assert the
  // disjunction rather than a single guessed note string.
  it('the WHOLE invariant never auto-adopts (no-transition, either accrual-masked or "no own-field cmp") — the bug', async () => {
    const variant = stripSettleGuard(subscriptionsModel);
    const res = await strengthenInvariant(variant, inv, [], realDeps, 6);
    expect(res.kind).toBe('no-transition');
    if (res.kind === 'no-transition') {
      expect(res.note).toMatch(/no own-field cmp|CTI reached via accrual/);
    }
  }, 240_000);

  it('the second conjunct (paid ⇒ ==) alone auto-adopts a settle==totalDue guard — the fix', async () => {
    const variant = stripSettleGuard(subscriptionsModel);
    const conjuncts = conjunctsOf(inv.candidate);
    expect(conjuncts.length).toBe(2);
    const secondConjunct: CandidateInvariant = { ...inv, candidate: conjuncts[1]!.candidate };
    const res = await strengthenInvariant(variant, secondConjunct, [], realDeps, 6);
    expect(res.kind).toBe('auto-adopt');
    if (res.kind === 'auto-adopt') {
      expect(res.guard.transition).toBe('settle');
      expect(res.guard.predicate.kind).toBe('cmp');
      if (res.guard.predicate.kind === 'cmp') expect(res.guard.predicate.op).toBe('eq');
    }
  }, 240_000);
});
