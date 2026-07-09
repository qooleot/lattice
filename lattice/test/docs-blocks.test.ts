import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLatText, loadContextMapText } from '../src/parse/fromLangium.js';
import { RESERVED_WORDS } from '../src/ast/reserved.js';

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

describe('naming-conventions.md reserved-word list stays in lockstep with RESERVED_WORDS', () => {
  it('lists exactly the members of RESERVED_WORDS, no extras', () => {
    const md = readFileSync(join(DOCS, 'naming-conventions.md'), 'utf8');
    // The page renders the list as one long comma-separated run of `word` tokens; every other
    // backtick run on the page is far shorter, so the longest run IS the list.
    const runs = md.match(/`[A-Za-z-]+`(?:,\s*`[A-Za-z-]+`)+/g) ?? [];
    const list = runs.sort((a, b) => b.length - a.length)[0] ?? '';
    const words = [...list.matchAll(/`([A-Za-z-]+)`/g)].map(m => m[1]!);
    expect(new Set(words).size).toBe(words.length);
    expect([...words].sort()).toEqual([...RESERVED_WORDS].sort());
  });
});
