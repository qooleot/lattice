import { describe, it, expect } from 'vitest';
import { parseLat, scanBannedComments } from '../../src/parse/parse.js';

const GOOD = `/// A tiny spec
context Demo {
  enum Mode { fast, slow }
  /// The one entity
  entity Thing {
    thingId : Id key
    cost    : Money @total
    mode    : Mode
  }
  aggregate Job {
    jobId : Id key
    thing : ref Thing
    machine {
      region run { states { queued @initial, going @active, done @terminal } }
      transition start { region run; from queued to going }
    }
    /// Jobs cost something.
    invariant positiveCost { thing.cost >= 0 && state run in {going} => 1 <= 1 }
  }
  invariant modeSane on Thing { mode == Mode.fast || mode == Mode.slow }
}
`;

describe('parseLat', () => {
  it('parses a well-formed file', () => {
    const r = parseLat(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cst.name).toBe('Demo');
  });

  it('reports syntax errors with 1-based positions, never throws', () => {
    const r = parseLat('context Broken { aggregate }');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0]!.line).toBeGreaterThanOrEqual(1);
      expect(r.diagnostics[0]!.code).toBe('syntax-error');
    }
  });

  it('bans // comments with a friendly diagnostic', () => {
    const r = parseLat('context C {\n  // nope\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.diagnostics.find(x => x.code === 'comment-banned')!;
      expect(d.message).toContain('///');
      expect(d.line).toBe(2);
    }
  });

  it('does not flag /// or // inside strings', () => {
    expect(scanBannedComments('/// fine\ncontext C {}')).toEqual([]);
    expect(scanBannedComments('x "a // b" y')).toEqual([]);
    expect(scanBannedComments('a // b')).toHaveLength(1);
  });

  it('parses every invariant body form', () => {
    const bodies = [
      'unique while run in {going} by (thing)',
      'refs resolve',
      'count where state run in {going} <= 1',
      'count <= 3',
      'terminal run.done',
      'monotonic cost',
      'conserve a + b == c',
      'from state run in {queued} leads to state run in {done} under fairness "start fires"',
      '! (cost < 0) || now + 1 >= 2'
    ];
    for (const b of bodies) {
      const r = parseLat(`context C { aggregate A { aId : Id key\n invariant x { ${b} } } }`);
      expect(r.ok, `body failed: ${b}\n${JSON.stringify(!r.ok && r.diagnostics)}`).toBe(true);
    }
  });
});

describe('ID terminal matches the AST identifier rule (single source, spec §3.3)', () => {
  it('grammar ID regex === validate.ts IDENT_RE', async () => {
    const { readFileSync } = await import('node:fs');
    const g = readFileSync(new URL('../../src/parse/lat.langium', import.meta.url), 'utf8');
    const m = g.match(/terminal ID: \/(.+?)\/;/)!;
    const { IDENT_RE } = await import('../../src/ast/validate.js');
    expect(`^${m[1]}$`).toBe(IDENT_RE.source);
  });
});

describe('RESERVED_WORDS matches the grammar keywords (single source enforced by test)', () => {
  it('every RESERVED_WORDS member is a quoted keyword in lat.langium, and vice versa', async () => {
    const { readFileSync } = await import('node:fs');
    const g = readFileSync(new URL('../../src/parse/lat.langium', import.meta.url), 'utf8');
    // strip terminal/regex definitions (bottom of the grammar) — only rule bodies contain keywords
    const rulesOnly = g.slice(0, g.indexOf('\nhidden terminal WS'));
    const grammarKeywords = new Set(
      [...rulesOnly.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]!));
    const { RESERVED_WORDS } = await import('../../src/ast/reserved.js');
    for (const w of RESERVED_WORDS) expect(grammarKeywords.has(w), `'${w}' not found as a quoted keyword in lat.langium`).toBe(true);
    for (const w of grammarKeywords) if (/^[a-z]/i.test(w))
      expect(RESERVED_WORDS.has(w), `grammar keyword '${w}' missing from RESERVED_WORDS`).toBe(true);
  });
});
