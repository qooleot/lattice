import { describe, it, expect } from 'vitest';
import { runCommand } from '../src/cli.js';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Slice 3: the `codegen` command — the faithful full-model TS type emitter. It bypasses the SQLite
// reference service, so it succeeds on a RICH spec (values/maps/unions/carriers) that `generate`
// cannot emit. Tests drive the CLI end to end via a temp `.lat` spec.

const RICH_SPEC = `context Rich {
  builtin Metadata
  enum Mode { fast, slow }
  value Amount { amount : Money  currency : Text }
  aggregate Ledger {
    ledgerId : Id key
    meta     : Metadata
    mode     : Mode
    approved : Optional<Money>
    balances : Map<Id, Amount>
  }
}
`;

function writeSpec(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-codegen-spec-'));
  const path = join(dir, 'spec.lat');
  writeFileSync(path, contents);
  return path;
}

describe('codegen command', () => {
  it('emits faithful TS types for a rich spec (that the SQLite service could not)', async () => {
    const spec = writeSpec(RICH_SPEC);
    const out = mkdtempSync(join(tmpdir(), 'cli-codegen-out-'));
    const res: any = await runCommand(['codegen', '--spec', spec, '--out', out], {} as any);
    expect(res.error).toBeUndefined();
    const path = join(out, 'types.ts');
    expect(existsSync(path)).toBe(true);
    const ts = readFileSync(path, 'utf8');
    expect(ts).toContain('export interface Ledger {');
    expect(ts).toContain('export type Metadata = unknown;');
    expect(ts).toContain('  balances: Record<string, Amount>;');
    expect(ts).toContain('  approved?: number;');
    expect(res.written).toEqual([path]);
  });

  it('honors an --out path ending in .ts as the exact file', async () => {
    const spec = writeSpec(RICH_SPEC);
    const dir = mkdtempSync(join(tmpdir(), 'cli-codegen-file-'));
    const file = join(dir, 'ledger.types.ts');
    const res: any = await runCommand(['codegen', '--spec', spec, '--out', file], {} as any);
    expect(res.error).toBeUndefined();
    expect(existsSync(file)).toBe(true);
    expect(res.written).toEqual([file]);
  });

  it('requires --out', async () => {
    const spec = writeSpec(RICH_SPEC);
    const res: any = await runCommand(['codegen', '--spec', spec], {} as any);
    expect(res.error).toBe('missing-arg');
  });

  it('requires either --session or --spec', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cli-codegen-none-'));
    const res: any = await runCommand(['codegen', '--out', out], {} as any);
    expect(res.error).toBe('missing-arg');
  });

  it('refuses --session together with --spec', async () => {
    const spec = writeSpec(RICH_SPEC);
    const out = mkdtempSync(join(tmpdir(), 'cli-codegen-both-'));
    const res: any = await runCommand(['codegen', '--session', out, '--spec', spec, '--out', out], {} as any);
    expect(res.error).toBe('invalid-args');
  });

  it('rejects an unsupported --lang', async () => {
    const spec = writeSpec(RICH_SPEC);
    const out = mkdtempSync(join(tmpdir(), 'cli-codegen-lang-'));
    const res: any = await runCommand(['codegen', '--spec', spec, '--out', out, '--lang', 'ruby'], {} as any);
    expect(res.error).toBe('invalid-args');
  });

  it('refuses a spec with a derived-name collision (ill-formed-model), writing nothing', async () => {
    // two Money fields whose derived non-negative names collapse onto one — the same gate `generate`
    // enforces, inherited via loadGenInputFromLat.
    const spec = writeSpec(`context C {
  value Amount { amount : Money }
  aggregate Bill {
    billId      : Id key
    totalAmount : Money
    total       : Amount
  }
}
`);
    const out = mkdtempSync(join(tmpdir(), 'cli-codegen-collide-'));
    const res: any = await runCommand(['codegen', '--spec', spec, '--out', out], {} as any);
    expect(res.error).toBe('ill-formed-model');
    expect(readdirSync(out)).toEqual([]);
  });
});
