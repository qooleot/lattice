import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, realDeps } from '../src/cli.js';

// The "does the real committed shape survive the real solver path" gate (fixture tests can't give
// this): test/cli-classify.test.ts exercises `classify` with a SCRIPTED quintVerify — it can never
// notice that an emission is malformed quint, because the fake dependency never runs a real solver
// over it. This test runs `classify --name` with realDeps (real quint/Apalache) against a scratch
// copy of the COMMITTED `.lattice-session-subscriptions` session — the same session whose
// `Subscription.plan : ref Catalog.Plan` field crashed classify pre-fix (QNT404). Kept to `--name`
// (one adopted invariant, 2 probes: consecution + reachability) rather than bulk classify, so it
// stays an affordable real-shape smoke rather than a full-session solver sweep.
const SESSION_SRC = join(import.meta.dirname, '../../.lattice-session-subscriptions');

describe('classify --name (integration, real quint/Apalache) on the committed real session', () => {
  it('runs to completion on the real committed session — no crash, returns a classified array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-classify-int-'));
    const sessionDir = join(dir, 'session');
    cpSync(SESSION_SRC, sessionDir, { recursive: true });   // scratch copy — never mutate the committed session

    // positivePeriodNonNegativeUsage (specs/subscriptions/spec.lat) is an adopted statePredicate with
    // no ref-hop (own-field only: `periodStart < periodEnd && accruedUnits >= 0`) — the cheapest
    // adopted quint-expressible invariant in the committed session, keeping this smoke light.
    const r: any = await runCommand(
      ['classify', '--session', sessionDir, '--name', 'positivePeriodNonNegativeUsage'], realDeps);

    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.classified)).toBe(true);
    expect(r.classified.length).toBeGreaterThan(0);
  }, 300_000);  // ~80s unloaded; generous flat budget (like golden/trace-b.test.ts) so machine load can't blow the margin
});
