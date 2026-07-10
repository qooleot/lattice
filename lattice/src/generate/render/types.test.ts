import { describe, it, expect } from 'vitest';
import { renderTypes } from './types.js';
import { buildPlan } from '../plan.js';
import { tinyInput } from '../fixtures.js';

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
});
