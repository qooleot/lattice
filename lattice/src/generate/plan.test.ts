import { describe, it, expect } from 'vitest';
import { buildPlan } from './plan.js';
import { loadGenInput } from './load.js';
import { tinyInput } from './fixtures.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

describe('buildPlan', () => {
  it('attaches ledger provenance to an adopted invariant', () => {
    const plan = buildPlan(tinyInput);
    const acct = plan.aggregates.find(a => a.name === 'Account')!;
    const inv = acct.invariants.find(i => i.name === 'nonNegativeBalance')!;
    expect(inv.anchors.provenance).toContain('seed:template');
    expect(inv.anchors.specElement).toBe('invariant nonNegativeBalance');
  });

  it('carries guarded transitions with their requires/emits onto the plan', () => {
    const plan = buildPlan(tinyInput);
    const acct = plan.aggregates.find(a => a.name === 'Account')!;
    const close = acct.transitions.find(t => t.name === 'close')!;
    expect(close.requires).toBeDefined();
    expect(close.from).toEqual(['open']);
  });

  it('resolves the real Subscriptions session with verdict witnesses anchored', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const plan = buildPlan(loadGenInput(join(repoRoot, '.lattice-session-subscriptions')));
    expect(plan.context).toBe('Subscriptions');
    const allInv = plan.aggregates.flatMap(a => a.invariants);
    // at least one adopted invariant carries a judged witness anchor
    expect(allInv.some(i => i.anchors.witnessIds.length > 0)).toBe(true);
  });

  it('resolves provenance for an invariant renamed after ledger adoption, by stable id not name', () => {
    // positivePeriodNonNegativeUsage was adopted under its pre-rename ledger name
    // (Positive_Period_NonNegative_Usage) but carries a stable id (r4b-subscription-sanity).
    // Matching the ledger 'adopted' entry by current name silently fails after a rename;
    // matching by id must still find the real elicited provenance.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const plan = buildPlan(loadGenInput(join(repoRoot, '.lattice-session-subscriptions')));
    const allInv = plan.aggregates.flatMap(a => a.invariants);
    const inv = allInv.find(i => i.name === 'positivePeriodNonNegativeUsage')!;
    expect(inv).toBeDefined();
    expect(inv.anchors.provenance.length).toBeGreaterThan(0);
    expect(inv.anchors.provenance.join(' ')).toContain('elicited');
  });
});
