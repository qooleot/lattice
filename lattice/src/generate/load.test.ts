import { describe, it, expect } from 'vitest';
import { loadGenInput } from './load.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const sessionDir = join(repoRoot, '.lattice-session-subscriptions');

describe('loadGenInput', () => {
  it('loads model, adopted invariants, and ledger from the session store', () => {
    const input = loadGenInput(sessionDir);
    expect(input.model.context).toBe('Subscriptions');
    expect(input.adopted.length).toBeGreaterThan(0);
    // every adopted item is a CandidateInvariant with a name + candidate
    expect(input.adopted.every(i => typeof i.name === 'string' && !!i.candidate)).toBe(true);
    // ledger carries the anchoring entries
    expect(input.ledger.some(e => e.kind === 'adopted')).toBe(true);
    expect(input.ledger.some(e => e.kind === 'verdict')).toBe(true);
  });
});
