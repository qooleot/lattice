import { describe, it, expect } from 'vitest';
import { anchorsCandidate } from '../../src/engine/anchoring.js';
import type { Candidate } from '../../src/ast/invariant.js';

const journalLaw: Candidate = { kind: 'statePredicate', aggregate: 'JournalTransaction',
  body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['netAmount'] }, right: { kind: 'int', value: 0 } } };
const refundWitness = { entities: [{ type: 'Refund', id: 'r1', fields: {} }] };
const journalWitness = { entities: [{ type: 'JournalTransaction', id: 'j1', fields: { netAmount: 0 } }] };

describe('anchorsCandidate', () => {
  it('a witness with no instance of the aggregate anchors nothing (vacuous permit is not evidence)', () => {
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: refundWitness }, journalLaw)).toBe(false);
  });
  it('a verdict judged before the candidate existed does not anchor it', () => {
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: journalWitness },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(false);
  });
  it('an at-or-after verdict whose witness contains the aggregate anchors', () => {
    expect(anchorsCandidate({ at: '2026-07-16T12:00:00Z', judge: 'permit', witness: journalWitness },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(true);
  });
  it('a pre-upgrade tracker (no registeredAt) waives the time filter, not the aggregate filter', () => {
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: journalWitness }, journalLaw)).toBe(true);
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: refundWitness }, journalLaw)).toBe(false);
  });
});
