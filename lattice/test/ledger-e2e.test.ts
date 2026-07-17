import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLatText } from '../src/parse/fromLangium.js';
import { astToCode } from '../src/emit/code.js';
import { astToAlloy } from '../src/emit/alloy.js';
import { astToQuint, candidateToQuint } from '../src/emit/quint.js';
import { impliedInvariants } from '../src/engine/implied.js';
import { matchTemplates } from '../src/engine/templates.js';
import { undecidedMoneySigns } from '../src/ast/validate.js';
import { validateCandidate } from '../src/ast/grammar.js';
import type { Candidate } from '../src/ast/invariant.js';

const src = readFileSync(join(import.meta.dirname, 'fixtures/ledger.lat'), 'utf8');

/** Real quint parser/typechecker over an emitted module (~1s, no Apalache) — the same gate
 *  test/emit/quint-emission-valid.test.ts uses. A `.toContain` on an emitted string cannot tell
 *  whether the string is even valid quint. */
async function typechecks(source: string): Promise<{ ok: boolean; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'qnt-ledger-'));
  const f = join(dir, 'm.qnt');
  writeFileSync(f, source);
  try {
    await promisify(execFile)('npx', ['quint', 'typecheck', f], { cwd: process.cwd() });
    return { ok: true, stderr: '' };
  } catch (e: any) {
    return { ok: false, stderr: String(e.stderr ?? e.stdout ?? e.message) };
  }
}

const r = loadLatText(src);
if (!r.ok) throw new Error(`fixture does not load:\n${JSON.stringify(r.diagnostics, null, 2)}`);
const { model, invariants } = r;

/** The double-entry balance law, hand-built. The SAME candidate the fixture authors as
 *  `netAmount.amount == sum(postings, amount.amount)` — asserted below to be exactly that. */
const balanceLaw: Candidate = {
  kind: 'sumOverCollection', aggregate: 'JournalTransaction',
  collection: 'postings', child: 'Posting', field: ['amount', 'amount'], op: 'eq',
  total: ['netAmount', 'amount'],
};

