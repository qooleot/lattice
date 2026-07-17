import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGenInput, loadGenInputFromLat, LatParseFailure, LatModelInvalid } from './load.js';
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

// Carried finding #1: derivedNameCollisions gated init and apply but NOT this loader, which reaches
// impliedInvariants via plan.ts's canonicalSet -> reconcile.ts. The unguarded door is the one that
// emits runtime check code — one check where two rules were meant.
describe('loadGenInputFromLat refuses a spec whose derived names collide', () => {
  // `totalAmount : Money` and `total : Amount{amount : Money}` both fold onto the single derived
  // name nonNegativeInvoiceTotalAmount — the same shape test/cli-apply.test.ts pins for `apply`.
  const COLLIDING_LAT = `context L {
  value Amount {
    amount : Money
  }
  aggregate Invoice {
    invId : Id key
    totalAmount : Money @unsigned
    total : Amount @unsigned
  }
}
`;
  const writeSpec = (text: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'load-collide-')), 'spec.lat');
    writeFileSync(path, text);
    return path;
  };

  it('throws LatModelInvalid — not LatParseFailure — carrying the collision diagnostic', () => {
    let caught: unknown;
    try { loadGenInputFromLat(writeSpec(COLLIDING_LAT)); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LatModelInvalid);
    // Distinguishes the two failure modes: a collision is not a parse failure, and reporting it as
    // one would give a single condition two codes depending on the door it came through.
    expect(caught).not.toBeInstanceOf(LatParseFailure);
    const d = (caught as LatModelInvalid).diagnostics.find(x => x.code === 'derived-name-collision');
    expect(d).toBeDefined();
    expect(d!.at).toBe('Invoice');
    expect(d!.message).toContain('nonNegativeInvoiceTotalAmount');
  });

  it('still loads the same spec once the collision is removed', () => {
    // Pins the refusal to the COLLISION and not to anything else about this spec: drop the
    // colliding field and the identical loader call succeeds.
    const clean = COLLIDING_LAT.replace('    totalAmount : Money @unsigned\n', '');
    const input = loadGenInputFromLat(writeSpec(clean));
    expect(input.model.context).toBe('L');
  });
});
