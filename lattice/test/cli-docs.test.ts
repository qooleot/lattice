import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, realDeps } from '../src/cli.js';

const MAP = `contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    exposes Plan
  }
}
`;

const CATALOG_SPEC = `context Catalog {
  entity Plan {
    planId : Id key
    name : Text
  }
}
`;

const SUBSCRIPTIONS_SPEC = `context Subscriptions {
  aggregate Subscription {
    subId : Id key
    plan : ref Catalog.Plan
  }
}
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lat-docs-'));
});

const writeMember = (wsDir: string, path: string, text: string) => {
  mkdirSync(join(wsDir, path), { recursive: true });
  writeFileSync(join(wsDir, path, 'spec.lat'), text);
};

const writeHappyWorkspace = (wsDir: string) => {
  writeFileSync(join(wsDir, 'context-map.lat'), MAP);
  writeMember(wsDir, 'catalog', CATALOG_SPEC);
  writeMember(wsDir, 'subscriptions', SUBSCRIPTIONS_SPEC);
};

describe('engine docs', () => {
  it('happy path: writes workspace + member diagram docs', async () => {
    writeHappyWorkspace(dir);
    const r: any = await runCommand(['docs', '--workspace', dir], realDeps);
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    expect(r.written).toBeDefined();

    const wsMd = join(dir, 'context-map.generated.md');
    const wsMmd = join(dir, 'diagrams', 'context-map.mmd');
    const catalogMd = join(dir, 'catalog', 'spec.diagrams.md');
    const subsMd = join(dir, 'subscriptions', 'spec.diagrams.md');

    for (const p of [wsMd, wsMmd, catalogMd, subsMd]) {
      expect(r.written).toContain(p);
      expect(existsSync(p)).toBe(true);
    }
  });

  it('missing --workspace errors as missing-arg', async () => {
    const r: any = await runCommand(['docs'], realDeps);
    expect(r).toEqual({ error: 'missing-arg', arg: 'workspace' });
  });

  it('does not require --session', async () => {
    writeHappyWorkspace(dir);
    // deliberately no --session passed at all
    const r: any = await runCommand(['docs', '--workspace', dir], realDeps);
    expect(r.error).toBeUndefined();
  });

  it('broken workspace (missing member spec) maps to workspace-invalid with diagnostics', async () => {
    writeFileSync(join(dir, 'context-map.lat'), MAP);
    writeMember(dir, 'catalog', CATALOG_SPEC);
    // subscriptions member spec.lat intentionally absent -> loadWorkspace fails
    const r: any = await runCommand(['docs', '--workspace', dir], realDeps);
    expect(r.error).toBe('workspace-invalid');
    expect(Array.isArray(r.diagnostics)).toBe(true);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
