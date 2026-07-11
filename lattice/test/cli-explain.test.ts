import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';
import { traceAModel } from './fixtures.js';

const SESSION = join(import.meta.dirname, '../../.lattice-session-subscriptions');

const inertDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 0 }), quint: async () => ({ violated: false, ms: 0 }) };
function scriptedDeps(results: { violated: boolean; witness?: any }[]) {
  let i = 0;
  return { ...inertDeps, quintVerify: async () => ({ ...results[i++]!, ms: 0 }) };
}

describe('engine explain', () => {
  it('explains an elicited invariant with witnesses and provenance', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'One_Draft_Invoice_Per_Subscription'], realDeps);
    // post-migration (Task 12) the current name is oneDraftInvoicePerSubscription; explain resolves
    // old names through rename history, so this query works in both eras.
    expect(r.error).toBeUndefined();
    expect(r.provenance).toContain('elicited');
    expect(r.witnesses.map((w: any) => w.id)).toContain('w5');
    expect(r.witnesses.find((w: any) => w.id === 'w5').judge).toBe('forbid');
    expect(r.english.toLowerCase()).toContain('one');
  });

  it('explains implied invariants by their deriving structure', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'terminalInvoiceSettlementVoid'], realDeps);
    expect(r.implied).toContain('@terminal');
  });

  it('derived-name query for a template-era invariant carries template provenance and a non-empty rename chain (multi-hop lineage)', async () => {
    // terminalInvoiceSettlementVoid was template-adopted as Terminal_Invoice_void (pre-migration);
    // the fix-3 ledger join records that lineage as a rename entry, so querying under the CURRENT
    // derived name must still resolve the original template provenance — not just 'implied by structure'.
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'terminalInvoiceSettlementVoid'], realDeps);
    expect(r.error).toBeUndefined();
    expect(r.provenance).toContain('template tpl-3-Invoice-void');
    expect(r.implied).toContain('@terminal');
    expect(r.renames.length).toBeGreaterThan(0);
    expect(r.renames.some((x: any) => x.from === 'Terminal_Invoice_void' && x.to === 'terminalInvoiceSettlementVoid')).toBe(true);

    // and the OLD template-era name still resolves to the same current identity (both directions)
    const rOld: any = await runCommand(['explain', '--session', SESSION, '--name', 'Terminal_Invoice_void'], realDeps);
    expect(rOld.name).toBe('terminalInvoiceSettlementVoid');
    expect(rOld.provenance).toContain('template tpl-3-Invoice-void');
  });

  it('unknown name errors cleanly', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'nope'], realDeps);
    expect(r.error).toBe('unknown-invariant');
  });

  it('surfaces verdict/tier from a classify run (Task 3: classified ledger merged into explain)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-explain-classify-'));
    const modelFile = join(dir, 'm.json');
    writeFileSync(modelFile, JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], inertDeps);
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    const h1 = st.candidates.find((c: any) => c.inv.id === 'H1');
    h1.status = 'adopted';
    writeFileSync(stateFile, JSON.stringify(st));
    // explain's `current` resolution walks `adopted` ledger entries.
    appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: h1.inv, provenance: 'test' }) + '\n');

    // [consecution=holds, reachability=clean] -> entailed
    await runCommand(['classify', '--session', dir, '--name', 'h1'], scriptedDeps([{ violated: false }, { violated: false }]));

    const r: any = await runCommand(['explain', '--session', dir, '--name', 'h1'], inertDeps);
    expect(r.classification.verdict).toBe('entailed');
    expect(r.classification.tier).toBe('sound');
  });
});
