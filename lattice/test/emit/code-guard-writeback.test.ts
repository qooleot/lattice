import { describe, it, expect } from 'vitest';
import { astToCode } from '../../src/emit/code.js';
import { subscriptionsModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

// An adopted `guard` candidate (design §8.5-8.7 CTI-strengthening write-back) on Invoice.settlement's
// `settle` transition — the same shape `engine strengthen` would auto-adopt when re-deriving the
// committed `amountPaid == totalDue` guard from a stripped-guard model variant (see
// strengthen.integration.test.ts). `settle` in subscriptionsModel is ALREADY authored with this exact
// requires, so conjoining it with itself is a faithful stand-in for "guard conjoined with authored
// requires" without inventing a second predicate that would obscure which text came from where.
const settleGuardInv: CandidateInvariant = {
  id: 'guard-Invoice-settle-eq', name: 'guard_settle_eq', prior: 1, source: 'regen',
  candidate: {
    kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
    predicate: { kind: 'cmp', op: 'eq',
      left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
      right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
  },
};

describe('astToCode: adopted-guard write-back into transition requires', () => {
  it('conjoins an adopted guard predicate into its transition\'s requires text', () => {
    const text = astToCode(subscriptionsModel, [settleGuardInv]);
    const settleLine = text.split('\n').find(l => l.includes('transition settle'));
    expect(settleLine).toBeDefined();
    expect(settleLine).toContain('requires');
    expect(settleLine).toContain('amountPaid == totalDue');
  });

  it('dedupes a guard structurally identical to the authored requires (no `p && p`)', () => {
    // settleGuardInv's predicate is exactly `settle`'s authored requires (amountPaid == totalDue).
    // Conjoining a predicate with itself must NOT render `amountPaid == totalDue && amountPaid ==
    // totalDue` (design carried fix iv) — the deduped output is byte-identical to the no-guard form.
    const text = astToCode(subscriptionsModel, [settleGuardInv]);
    const settleLine = text.split('\n').find(l => l.includes('transition settle'));
    expect(settleLine).not.toContain('&&');
    expect(settleLine).toBe('      transition settle { from open to paid; requires amountPaid == totalDue; emits InvoicePaid }');
  });

  it('renders no-guard transitions byte-identically to the pre-write-back form', () => {
    // No adopted guards at all: `finalize`'s authored requires (totalDue == licenseFeeAmount + usageAmount)
    // and `settle`'s authored requires must render exactly as astToCode did before guard write-back existed.
    const text = astToCode(subscriptionsModel, []);
    const finalizeLine = text.split('\n').find(l => l.includes('transition finalize'));
    const settleLine = text.split('\n').find(l => l.includes('transition settle'));
    expect(finalizeLine).toBe('      transition finalize { from draft to open; requires totalDue == licenseFeeAmount + usageAmount; emits InvoiceFinalized }');
    expect(settleLine).toBe('      transition settle { from open to paid; requires amountPaid == totalDue; emits InvoicePaid }');
  });

  it('conjoins a guard with a DIFFERENT predicate than the authored requires using &&', () => {
    // finalize has no adopted guard in this test's set, but voidOpen has none authored — attach a
    // synthetic guard there to prove the "authored requires absent, guard present" single-item path
    // renders the guard alone (no spurious && with nothing), and a genuinely distinct guard on an
    // ALREADY-guarded transition (settle) is joined with && rather than replacing the authored text.
    const distinctGuard: CandidateInvariant = {
      id: 'guard-Invoice-settle-le', name: 'guard_settle_le', prior: 1, source: 'regen',
      candidate: {
        kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
        predicate: { kind: 'cmp', op: 'le',
          left: { kind: 'field', owner: 'self', path: ['amountPaid'] },
          right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
      },
    };
    const text = astToCode(subscriptionsModel, [distinctGuard]);
    const settleLine = text.split('\n').find(l => l.includes('transition settle'));
    expect(settleLine).toContain('amountPaid == totalDue && amountPaid <= totalDue');
  });
});
