import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLatText, loadContextMapText } from '../src/parse/fromLangium.js';

const DOCS = join(import.meta.dirname, '../../docs/language');
const blocks = (md: string): string[] =>
  [...md.matchAll(/```lat\n([\s\S]*?)```/g)].map(m => m[1]!);

/** Strip leading `///` doc-comment lines, then decide the loader from the first real token:
 *  `context` or `contextMap` (spec §10 — every ```lat block is a complete, parseable file). */
function sniff(src: string): 'context' | 'contextMap' {
  const stripped = src
    .split('\n')
    .filter(line => !/^\s*\/\/\//.test(line))
    .join('\n')
    .trimStart();
  return stripped.startsWith('contextMap') ? 'contextMap' : 'context';
}

describe('docs/language ```lat blocks are complete, parseable files (spec §10)', () => {
  const pages = readdirSync(DOCS).filter(f => f.endsWith('.md'));
  it('has pages to check', () => expect(pages.length).toBeGreaterThan(0));
  for (const page of pages)
    it(page, () => {
      for (const src of blocks(readFileSync(join(DOCS, page), 'utf8'))) {
        const r = sniff(src) === 'contextMap' ? loadContextMapText(src) : loadLatText(src);
        expect(r.ok, `${page}:\n${src}\n${JSON.stringify(!r.ok && r.diagnostics, null, 2)}`).toBe(true);
      }
    });
});
