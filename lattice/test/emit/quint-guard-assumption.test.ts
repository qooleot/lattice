import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const settleGuard: Candidate = { kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
  predicate: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } };
const q = (adopted: Candidate[]) => ({ kind: 'probe-permit' as const, hi: paidImpliesExactConjunct, exclusions: [], maxSteps: 1, adopted });

describe('adopted guard emission', () => {
  it('conjoins an adopted guard into its trans_ action, NOT the adopted always-property list', () => {
    const em = astToQuint(subscriptionsModel, q([settleGuard]));
    // the settle transition action carries the guard predicate as an extra enablement conjunct
    expect(em.source).toMatch(/action trans_Invoice_settle = \{[^}]*amountPaid[^}]*>=[^}]*totalDue/);
    // and the guard is NOT rendered as an `adopted<i>` always-property val
    expect(em.source).not.toMatch(/val adopted\d+ = .*amountPaid.*>=.*totalDue/);
  });
  it('no adopted guards → byte-identical to today', () => {
    const withArg = astToQuint(subscriptionsModel, q([]));
    const noArg = astToQuint(subscriptionsModel, { kind: 'probe-permit', hi: paidImpliesExactConjunct, exclusions: [], maxSteps: 1 });
    expect(withArg.source).toBe(noArg.source);
  });
});
