import { createLatServices } from './lat-services.js';
import type { LatFile } from './generated/ast.js';

export interface ParseDiagnostic { code: string; message: string; line: number; col: number }
export type LatParseResult = { ok: true; cst: LatFile } | { ok: false; diagnostics: ParseDiagnostic[] };

/** `//` is banned (spec P5); `///` is the only comment form. Skips string literals. */
export function scanBannedComments(text: string): ParseDiagnostic[] {
  const out: ParseDiagnostic[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let inString = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') inString = !inString;
      if (!inString && ch === '/' && line[j + 1] === '/') {
        if (line[j + 2] === '/') break;                      // /// doc comment — legal, rest of line is comment
        out.push({ code: 'comment-banned', line: i + 1, col: j + 1,
          message: "'//' comments are not part of the language — use '///' for documentation (it becomes part of the spec)" });
        break;
      }
    }
  }
  return out;
}

const services = createLatServices();

export function parseLat(text: string): LatParseResult {
  const banned = scanBannedComments(text);
  if (banned.length) return { ok: false, diagnostics: banned };
  const r = services.parser.LangiumParser.parse<LatFile>(text);
  const diagnostics: ParseDiagnostic[] = [
    ...r.lexerErrors.map(e => ({ code: 'syntax-error', message: e.message,
      line: e.line ?? 1, col: e.column ?? 1 })),
    ...r.parserErrors.map(e => ({ code: 'syntax-error', message: e.message,
      line: e.token.startLine ?? 1, col: e.token.startColumn ?? 1 })),
  ];
  // `///` docs are grammatical on context/entity/event/aggregate/invariant but NOT on enums;
  // Langium's raw "Expecting: one of these possible Token sequences" for that case is unreadable.
  const lines = text.split('\n');
  for (const e of r.parserErrors) {
    if (!e.token.image?.startsWith('///')) continue;
    const line = e.token.startLine ?? 1, col = e.token.startColumn ?? 1;
    const next = lines.slice(line).map(l => l.trim()).find(t => t && !t.startsWith('///'));
    if (!/^enum\b/.test(next ?? '')) continue;
    return { ok: false, diagnostics: [{ code: 'enum-doc-unsupported', line, col,
      message: "'///' docs cannot attach to an enum — move the doc onto the context, an entity, event, aggregate, or invariant, or remove it" }] };
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, cst: r.value };
}
