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
  'aggregate', 'by', 'conserve', 'context', 'count', 'entity', 'enum', 'event', 'fairness',
  'from', 'in', 'invariant', 'key', 'leads', 'List', 'machine', 'monotonic', 'now', 'on', 'ref',
  'refs', 'region', 'resolve', 'state', 'states', 'terminal', 'ticksPerDay', 'to', 'transition',
  'under', 'unique', 'when', 'where', 'while',
]);
