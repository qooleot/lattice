import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';

const SESSION = join(import.meta.dirname, '../../.lattice-session-subscriptions');

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

  it('unknown name errors cleanly', async () => {
    const r: any = await runCommand(['explain', '--session', SESSION, '--name', 'nope'], realDeps);
    expect(r.error).toBe('unknown-invariant');
  });
});
