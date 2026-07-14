import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { subscriptionsModel } from './fixtures.js';
import type { AggregateDef, DomainModel } from '../src/ast/domain.js';

// REAL-quint proof of the §8.4 masking reclassify (I-1 fix). The scripted `hookDeps` test in
// cli-strengthen.test.ts drives the reclassify verdict by call-order, so it stays green even when the
// classify machine is guard-blind (the defect) — a false green. This test uses realDeps: bulk
// `classify` classifies `paidExact` (paid ⇒ amountPaid==totalDue) `violated` on the stripped variant,
// the strengthening hook auto-adopts the `settle == guard`, and the masking reclassify must report
// `paidExact` as `entailed` — which is only possible if the freshly-adopted guard actually rode into
// the classify machine's `trans_` action (the guards channel). Pre-fix this reclassify reports
// `violated` (the guard reaches the machine through neither `peers` nor `adopted`).

const inertDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 0 }), quint: async () => ({ violated: false, ms: 0 }) };

// Deep-clone subscriptionsModel and strip `settle`'s authored `requires` (mirrors
// strengthen.integration.test.ts) — genuinely violates `paidExact` since nothing forces
// amountPaid==totalDue on entering `paid` anymore, giving the hook a real CTI to re-close via a guard.
function stripSettleGuard(m: DomainModel): DomainModel {
  const variant = structuredClone(m);
  const invoice = (variant.aggregates as AggregateDef[]).find(a => a.name === 'Invoice')!;
  const settle = invoice.machine!.transitions.find(t => t.name === 'settle')!;
  delete settle.requires;
  return variant;
}

const paidExactCandidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
  body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
};

async function setup(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-strengthen-int-'));
  const modelFile = join(dir, 'm.json');
  writeFileSync(modelFile, JSON.stringify(stripSettleGuard(subscriptionsModel)));
  await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
  await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
    { id: 'pe', name: 'paidExact', prior: 1, source: 'seed', candidate: paidExactCandidate },
  ])], inertDeps);

  // Adopt paidExact directly (skip elicitation), same pattern as cli-strengthen.test.ts's setup.
  const stateFile = join(dir, 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const c = st.candidates.find((c: any) => c.inv.id === 'pe');
  c.status = 'adopted';
  writeFileSync(stateFile, JSON.stringify(st));
  const ledgerFile = join(dir, 'ledger.jsonl');
  writeFileSync(ledgerFile, JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: c.inv, provenance: 'test' }) + '\n');
  return dir;
}

describe('engine classify interactive strengthening hook (bulk, REAL quint)', () => {
  it('masking: violated paidExact auto-adopts a settle guard, then reclassifies ENTAILED on real quint', async () => {
    const dir = await setup();
    const r: any = await runCommand(['classify', '--session', dir], realDeps);

    // paidExact classifies violated on the stripped variant ⇒ the hook fires.
    expect(r.classified.find((c: any) => c.invariant === 'paidExact')?.verdict).toBe('violated');

    // The hook auto-adopts a `settle == guard`.
    expect(r.autoStrengthened).toHaveLength(1);
    expect(r.autoStrengthened[0]).toMatchObject({
      invariant: 'paidExact', guard: 'guard_settle_eq',
      resolution: { kind: 'auto-adopt', guard: { transition: 'settle', predicate: { op: 'eq' } } },
    });

    // THE PROOF: the masking reclassify — run over REAL quint with the guard now in the machine —
    // reports paidExact as `entailed`. Guard-blind (pre-fix), this comes back `violated`. The
    // broadened §7.2 aggregate scope (item 1) also sweeps in every other adopted invariant over
    // Invoice — here the four NonNegative_Invoice_* templates matchTemplates auto-adopts for
    // subscriptionsModel's four Money fields — which real quint confirms stay `entailed` too.
    expect(r.autoStrengthened[0].reclassified).toContainEqual(
      expect.objectContaining({ invariant: 'paidExact', verdict: 'entailed' }),
    );
    expect(r.autoStrengthened[0].reclassified.every((e: any) => e.verdict === 'entailed')).toBe(true);
    expect(r.autoStrengthened[0].reclassified.map((e: any) => e.invariant).sort()).toEqual([
      'NonNegative_Invoice_amountPaid', 'NonNegative_Invoice_licenseFeeAmount',
      'NonNegative_Invoice_totalDue', 'NonNegative_Invoice_usageAmount', 'paidExact',
    ]);

    // The guard is now adopted in the session with the same id the `strengthen` command mints.
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guard = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guard?.status).toBe('adopted');
    expect(guard.inv.id).toBe('guard-Invoice-settle-eq');

    // M-3: the adopted guard must NOT appear in `skipped` (that list names unclassified INVARIANTS).
    expect((r.skipped ?? []).some((x: any) => x.kind === 'guard')).toBe(false);
  }, 300_000);
});
