import { describe, it, expect } from 'vitest';
import { stuckCandidates, reachabilityResidual } from '../../src/engine/guard-structure.js';
import { subscriptionsModel } from '../fixtures.js';
import type { DomainModel } from '../../src/ast/domain.js';

// Tiny model: region s, initial=a (non-terminal), only exit `go` is guarded → a is a stuck candidate;
// b is reached only via the guarded `go` → b is in the reachability residual.
const guardedOnlyModel: DomainModel = {
  aggregates: [{
    kind: 'aggregate', name: 'W',
    fields: [{ name: 'wId', type: { kind: 'prim', prim: 'Id' }, key: true },
             { name: 'n', type: { kind: 'prim', prim: 'Int' } }],
    machine: {
      regions: [{ name: 's', initial: 'a', states: [{ name: 'a' }, { name: 'b', tags: ['terminal'] }] }],
      transitions: [{ name: 'go', region: 's', from: ['a'], to: 'b',
        requires: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['n'] }, right: { kind: 'int', value: 1 } } }],
    },
  }],
  entities: [], enums: [], values: [], events: [], services: [], context: 'T',
} as unknown as DomainModel;

describe('stuckCandidates', () => {
  it('committed subscriptions model has NO stuck candidates (every non-terminal state has an unguarded escape)', () => {
    expect(stuckCandidates(subscriptionsModel)).toEqual([]);
  });
  it('flags a non-terminal state whose only out-transition is guarded', () => {
    expect(stuckCandidates(guardedOnlyModel)).toEqual([{ owner: 'W', region: 's', state: 'a' }]);
  });
  it('does NOT flag a terminal state with no out-transitions', () => {
    // `b` is terminal-tagged in guardedOnlyModel — never a stuck candidate.
    expect(stuckCandidates(guardedOnlyModel).some(s => s.state === 'b')).toBe(false);
  });
});

describe('reachabilityResidual', () => {
  it('subscriptions residual is exactly the guard-gated states', () => {
    const res = reachabilityResidual(subscriptionsModel).map(s => `${s.owner}.${s.state}`).sort();
    expect(res).toEqual(['Invoice.open', 'Invoice.paid', 'Invoice.uncollectible', 'Subscription.active', 'Subscription.pastDue'].sort());
  });
  it('a state reached only via a guarded transition is in the residual', () => {
    expect(reachabilityResidual(guardedOnlyModel)).toEqual([{ owner: 'W', region: 's', state: 'b' }]);
  });
});
