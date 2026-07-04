import { describe, it, expect } from 'vitest';
import { astToProse, renderCandidateEnglish } from '../../src/emit/prose.js';
import { astToCode } from '../../src/emit/code.js';
import { traceAModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const H3: CandidateInvariant = { id: 'H3', name: 'SingleActivePerFamily', prior: 0.9, source: 'regen',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] } };
const ledger: LedgerEntry[] = [
  { kind: 'verdict', at: 't1', witnessId: 'w1', witness: { entities: [] }, salient: [], judge: 'forbid', question: 'Two active, same family?' },
  { kind: 'adopted', at: 't3', invariant: H3, provenance: 'elicited w1–w2' },
  { kind: 'open-decision', at: 't4', topic: 'dunning_exhausted', note: 'Unpaid or Canceled? undecided' }
];

describe('astToProse', () => {
  const prose = astToProse(traceAModel, [H3], ledger);
  it('renders lifecycle, invariants with anchors, and open decisions', () => {
    expect(prose).toContain('# Billing');
    expect(prose).toContain('Trialing');
    expect(prose).toContain('Only one Subscription may be Active per (customer, plan.family)');
    expect(prose).toContain('elicited w1–w2');
    expect(prose).toContain('## ⚠️ Open decisions');
    expect(prose).toContain('dunning_exhausted');
  });
});

describe('astToCode', () => {
  const code = astToCode(traceAModel, [H3]);
  it('pretty-prints the .lat projection', () => {
    expect(code).toContain('context Billing {');
    expect(code).toContain('aggregate Subscription {');
    expect(code).toContain('customer : ref Customer');
    expect(code).toContain('region Access { states { Trialing, Active @active, Ended @terminal } }');
    expect(code).toContain('unique while Active by (customer, plan.family)');
  });
});

describe('renderCandidateEnglish', () => {
  it('covers every candidate kind', () => {
    expect(renderCandidateEnglish(H3.candidate)).toContain('Only one Subscription');
    expect(renderCandidateEnglish({ kind: 'terminal', aggregate: 'S', region: 'R', state: 'Closed' })).toBe('Once S is Closed, it stays Closed.');
    expect(renderCandidateEnglish({ kind: 'monotonic', aggregate: 'O', field: ['recognized'] })).toBe('O.recognized never decreases.');
    expect(renderCandidateEnglish({ kind: 'conservation', aggregate: 'O', parts: [['recognized'], ['deferred']], total: ['allocated'] }))
      .toBe('On every O, recognized + deferred always equals allocated.');
    expect(renderCandidateEnglish({ kind: 'refsResolve', aggregate: 'E' })).toBe('Every reference on E resolves to an existing record.');
    expect(renderCandidateEnglish({ kind: 'cardinality', aggregate: 'P', where: null, atMost: 1 })).toBe('At most 1 P may exist.');
  });
});
