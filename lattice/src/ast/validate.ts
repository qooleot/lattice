import type { Diagnostic, Predicate, Term } from './invariant.js';
import type { DomainModel, Field, TypeRef } from './domain.js';
import { RESERVED_WORDS } from './reserved.js';

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Guard predicates on transitions are OWN-AGGREGATE-ONLY in v1 (design §3.3): every field path
// must be a single segment naming a field on the SAME aggregate, and every inState clause must
// name a region/state pair declared on that aggregate's own machine. Ref-hops (multi-segment
// paths) are rejected wholesale as guard-cross-aggregate — that's the r04 ref-hop class,
// deliberately out of scope until real evidence motivates it (§3.3/§5.2.1).
function checkGuard(a: { name: string; fields: Field[]; machine?: { regions: { name: string; states: { name: string }[] }[] } },
    enums: Map<string, string[]>, t: string, p: Predicate, out: Diagnostic[]): void {
  const term = (tm: Term): void => {
    switch (tm.kind) {
      case 'field': {
        if (tm.path.length !== 1) {
          // multi-segment = ref-hop or value path; guards are own-scalar-only in v1 (§5.2.1)
          out.push({ code: 'guard-cross-aggregate', message: `transition ${t}: guard path ${tm.path.join('.')} leaves the aggregate — v1 guards read own fields only`, at: t });
          return;
        }
        if (!a.fields.some(f => f.name === tm.path[0]))
          out.push({ code: 'unknown-path', message: `transition ${t}: guard reads unknown field ${tm.path[0]}`, at: t });
        break;
      }
      case 'enumval': {
        const e = enums.get(tm.enum);
        if (!e) out.push({ code: 'unknown-enum', message: `transition ${t}: no enum ${tm.enum}`, at: t });
        else if (!e.includes(tm.value)) out.push({ code: 'unknown-enum-value', message: `transition ${t}: ${tm.enum} has no value ${tm.value}`, at: t });
        break;
      }
      case 'plus': term(tm.left); term(tm.right); break;
      case 'int': case 'now': break;
    }
  };
  const walk = (q: Predicate): void => {
    switch (q.kind) {
      case 'cmp': term(q.left); term(q.right); break;
      case 'inState': {
        const r = a.machine?.regions.find(x => x.name === q.region);
        if (!r) { out.push({ code: 'unknown-region', message: `transition ${t}: guard names missing region ${q.region}`, at: t }); return; }
        for (const s of q.states) if (!r.states.some(x => x.name === s))
          out.push({ code: 'unknown-state', message: `transition ${t}: guard names missing state ${s}`, at: t });
        break;
      }
      case 'and': case 'or': q.args.forEach(walk); break;
      case 'not': walk(q.arg); break;
      case 'implies': walk(q.left); walk(q.right); break;
    }
  };
  walk(p);
}

