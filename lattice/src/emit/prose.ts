import type { DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Predicate, Term } from '../ast/invariant.js';
import type { LedgerEntry } from '../engine/session.js';

function termEn(t: Term): string {
  switch (t.kind) {
    case 'field': return t.path.join('.');
    case 'int': return String(t.value);
    case 'enumval': return t.value;
    case 'now': return 'now';
    case 'plus': return `${termEn(t.left)} + ${termEn(t.right)}`;
  }
}
function predEn(p: Predicate): string {
  switch (p.kind) {
    case 'cmp': { const ops = { eq: 'is', ne: 'is not', lt: '<', le: '≤', gt: '>', ge: '≥' }; return `${termEn(p.left)} ${ops[p.op]} ${termEn(p.right)}`; }
    case 'inState': return `it is ${p.states.join(' or ')}`;
    case 'and': return p.args.map(predEn).join(' and ');
    case 'or': return p.args.map(predEn).join(' or ');
    case 'not': return `not (${predEn(p.arg)})`;
    case 'implies': return `if ${predEn(p.left)}, then ${predEn(p.right)}`;
  }
}
export function renderCandidateEnglish(c: Candidate): string {
  switch (c.kind) {
    case 'unique': return `Only one ${c.aggregate} may be ${c.whileStates.states.join('/')} per (${c.by.map(p => p.join('.')).join(', ')}).`;
    case 'statePredicate': return `On every ${c.aggregate}: ${c.where ? `where ${predEn(c.where)}, ` : ''}${predEn(c.body)}.`;
    case 'refsResolve': return `Every reference on ${c.aggregate} resolves to an existing record.`;
    case 'cardinality': return `At most ${c.atMost} ${c.aggregate}${c.where ? ` where ${predEn(c.where)}` : ''} may exist.`;
    case 'terminal': return `Once ${c.aggregate} is ${c.state}, it stays ${c.state}.`;
    case 'monotonic': return `${c.aggregate}.${c.field.join('.')} never decreases.`;
    case 'conservation': return `On every ${c.aggregate}, ${c.parts.map(p => p.join('.')).join(' + ')} always equals ${c.total.join('.')}.`;
    case 'leadsTo': return `${c.aggregate}: ${predEn(c.from)} eventually leads to ${predEn(c.to)} (under fairness: ${c.fairness}).`;
  }
}

export function astToProse(m: DomainModel, adopted: CandidateInvariant[], ledger: LedgerEntry[]): string {
  const lines: string[] = [`# ${m.context}`, ''];
  if (m.doc) lines.push(`*${m.doc}*`, '');
  for (const a of m.aggregates) {
    lines.push(`## ${a.name}`, '');
    if (a.doc) lines.push(a.doc, '');
    for (const r of a.machine?.regions ?? []) {
      const label = (s: string) => r.states.find(st => st.name === s)?.tags?.includes('terminal') ? `${s} (terminal)` : s;
      // A linear `A → B → C` chain misreads as declaring transitions between adjacent states in
      // that order, which isn't true unless the machine actually says so — states are just an
      // enumerated set until a transition names a from/to pair. Render the DECLARED transitions
      // (per-edge, since they may not be a simple chain) when present; otherwise fall back to a
      // plain comma-separated list of states with no arrows, so no transition is implied.
      const declared = (a.machine?.transitions ?? []).filter(t => t.region === r.name);
      if (declared.length > 0) {
        lines.push(`**${r.name} lifecycle:** ${declared.map(t => `${t.from.map(label).join('/')} → ${label(t.to)} (${t.name})`).join(', ')}`, '');
      } else {
        lines.push(`**${r.name} states:** ${r.states.map(s => label(s.name)).join(', ')}`, '');
      }
    }
  }
  lines.push('## Always true', '');
  const provenance = new Map(ledger.filter(e => e.kind === 'adopted').map(e => [(e as any).invariant.id, (e as any).provenance]));
  for (const inv of adopted.filter(i => i.candidate.kind !== 'leadsTo'))
    lines.push(`- ${renderCandidateEnglish(inv.candidate)}  (${
      inv.id.startsWith('implied-') ? 'implied by structure' : provenance.get(inv.id) ?? inv.source}: ${inv.name})`);
  const live = adopted.filter(i => i.candidate.kind === 'leadsTo');
  if (live.length) { lines.push('', '## Eventually', ''); live.forEach(i => lines.push(`- ${renderCandidateEnglish(i.candidate)}`)); }
  const open = ledger.filter(e => e.kind === 'open-decision');
  if (open.length) {
    lines.push('', '## ⚠️ Open decisions', '');
    open.forEach(e => lines.push(`- **${(e as any).topic}** — ${(e as any).note}`));
  }
  return lines.join('\n') + '\n';
}
