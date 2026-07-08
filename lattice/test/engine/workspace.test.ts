import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspace, compileWorkspace } from '../../src/engine/workspace.js';

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
  dir = mkdtempSync(join(tmpdir(), 'lat-workspace-'));
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

describe('loadWorkspace', () => {
  it('happy path: loads map + members in contains order', () => {
    writeHappyWorkspace(dir);
    const r = loadWorkspace(dir);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.map.name).toBe('Acme');
    expect(r.members.map(m => m.name)).toEqual(['Catalog', 'Subscriptions']);
    expect(r.members[0]!.path).toBe('catalog');
    expect(r.members[0]!.dir).toBe(join(dir, 'catalog'));
    expect(r.members[0]!.model.context).toBe('Catalog');
    expect(r.members[1]!.dir).toBe(join(dir, 'subscriptions'));
    expect(r.members[1]!.model.context).toBe('Subscriptions');
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('missing context-map.lat is ok:false with missing-member naming the file', () => {
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ code: 'missing-member' });
    expect(JSON.stringify(r.diagnostics[0])).toContain('context-map.lat');
  });

  it('missing member dir/spec.lat is ok:false with missing-member naming the file', () => {
    writeFileSync(join(dir, 'context-map.lat'), MAP);
    writeMember(dir, 'catalog', CATALOG_SPEC);
    // subscriptions member dir/spec.lat intentionally absent
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const d = r.diagnostics.find((x: any) => x.code === 'missing-member');
    expect(d).toBeDefined();
    expect(JSON.stringify(d)).toContain(join(dir, 'subscriptions', 'spec.lat'));
  });

  it('unparseable member spec.lat is ok:false with parse-failed naming the file', () => {
    writeFileSync(join(dir, 'context-map.lat'), MAP);
    writeMember(dir, 'catalog', CATALOG_SPEC);
    writeMember(dir, 'subscriptions', SUBSCRIPTIONS_SPEC + '\n// stray comment\n');
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const d = r.diagnostics.find((x: any) => x.code === 'parse-failed');
    expect(d).toBeDefined();
    expect(JSON.stringify(d)).toContain(join(dir, 'subscriptions', 'spec.lat'));
  });

  it('context-name-mismatch: member spec.lat context does not match declared name', () => {
    writeFileSync(join(dir, 'context-map.lat'), MAP);
    writeMember(dir, 'catalog', CATALOG_SPEC);
    writeMember(dir, 'subscriptions', SUBSCRIPTIONS_SPEC.replace('context Subscriptions', 'context Subs'));
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((x: any) => x.code === 'context-name-mismatch')).toBe(true);
  });

  it('rejects a member path that escapes the workspace via ../', () => {
    const outside = mkdtempSync(join(tmpdir(), 'lat-outside-'));
    writeMember(outside, 'catalog', CATALOG_SPEC);   // exists, but must never be read
    writeFileSync(join(dir, 'context-map.lat'),
      `contextMap Acme {\n  contains Catalog from "${join('..', basename(outside), 'catalog')}"\n}\n`);
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const d = r.diagnostics.find((x: any) => x.code === 'invalid-member-path');
    expect(d).toBeDefined();
    expect(JSON.stringify(d)).toContain('Catalog');
  });

  it('rejects an absolute member path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'lat-outside-'));
    writeMember(outside, 'catalog', CATALOG_SPEC);
    writeFileSync(join(dir, 'context-map.lat'),
      `contextMap Acme {\n  contains Catalog from "${join(outside, 'catalog')}"\n}\n`);
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((x: any) => x.code === 'invalid-member-path')).toBe(true);
  });

  it('accepts a nested relative member path inside the workspace', () => {
    writeFileSync(join(dir, 'context-map.lat'),
      `contextMap Acme {\n  contains Catalog from "packages/catalog"\n}\n`);
    writeMember(dir, join('packages', 'catalog'), CATALOG_SPEC);
    const r = loadWorkspace(dir);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.members[0]!.dir).toBe(join(dir, 'packages', 'catalog'));
  });

  it('bubbles up uncovered cross-context ref from validateWorkspace', () => {
    const mapNoExposes = MAP.replace('    exposes Plan\n', '');
    writeFileSync(join(dir, 'context-map.lat'), mapNoExposes);
    writeMember(dir, 'catalog', CATALOG_SPEC);
    writeMember(dir, 'subscriptions', SUBSCRIPTIONS_SPEC);
    const r = loadWorkspace(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((x: any) => x.code === 'uncovered-cross-context-ref')).toBe(true);
  });
});

describe('compileWorkspace', () => {
  it('writes workspace context-map diagrams + each member\'s spec diagrams, all under the workspace/member dirs', () => {
    writeHappyWorkspace(dir);
    const r = compileWorkspace(dir);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;

    const wsMd = join(dir, 'context-map.generated.md');
    const wsMmd = join(dir, 'diagrams', 'context-map.mmd');
    const catalogMd = join(dir, 'catalog', 'spec.diagrams.md');
    const catalogCd = join(dir, 'catalog', 'diagrams', 'CD_Catalog.mmd');
    const subsMd = join(dir, 'subscriptions', 'spec.diagrams.md');
    const subsCd = join(dir, 'subscriptions', 'diagrams', 'CD_Subscriptions.mmd');

    for (const p of [wsMd, wsMmd, catalogMd, catalogCd, subsMd, subsCd]) {
      expect(r.written).toContain(p);
      expect(existsSync(p)).toBe(true);
    }
  });

  it('propagates loadWorkspace failure as diagnostics without writing anything', () => {
    const r = compileWorkspace(dir);   // no context-map.lat at all
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ code: 'missing-member' });
    expect(existsSync(join(dir, 'context-map.generated.md'))).toBe(false);
  });
});
