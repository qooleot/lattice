import { describe, it, expect } from 'vitest';
import { parseLat, scanBannedComments } from '../../src/parse/parse.js';
import { loadLatText } from '../../src/parse/fromLangium.js';

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
    lifecycle run {
      states { queued @initial, going @active, done @terminal }
      transition start { from queued to going }
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
    if (r.ok) expect(r.cst.context?.name).toBe('Demo');
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

  it("attaches a '///' doc to an enum and stores it on the CST node", () => {
    const r = parseLat('context C {\n  /// billing modes\n  enum Mode { fast, slow }\n}');
    expect(r.ok, JSON.stringify(!r.ok && (r as any).diagnostics)).toBe(true);
    if (r.ok) {
      const enumDecl = r.cst.context?.items.find((i: any) => i.$type === 'EnumDecl') as any;
      expect(enumDecl?.docs).toEqual(['/// billing modes']);
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

  it('parses the const field modifier (suffix, after key, before tags)', () => {
    const r = parseLat('context C { aggregate A { aId : Id key\n foo : Int const\n bar : Id key const } }');
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
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

describe('contextMap files', () => {
  const MAP = `/// Acme billing: catalog-driven subscriptions.
contextMap AcmeBilling {
  contains Subscriptions
  contains Catalog from "catalog"

  /// Subscriptions consumes plan definitions from the catalog.
  Catalog upstream of Subscriptions {
    upstream roles openHost, publishedLanguage
    downstream roles anticorruption
    exposes Plan
  }

  Billing partnership with Ordering {
  }
}
`;
  it('parses a contextMap file', () => {
    const r = parseLat(MAP);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (r.ok) expect(r.cst.map?.name).toBe('AcmeBilling');
  });
  it('still parses a context file through the same entry', () => {
    const r = parseLat('context A {\n  entity E {\n    id : Id key\n  }\n}\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cst.context?.name).toBe('A');
  });
  it('many leading /// docs still disambiguate (docs hoisted to LatFile)', () => {
    const docs = Array.from({ length: 8 }, (_, i) => `/// line ${i}`).join('\n');
    expect(parseLat(`${docs}\ncontextMap M {\n}\n`).ok).toBe(true);
  });

  it('rejects a downstream role keyword under upstream roles (positional vocabulary)', () => {
    const r = parseLat(`contextMap M {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    upstream roles anticorruption
  }
}
`);
    expect(r.ok).toBe(false);
  });

  it('rejects an upstream role keyword under downstream roles (positional vocabulary)', () => {
    const r = parseLat(`contextMap M {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    downstream roles openHost
  }
}
`);
    expect(r.ok).toBe(false);
  });

  it('still parses correct positional role usage', () => {
    const r = parseLat(MAP);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
  });
});

describe('RESERVED_WORDS matches the grammar keywords (single source enforced by test)', () => {
  it('every RESERVED_WORDS member is a quoted keyword in lat.langium, and vice versa', async () => {
    const { readFileSync } = await import('node:fs');
    const g = readFileSync(new URL('../../src/parse/lat.langium', import.meta.url), 'utf8');
    // strip terminal/regex definitions (bottom of the grammar) — only rule bodies contain keywords
    const rulesOnly = g.slice(0, g.indexOf('\nhidden terminal WS'));
    // hyphen included (Task 12's 'read-only' keyword) — IDENT_RE can never produce a hyphenated
    // identifier, but the quoted grammar literal itself needs to round-trip through this regex.
    const grammarKeywords = new Set(
      [...rulesOnly.matchAll(/'([A-Za-z_][A-Za-z0-9_-]*)'/g)].map(m => m[1]!));
    const { RESERVED_WORDS } = await import('../../src/ast/reserved.js');
    for (const w of RESERVED_WORDS) expect(grammarKeywords.has(w), `'${w}' not found as a quoted keyword in lat.langium`).toBe(true);
    for (const w of grammarKeywords) if (/^[a-z]/i.test(w))
      expect(RESERVED_WORDS.has(w), `grammar keyword '${w}' missing from RESERVED_WORDS`).toBe(true);
  });
});

describe('Enum-level doc comments (Slice 8)', () => {
  it('/// before enum parses and attaches doc via loadLatText', async () => {
    const { loadLatText } = await import('../../src/parse/fromLangium.js');
    const r = loadLatText('context C {\n  /// Billing cadence.\n  enum Period { monthly, annual }\n}');
    expect(r.ok, JSON.stringify(!r.ok && (r as any).diagnostics)).toBe(true);
    if (r.ok) expect(r.model.enums[0]!.doc).toBe('Billing cadence.');
  });

  it('/// before enum round-trips through astToCode', async () => {
    const { loadLatText } = await import('../../src/parse/fromLangium.js');
    const { astToCode } = await import('../../src/emit/code.js');
    const src = 'context C {\n  /// Billing cadence.\n  enum Period { monthly, annual }\n}';
    const r = loadLatText(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const printed = astToCode(r.model, []);
    expect(printed).toContain('/// Billing cadence.');
    const reparsed = loadLatText(printed);
    expect(reparsed.ok, JSON.stringify(!reparsed.ok && (reparsed as any).diagnostics)).toBe(true);
    if (reparsed.ok) expect(reparsed.model.enums[0]!.doc).toBe('Billing cadence.');
  });
});

describe('Service tier annotation (Slice 8)', () => {
  it('parses tier = appPrivate and sets model.services[0].tier', async () => {
    const { loadLatText } = await import('../../src/parse/fromLangium.js');
    const r = loadLatText(`context C {
  aggregate A { aId : Id key
    lifecycle r { states { s @initial, t @terminal } transition x { from s to t } }
  }
  service MyService {
    tier = appPrivate
    doIt(id: Id) performs A.x
  }
}`);
    expect(r.ok, JSON.stringify(!r.ok && (r as any).diagnostics)).toBe(true);
    if (r.ok) expect(r.model.services[0]!.tier).toBe('appPrivate');
  });

  it('round-trips tier = appPrivate through astToCode', async () => {
    const { loadLatText } = await import('../../src/parse/fromLangium.js');
    const { astToCode } = await import('../../src/emit/code.js');
    const src = `context C {
  aggregate A { aId : Id key
    lifecycle r { states { s @initial, t @terminal } transition x { from s to t } }
  }
  service MySvc {
    tier = appPrivate
    doIt(id: Id) performs A.x
  }
}`;
    const r = loadLatText(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const printed = astToCode(r.model, []);
    expect(printed).toContain('tier = appPrivate');
    const reparsed = loadLatText(printed);
    expect(reparsed.ok, JSON.stringify(!reparsed.ok && (reparsed as any).diagnostics)).toBe(true);
    if (reparsed.ok) expect(reparsed.model.services[0]!.tier).toBe('appPrivate');
  });

  it('invalid tier produces unknown-service-tier diagnostic', async () => {
    const { loadLatText } = await import('../../src/parse/fromLangium.js');
    const r = loadLatText(`context C {
  aggregate A { aId : Id key
    lifecycle r { states { s @initial, t @terminal } transition x { from s to t } }
  }
  service MySvc {
    tier = bogus
    doIt(id: Id) performs A.x
  }
}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some(d => d.code === 'unknown-service-tier')).toBe(true);
  });
});

describe('keyword field names (FieldName rule + reserved carve-out)', () => {
  it('allows state/type/count/from/to as field and param names, preserving them', () => {
    const r = loadLatText(`context Kw {
  type Loc = { state : Text  type : Text  count : Int  from : Date  to : Date }
  value V { state : Text }
  service S { tier = appPublic  doThing(type : Text) : Loc read-only }
}`);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (r.ok) {
      const loc = r.model.records?.find(x => x.name === 'Loc');
      expect(loc?.fields.map(f => f.name)).toEqual(['state', 'type', 'count', 'from', 'to']);
    }
  });

  it("still rejects a 'state' field on an aggregate with a lifecycle (<Region>.state collision)", () => {
    const r = loadLatText(`context KwAgg {
  aggregate Order { orderId : Id key  state : Text
    lifecycle L { states { draft @initial, done @terminal } transition go { from draft to done } }
  }
}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some(d => d.code === 'reserved-field-name')).toBe(true);
  });
});
