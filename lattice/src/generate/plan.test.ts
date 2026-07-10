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
});
