import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateService } from './generate.js';
import { loadGenInput, loadGenInputFromLat } from './load.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const sessionDir = join(repoRoot, '.lattice-session-subscriptions');
const specLatPath = join(repoRoot, 'specs/subscriptions/spec.lat');

// The point of the seam (task brief): `.lat` is the spec's source of truth (slice-3 decision), and
// generation must be able to read it directly instead of only the session store. This test pins
// that guarantee against the COMMITTED subscriptions artifacts — if `emit`/`apply` ever let the
// session and spec.lat drift, or if the two loaders disagree on how to resolve model/invariants/
// provenance, this is where it breaks.
describe('loadGenInput vs loadGenInputFromLat: generated-output equivalence', () => {
  it('produces byte-identical generated trees from the session store and from spec.lat', () => {
    const viaSession = loadGenInput(sessionDir);
    const viaLat = loadGenInputFromLat(specLatPath, sessionDir);

    const a = mkdtempSync(join(tmpdir(), 'lat-eq-session-'));
    const b = mkdtempSync(join(tmpdir(), 'lat-eq-lat-'));
    generateService(viaSession, a);
    generateService(viaLat, b);

    const filesA = readdirSync(a).sort();
    const filesB = readdirSync(b).sort();
    expect(filesB).toEqual(filesA);
    for (const f of filesA) expect(readFileSync(join(b, f), 'utf8'), f).toBe(readFileSync(join(a, f), 'utf8'));
  });
});
