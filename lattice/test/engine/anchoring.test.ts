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
  it('a pre-registration verdict the candidate AGREES with anchors (the regeneration path: the candidate was authored from it)', () => {
    // journalWitness has netAmount 0 — the law holds — and the human said permit: agreement.
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: journalWitness },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(true);
  });
  it('a pre-registration verdict the candidate DISAGREES with does not anchor it', () => {
    // netAmount 7 violates the law, yet the human said permit: the candidate rules 'forbid' — no agreement.
    const violating = { entities: [{ type: 'JournalTransaction', id: 'j2', fields: { netAmount: 7 } }] };
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: violating },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(false);
    // Symmetric: the law holds but the human said forbid — still no agreement.
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'forbid', witness: journalWitness },
      journalLaw, '2026-07-16T11:00:00Z')).toBe(false);
  });
  it('a pre-registration verdict on a foreign aggregate never anchors, even though the candidate does not contradict it (vacuously)', () => {
    // The aggregate filter is unconditional: agreement must be non-vacuous.
    expect(anchorsCandidate({ at: '2026-07-16T10:00:00Z', judge: 'permit', witness: refundWitness },
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
