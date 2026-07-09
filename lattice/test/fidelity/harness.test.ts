import { describe, it, expect } from 'vitest';
import { checkRecord, type FidelityRecord } from '../../fidelity/harness.js';

const record: FidelityRecord = {
  ruleId: 'r01',
  status: 'formalized',
  model: {
    context: 'RevRec', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [{ kind: 'aggregate', name: 'Obligation', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'recognized', type: { kind: 'prim', prim: 'Money' } },
      { name: 'deferred', type: { kind: 'prim', prim: 'Money' } },
      { name: 'allocated', type: { kind: 'prim', prim: 'Money' } }
    ]}]
  },
  formalization: { kind: 'conservation', aggregate: 'Obligation', parts: [['recognized'], ['deferred']], total: ['allocated'] },
  cases: [
    { desc: 'balanced', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 60, allocated: 100 } }] }, expected: 'permit' },
    { desc: 'leak', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 40, deferred: 50, allocated: 100 } }] }, expected: 'forbid' },
    { desc: 'nothing recognized', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 0, deferred: 100, allocated: 100 } }] }, expected: 'permit' }
  ],
  adversarial: { desc: 'over-recognized but sums', state: { entities: [{ type: 'Obligation', id: 'o1', fields: { recognized: 120, deferred: -20, allocated: 100 } }] }, expected: 'forbid' },
  humanVerdict: null
};

describe('fidelity harness', () => {
  it('reports obvious-case agreement and adversarial disagreement', () => {
    const r = checkRecord(record);
    expect(r.grammarErrors).toEqual([]);
    expect(r.obviousPass).toBe(true);
    // conservation permits (120 + -20 == 100) but intent forbids ⇒ subtle-wrong candidate, surfaced:
    expect(r.adversarialAgrees).toBe(false);
  });
  it('flags grammar violations', () => {
    const bad = structuredClone(record);
    (bad.formalization as any).kind = 'wibble';
    const result = checkRecord(bad);
    expect(result.grammarErrors.length).toBeGreaterThan(0);
    expect(result.grammarErrors.map(d => d.code)).toContain('out-of-grammar');
  });
  it('handles ill-typed candidate shape (flat parts) without throwing', () => {
    const bad = structuredClone(record);
    (bad.formalization as any).parts = ['recognized', 'deferred'];
    let result: ReturnType<typeof checkRecord> = { grammarErrors: [], obviousPass: false, adversarialAgrees: null, perCase: [] };
    expect(() => { result = checkRecord(bad); }).not.toThrow();
    expect(result.grammarErrors.length).toBeGreaterThan(0);
  });
  it('handles not-formalizable status without throwing', () => {
    const notFormalizableRec: FidelityRecord = {
      ruleId: 'r02',
      status: 'not-formalizable',
      model: record.model,
      formalization: null,
      cases: record.cases,
      adversarial: record.adversarial,
      humanVerdict: null
    };
    const r = checkRecord(notFormalizableRec);
    expect(r.grammarErrors).toEqual([]);
    expect(r.obviousPass).toBe(false);
    expect(r.adversarialAgrees).toBe(null);
    expect(r.perCase).toEqual([]);
  });
});
