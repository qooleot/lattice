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
});
