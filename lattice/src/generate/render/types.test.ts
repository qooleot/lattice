import { describe, it, expect } from 'vitest';
import { renderTypes } from './types.js';
import { buildPlan } from '../plan.js';
import { tinyInput } from '../fixtures.js';
import type { GenPlan } from '../plan.js';

describe('renderTypes', () => {
  const src = renderTypes(buildPlan(tinyInput));
  it('emits an interface with mapped primitive types', () => {
    expect(src).toContain('export interface Account');
    expect(src).toMatch(/accountId:\s*string/);
    expect(src).toMatch(/balance:\s*number/);
  });
  it('includes a region-state field typed as the state union', () => {
    expect(src).toMatch(/status:\s*'open'\s*\|\s*'closed'/);
  });
  it('carries a provenance comment naming the aggregate', () => {
    expect(src).toMatch(/\/\/.*aggregate Account/);
  });
  it('throws on an unsupported value-kind field instead of emitting uncompilable output', () => {
    const plan: GenPlan = {
      context: 'Bank',
      aggregates: [{
        name: 'Payment',
        fields: [
          { name: 'amount', type: { kind: 'value', value: 'Money' } },
        ],
        regions: [],
        transitions: [],
        invariants: [],
      }],
      events: [],
    };
    expect(() => renderTypes(plan)).toThrow(/unsupported field type kind: value/);
  });
});
