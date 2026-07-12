import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { traceAModel } from './fixtures.js';

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
    // Plan 3 Task 3 tier gate: h1/h2 are `unique ... by [customer|plan]`, which reference data
    // fields → conjunctTier now classifies them `abstract` (was a hardcoded `sound` pre-gate).
    expect(classifiedEntries.every((e: any) => e.tier === 'abstract')).toBe(true);
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
    expect(calls).toHaveLength(2);   // only h1's 2-probe pair ran, never h2's
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
    // Plan 3 Task 3 tier gate: `unique ... by [customer]` references a data field → `abstract`.
    expect(r.classification.tier).toBe('abstract');
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
    expect(r).toEqual({ error: 'missing-arg', arg: 'max-steps' });
  });
});
