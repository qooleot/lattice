import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';

const inertDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 0 }), quint: async () => ({ violated: false, ms: 0 }) };

const MODEL = {
  context: 'Billing', enums: [], values: [], events: [], services: [], entities: [],
  aggregates: [{
    kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invoiceId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'totalDue', type: { kind: 'prim', prim: 'Money' } },
      { name: 'usageAmount', type: { kind: 'prim', prim: 'Money' } },
    ],
  }],
};

const le = (left: string, right: string) => ({
  kind: 'statePredicate', aggregate: 'Invoice',
  body: {
    kind: 'cmp', op: 'le',
    left: { kind: 'field', owner: 'self', path: [left] },
    right: { kind: 'field', owner: 'self', path: [right] },
  },
});

async function session() {
  const dir = mkdtempSync(join(tmpdir(), 'lat-propose-naming-'));
  const model = join(dir, 'model.json');
  writeFileSync(model, JSON.stringify(MODEL));
  await runCommand(['init', '--session', dir, '--model', model], inertDeps);
  return dir;
}

const propose = (dir: string, invs: unknown[]) =>
  runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(invs)], inertDeps) as Promise<any>;

describe('propose — name normalization (spec P8)', () => {
  it('folds an agent-authored Pascal_Snake_Case name onto the convention and reports the change', async () => {
    const dir = await session();
    const r = await propose(dir, [
      { id: 'r1-discounts', name: 'TotalDue_At_Most_Parts', prior: 1, source: 'seed', candidate: le('totalDue', 'usageAmount') },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.registered).toBe(1);
    expect(r.normalized).toEqual([{ id: 'r1-discounts', from: 'TotalDue_At_Most_Parts', to: 'totalDueAtMostParts' }]);

    // the normalized name is what the session stores — so it is what emit/apply will print, and
    // the `--rename` ceremony never has to run for a casing fix.
    const st: any = await runCommand(['status', '--session', dir], inertDeps);
    expect(JSON.stringify(st)).toContain('totalDueAtMostParts');
    expect(JSON.stringify(st)).not.toContain('TotalDue_At_Most_Parts');
  });

  it('says nothing when every name already follows the convention', async () => {
    const dir = await session();
    const r = await propose(dir, [
      { id: 'a', name: 'totalDueAtMostUsage', prior: 1, source: 'seed', candidate: le('totalDue', 'usageAmount') },
    ]);
    expect(r.registered).toBe(1);
    expect(r.normalized).toBeUndefined();
  });

  it('refuses a batch whose names collide once folded, naming both originals', async () => {
    const dir = await session();
    const r = await propose(dir, [
      { id: 'a', name: 'TotalDue_At_Most', prior: 0.5, source: 'seed', candidate: le('totalDue', 'usageAmount') },
      { id: 'b', name: 'totalDue_AtMost', prior: 0.5, source: 'seed', candidate: le('usageAmount', 'totalDue') },
    ]);
    expect(r.error).toBe('name-collision');
    expect(r.collisions).toEqual([
      { name: 'totalDueAtMost', candidates: [{ id: 'a', name: 'TotalDue_At_Most' }, { id: 'b', name: 'totalDue_AtMost' }] },
    ]);

    // a refused batch registers nothing — the session is untouched.
    const st: any = await runCommand(['status', '--session', dir], inertDeps);
    expect(JSON.stringify(st)).not.toContain('totalDueAtMost');
  });

  it('allows a later round to re-propose a name under a new id', async () => {
    // The real subscriptions session does exactly this three times: r1-discounts and r1b-le-always
    // both carry TotalDue_At_Most_Parts, a refined restatement of the same rule. Collision is a
    // within-batch check for that reason — a cross-session check would refuse legitimate work.
    const dir = await session();
    const inv = (id: string) => ({ id, name: 'TotalDue_At_Most_Parts', prior: 1, source: 'seed', candidate: le('totalDue', 'usageAmount') });
    expect((await propose(dir, [inv('r1-discounts')])).error).toBeUndefined();
    const r = await propose(dir, [inv('r1b-le-always')]);
    expect(r.error).toBeUndefined();
    expect(r.registered).toBe(1);
  });
});