describe('the double-entry ledger that motivated slice B2', () => {
  it('loads clean: no diagnostics, and every naming warning is absent too', () => {
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('has no undecided money signs: every money decision is made at a use site', () => {
    expect(undecidedMoneySigns(model)).toEqual([]);
  });

  it('round-trips through the printer (print∘parse is a fixed point)', () => {
    const printed = astToCode(model, invariants);
    const again = loadLatText(printed);
    if (!again.ok) throw new Error(`printed .lat does not re-parse:\n${JSON.stringify(again.diagnostics, null, 2)}`);
    expect(astToCode(again.model, again.invariants)).toBe(printed);
    // The authored balance law survives the round-trip as the same candidate, not just as text.
    expect(again.invariants.map(i => i.candidate)).toContainEqual(balanceLaw);
  });

  // ── Finding 1, BOTH horns against the same spec ────────────────────────────────────────────
  // Before this slice a modeller had to choose. Keep Posting an owned child and `refsResolve`
  // was unreachable (impliedInvariants' owner list excluded children); promote Posting to
  // top-level and the balance law became inexpressible (sumOverCollection requires an OWNED
  // collection). The next two tests hold against ONE model.

  it('FINDING 1a — referential integrity on an OWNED child: refsResolvePosting is derived', () => {
    expect(impliedInvariants(model).map(i => i.name)).toContain('refsResolvePosting');
    const c = impliedInvariants(model).find(i => i.name === 'refsResolvePosting')!.candidate;
    // The rule is about `account`, the ref into a top-level entity — not a vacuous shell.
    expect(c).toEqual({ kind: 'refsResolve', aggregate: 'Posting', fields: ['account'] });
  });

  it('FINDING 1b — the balance law on that SAME owned child: netAmount.amount == sum(postings, amount.amount)', () => {
    expect(validateCandidate(balanceLaw, model)).toEqual([]);
    // Authored on the .lat surface too (dotted sum field), so the claim is not TS-only.
    expect(invariants.map(i => i.name)).toContain('netIsSumOfPostings');
    expect(invariants.find(i => i.name === 'netIsSumOfPostings')!.candidate).toEqual(balanceLaw);
  });

  // ── Finding 2 ─────────────────────────────────────────────────────────────────────────────
  // One `value Amount`, two use sites, opposite signs. `@unsigned` used to assert a rule nothing
  // enforced; a sign tag on the value declaration could not have expressed both signs at all.

  it('FINDING 2 — non-negativity is derived PER USE SITE: one value, opposite signs', () => {
    const names = impliedInvariants(model).map(i => i.name);
    expect(names).toContain('nonNegativeBillTotalAmount');         // @unsigned use site
    expect(names).toContain('nonNegativeLineItemAmountAmount');    // @unsigned on an owned CHILD
    expect(names).not.toContain('nonNegativePostingAmountAmount');        // @signed child
    expect(names).not.toContain('nonNegativeLedgerAccountBalanceAmount'); // @signed entity
    // …and the derived rule reads THROUGH the value type, not at the field root.
    expect(impliedInvariants(model).find(i => i.name === 'nonNegativeBillTotalAmount')!.candidate)
      .toEqual({ kind: 'statePredicate', aggregate: 'Bill',
        body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['total', 'amount'] },
                right: { kind: 'int', value: 0 } } });
  });

  it('FINDING 2 — a sign tag inside the value declaration is rejected, so sign has ONE home', () => {
    const tagged = src.replace('amount   : Money', 'amount   : Money @unsigned');
    const bad = loadLatText(tagged);
    expect(bad.ok).toBe(false);
    expect((bad as Extract<typeof bad, { ok: false }>).diagnostics.map(d => d.code))
      .toContain('value-money-sign-inert');
  });

  // ── Findings 3+4 ──────────────────────────────────────────────────────────────────────────
  // Making money value-typed to carry currency silently disabled conservation: the @balance/@total
  // tags resolved to no numeric path and the template stayed quiet.

  it('FINDINGS 3+4 — conservation fires THROUGH the value type, with two-segment paths', () => {
    const c = matchTemplates(model).adopt
      .find(i => i.candidate.kind === 'conservation' && i.candidate.aggregate === 'Bill')!;
    expect(c.candidate).toEqual({ kind: 'conservation', aggregate: 'Bill',
      parts: [['amountPaid', 'amount'], ['amountDue', 'amount']], total: ['total', 'amount'] });
    expect(validateCandidate(c.candidate, model)).toEqual([]);
  });

  // ── The encodings ─────────────────────────────────────────────────────────────────────────

  it('emits Quint and Alloy for the balance law through the value hop', () => {
    // quint nests a value as a record; alloy flattens it to `<field>_<sub>` sig relations.
    expect(candidateToQuint(model, balanceLaw, 'S')).toContain('.get(i).amount.amount');
    expect(astToAlloy(model, { kind: 'probe-permit', exclusions: [], scope: 4, hi: balanceLaw }))
      .toContain('l.amount_amount');
  });

  it('a child-subject rule names only vars the Quint module declares', () => {
    const nonNegLine = impliedInvariants(model).find(i => i.name === 'nonNegativeLineItemAmountAmount')!.candidate;
    const mod = astToQuint(model, { kind: 'probe-permit', exclusions: [], maxSteps: 1, hi: nonNegLine }).source;
    expect(mod).not.toMatch(/\blineItems\b/);   // the child has no var of its own
    const declared = new Set([...mod.matchAll(/var (\w+):/g)].map(x => x[1]!));
    declared.add('now');
    for (const used of new Set([...mod.matchAll(/^\s*val \w+ = (\w+)\.keys\(\)/gm)].map(x => x[1]!)))
      expect([...declared], `val body names undeclared var ${used}`).toContain(used);
  });

  it('emits typecheck-clean Quint for the child-subject non-negativity rule', async () => {
    const nonNegLine = impliedInvariants(model).find(i => i.name === 'nonNegativeLineItemAmountAmount')!.candidate;
    const em = astToQuint(model, { kind: 'probe-permit', exclusions: [], maxSteps: 1, hi: nonNegLine });
    const t = await typechecks(em.source);
    expect(t.ok, t.stderr).toBe(true);
  }, 60_000);

  it('emits typecheck-clean Quint for the balance law over the owned collection', async () => {
    const em = astToQuint(model, { kind: 'probe-permit', exclusions: [], maxSteps: 1, hi: balanceLaw });
    const t = await typechecks(em.source);
    expect(t.ok, t.stderr).toBe(true);
  }, 60_000);
});
