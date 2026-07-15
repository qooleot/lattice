import { describe, it, expect } from 'vitest';
import type { CaseEntity } from '../engine/evaluate.js';
import type { GenPlan } from '../generate/plan.js';
import { checkInvariants } from './tier1.js';

// Minimal hand-built GenPlan: one Account aggregate with one statePredicate invariant
// (balance >= 0) carrying anchors. GenPlan.invariants live under aggregates[].invariants
// (src/generate/plan.ts), not at the plan's top level.
const plan: GenPlan = {
  context: 'Test',
  events: [],
  aggregates: [{
    name: 'Account',
    fields: [],
    regions: [],
    transitions: [],
    invariants: [{
      name: 'nonNegativeBalance',
      aggregate: 'Account',
      candidate: {
        kind: 'statePredicate',
        aggregate: 'Account',
        body: {
          kind: 'cmp', op: 'ge',
          left: { kind: 'field', owner: 'self', path: ['balance'] },
          right: { kind: 'int', value: 0 },
        },
      },
      anchors: { specElement: 'invariant nonNegativeBalance', provenance: ['elicited (w1, w2)'], witnessIds: ['w1', 'w2'] },
    }],
  }],
};

const acct = (id: string, balance: number): CaseEntity => ({ type: 'Account', id, fields: { accountId: id, balance } });

describe('checkInvariants', () => {
  it('passes clean state', () => {
    expect(checkInvariants([acct('a1', 10)], plan, [], 'test:clean')).toEqual([]);
  });

  it('reports a violation with spec element, anchors, and the offending row id', () => {
    const v = checkInvariants([acct('a1', 10), acct('a2', -5)], plan, [], 'test:dirty');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      invariant: 'nonNegativeBalance',
      specElement: 'invariant nonNegativeBalance',
      source: 'test:dirty',
      witnessIds: ['a2'],
    });
    expect(v[0]!.anchors).toContain('elicited (w1, w2)');
  });

  it('honors opt-outs with reasons and rejects reasonless ones', () => {
    expect(checkInvariants([acct('a2', -5)], plan, [{ invariant: 'nonNegativeBalance', reason: 'fixture builds pre-migration accounts' }], 's')).toEqual([]);
    expect(() => checkInvariants([], plan, [{ invariant: 'nonNegativeBalance', reason: '' }], 's')).toThrow(/reason/);
  });

  it('pins a set-level violation to all subject ids, not a single row', () => {
    const uniquePlan: GenPlan = {
      context: 'Test', events: [],
      aggregates: [{
        name: 'Invoice', fields: [], regions: [], transitions: [],
        invariants: [{
          name: 'uniqueSubscription', aggregate: 'Invoice',
          candidate: { kind: 'unique', aggregate: 'Invoice', whileStates: { region: 'settlement', states: ['draft'] }, by: [['subscription']] },
          anchors: { specElement: 'invariant uniqueSubscription', provenance: [], witnessIds: [] },
        }],
      }],
    };
    const inv = (id: string, sub: string): CaseEntity => ({ type: 'Invoice', id, fields: { 'settlement.state': 'draft', subscription: sub } });
    const v = checkInvariants([inv('i1', 's1'), inv('i2', 's1')], uniquePlan, [], 'test:unique');
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toBe('set-level violation');
    expect(v[0]!.witnessIds.sort()).toEqual(['i1', 'i2']);
  });

  it('never evaluates guard-kind candidates as always-properties', () => {
    const guardPlan: GenPlan = {
      context: 'Test', events: [],
      aggregates: [{
        name: 'Account', fields: [], regions: [], transitions: [],
        invariants: [{
          name: 'closeGuard', aggregate: 'Account',
          candidate: {
            kind: 'guard', aggregate: 'Account', region: 'status', transition: 'close',
            predicate: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['balance'] }, right: { kind: 'int', value: 0 } },
          },
          anchors: { specElement: 'invariant closeGuard', provenance: [], witnessIds: [] },
        }],
      }],
    };
    // Every account below has a nonzero balance, which would forbid under the guard's predicate
    // if it were evaluated as an always-property. Tier 1 must skip it and report nothing.
    expect(checkInvariants([acct('a1', 42)], guardPlan, [], 'test:guard')).toEqual([]);
  });
});
