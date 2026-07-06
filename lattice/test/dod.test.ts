import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, realDeps } from '../src/cli.js';
import { loadLatText } from '../src/parse/fromLangium.js';

const SESSION_SRC = join(import.meta.dirname, '../../.lattice-session-subscriptions');
const SPEC_SRC = join(import.meta.dirname, '../../specs/subscriptions');

describe('definition of done (brief): rename + new transition + contradicting invariant edit', () => {
  it('applies the first two with provenance, rejects the third naming witness+verdict, re-renders projections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-dod-'));
    const sessionDir = join(dir, 'session'); const specDir = join(dir, 'spec');
    cpSync(SESSION_SRC, sessionDir, { recursive: true });
    cpSync(SPEC_SRC, specDir, { recursive: true });
    const lat = join(specDir, 'spec.lat');
    const original = readFileSync(lat, 'utf8');

    // Edit 1 (rename): accruedUnits → usedUnits (ledger-referenced field)
    // Edit 2 (new transition): pastDue → expired grace exhaustion
    // Edit 3 (invariant change contradicting w5): unique by (totalDue) instead of by (subscription)
    // (totalDue distinguishes w5's two draft invoices; key fields like invoiceId are witness-invisible → always-forbid)
    const edited = original
      .replaceAll('accruedUnits', 'usedUnits')
      .replace('transition recover { region lifecycle; from pastDue to active }',
        'transition recover { region lifecycle; from pastDue to active }\n      transition graceToExpired { region lifecycle; from pastDue to expired }')
      .replace('unique while settlement in {draft} by (subscription)',
        'unique while settlement in {draft} by (totalDue)');   // totalDue is witness-visible; key fields are not (Task 9 finding)
    writeFileSync(lat, edited);

    // The contradicting edit must be rejected — atomically: nothing applies
    const r1: any = await runCommand(['apply', '--session', sessionDir, '--lat', lat,
      '--rename', 'Subscription.accruedUnits=usedUnits'], realDeps);
    expect(r1.error).toBe('refused');
    const contradiction = r1.refusals.find((x: any) => x.code === 'contradicts-verdict');
    expect(contradiction.witnessId).toBe('w5');
    expect(contradiction.verdict).toBe('forbid');
    expect(contradiction.judgedAt).toContain('2026-07-05');
    expect(contradiction.message).toContain('re-judge with the domain expert or revert');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8'))
      .toBe(readFileSync(join(SESSION_SRC, 'ledger.jsonl'), 'utf8'));   // atomic: no appends

    // Revert edit 3; the rename + transition now apply with provenance
    writeFileSync(lat, edited.replace('by (totalDue)', 'by (subscription)'));
    const r2: any = await runCommand(['apply', '--session', sessionDir, '--lat', lat,
      '--rename', 'Subscription.accruedUnits=usedUnits'], realDeps);
    expect(r2.ok).toBe(true);
    expect(r2.applied.join(' ')).toContain('graceToExpired');
    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"rename"');
    expect(ledger).toContain('usedUnits');

    // every projection re-renders from the updated canonical store
    const normalized = readFileSync(lat, 'utf8');
    expect(normalized).toContain('usedUnits');
    expect(normalized).toContain('graceToExpired');
    expect(readFileSync(join(specDir, 'spec.prose.md'), 'utf8')).toContain('graceToExpired');

    // round-trip identity holds on the result
    const reparsed = loadLatText(normalized);
    expect(reparsed.ok).toBe(true);

    // and the ledger history remains queryable across the rename
    const ex: any = await runCommand(['explain', '--session', sessionDir, '--name', 'positivePeriodNonNegativeUsage'], realDeps);
    expect(ex.witnesses.length).toBeGreaterThan(0);
  }, 60000);
});
