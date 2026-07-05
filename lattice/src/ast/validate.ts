import type { Diagnostic } from './invariant.js';
import type { DomainModel, Field, TypeRef } from './domain.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateModel(m: DomainModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const checkName = (kind: string, value: string, at?: string) => {
    if (!IDENT_RE.test(value))
      out.push({ code: 'invalid-name', message: `${kind} name '${value}' is not a valid identifier (letters, digits, underscore; no spaces)`, at });
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
    if (t.kind === 'ref' && !owners.has(t.target)) out.push({ code: 'unresolved-ref', message: `ref target ${t.target} not declared`, at });
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
      for (const s of [t.from, t.to]) if (!r.states.some(x => x.name === s))
        out.push({ code: 'unknown-transition-state', message: `transition ${t.name}: no state ${s} in ${a.name}.${t.region}`, at: t.name });
      if (t.when && !events.has(t.when))
        out.push({ code: 'unknown-event', message: `transition ${t.name} triggered by undeclared event ${t.when}`, at: t.name });
    }
  });
  return out;
}
