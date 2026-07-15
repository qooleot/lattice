import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import { traceDModel, traceDSumEq, traceDSumLe } from './fixtures.js';

// Golden trace D (design DoD item 3): an invoice-lines domain elicited end-to-end through the real
// engine loop with real solvers (Alloy + Quint), where the residual invariant is sumOverCollection,
// a value object (Period.wellOrdered) exercises type-carried adoption, and a masking-regression
// assertion is checked inside the trace (design §6.4). Real solver calls are slow (~2-25s each);
// the whole suite budgets up to ~60s, comparable to golden trace B's ~23s.
describe('golden trace D: invoice-lines sum-over-collection, elicited end-to-end with real solvers', () => {
  it('converges on totalDue == sum(lines.amount), adopts with ledger anchors, and emits consistent projections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-trace-d-'));
    const modelFile = join(dir, 'model.json');
    writeFileSync(modelFile, JSON.stringify(traceDModel));

    // --- Step 1: init — adoptions fire ---
    const init: any = await runCommand(['init', '--session', dir, '--model', modelFile], realDeps);
    expect(init.adopted.map((a: any) => a.name)).toContain('nonNegativeInvoiceTotalDue');
    expect(init.adopted.map((a: any) => a.name)).toContain('valPeriodInvoicePeriodWellOrdered');

    // --- Step 2: propose H1 (eq) / H2 (le) sumOverCollection rivals ---
    const cands = [
      { id: 'H1', name: 'lineTotalsEqual', prior: 0.5, source: 'seed', candidate: traceDSumEq },
      { id: 'H2', name: 'lineTotalsAtMost', prior: 0.5, source: 'seed', candidate: traceDSumLe },
    ];
    const prop: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(cands)], realDeps);
    expect(prop.registered).toBe(2);

    // --- Step 3: drive next-question / verdict loop with real solvers until convergence ---
    let firstVerdictWitnessId: string | undefined;
    let steps = 0;
    const MAX_STEPS = 8;
    let out: any = await runCommand(['next-question', '--session', dir], realDeps);

    while (out.type !== 'converged' && steps < MAX_STEPS) {
      steps++;
      if (out.type === 'question') {
        // Judge from the witness itself: domain truth is equality — a witness where sum != total
        // permitted by H2 (le) but forbidden by H1 (eq) is a `forbid` (equality is what's true).
        const evalH1 = evaluateCandidate(traceDSumEq, out.witness);
        const evalH2 = evaluateCandidate(traceDSumLe, out.witness);
        expect(evalH1).not.toBe(evalH2);   // cross-check: the witness must split H1/H2

        const judge = evalH1;   // honest judge: the witness's own sum-vs-total truth under equality
        const v: any = await runCommand(
          ['verdict', '--session', dir, '--witness', out.witnessId, '--judge', judge], realDeps);
        expect(v.error).toBeUndefined();

        if (!firstVerdictWitnessId) firstVerdictWitnessId = out.witnessId;
      } else if (out.type === 'probe-options') {
        // Judge each probe option from its own witness truth (equality is domain truth).
        for (const opt of out.options) {
          const judge = evaluateCandidate(traceDSumEq, opt.witness);
          await runCommand(['verdict', '--session', dir, '--witness', opt.witnessId, '--judge', judge], realDeps);
        }
      } else if (out.type === 'need-alternatives') {
        // No genuinely different alternative to offer for this domain truth — regenerate with the
        // sole survivor's own shape (equal op). checkDistinct finds it equivalent over scope
        // (UNSAT distinguish) and bumps alternativeAttempts without admitting a duplicate
        // candidate; after 2 such attempts the planner converges (design's alternatives phase).
        const rg: any = await runCommand(['regenerate', '--session', dir,
          '--candidate', JSON.stringify({ id: `ALT${steps}`, name: `alt${steps}`, candidate: traceDSumEq })], realDeps);
        expect(rg.ok).toBe(false);
        expect(rg.reason).toMatch(/equivalent/i);
      } else if (out.type === 'regenerate') {
        // Empty-hypothesis-space regen phase (unexpected for this trace) — should not occur since
        // H1 survives every verdict; fail loudly rather than loop silently if it ever does.
        throw new Error(`unexpected regenerate-phase output: ${JSON.stringify(out)}`);
      } else if (out.type === 'merged') {
        // fallthrough — re-poll below
      }
      out = await runCommand(['next-question', '--session', dir], realDeps);
    }

    expect(steps).toBeLessThan(MAX_STEPS);
    expect(out.type).toBe('converged');
    expect(firstVerdictWitnessId).toBeDefined();

    // --- assert H1 (eq) adopted with ledger anchors ---
    const st: any = await runCommand(['status', '--session', dir], realDeps);
    const h1 = st.candidates.find((c: any) => c.id === 'H1');
    const h2 = st.candidates.find((c: any) => c.id === 'H2');
    expect(h1.status).toBe('adopted');
    expect(h2.status).not.toBe('adopted');

    const ledgerPath = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const adoptedEntry = ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H1');
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry.provenance).toContain('w');   // ledger-anchored provenance references a witness id

    // --- Step 5 (masking regression, design §6.4): the first verdict's recorded exclusion shape's
    // salient dims must be a subset of {lines.count, sum(lines.amount), totalDue value} — no
    // per-row dims leaked into the shape used to exclude repeat witnesses. ---
    const firstVerdict = ledger.find((e: any) => e.kind === 'verdict' && e.witnessId === firstVerdictWitnessId);
    expect(firstVerdict).toBeDefined();
    const allowedDims = new Set(['lines.count', 'sum(lines.amount)', 'totalDue value']);
    const salientDims = firstVerdict.salient.map((f: any) => f.dim);
    expect(salientDims.length).toBeGreaterThan(0);
    for (const dim of salientDims) expect(allowedDims.has(dim)).toBe(true);

    // --- Step 4: emit → assert spec.lat / prose / statechart projections ---
    const emitDir = join(dir, 'emit-out');
    const emit: any = await runCommand(['emit', '--session', dir, '--out', emitDir], realDeps);
    expect(emit.written.length).toBeGreaterThan(0);

    const specLat = readFileSync(join(emitDir, 'spec.lat'), 'utf8');
    expect(specLat).toContain('totalDue == sum(lines, amount)');

    const prose = readFileSync(join(emitDir, 'spec.prose.md'), 'utf8');
    expect(prose).toMatch(/totalDue always equals the sum of amount over its lines/);
    // anchor: the "Always true" section cites the elicited witness that anchors the adoption
    expect(prose).toContain(firstVerdictWitnessId!);

    const statechartPath = join(emitDir, 'diagrams', 'SD_Invoice_settlement.mmd');
    expect(existsSync(statechartPath)).toBe(true);
    const statechart = readFileSync(statechartPath, 'utf8');
    expect(statechart).toContain('finalize [totalDue >= 0]');   // guarded edge (requires totalDue >= 0)
    expect(statechart).toContain('settle / InvoicePaid');       // emitting edge (emits InvoicePaid)
  }, 90000);
});
