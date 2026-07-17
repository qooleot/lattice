import { describe, it, expect } from 'vitest';
import { compileInvariantCheck, predToTs } from './invariantCheck.js';
import type { PlanInvariant } from './plan.js';

const mk = (candidate: any, name = 'x'): PlanInvariant =>
  ({ name, candidate, aggregate: candidate.aggregate, anchors: { specElement: '', provenance: [], witnessIds: [] } });

describe('compileInvariantCheck', () => {
  it('compiles a statePredicate to a readable row boolean', () => {
    const c = compileInvariantCheck(mk({ kind: 'statePredicate', aggregate: 'Account',
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['balance'] }, right: { kind: 'int', value: 0 } } }));
    expect(c.kind).toBe('row');
    expect(c.bodyTs).toContain('row.balance >= 0');
    // executable: build a function and run it
    const fn = new Function('row', `return (${c.bodyTs});`);
    expect(fn({ balance: 5 })).toBe(true);
    expect(fn({ balance: -1 })).toBe(false);
  });

  it('honors where-state scoping (vacuously true outside the scope)', () => {
    const c = compileInvariantCheck(mk({ kind: 'statePredicate', aggregate: 'Sub',
      where: { kind: 'inState', owner: 'self', region: 'status', states: ['active'] },
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['paid'] }, right: { kind: 'int', value: 1 } } }));
    const fn = new Function('row', `return (${c.bodyTs});`);
    expect(fn({ status: 'trialing', paid: 0 })).toBe(true);  // out of scope → holds
    expect(fn({ status: 'active', paid: 0 })).toBe(false);   // in scope, violated
    expect(fn({ status: 'active', paid: 1 })).toBe(true);
  });

  it('compiles unique to a table-level check', () => {
    const c = compileInvariantCheck(mk({ kind: 'unique', aggregate: 'Invoice',
      whileStates: { region: 'settlement', states: ['draft'] }, by: [['subscription']] }));
    expect(c.kind).toBe('table');
    const fn = new Function('rows', `return (${c.bodyTs});`);
    expect(fn([{ settlement: 'draft', subscription: 's1' }, { settlement: 'draft', subscription: 's1' }])).toBe(false);
    expect(fn([{ settlement: 'draft', subscription: 's1' }, { settlement: 'paid', subscription: 's1' }])).toBe(true);
  });

  it('throws loudly on an unsupported kind', () => {
    expect(() => compileInvariantCheck(mk({ kind: 'monotonic', aggregate: 'Sub', field: ['n'] })))
      .toThrow(/unsupported invariant kind: monotonic/);
  });

  it('present() is NULL-aware and hop-safe in generated TS', () => {
    const single = predToTs({ kind: 'present', path: ['approvedAmount'] }, 'row');
    expect(single).toBe('row.approvedAmount != null');
    // eslint-disable-next-line no-new-func
    const f = new Function('row', `return ${single};`);
    expect(f({ approvedAmount: null })).toBe(false);   // SQL NULL is absence
    expect(f({ approvedAmount: 0 })).toBe(true);       // falsy zero is a fact

    const hop = predToTs({ kind: 'present', path: ['method', 'fee'] }, 'row');
    expect(hop).toBe('row.method?.fee != null');
    const g = new Function('row', `return ${hop};`);
    expect(g({ method: undefined })).toBe(false);      // absent ref: no throw, answer is false
    expect(g({ method: { fee: 3 } })).toBe(true);
  });
});
