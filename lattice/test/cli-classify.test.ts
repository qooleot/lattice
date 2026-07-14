import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { readGuardFindings, readMethodGuards } from '../src/engine/session.js';
import { traceAModel, traceDModel, someStatePredicateOnInvoice } from './fixtures.js';
import type { DomainModel } from '../src/ast/domain.js';

// Scripted quintVerify: returns queued results in CALL ORDER (mirrors classify.test.ts's fakeDeps
// pattern). classifyInvariant makes 2 calls per invariant — [consecution, reachability] — in the
// order `classify` walks its targets.
function scriptedDeps(results: { violated: boolean; witness?: any }[]) {
  let i = 0;
  const calls: { opts: any }[] = [];
  const deps: any = {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => ({ violated: false, ms: 0 }),
    quintVerify: async (_em: any, opts: any) => { calls.push({ opts }); return { ...results[i++]!, ms: 0 }; },
  };
  return { deps, calls };
}

const inertDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 0 }), quint: async () => ({ violated: false, ms: 0 }) };

// Builds a session with traceAModel's 3 template-adopted (unclassifiable-kind) invariants plus two
// hand-adopted `unique`-kind (quint-expressible) invariants h1/h2 — skipping elicitation entirely by
// patching state.json directly (mirrors cli.test.ts's "next-question returning converged..." pattern).
async function setup(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-classify-'));
  const modelFile = join(dir, 'm.json');
  writeFileSync(modelFile, JSON.stringify(traceAModel));
  await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
  await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
    { id: 'H1', name: 'h1', prior: 0.5, source: 'seed',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
    { id: 'H2', name: 'h2', prior: 0.4, source: 'seed',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] } }
  ])], inertDeps);

  const stateFile = join(dir, 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const ledgerFile = join(dir, 'ledger.jsonl');
  for (const c of st.candidates) {
    if (c.inv.id === 'H1' || c.inv.id === 'H2') {
      c.status = 'adopted';
      // explain's `current` resolution walks `adopted` ledger entries — mirror the real elicited
      // flow (converged survivor) rather than only patching state.json's tracked-candidate status.
      appendFileSync(ledgerFile, JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: c.inv, provenance: 'test' }) + '\n');
    }
  }
  writeFileSync(stateFile, JSON.stringify(st));
  return dir;
}

