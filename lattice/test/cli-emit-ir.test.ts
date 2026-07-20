import { describe, it, expect } from 'vitest';
import { runCommand } from '../src/cli.js';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The `emit-ir` command — exports the versioned, language-neutral IR (src/ir/schema.ts) as JSON.
// Mirrors test/cli-codegen.test.ts's e2e shape: drives the CLI end to end via a temp `.lat` spec,
// minus the `--lang` check (the IR has no per-language target).

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

function writeSpec(contents: string, name = 'spec.lat'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-emit-ir-spec-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('emit-ir command', () => {
  it('emits a versioned IR JSON for a rich spec', async () => {
    const spec = writeSpec(RICH_SPEC);
    const out = mkdtempSync(join(tmpdir(), 'cli-emit-ir-out-'));
    const res: any = await runCommand(['emit-ir', '--spec', spec, '--out', out], {} as any);
    expect(res.error).toBeUndefined();
    const path = join(out, 'ir.json');
    expect(existsSync(path)).toBe(true);
    const ir = JSON.parse(readFileSync(path, 'utf8'));
    expect(ir.irVersion).toBe('1');
    expect(ir.context).toBe('Rich');
    expect(ir.aggregates.some((a: any) => a.name === 'Ledger')).toBe(true);
    expect(ir.enums.some((e: any) => e.name === 'Mode')).toBe(true);
    expect(ir.values.some((v: any) => v.name === 'Amount')).toBe(true);
    expect(res.written).toEqual([path]);
  });

  it('honors an --out path ending in .json as the exact file', async () => {
    const spec = writeSpec(RICH_SPEC);
    const dir = mkdtempSync(join(tmpdir(), 'cli-emit-ir-file-'));
    const file = join(dir, 'ledger.ir.json');
    const res: any = await runCommand(['emit-ir', '--spec', spec, '--out', file], {} as any);
    expect(res.error).toBeUndefined();
    expect(existsSync(file)).toBe(true);
    expect(res.written).toEqual([file]);
  });

  it('requires --out', async () => {
    const spec = writeSpec(RICH_SPEC);
    const res: any = await runCommand(['emit-ir', '--spec', spec], {} as any);
    expect(res.error).toBe('missing-arg');
    expect(res.arg).toBe('out');
  });

  it('requires either --session or --spec', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cli-emit-ir-none-'));
    const res: any = await runCommand(['emit-ir', '--out', out], {} as any);
    expect(res.error).toBe('missing-arg');
  });

  it('refuses --session together with --spec', async () => {
    const spec = writeSpec(RICH_SPEC);
    const out = mkdtempSync(join(tmpdir(), 'cli-emit-ir-both-'));
    const res: any = await runCommand(['emit-ir', '--session', out, '--spec', spec, '--out', out], {} as any);
    expect(res.error).toBe('invalid-args');
  });

  it('refuses a spec with a derived-name collision (ill-formed-model)', async () => {
    const spec = writeSpec(`context C {
  value Amount { amount : Money }
  aggregate Bill {
    billId      : Id key
    totalAmount : Money
    total       : Amount
  }
}
`);
    const out = mkdtempSync(join(tmpdir(), 'cli-emit-ir-collide-'));
    const res: any = await runCommand(['emit-ir', '--spec', spec, '--out', out], {} as any);
    expect(res.error).toBe('ill-formed-model');
  });

  // Drift guard: test/fixtures/ir/abstract.lat is a small, abstract spec covering value+invariant,
  // enum+payload, aggregate+machine, service+method, builtin, and optional/list/map/generic/union/
  // carrier fields. Its emitted IR is compared against a checked-in golden. To regenerate the golden
  // after an intentional IR shape change: run
  //   npx tsx src/cli.ts emit-ir --spec test/fixtures/ir/abstract.lat --out test/fixtures/ir/abstract.ir.json
  // from the repo root and commit the resulting file.
  it('matches the checked-in golden IR for the abstract fixture', async () => {
    const specPath = join(__dirname, 'fixtures', 'ir', 'abstract.lat');
    const goldenPath = join(__dirname, 'fixtures', 'ir', 'abstract.ir.json');
    const out = mkdtempSync(join(tmpdir(), 'cli-emit-ir-golden-'));
    const res: any = await runCommand(['emit-ir', '--spec', specPath, '--out', out], {} as any);
    expect(res.error).toBeUndefined();
    const produced = JSON.parse(readFileSync(join(out, 'ir.json'), 'utf8'));
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
    expect(produced).toEqual(golden);
  });
});
