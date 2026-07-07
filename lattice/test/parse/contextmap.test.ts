import { describe, it, expect } from 'vitest';
import { loadContextMapText } from '../../src/parse/fromLangium.js';

const MAP = `/// Acme billing.
contextMap AcmeBilling {
  contains Subscriptions
  contains Catalog from "catalogs/main"

  /// Plans flow downstream.
  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    downstream roles anticorruption
    exposes Plan
  }
}
`;

describe('loadContextMapText', () => {
  it('maps the full shape, resolving default and explicit paths', () => {
    const r = loadContextMapText(MAP);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.map).toEqual({
      name: 'AcmeBilling', doc: 'Acme billing.',
      contexts: [
        { name: 'Subscriptions', path: 'subscriptions' },
        { name: 'Catalog', path: 'catalogs/main' }],
      relationships: [{
        kind: 'upstreamDownstream', left: 'Catalog', right: 'Subscriptions',
        upstreamRoles: ['openHost', 'publishedLanguage'], downstreamRoles: ['anticorruption'],
        exposes: ['Plan'], doc: 'Plans flow downstream.' }],
    });
  });
  it('rejects a context file with wrong-file-kind', () => {
    const r = loadContextMapText('context A {\n}\n');
    expect(!r.ok && r.diagnostics[0]!.code).toBe('wrong-file-kind');
  });
  it('validates: unknown endpoint, self-relationship, duplicate contains', () => {
    const bad = `contextMap M {\n  contains A\n  contains A\n  A upstream of A {\n  }\n  A upstream of Ghost {\n  }\n}\n`;
    const r = loadContextMapText(bad);
    expect(r.ok).toBe(false);
    const codes = !r.ok ? r.diagnostics.map(d => d.code) : [];
    expect(codes).toContain('duplicate-context');
    expect(codes).toContain('self-relationship');
    expect(codes).toContain('unknown-relationship-endpoint');
  });
  it('warns naming-convention on a camelCase map name', () => {
    const r = loadContextMapText('contextMap acme {\n  contains A\n}\n');
    expect(r.ok && r.warnings.some(w => w.code === 'naming-convention')).toBe(true);
  });
});
