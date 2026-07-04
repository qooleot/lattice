import { describe, it, expect } from 'vitest';
import { registerCandidates, activeCandidates, pruneOnVerdict, ledgerConflicts, admit, markMerged } from '../../src/engine/hypothesis.js';
import { newSession, type LedgerEntry } from '../../src/engine/session.js';
import { traceAModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const mkUnique = (id: string, by: string[][], prior: number): CandidateInvariant => ({
  id, name: id, prior, source: 'seed',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by }
});
const H1 = mkUnique('H1', [['customer']], 0.35);
const H2 = mkUnique('H2', [['customer'], ['plan']], 0.4);
const H3 = mkUnique('H3', [['customer'], ['plan', 'family']], 0.5);

const dpsf: CaseState = { entities: [
  { type: 'Plan', id: 'p1', fields: { family: 'fam1' } }, { type: 'Plan', id: 'p2', fields: { family: 'fam1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const dpdf: CaseState = { entities: [
  { type: 'Plan', id: 'p1', fields: { family: 'fam1' } }, { type: 'Plan', id: 'p3', fields: { family: 'fam2' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p3', 'Access.state': 'Active' } }
]};

describe('hypothesis manager', () => {
  it('prunes candidates that disagree with a verdict (trace-A Q1)', () => {
    const s = newSession();
    registerCandidates(s, [H1, H2]);
    const r = pruneOnVerdict(s, dpsf, 'forbid');    // expert forbids DPSF
    expect(r.pruned).toEqual(['H2']);               // H2 (per-plan) permitted it
    expect(activeCandidates(s).map(c => c.inv.id)).toEqual(['H1']);
  });
  it('empties the space when the survivor is refuted (trace-A Q2)', () => {
    const s = newSession();
    registerCandidates(s, [H1]);
    const r = pruneOnVerdict(s, dpdf, 'permit');    // expert permits DPDF; H1 forbids ⇒ refuted
    expect(r.empty).toBe(true);
  });
  it('ledgerConflicts validates a regen against every verdict', () => {
    const ledger: LedgerEntry[] = [
      { kind: 'verdict', at: 't', witnessId: 'w1', witness: dpsf, salient: [], judge: 'forbid', question: '' },
      { kind: 'verdict', at: 't', witnessId: 'w2', witness: dpdf, salient: [], judge: 'permit', question: '' }
    ];
    expect(ledgerConflicts(H3.candidate, ledger)).toEqual([]);       // fits both
    expect(ledgerConflicts(H1.candidate, ledger)).toEqual(['w2']);   // forbids the permitted DPDF
  });
  it('admit enforces the regen cap and ledger consistency', () => {
    const s = newSession();
    const ledger: LedgerEntry[] = [{ kind: 'verdict', at: 't', witnessId: 'w2', witness: dpdf, salient: [], judge: 'permit', question: '' }];
    const bad = { ...H1, id: 'R1', source: 'regen' as const };
    expect(admit(s, bad, traceAModel, ledger).ok).toBe(false);
    expect(s.regenAttempts).toBe(1);
    const good = { ...H3, id: 'R2', source: 'regen' as const };
    expect(admit(s, good, traceAModel, ledger).ok).toBe(true);
    s.regenAttempts = 3;
    expect(admit(s, { ...H3, id: 'R3', source: 'regen' }, traceAModel, ledger)).toEqual({ ok: false, reason: 'regen cap (3) reached — park as open decision' });
  });
  it('markMerged retires the loser', () => {
    const s = newSession();
    registerCandidates(s, [H1, H2]);
    markMerged(s, 'H1', 'H2');
    expect(activeCandidates(s).map(c => c.inv.id)).toEqual(['H2']);
  });
});
