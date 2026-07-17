import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateService } from './generate.js';
import { renderInvariants } from './render/invariants.js';
import { renderCommands } from './render/commands.js';
import { buildPlan } from './plan.js';
import { tinyInput } from './fixtures.js';
import type { GenInput } from './types.js';
import type { LedgerEntry } from '../engine/session.js';

// Cribbed from fixtures.ts's tinyInput/tableInput shape, extended with a ref field ('method' ->
// Method) so Payment's ONLY multi-segment path is inside a present() predicate — no cmp/inState
// term reaches through the ref. This proves present() alone (not some other predicate kind)
// triggers flattenForChecks registration in commands.ts's multiSegmentPaths/walkPred.
const presentOnlyHopInput: GenInput = {
  model: {
    context: 'Pay', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [
      {
        kind: 'aggregate', name: 'Payment',
        fields: [
          { name: 'paymentId', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'method', type: { kind: 'ref', target: 'Method' } },
        ],
        machine: {
          regions: [{ name: 'status', initial: 'pending', states: [
            { name: 'pending', tags: [] }, { name: 'settled', tags: [] }] }],
          transitions: [{ name: 'settle', region: 'status', from: ['pending'], to: 'settled' }],
        },
      },
      {
        kind: 'aggregate', name: 'Method',
        fields: [
          { name: 'methodId', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'fee', type: { kind: 'prim', prim: 'Int' } },
        ],
      },
    ],
  },
  adopted: [{
    id: 'inv-methodfee', name: 'methodFeePresent', prior: 1, source: 'seed',
    candidate: { kind: 'statePredicate', aggregate: 'Payment',
      body: { kind: 'present', path: ['method', 'fee'] } },
  }],
  ledger: [
    { kind: 'adopted', at: '2026-01-01', invariant: { id: 'inv-methodfee', name: 'methodFeePresent', prior: 1, source: 'seed',
        candidate: { kind: 'statePredicate', aggregate: 'Payment',
          body: { kind: 'present', path: ['method', 'fee'] } } },
      provenance: 'seed:template' } as LedgerEntry,
  ],
};

const planWithPresentOnlyHop = buildPlan(presentOnlyHopInput);

describe('generateService', () => {
  it('writes a full package tree into a clean dir', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-'));
    const written = generateService(tinyInput, out);
    for (const f of ['types.ts', 'invariants.ts', 'repo.ts', 'commands.ts', 'schema.sql', 'package.json', 'tsconfig.json', 'db.ts'])
      expect(existsSync(join(out, f)), f).toBe(true);
    expect(written.length).toBeGreaterThan(0);
    expect(readFileSync(join(out, 'package.json'), 'utf8')).toContain('better-sqlite3');
  });

  it('returns a sorted list of written paths', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-'));
    const written = generateService(tinyInput, out);
    const sorted = [...written].sort();
    expect(written).toEqual(sorted);
  });

  it('clean-dir wipes stale files from a previous generation', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-'));
    generateService(tinyInput, out);
    // simulate a stale leftover file from a prior generation (e.g. a renamed/removed artifact)
    const stalePath = join(out, 'stale-leftover.txt');
    writeFileSync(stalePath, 'stale');
    generateService(tinyInput, out);
    expect(existsSync(stalePath)).toBe(false);
  });

  it('declares type: module and the test/typecheck scripts in package.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-'));
    generateService(tinyInput, out);
    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    expect(pkg.dependencies['better-sqlite3']).toBeDefined();
  });

  it('writes a .gitignore covering npm/install and demo-db artifacts', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-'));
    generateService(tinyInput, out);
    const gitignorePath = join(out, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const gitignore = readFileSync(gitignorePath, 'utf8');
    expect(gitignore).toContain('package-lock.json');
    expect(gitignore).toContain('node_modules/');
  });

  it('renders invariants as exported, provenance-commented checks', () => {
    const src = renderInvariants(buildPlan(tinyInput));
    expect(src).toMatch(/\/\/ spec: invariant nonNegativeBalance/);
    expect(src).toMatch(/export function checkNonNegativeBalance/);
    expect(src).toContain('row.balance >= 0');
  });

  it('a present()-only ref hop still triggers flattenForChecks', () => {
    const src = renderCommands(planWithPresentOnlyHop);
    expect(src).toContain('flattenForChecks');
  });
});
