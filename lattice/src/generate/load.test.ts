import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGenInput, loadGenInputFromLat, LatParseFailure } from './load.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const sessionDir = join(repoRoot, '.lattice-session-subscriptions');
const specLatPath = join(repoRoot, 'specs/subscriptions/spec.lat');

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

describe('loadGenInputFromLat', () => {
  it('loads model + invariants by parsing spec.lat directly, ledger from the session', () => {
    const input = loadGenInputFromLat(specLatPath, sessionDir);
    expect(input.model.context).toBe('Subscriptions');
    expect(input.adopted.length).toBeGreaterThan(0);
    expect(input.adopted.every(i => typeof i.name === 'string' && !!i.candidate)).toBe(true);
    expect(input.ledger.some(e => e.kind === 'adopted')).toBe(true);
    expect(input.ledger.some(e => e.kind === 'verdict')).toBe(true);
  });

  it('rehydrates parsed invariants to the session\'s stable ledger ids by name', () => {
    const viaSession = loadGenInput(sessionDir);
    const viaLat = loadGenInputFromLat(specLatPath, sessionDir);
    const idsByName = new Map(viaSession.adopted.map(i => [i.name, i.id]));
    for (const inv of viaLat.adopted) expect(inv.id, inv.name).toBe(idsByName.get(inv.name));
  });

  it('with no ledgerDir, generates with hand-authored "from .lat (no ledger)" provenance', () => {
    const input = loadGenInputFromLat(specLatPath);
    expect(input.model.context).toBe('Subscriptions');
    expect(input.adopted.length).toBeGreaterThan(0);
    expect(input.ledger.length).toBe(input.adopted.length);
    expect(input.ledger.every(e => e.kind === 'adopted' && e.provenance === 'from .lat (no ledger)')).toBe(true);
  });

  it('returns structured diagnostics (never a raw throw) on a garbage .lat file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-lat-'));
    const badPath = join(dir, 'spec.lat');
    writeFileSync(badPath, 'this is not a valid .lat file {{{');
    let caught: unknown;
    try { loadGenInputFromLat(badPath); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LatParseFailure);
    const failure = caught as LatParseFailure;
    expect(failure.diagnostics.length).toBeGreaterThan(0);
    expect(failure.diagnostics.every(d => typeof d.code === 'string' && typeof d.message === 'string')).toBe(true);
  });
});
