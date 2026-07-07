import type { Diagnostic } from './invariant.js';
import { IDENT_RE } from './validate.js';
import { RESERVED_WORDS } from './reserved.js';

export type Role = 'openHost' | 'publishedLanguage' | 'anticorruption' | 'conformist';
export type RelationshipKind = 'upstreamDownstream' | 'partnership' | 'sharedKernel';
export interface ContextRef { name: string; path: string }   // path always resolved (explicit or default)
export interface Relationship {
  kind: RelationshipKind;
  left: string; right: string;            // upstreamDownstream: left = upstream, right = downstream
  upstreamRoles?: Role[]; downstreamRoles?: Role[];   // upstreamDownstream only
  exposes?: string[];
  doc?: string;
}
export interface ContextMapModel { name: string; contexts: ContextRef[]; relationships: Relationship[]; doc?: string }

export const defaultPath = (contextName: string): string =>
  contextName.charAt(0).toLowerCase() + contextName.slice(1);

export function validateContextMap(m: ContextMapModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const checkName = (kind: string, value: string, at?: string) => {
    if (!IDENT_RE.test(value))
      out.push({ code: 'invalid-name', message: `${kind} name '${value}' is not a valid identifier (letters, digits, underscore; no spaces)`, at });
    else if (RESERVED_WORDS.has(value))
      out.push({ code: 'reserved-word', message: `${kind} name '${value}' is a .lat keyword and cannot be used as an identifier`, at });
  };

  checkName('contextMap', m.name);
  for (const c of m.contexts) checkName('context', c.name, c.name);
  for (const r of m.relationships) {
    checkName('relationship left', r.left, `${r.left}-${r.right}`);
    checkName('relationship right', r.right, `${r.left}-${r.right}`);
  }

  const names = new Map<string, number>();
  for (const c of m.contexts) names.set(c.name, (names.get(c.name) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) out.push({ code: 'duplicate-context', message: `context ${n} declared ${c} times` });

  const known = new Set(m.contexts.map(c => c.name));
  for (const r of m.relationships) {
    const at = `${r.left}-${r.right}`;
    if (r.left === r.right) out.push({ code: 'self-relationship', message: `relationship ${r.left}-${r.right}: a context cannot relate to itself`, at });
    if (!known.has(r.left)) out.push({ code: 'unknown-relationship-endpoint', message: `relationship endpoint ${r.left} is not a declared context`, at });
    if (!known.has(r.right)) out.push({ code: 'unknown-relationship-endpoint', message: `relationship endpoint ${r.right} is not a declared context`, at });
  }

  return out;
}
