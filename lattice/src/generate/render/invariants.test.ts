import { describe, it, expect } from 'vitest';
import { renderInvariants } from './invariants.js';
import { buildPlan } from '../plan.js';
import { tinyInput, witnessedInput, tableInput } from '../fixtures.js';

describe('renderInvariants', () => {
  it('emits a row-kind check as an exported function over `row`', () => {
    const src = renderInvariants(buildPlan(tinyInput));
    expect(src).toMatch(/\/\/ spec: invariant nonNegativeBalance/);
    expect(src).toMatch(/export function checkNonNegativeBalance\(row\): boolean \{/);
    expect(src).toContain('row.balance >= 0');
  });

  it('cites per-invariant adopted provenance in the comment', () => {
    const src = renderInvariants(buildPlan(tinyInput));
    expect(src).toMatch(/\/\/ spec: invariant nonNegativeBalance\s+\[provenance: seed:template\]/);
  });

  it('cites judged witnesses as exercising the aggregate, not as having judged the invariant', () => {
    const src = renderInvariants(buildPlan(witnessedInput));
    expect(src).toMatch(/witnesses exercising aggregate Account: w1, w3/);
    expect(src).not.toMatch(/witnesses that judged/);
  });

  it('omits the witnesses clause when there are no witnessIds', () => {
    const src = renderInvariants(buildPlan(tinyInput));
    // tinyInput's ledger has no verdict entries, so no witnesses were exercised
    expect(src).not.toMatch(/witnesses exercising/);
  });

  it('emits a table-kind (unique) check as an exported function over `rows`', () => {
    const src = renderInvariants(buildPlan(tableInput));
    expect(src).toMatch(/\/\/ spec: invariant onePublishedPerOwner/);
    expect(src).toMatch(/export function checkOnePublishedPerOwner\(rows\): boolean \{/);
    expect(src).toContain('for (const r of rows)');
  });
});
