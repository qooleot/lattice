import { describe, it, expect } from 'vitest';
import { runCommand } from '../cli.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('generate command', () => {
  it('generates a package from the subscriptions session', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cli-gen-'));
    const res: any = await runCommand(
      ['generate', '--session', join(repoRoot, '.lattice-session-subscriptions'), '--out', out],
      {} as any); // generate needs no solvers
    expect(res.error).toBeUndefined();
    expect(existsSync(join(out, 'commands.ts'))).toBe(true);
    expect(res.written.length).toBeGreaterThan(0);
  });

  it('generates a package from --spec spec.lat with --ledger for provenance', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cli-gen-lat-'));
    const res: any = await runCommand(
      ['generate', '--spec', join(repoRoot, 'specs/subscriptions/spec.lat'),
        '--ledger', join(repoRoot, '.lattice-session-subscriptions'), '--out', out],
      {} as any);
    expect(res.error).toBeUndefined();
    expect(existsSync(join(out, 'commands.ts'))).toBe(true);
    expect(res.written.length).toBeGreaterThan(0);
  });

  it('refuses --session together with --spec as invalid-args', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cli-gen-bad-'));
    const res: any = await runCommand(
      ['generate', '--session', join(repoRoot, '.lattice-session-subscriptions'),
        '--spec', join(repoRoot, 'specs/subscriptions/spec.lat'), '--out', out],
      {} as any);
    expect(res.error).toBe('invalid-args');
  });

  it('requires either --session or --spec', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cli-gen-none-'));
    const res: any = await runCommand(['generate', '--out', out], {} as any);
    expect(res.error).toBe('missing-arg');
  });
});