describe('engine classify CLI', () => {
  it('classifies every adopted quint-expressible invariant, skipping template-adopted structural kinds', async () => {
    const dir = await setup();
    // [h1-consecution, h1-reachability, h2-consecution, h2-reachability]
    const { deps } = scriptedDeps([
      { violated: false }, { violated: false },                                   // h1 -> entailed
      { violated: true, witness: { entities: [], trace: [] } }, { violated: false } // h2 -> independent
    ]);

    const r: any = await runCommand(['classify', '--session', dir], deps);
    expect(r.classified).toHaveLength(2);
    expect(r.classified.map((c: any) => c.invariant).sort()).toEqual(['h1', 'h2']);

    const h1Result = r.classified.find((c: any) => c.invariant === 'h1');
    expect(h1Result.verdict).toBe('entailed');
    expect(h1Result.pinnedBy).toEqual(['h2']);          // peers exclude the target itself
    const h2Result = r.classified.find((c: any) => c.invariant === 'h2');
    expect(h2Result.verdict).toBe('independent');

    // (a) a `classified` ledger entry per adopted (quint-expressible) invariant
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const classifiedEntries = ledger.filter((e: any) => e.kind === 'classified');
    expect(classifiedEntries).toHaveLength(2);
    expect(classifiedEntries.map((e: any) => e.invariant).sort()).toEqual(['h1', 'h2']);
    // D1 tier gate: h1/h2 are `unique ... by [customer|plan]`, both refs — not evolving (non-const
    // Int/Money) fields — so conjunctTier classifies them `sound` (was `abstract` under the old
    // "references any data field" rule; traceAModel has no numeric fields at all).
    expect(classifiedEntries.every((e: any) => e.tier === 'sound')).toBe(true);
    // template-adopted refsResolve/terminal invariants must never reach the classifier (candidateToQuint
    // throws for those kinds) — only h1/h2 appear.
    expect(classifiedEntries.some((e: any) => e.invariant.includes('NoOrphan') || e.invariant.includes('Terminal'))).toBe(false);

    // (b) status returns the counts
    const st: any = await runCommand(['status', '--session', dir], inertDeps);
    expect(st.classifications).toEqual({ entailed: 1, independent: 1, notInductive: 0, violated: 0 });
  });

  it('--name classifies only the named invariant', async () => {
    const dir = await setup();
    const { deps, calls } = scriptedDeps([{ violated: false }, { violated: false }]);   // h1 -> entailed
    const r: any = await runCommand(['classify', '--session', dir, '--name', 'h1'], deps);
    expect(r.classified).toHaveLength(1);
    expect(r.classified[0].invariant).toBe('h1');
    // `--name` is the fast, scoped path (Fix 2): guard analysis is model-level, not invariant-scoped,
    // so it must NOT run here — only h1's 2-probe pair ran through classifyAdopted, never h2's, and
    // no guard probes (q_not_stuck/q_not_reach) are mixed in.
    expect(calls).toHaveLength(2);
  });

  it('--name classify returns no guardFindings key and does not run guard analysis', async () => {
    const dir = await setup();
    const { deps, calls } = scriptedDeps([{ violated: false }, { violated: false }]);   // h1 -> entailed
    const r: any = await runCommand(['classify', '--session', dir, '--name', 'h1'], deps);
    expect(r.guardFindings).toBeUndefined();
    expect(calls).toHaveLength(2);   // only h1's consecution+reachability probes, no guard probes

    const persisted = readGuardFindings(dir);
    expect(persisted).toHaveLength(0);
  });

  it('--max-steps threads through as the reachability bound (default 6)', async () => {
    const dir = await setup();
    const { deps, calls } = scriptedDeps([{ violated: false }, { violated: false }]);
    await runCommand(['classify', '--session', dir, '--name', 'h1', '--max-steps', '3'], deps);
    expect(calls[1]!.opts.maxSteps).toBe(3);   // 2nd call = reachability probe
  });

  it('default reachability bound is 6 when --max-steps is omitted', async () => {
    const dir = await setup();
    const { deps, calls } = scriptedDeps([{ violated: false }, { violated: false }]);
    await runCommand(['classify', '--session', dir, '--name', 'h1'], deps);
    expect(calls[1]!.opts.maxSteps).toBe(6);
  });

  it('(c) explain surfaces the classification verdict for a classified invariant', async () => {
    const dir = await setup();
    const { deps } = scriptedDeps([{ violated: false }, { violated: false }]);   // h1 -> entailed
    await runCommand(['classify', '--session', dir, '--name', 'h1'], deps);

    const r: any = await runCommand(['explain', '--session', dir, '--name', 'h1'], inertDeps);
    expect(r.classification).toBeDefined();
    expect(r.classification.verdict).toBe('entailed');
    // D1 tier gate: `unique ... by [customer]` references only a ref (customer), not an evolving
    // (non-const Int/Money) field, so conjunctTier is `sound` (was `abstract` under the old
    // "references any data field" rule).
    expect(r.classification.tier).toBe('sound');
    expect(r.classification.pinnedBy).toEqual(['h2']);
  });

  it('reachable ¬I classifies violated and surfaces the witness', async () => {
    const dir = await setup();
    const witness = { entities: [{ type: 'Subscription', id: 's1', fields: {} }], trace: [] };
    const { deps } = scriptedDeps([{ violated: false }, { violated: true, witness }]);
    const r: any = await runCommand(['classify', '--session', dir, '--name', 'h1'], deps);
    expect(r.classified[0].verdict).toBe('violated');
    expect(r.classified[0].reachable).toBe(true);
    expect(r.classified[0].witness).toEqual(witness);

    const st: any = await runCommand(['status', '--session', dir], inertDeps);
    expect(st.classifications.violated).toBe(1);
  });

  it('status counts reflect only the LATEST classification per invariant, not a naive count-all', async () => {
    const dir = await setup();

    // First run: h1 -> independent (consecution fails, no reachable ¬I).
    const first = scriptedDeps([{ violated: true, witness: { entities: [], trace: [] } }, { violated: false }]);
    await runCommand(['classify', '--session', dir, '--name', 'h1'], first.deps);
    let st: any = await runCommand(['status', '--session', dir], inertDeps);
    expect(st.classifications).toEqual({ entailed: 0, independent: 1, notInductive: 0, violated: 0 });

    // Second run on the SAME invariant: h1 -> violated (reachable ¬I this time). The ledger now
    // holds two `classified` entries for h1; status must count only the latest one — independent's
    // bucket must drop back to 0, not stay at 1 alongside violated's 1.
    const second = scriptedDeps([{ violated: false }, { violated: true, witness: { entities: [], trace: [] } }]);
    await runCommand(['classify', '--session', dir, '--name', 'h1'], second.deps);
    st = await runCommand(['status', '--session', dir], inertDeps);
    expect(st.classifications).toEqual({ entailed: 0, independent: 0, notInductive: 0, violated: 1 });
  });

  it('--name with no matching classifiable target returns an explicit error, never a silent no-op', async () => {
    const dir = await setup();

    // Case 1: no adopted invariant has this name at all (typo / never proposed).
    const r1: any = await runCommand(['classify', '--session', dir, '--name', 'no-such-invariant'], inertDeps);
    expect(r1.error).toBe('not-classifiable');
    expect(r1.name).toBe('no-such-invariant');
    expect(r1.hint).toMatch(/no adopted invariant/i);

    // Case 2: the name IS adopted (template-adopted NoOrphan_Subscription, kind refsResolve) but its
    // kind isn't quint-expressible — distinct hint from case 1, since it's a real invariant just not
    // classifiable by this engine.
    const r2: any = await runCommand(['classify', '--session', dir, '--name', 'NoOrphan_Subscription'], inertDeps);
    expect(r2.error).toBe('not-classifiable');
    expect(r2.name).toBe('NoOrphan_Subscription');
    expect(r2.hint).toMatch(/refsResolve/);
    expect(r2.hint).not.toMatch(/no adopted invariant/i);
  });

  it('bulk classify (no --name) surfaces adopted-but-unclassifiable invariants in `skipped`', async () => {
    const dir = await setup();
    const { deps } = scriptedDeps([
      { violated: false }, { violated: false },   // h1 -> entailed
      { violated: false }, { violated: false },   // h2 -> entailed
    ]);
    const r: any = await runCommand(['classify', '--session', dir], deps);
    expect(r.classified).toHaveLength(2);
    // traceAModel's 3 template-adopted structural invariants (refsResolve/terminal kinds) are
    // adopted but never quint-classifiable — bulk classify must name them, not just drop them.
    expect(r.skipped).toEqual(expect.arrayContaining([
      { name: 'NoOrphan_Subscription', kind: 'refsResolve' },
      { name: 'Terminal_Subscription_Ended', kind: 'terminal' },
      { name: 'NoOrphan_Plan', kind: 'refsResolve' },
    ]));
    expect(r.skipped).toHaveLength(3);
  });

  it('--max-steps rejects a non-numeric value instead of letting NaN reach the solver', async () => {
    const dir = await setup();
    const r: any = await runCommand(['classify', '--session', dir, '--name', 'h1', '--max-steps', 'not-a-number'], inertDeps);
    expect(r).toEqual({ error: 'invalid-arg', arg: 'max-steps' });
  });

  // Mirrors guard-structure.test.ts's `guardedOnlyModel`: region `s`, initial `a` (non-terminal),
  // its only exit `go` is guarded by `n==1` → `a` is a stuck candidate; `b` is reached only via the
  // guarded `go` → `b` is in the reachability residual. This tests the WIRING (classify calls
  // analyzeGuards and persists+surfaces its findings), not the solver — Task 3's integration test
  // already proves the solver direction against real quint.
  const stuckGuardModel: DomainModel = {
    context: 'T', ticksPerDay: 24, enums: [], values: [], entities: [], events: [], services: [],
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
  } as unknown as DomainModel;

  it('classify surfaces a stuck guard finding and persists it to the ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-classify-guard-'));
    const modelFile = join(dir, 'm.json');
    writeFileSync(modelFile, JSON.stringify(stuckGuardModel));
    await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);

    // A stub `quintVerify` that always reports `violated: true` — a stuck probe treats that as a
    // confirmed stuck finding; a reachability probe treats it as reachable (no unreachable finding),
    // so this model yields exactly one finding: `a` is stuck.
    const guardDeps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 0 }),
      quint: async () => ({ violated: false, ms: 0 }),
      quintVerify: async () => ({ violated: true, ms: 0 }),
    };
    const r: any = await runCommand(['classify', '--session', dir], guardDeps);
    expect(r.guardFindings).toBeDefined();
    expect(r.guardFindings).toHaveLength(1);
    expect(r.guardFindings[0]).toMatchObject({ finding: 'stuck', owner: 'W', region: 's', state: 'a', boundedN: 6 });

    const persisted = readGuardFindings(dir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: 'guard-finding', finding: 'stuck', owner: 'W', region: 's', state: 'a', boundedN: 6 });
  });

  // traceDModel carries a `Billing` service with one `performs` method (`settle`, no `requires`) —
  // checkAllMethodGuards (cli.ts) runs unconditionally before the `--name` early return, so a
  // `--name` classify still produces method-guard results even though it skips guard analysis
  // (item 4: those results must now survive to the ledger, not just the command's own output).
  it('classify persists method-guard results to the ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-classify-mg-'));
    const modelFile = join(dir, 'm.json');
    writeFileSync(modelFile, JSON.stringify(traceDModel));
    await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'nonNegativeTotal', prior: 0.5, source: 'seed', candidate: someStatePredicateOnInvoice }
    ])], inertDeps);
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    const h1 = st.candidates.find((c: any) => c.inv.id === 'H1');
    h1.status = 'adopted';
    writeFileSync(stateFile, JSON.stringify(st));
    appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: h1.inv, provenance: 'test' }) + '\n');

    // [h1-consecution, h1-reachability, methodGuard-probe1(method-implies-guard), methodGuard-probe2(guard-implies-method)]
    const { deps } = scriptedDeps([
      { violated: false }, { violated: false },
      { violated: false }, { violated: false },
    ]);
    const r: any = await runCommand(['classify', '--session', dir, '--name', 'nonNegativeTotal'], deps);
    expect(r.methodGuards).toEqual([{ service: 'Billing', method: 'settle', verdict: 'consistent', reachable: false }]);

    const persisted = readMethodGuards(dir);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]).toMatchObject({ kind: 'method-guard', service: 'Billing', method: 'settle', verdict: 'consistent' });
    expect(persisted[0]!.provenance).toContain('classify');
  });
});
