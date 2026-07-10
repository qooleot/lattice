import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateService } from './generate.js';
import { loadGenInput } from './load.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('determinism', () => {
  it('produces byte-identical output across two runs from the same input', () => {
    const input = loadGenInput(join(repoRoot, '.lattice-session-subscriptions'));
    const a = mkdtempSync(join(tmpdir(), 'det-a-')), b = mkdtempSync(join(tmpdir(), 'det-b-'));
    generateService(input, a); generateService(input, b);
    const files = readdirSync(a).sort();
    for (const f of files) expect(readFileSync(join(b, f), 'utf8'), f).toBe(readFileSync(join(a, f), 'utf8'));
  });
});
