import type { PrimType } from './domain.js';

/**
 * .lat grammar keywords (spec §3/§5 conformance follow-up): names like `count`, `state`, `from`,
 * `to`, `key`, `now` pass IDENT_RE/validateModel but cannot lex as ID in the Langium grammar —
 * astToCode would then print an unparseable file. This set lets validateModel reject them before
 * a hand-authored construct name collides with a keyword.
 *
 * SOURCE OF TRUTH: this list is hand-maintained but kept in lockstep with src/parse/lat.langium
 * by a grammar-sync test (test/parse/parse.test.ts) that asserts every member here appears as a
 * quoted keyword in the grammar, and every quoted keyword matching /^[a-z]/i in the grammar
 * appears here. Deliberately lives in ast/ rather than parse/reserved.ts: ast/ must not depend on
 * parse/ (parse/ already imports from ast/ — see fromLangium.ts, diff.ts).
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'aggregate', 'anticorruption', 'builtin', 'by', 'conformist', 'conserve', 'const', 'contains', 'context',
  'contextMap', 'count', 'creates', 'downstream', 'emits', 'entity', 'enum', 'event', 'exposes', 'fairness',
  'from', 'in', 'invariant', 'key', 'leads', 'lifecycle', 'List', 'Map', 'module', 'monotonic', 'now', 'of', 'on', 'openHost',
  'Optional', 'partnership', 'performs', 'present', 'publishedLanguage', 'read-only', 'ref', 'refs', 'requires', 'resolve', 'roles',
  'service', 'sharedKernel', 'state', 'states', 'sum', 'terminal', 'ticksPerDay', 'to', 'transition', 'type',
  'under', 'unique', 'upstream', 'value', 'when', 'where', 'while', 'with',
]);

/**
 * Built-in primitive type names, reserved against enum/value/entity/aggregate names — the type
 * namespace — by validateModel's `reserved-prim-name`.
 *
 * A separate set from RESERVED_WORDS above, mechanically and semantically. Mechanically, that set
 * is locked to the grammar's quoted keywords in both directions by a sync test, and prims are not
 * keywords — lat.langium has no prim production at all. Semantically, the failures differ: a
 * reserved word cannot lex as ID, so astToCode prints an unparseable file; a prim name lexes fine
 * but resolves to the *wrong type*. Every named type parses as one `NamedType: name=ID`, and the
 * prim/declared split happens after parsing, in fromLangium's mapType, which resolves prim-first.
 *
 * The rule is deliberately wider than round-trip identity strictly requires, because the severity
 * splits by kind:
 *
 *  - value/enum are ONLY expressible as a bare name, so `value Id {...}` prints a field type
 *    identical to prim Id's, re-parses as the prim, and print∘parse is not identity. Necessity.
 *  - entity/aggregate also have `ref X`, which is what astToCode always emits for a ref (code.ts),
 *    so a prim-named entity does round-trip today. They are covered anyway because mapType's
 *    bare-name `owners` branch is unreachable for them: a hand-authored `foo : Id` meaning the
 *    entity silently yields prim Id instead. Prevention of that trap, not a round-trip fix.
 *
 * SOURCE OF TRUTH for the prim spelling — fromLangium's mapType imports this rather than keeping
 * its own copy, so the parser's notion of "is a prim" cannot drift from the rule reserving them.
 * Keyed by PrimType so tsc fails here if a prim is added to the union without landing in this set
 * (a missing member would silently un-reserve the new name).
 */
const PRIM_NAME_KEYS: Record<PrimType, true> = {
  Int: true, Text: true, Date: true, Duration: true, Money: true, Id: true, Boolean: true,
};
export const PRIM_NAMES: ReadonlySet<string> = new Set(Object.keys(PRIM_NAME_KEYS));
