import { describe, it, expect } from 'vitest';
import { tallyRecords, type TallyResult } from '../../fidelity/tally.js';
import type { FidelityRecord } from '../../fidelity/harness.js';

const makeRecord = (ruleId: string, status: 'formalized' | 'not-formalizable', humanVerdict: 'faithful' | 'subtle-wrong' | null): FidelityRecord => ({
  ruleId,
  status,
  model: {
    context: 'RevRec', enums: [], entities: [], events: [],
    aggregates: [{ kind: 'aggregate', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' } },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' } },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' } }
    ]}]
  },
  formalization: status === 'not-formalizable' ? null : { kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] },
  cases: [
    { desc: 'balanced', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 60, allocated: 100 } }] }, expected: 'permit' },
    { desc: 'leak', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 50, allocated: 100 } }] }, expected: 'forbid' },
    { desc: 'nothing recognized', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 0, deferred: 100, allocated: 100 } }] }, expected: 'permit' }
  ],
  adversarial: { desc: 'over-recognized but sums', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 120, deferred: -20, allocated: 100 } }] }, expected: 'forbid' },
  humanVerdict
});

describe('tally: verdict thresholds', () => {
  it('all-faithful returns proceed verdict (rate = 0)', () => {
    const recs: FidelityRecord[] = [
      makeRecord('r1', 'formalized', 'faithful'),
      makeRecord('r2', 'formalized', 'faithful'),
      makeRecord('r3', 'formalized', 'faithful'),
    ];
    const result = tallyRecords(recs);
    expect(result.rate).toBe(0);
    expect(result.verdict).toBe('VERDICT: proceed as designed (<10%)');
  });

  it('rate exactly 0.10 (1 subtle + 9 faithful) returns pivot verdict (0.10 is NOT < 0.10)', () => {
    const recs: FidelityRecord[] = [
      makeRecord('r1', 'formalized', 'faithful'),
      makeRecord('r2', 'formalized', 'faithful'),
      makeRecord('r3', 'formalized', 'faithful'),
      makeRecord('r4', 'formalized', 'faithful'),
      makeRecord('r5', 'formalized', 'faithful'),
      makeRecord('r6', 'formalized', 'faithful'),
      makeRecord('r7', 'formalized', 'faithful'),
      makeRecord('r8', 'formalized', 'faithful'),
      makeRecord('r9', 'formalized', 'faithful'),
      makeRecord('r10', 'formalized', 'subtle-wrong'),
    ];
    const result = tallyRecords(recs);
    expect(result.rate).toBe(0.1);
    expect(result.verdict).toBe('VERDICT: STOP — example-set-as-spec pivot required (10–30%)');
  });

  it('rate > 0.30 returns stop verdict', () => {
    const recs: FidelityRecord[] = [
      makeRecord('r1', 'formalized', 'faithful'),
      makeRecord('r2', 'formalized', 'faithful'),
      makeRecord('r3', 'formalized', 'subtle-wrong'),
      makeRecord('r4', 'formalized', 'subtle-wrong'),
    ];
    const result = tallyRecords(recs);
    expect(result.rate).toBe(0.5);
    expect(result.verdict).toBe('VERDICT: STOP — do not build further (>30%)');
  });
});

describe('tally: record categorization', () => {
  it('not-formalizable record is counted', () => {
    const recs: FidelityRecord[] = [
      makeRecord('r1', 'not-formalizable', null),
      makeRecord('r2', 'formalized', 'faithful'),
    ];
    const result = tallyRecords(recs);
    expect(result.total).toBe(2);
    expect(result.notFormalizable).toBe(1);
    expect(result.faithful).toBe(1);
  });

  it('unjudged record (humanVerdict null, passes obvious) is counted as unjudged', () => {
    const recs: FidelityRecord[] = [
      makeRecord('r1', 'formalized', null),
      makeRecord('r2', 'formalized', 'faithful'),
    ];
    const result = tallyRecords(recs);
    expect(result.total).toBe(2);
    expect(result.unjudged).toBe(1);
    expect(result.faithful).toBe(1);
  });
});

describe('tally: zero passing records', () => {
  it('zero passing records returns rate 0', () => {
    const recs: FidelityRecord[] = [
      makeRecord('r1', 'not-formalizable', null),
      makeRecord('r2', 'not-formalizable', null),
    ];
    const result = tallyRecords(recs);
    expect(result.rate).toBe(0);
    expect(result.faithful + result.subtleWrong).toBe(0);
  });
});
