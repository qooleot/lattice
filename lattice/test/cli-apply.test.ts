import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, realDeps } from '../src/cli.js';

const SESSION_SRC = join(import.meta.dirname, '../../.lattice-session-subscriptions');

// NOTE: these tests run AFTER Task 12's migration in plan order, but they are written to be
// order-independent: they regenerate the .lat from the session model via `emit` first, so they
// never depend on the committed spec.lat's naming era.
let dir: string, sessionDir: string, specDir: string, latFile: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lat-apply-'));
  sessionDir = join(dir, 'session');
  specDir = join(dir, 'spec');
  cpSync(SESSION_SRC, sessionDir, { recursive: true });
  mkdirSync(specDir, { recursive: true });
  const r: any = await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
  expect(r.written).toBeDefined();
  latFile = join(specDir, 'spec.lat');
});

const apply = (extra: string[] = []) =>
  runCommand(['apply', '--session', sessionDir, '--lat', latFile, ...extra], realDeps);

describe('engine apply', () => {
  it('no-op apply succeeds and is idempotent on the normalized file', async () => {
    const before = readFileSync(latFile, 'utf8');
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(readFileSync(latFile, 'utf8')).toBe(before);
    expect(existsSync(join(specDir, 'spec.prose.md'))).toBe(true);

    // diagrams are projections too: writeProjections also writes spec.diagrams.md + .mmd files
    const diagramsMd = join(specDir, 'spec.diagrams.md');
    const cdMmd = join(specDir, 'diagrams', 'CD_Subscriptions.mmd');
    expect(r.written).toContain(diagramsMd);
    expect(r.written).toContain(cdMmd);
    expect(existsSync(diagramsMd)).toBe(true);
    expect(existsSync(cdMmd)).toBe(true);
    // both member aggregates (Subscription/lifecycle, Invoice/settlement) get their own SD file
    const sdSubscription = join(specDir, 'diagrams', 'SD_Subscription_lifecycle.mmd');
    const sdInvoice = join(specDir, 'diagrams', 'SD_Invoice_settlement.mmd');
    expect(r.written).toContain(sdSubscription);
    expect(r.written).toContain(sdInvoice);
    expect(existsSync(sdSubscription)).toBe(true);
    expect(existsSync(sdInvoice)).toBe(true);
  });

  it('parse errors refuse and write nothing', async () => {
    const before = readFileSync(latFile, 'utf8');
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    writeFileSync(latFile, before + '\n// stray comment\n');
    const r: any = await apply();
    expect(r.error).toBe('parse-failed');
    expect(r.diagnostics[0]!.code).toBe('comment-banned');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });

  it('applying a contextMap file refuses as wrong-file-kind', async () => {
    writeFileSync(latFile, 'contextMap Acme {\n  contains Billing\n}\n');
    const r: any = await apply();
    expect(r.error).toBe('parse-failed');
    expect(r.diagnostics.some((d: any) => d.code === 'wrong-file-kind')).toBe(true);
  });

  it('new transition applies with provenance-free structural note', async () => {
    const text = readFileSync(latFile, 'utf8')
      .replace('transition recover { region lifecycle; from pastDue to active }',
        'transition recover { region lifecycle; from pastDue to active }\n      transition graceToExpired { region lifecycle; from pastDue to expired }');
    writeFileSync(latFile, text);
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(r.applied.join(' ')).toContain('graceToExpired');
    expect(readFileSync(latFile, 'utf8')).toContain('graceToExpired');
    const model = JSON.parse(readFileSync(join(sessionDir, 'model.json'), 'utf8'));
    expect(JSON.stringify(model)).toContain('graceToExpired');
  });

  it('ledger-referenced field rename refuses without the flag, applies with it', async () => {
    const renamed = readFileSync(latFile, 'utf8').replaceAll('accruedUnits', 'usedUnits');
    writeFileSync(latFile, renamed);
    const r1: any = await apply();
    expect(r1.error).toBe('refused');
    expect(JSON.stringify(r1.refusals)).toContain('--rename Subscription.accruedUnits=usedUnits');
    const r2: any = await apply(['--rename', 'Subscription.accruedUnits=usedUnits']);
    expect(r2.ok).toBe(true);
    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"rename"');
    // append-only: original first line untouched
    expect(ledger.split('\n')[0]).toContain('"kind":"structure"');
  });

  it('invariant edit contradicting a judged forbid case is rejected naming the witness', async () => {
    // w5 is forbidden ONLY by the one-draft-per-subscription unique rule (see plan preamble analysis).
    // NOTE: `invoiceId` is a `key`-tagged field (spec P-key semantics; see src/emit/alloy.ts:32,
    // src/emit/quint.ts:26): solver-generated witnesses never populate key fields because the
    // entity's own atom identity already carries that role, so `by (invoiceId)` would resolve to
    // `undefined` for every subject and evaluate as a vacuous (always-forbid) uniqueness key —
    // it can never demonstrate a permit-flip for ANY witness. `totalDue` is a real witness-visible
    // field that differs between the two draft invoices in w5 (14 vs 15), so grouping by it
    // genuinely distinguishes them and flips the invariant to permit, which is what this test needs.
    const text = readFileSync(latFile, 'utf8')
      .replace('unique while settlement in {draft} by (subscription)',
        'unique while settlement in {draft} by (totalDue)');
    writeFileSync(latFile, text);
    const r: any = await apply();
    expect(r.error).toBe('refused');
    const f = r.refusals.find((x: any) => x.code === 'contradicts-verdict');
    expect(f.witnessId).toBe('w5');
    expect(f.verdict).toBe('forbid');
    expect(f.message).toContain('re-judge');
  });

  it('session mid-flight refuses', async () => {
    const state = JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8'));
    state.phase = 'distinguish';
    writeFileSync(join(sessionDir, 'state.json'), JSON.stringify(state));
    const r: any = await apply();
    expect(r.error).toBe('session-busy');
  });

  it('missing session dir hand-authors a fresh one', async () => {
    const fresh = join(dir, 'fresh-session');
    const r: any = await runCommand(['apply', '--session', fresh, '--lat', latFile], realDeps);
    expect(r.ok).toBe(true);
    const ledger = readFileSync(join(fresh, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('hand-authored');
    const state = JSON.parse(readFileSync(join(fresh, 'state.json'), 'utf8'));
    expect(state.phase).toBe('converged');
  });

  it('--dry-run reports and writes nothing', async () => {
    const text = readFileSync(latFile, 'utf8')
      .replace('transition recover { region lifecycle; from pastDue to active }',
        'transition recover { region lifecycle; from pastDue to active }\n      transition graceToExpired { region lifecycle; from pastDue to expired }');
    writeFileSync(latFile, text);
    const modelBefore = readFileSync(join(sessionDir, 'model.json'), 'utf8');
    const r: any = await apply(['--dry-run']);
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(readFileSync(join(sessionDir, 'model.json'), 'utf8')).toBe(modelBefore);
  });

  it('typo in --rename bare name errors instead of silently ledgering', async () => {
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    const r: any = await apply(['--rename', 'noSuchInvariant=whatever']);
    expect(r.error).toBe('unknown-rename-path');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });

  it('unmatched --rename confirmation on an unchanged file refuses without poisoning the ledger', async () => {
    // the .lat is applied UNCHANGED — accruedUnits is still called accruedUnits, so this --rename
    // does not correspond to any detected rename proposal and must be refused, not ledgered.
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    const r: any = await apply(['--rename', 'Subscription.accruedUnits=usedUnits']);
    expect(r.error).toBe('refused');
    expect(JSON.stringify(r.refusals)).toContain('unmatched-rename-confirmation');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });
});

describe('engine apply: workspace context-map hook', () => {
  const MAP = `contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    exposes Plan
  }
}
`;
  const CATALOG_SPEC = `context Catalog {
  entity Plan {
    planId : Id key
    name : Text
  }
}
`;
  const SUBSCRIPTIONS_SPEC = `context Subscriptions {
  aggregate Subscription {
    subId : Id key
    plan : ref Catalog.Plan
  }
}
`;

  const writeMember = (wsDir: string, path: string, text: string) => {
    mkdirSync(join(wsDir, path), { recursive: true });
    writeFileSync(join(wsDir, path, 'spec.lat'), text);
  };

  it('apply inside a workspace attaches workspace.written', async () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'lat-apply-ws-'));
    writeFileSync(join(wsDir, 'context-map.lat'), MAP);
    writeMember(wsDir, 'catalog', CATALOG_SPEC);
    writeMember(wsDir, 'subscriptions', SUBSCRIPTIONS_SPEC);

    const fresh = join(wsDir, 'catalog-session');
    const r: any = await runCommand(
      ['apply', '--session', fresh, '--lat', join(wsDir, 'catalog', 'spec.lat')], realDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.workspace).toBeDefined();
    expect(r.workspace.written).toBeDefined();
    expect(r.workspace.diagnostics).toBeUndefined();
    expect(existsSync(join(wsDir, 'context-map.generated.md'))).toBe(true);
  });

  it('apply with a broken sibling member: ok:true AND workspace.diagnostics non-empty', async () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'lat-apply-ws-broken-'));
    writeFileSync(join(wsDir, 'context-map.lat'), MAP);
    writeMember(wsDir, 'catalog', CATALOG_SPEC);
    // subscriptions member spec.lat intentionally absent -> sibling is broken

    const fresh = join(wsDir, 'catalog-session');
    const r: any = await runCommand(
      ['apply', '--session', fresh, '--lat', join(wsDir, 'catalog', 'spec.lat')], realDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.workspace).toBeDefined();
    expect(r.workspace.diagnostics).toBeDefined();
    expect(r.workspace.diagnostics.length).toBeGreaterThan(0);
    expect(r.workspace.written).toBeUndefined();
  });

  it('apply outside any workspace has no workspace key', async () => {
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(r.workspace).toBeUndefined();
  });
});
