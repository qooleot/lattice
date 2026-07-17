import { describe, it, expect } from 'vitest';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import type { CaseState } from '../../src/engine/evaluate.js';
import type { Candidate } from '../../src/ast/invariant.js';

// present(approvedAmount) && approvedAmount > 0  — the assertion form: absence must FORBID.
const cand: Candidate = { kind: 'statePredicate', aggregate: 'Refund',
  body: { kind: 'and', args: [
    { kind: 'present', path: ['approvedAmount'] },
    { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['approvedAmount'] }, right: { kind: 'int', value: 0 } }] } };

const absent: CaseState = { entities: [{ type: 'Refund', id: 'r1', fields: { amount: 100 } }] };
const present: CaseState = { entities: [{ type: 'Refund', id: 'r1', fields: { amount: 100, approvedAmount: 40 } }] };

describe('present()', () => {
  it('forbids when the field is absent — the conjunction fails', () =>
    expect(evaluateCandidate(cand, absent)).toBe('forbid'));

  it('permits when the field is present and the comparison holds', () =>
    expect(evaluateCandidate(cand, present)).toBe('permit'));

  // This is the whole reason present() exists: without it, absence SATISFIES the rule.
  it('a bare comparison still permits an absent field — unknown facts do not convict', () => {
    const bare: Candidate = { kind: 'statePredicate', aggregate: 'Refund',
      body: { kind: 'cmp', op: 'gt', left: { kind: 'field', owner: 'self', path: ['approvedAmount'] }, right: { kind: 'int', value: 0 } } };
    expect(evaluateCandidate(bare, absent)).toBe('permit');   // evaluate.ts:45
  });
});
