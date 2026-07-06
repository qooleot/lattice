import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = (args: string[]) => {
  try {
    execFileSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: join(import.meta.dirname, '..'), stdio: 'pipe' });
    return 0;
  } catch (e: any) { return e.status as number; }
};

describe('CLI exit codes (design §5.8)', () => {
  it('refusal/diagnostic errors exit 1', () => {
    expect(run(['status'])).toBe(1);   // missing --session → {error:'missing-arg'}
  });
  it('success exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-'));
    expect(run(['status', '--session', dir])).toBe(0);
  });
}, 60000);