export function validateModel(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const enumMap = new Map(m.enums.map(e => [e.name, e.values]));
  const checkName = (kind: string, value: string, at?: string) => {
    if (!IDENT_RE.test(value))
      out.push({ code: 'invalid-name', message: `${kind} name '${value}' is not a valid identifier (letters, digits, underscore; no spaces)`, at });
    else if (RESERVED_WORDS.has(value))
      out.push({ code: 'reserved-word', message: `${kind} name '${value}' is a .lat keyword and cannot be used as an identifier`, at });
  };

  checkName('context', m.context);
  for (const en of m.enums) {
    checkName('enum', en.name, en.name);
    for (const v of en.values) checkName('enum value', v, `${en.name}.${v}`);
  }
  for (const e of m.entities) {
    checkName('entity', e.name, e.name);
    for (const f of e.fields) checkName('field', f.name, `${e.name}.${f.name}`);
  }
  for (const a of m.aggregates) {
    checkName('aggregate', a.name, a.name);
    for (const f of a.fields) checkName('field', f.name, `${a.name}.${f.name}`);
    for (const r of a.machine?.regions ?? []) {
      checkName('machine region', r.name, `${a.name}.${r.name}`);
      for (const s of r.states) checkName('state', s.name, `${a.name}.${r.name}.${s.name}`);
    }
    for (const t of a.machine?.transitions ?? []) checkName('transition', t.name, t.name);
  }
  for (const e of m.events) {
    checkName('event', e.name, e.name);
    for (const f of e.fields) checkName('field', f.name, `${e.name}.${f.name}`);
  }

  const names = new Map<string, number>();
  const all = [...m.enums.map(e => e.name), ...m.entities.map(e => e.name), ...m.aggregates.map(a => a.name)];
  for (const n of all) names.set(n, (names.get(n) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) out.push({ code: 'duplicate-name', message: `name ${n} declared ${c} times` });

  const owners = new Set([...m.entities.map(e => e.name), ...m.aggregates.map(a => a.name)]);
  const enums = new Set(m.enums.map(e => e.name));
  const events = new Set(m.events.map(e => e.name));

  const checkType = (t: TypeRef, at: string) => {
    if (t.kind === 'ref') {
      if (t.target.includes('.')) {
        const segs = t.target.split('.');
        // shape only — resolution happens at workspace level (spec §4.4)
        for (const s of segs) checkName('cross-context ref segment', s, at);
      } else if (!owners.has(t.target)) {
        out.push({ code: 'unresolved-ref', message: `ref target ${t.target} not declared`, at });
      }
    }
    if (t.kind === 'enum' && !enums.has(t.enum)) out.push({ code: 'unresolved-enum', message: `enum ${t.enum} not declared`, at });
    if (t.kind === 'list') checkType(t.of, at);
  };
  const checkReservedField = (f: Field, at: string) => {
    if (f.name === 'state')
      out.push({ code: 'reserved-field-name', message: `'state' is reserved for machine-state keys (<Region>.state)`, at });
  };
  const checkFields = (fs: Field[], owner: string, needKey: boolean) => {
    fs.forEach(f => { checkType(f.type, `${owner}.${f.name}`); checkReservedField(f, `${owner}.${f.name}`); });
    if (needKey && !fs.some(f => f.key)) out.push({ code: 'missing-key', message: `${owner} has no key field`, at: owner });
  };

  m.entities.forEach(e => checkFields(e.fields, e.name, true));
  m.events.forEach(e => e.fields.forEach(f => { checkType(f.type, `${e.name}.${f.name}`); checkReservedField(f, `${e.name}.${f.name}`); }));
  m.aggregates.forEach(a => {
    checkFields(a.fields, a.name, true);
    for (const r of a.machine?.regions ?? []) {
      if (!r.states.some(s => s.name === r.initial))
        out.push({ code: 'unknown-initial-state', message: `region ${a.name}.${r.name} initial ${r.initial} not a state`, at: r.name });
    }
    for (const t of a.machine?.transitions ?? []) {
      const r = a.machine!.regions.find(x => x.name === t.region);
      if (!r) { out.push({ code: 'unknown-region', message: `transition ${t.name} names missing region ${t.region}`, at: t.name }); continue; }
      for (const s of [...t.from, t.to]) if (!r.states.some(x => x.name === s))
        out.push({ code: 'unknown-transition-state', message: `transition ${t.name}: no state ${s} in ${a.name}.${t.region}`, at: t.name });
      if (new Set(t.from).size !== t.from.length)
        out.push({ code: 'duplicate-source', message: `transition ${t.name}: repeated source state`, at: t.name });
      if (t.from.includes(t.to))
        out.push({ code: 'self-loop', message: `transition ${t.name}: target ${t.to} is also a source — self-loops need evidence before the grammar admits them (design §5.2)`, at: t.name });
      if (t.when && !events.has(t.when))
        out.push({ code: 'unknown-event', message: `transition ${t.name} triggered by undeclared event ${t.when}`, at: t.name });
      if (t.requires) checkGuard(a, enumMap, t.name, t.requires, out);
    }
  });
  return out;
}
