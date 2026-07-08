import { describe, it, expect } from 'vitest';
import { remapValueKeys } from '../../src/engine/witness.js';
import { periodModel } from '../fixtures.js';
import type { CaseState } from '../../src/engine/evaluate.js';

describe('remapValueKeys', () => {
  it('renames underscore-flattened value keys to dotted, leaving other fields untouched', () => {
    const cs: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3, other_thing: 1 } }] };
    const out = remapValueKeys(periodModel, cs);
    expect(out.entities[0]!.fields).toEqual({ 'period.start': 3, other_thing: 1 });
  });

  it('remaps every declared sub-field of the value type', () => {
    const cs: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3, period_end: 9 } }] };
    const out = remapValueKeys(periodModel, cs);
    expect(out.entities[0]!.fields).toEqual({ 'period.start': 3, 'period.end': 9 });
  });

  it('leaves entities of a type with no value fields untouched', () => {
    const cs: CaseState = { entities: [{ type: 'Other', id: 'o1', fields: { foo_bar: 1 } }] };
    const out = remapValueKeys(periodModel, cs);
    expect(out.entities[0]!.fields).toEqual({ foo_bar: 1 });
  });

  it('does not mutate the input CaseState', () => {
    const cs: CaseState = { entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3 } }] };
    remapValueKeys(periodModel, cs);
    expect(cs.entities[0]!.fields).toEqual({ period_start: 3 });
  });

  it('preserves now/trace and remaps every trace step entity too', () => {
    const cs: CaseState = {
      now: 5,
      entities: [{ type: 'Subscription', id: 's1', fields: { period_start: 3 } }],
      trace: [[{ type: 'Subscription', id: 's1', fields: { period_start: 1 } }]],
    };
    const out = remapValueKeys(periodModel, cs);
    expect(out.now).toBe(5);
    expect(out.trace![0]![0]!.fields).toEqual({ 'period.start': 1 });
  });

  it('handles an entity type not present in the model without crashing', () => {
    const cs: CaseState = { entities: [{ type: 'Bogus', id: 'x1', fields: { a_b: 1 } }] };
    expect(() => remapValueKeys(periodModel, cs)).not.toThrow();
    expect(remapValueKeys(periodModel, cs).entities[0]!.fields).toEqual({ a_b: 1 });
  });
});
