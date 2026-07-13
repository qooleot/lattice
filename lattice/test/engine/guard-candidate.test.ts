import { describe, it, expect } from 'vitest';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import { candidateToQuint } from '../../src/emit/quint.js';
import { conjunctTier } from '../../src/engine/tier.js';
import { subscriptionsModel } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const settleGuard: Candidate = { kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
  predicate: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } };

describe('guard Candidate kind', () => {
  it('evaluateCandidate: permit iff the guard predicate holds on every subject', () => {
    // CaseEntity is { type, id, fields: Record<name, value> } — fields are NESTED, not flat.
    const permit = { entities: [{ type: 'Invoice', id: 'i1', fields: { amountPaid: 5, totalDue: 5 } }] };
    const forbid = { entities: [{ type: 'Invoice', id: 'i1', fields: { amountPaid: 3, totalDue: 5 } }] };
    expect(evaluateCandidate(settleGuard, permit)).toBe('permit');
    expect(evaluateCandidate(settleGuard, forbid)).toBe('forbid');
  });
  it('candidateToQuint THROWS on a guard (never an always-property)', () => {
    expect(() => candidateToQuint(subscriptionsModel, settleGuard, 'q')).toThrow(/guard/i);
  });
  it('conjunctTier THROWS on a guard (guards are not classified)', () => {
    expect(() => conjunctTier(subscriptionsModel, settleGuard)).toThrow(/guard/i);
  });
});
