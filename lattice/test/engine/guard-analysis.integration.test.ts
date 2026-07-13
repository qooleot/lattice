import { describe, it, expect } from 'vitest';
import { analyzeGuards } from '../../src/engine/guard-analysis.js';
import { realDeps } from '../../src/cli.js';   // the real SolverDeps (quintVerify = runQuintVerify)
import type { DomainModel } from '../../src/ast/domain.js';

const mk = (transitions: any[], states: any[]): DomainModel => ({
  aggregates: [{ kind: 'aggregate', name: 'W',
    fields: [{ name: 'wId', type: { kind: 'prim', prim: 'Id' }, key: true },
             { name: 'n', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 's', initial: 'a', states }], transitions } }],
  entities: [], enums: [], values: [], events: [], services: [], context: 'T',
} as unknown as DomainModel);
const cmp = (l: any, op: string, r: any) => ({ kind: 'cmp', op, left: l, right: r });
const fld = (p: string) => ({ kind: 'field', owner: 'self', path: [p] });
const int = (value: number) => ({ kind: 'int', value });
const and = (...args: any[]) => ({ kind: 'and', args });

describe('analyzeGuards (integration, real quint)', () => {
  it('flags a reachable non-terminal state stuck behind an unsatisfiable guard', async () => {
    // `a` (initial, non-terminal) only exits via `go`, guarded by `n==1 and n==2` (unsatisfiable
    // even under accrual). `a` is reachable (initial) and can never escape → stuck.
    const model = mk(
      [{ name: 'go', region: 's', from: ['a'], to: 'b',
         requires: and(cmp(fld('n'), 'eq', int(1)), cmp(fld('n'), 'eq', int(2))) }],
      [{ name: 'a' }, { name: 'b', tags: ['terminal'] }]);
    const findings = await analyzeGuards(model, realDeps, 4);
    expect(findings.some(f => f.finding === 'stuck' && f.state === 'a')).toBe(true);
  }, 60_000);

  it('flags a state unreachable behind an unsatisfiable guard', async () => {
    // `b` is entered only via `go` (guarded by the unsatisfiable `n==1 and n==2`) → unreachable.
    const model = mk(
      [{ name: 'go', region: 's', from: ['a'], to: 'b',
         requires: and(cmp(fld('n'), 'eq', int(1)), cmp(fld('n'), 'eq', int(2))) }],
      [{ name: 'a' }, { name: 'b' }]);
    const findings = await analyzeGuards(model, realDeps, 4);
    expect(findings.some(f => f.finding === 'unreachable' && f.state === 'b')).toBe(true);
  }, 60_000);

  it('a well-formed model with an unguarded escape yields no stuck finding', async () => {
    // `a` has an unguarded exit `esc` → never a stuck candidate → no stuck probe, no finding.
    const model = mk(
      [{ name: 'esc', region: 's', from: ['a'], to: 'b' }],
      [{ name: 'a' }, { name: 'b', tags: ['terminal'] }]);
    const findings = await analyzeGuards(model, realDeps, 4);
    expect(findings.some(f => f.finding === 'stuck')).toBe(false);
  }, 60_000);
});
