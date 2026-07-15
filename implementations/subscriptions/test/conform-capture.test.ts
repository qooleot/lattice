import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from './support.js';
import { createSubscription } from '../src/subscription-service.js';

const snapDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.conform', 'snapshots');

describe('conform capture', () => {
  it('a test that opens a db leaves a raw snapshot behind after teardown', () => {
    const db = makeDb();
    createSubscription(db, { id: 's', planCode: 'p', seats: 1, periodStart: 1, periodEnd: 2, licenseFeeAmount: 100 });
    // capture happens in afterEach — assert on artifacts from PREVIOUS tests instead:
    // this file runs two cases; the second sees the first's snapshot.
    expect(true).toBe(true);
  });

  it('previous test produced a .sqlite snapshot + .json meta', () => {
    expect(existsSync(snapDir)).toBe(true);
    const files = readdirSync(snapDir);
    expect(files.some(f => f.endsWith('.sqlite'))).toBe(true);
    expect(files.some(f => f.endsWith('.json'))).toBe(true);
  });
});
