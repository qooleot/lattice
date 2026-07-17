import { describe, it, expect } from 'vitest';
import { validateCandidate, routeCandidate } from '../../src/ast/grammar.js';
import { sumFieldPath } from '../../src/ast/invariant.js';
import { candidateToQuint, astToQuint } from '../../src/emit/quint.js';
import { astToAlloy } from '../../src/emit/alloy.js';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import { extractSalient } from '../../src/engine/salient.js';
import { conjunctTier } from '../../src/engine/tier.js';
import { applyRenamesToInvariant } from '../../src/engine/renames.js';
import { renderCandidateEnglish } from '../../src/emit/prose.js';
import { candidateBodyText } from '../../src/emit/code.js';
import { invoiceLinesModel } from '../fixtures.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const sum = (over: Partial<any> = {}): any => ({ kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lines', child: 'InvoiceLine', field: 'amount', op: 'eq', total: ['totalDue'], ...over });

describe('sumOverCollection', () => {
  it('accepts the b02 shape', () => expect(validateCandidate(sum(), invoiceLinesModel)).toEqual([]));
  it('rejects non-owned collections', () =>
    expect(validateCandidate(sum({ collection: 'totalDue' }), invoiceLinesModel).map(d => d.code)).toContain('sum-not-owned-collection'));
  it('rejects a child mismatch', () =>
    expect(validateCandidate(sum({ child: 'Invoice' }), invoiceLinesModel).map(d => d.code)).toContain('sum-not-owned-collection'));
  it('rejects non-numeric child fields', () =>
    expect(validateCandidate(sum({ field: 'lineId' }), invoiceLinesModel).map(d => d.code)).toContain('ill-typed'));
  it('routes to quint', () => expect(routeCandidate(sum())).toBe('quint'));

  // checkPath (the choke point shared by every candidate path — grammar.ts) also runs over
  // sumOverCollection's `total` path: a total ending in a key field or a Text field must be
  // rejected the same way any other candidate path would be.
  it('rejects a total path ending in a key field (key-path)', () =>
    expect(validateCandidate(sum({ total: ['invId'] }), invoiceLinesModel).map(d => d.code)).toContain('key-path'));
  it('rejects a total path ending in a Text field (unrepresentable-path)', () => {
    const modelWithText: DomainModel = {
      ...invoiceLinesModel,
      aggregates: [{
        ...invoiceLinesModel.aggregates[0]!,
        fields: [...invoiceLinesModel.aggregates[0]!.fields,
          { name: 'memo', type: { kind: 'prim', prim: 'Text' } }],
      }],
    };
    expect(validateCandidate(sum({ total: ['memo'] }), modelWithText).map(d => d.code)).toContain('unrepresentable-path');
  });
});

describe('sumOverCollection over a value sub-field (slice B2)', () => {
  const m: DomainModel = {
    context: 'L', enums: [], entities: [], events: [], services: [],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } },
      { name: 'currency', type: { kind: 'prim', prim: 'Text' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'net', type: { kind: 'value', value: 'Amount' } },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'value', value: 'Amount' } }] }] }],
  };
  const c: Candidate = { kind: 'sumOverCollection', aggregate: 'Txn', collection: 'legs',
    child: 'Posting', field: ['amount', 'amount'], op: 'eq', total: ['net', 'amount'] };

  const witness: CaseState = { entities: [
    { type: 'Txn', id: 't1', fields: { 'net.amount': 7 } },
    { type: 'Posting', id: 'p1', fields: { owner: 't1', 'amount.amount': 3 } },
    { type: 'Posting', id: 'p2', fields: { owner: 't1', 'amount.amount': 4 } }] };

  it('validates a two-segment sum field', () => {
    expect(validateCandidate(c, m)).toEqual([]);
  });

  it('rejects a sum field ending at a non-numeric sub-field', () => {
    expect(validateCandidate({ ...c, field: ['amount', 'currency'] } as Candidate, m)
      .map(d => d.code)).toContain('ill-typed');
  });

  it('normalizes a legacy `field: string` candidate on read (back-compat)', () => {
    const legacy = { kind: 'sumOverCollection', aggregate: 'Txn', collection: 'legs',
      child: 'Posting', field: 'amount', op: 'eq', total: ['net', 'amount'] } as unknown as Candidate;
    expect(sumFieldPath(legacy as any)).toEqual(['amount']);
  });

  // shapeErrors is module-private and runs BEFORE the semantic gate; its message is the tell.
  it('accepts both the legacy string and the Path form in the shape check', () => {
    const shapeMsg = (f: unknown) => validateCandidate({ ...c, field: f } as unknown as Candidate, m)
      .map(d => d.message).filter(msg => msg.startsWith('field: expected'));
    expect(shapeMsg('amount')).toEqual([]);
    expect(shapeMsg(['amount', 'amount'])).toEqual([]);
    expect(shapeMsg(42)).toEqual(['field: expected string | Path (array of string), got 42']);
    expect(shapeMsg([1, 2])).toEqual(['field: expected string | Path (array of string), got [1,2]']);
  });

  it('emits the dotted accessor in quint and the underscore relation in alloy', () => {
    expect(candidateToQuint(m, c, 'S')).toContain('.get(i).amount.amount');
    // candidateToPred is module-private — assert through astToAlloy, which renders `hi` as `pred Hi`.
    const alloySrc = astToAlloy(m, { kind: 'probe-permit', exclusions: [], scope: 4, hi: c });
    expect(alloySrc).toContain('l.amount_amount');
    expect(alloySrc).not.toContain('l.amount.amount');
  });

  it('the judge sums a child\'s value sub-field via the dotted witness key', () => {
    expect(evaluateCandidate(c, witness)).toBe('permit');
    expect(evaluateCandidate(c, { entities: [
      { type: 'Txn', id: 't1', fields: { 'net.amount': 9 } },
      { type: 'Posting', id: 'p1', fields: { owner: 't1', 'amount.amount': 3 } }] })).toBe('forbid');
  });

  // The exclusion loop's second probe: extractSalient renders the sum dim, and BOTH shape emitters
  // must match it back. A silent regex non-match drops the exclusion and re-shows the witness.
  it('extractSalient renders a dotted sum dim that both shape emitters match back', () => {
    const facts = extractSalient([c], witness);
    expect(facts.map(f => f.dim)).toContain('sum(legs.amount.amount)');

    // Pin to the shape0 LINE, not the whole module: `hi`'s own fold also renders
    // `.get(i).amount.amount`, and the `net.amount value` dim also renders `== 7`, so asserting
    // over the full source passes even when the sum dim is silently dropped by a regex non-match.
    const q = astToQuint(m, { kind: 'probe-permit', exclusions: [facts], hi: c, maxSteps: 1 }).source;
    const shape0 = q.split('\n').find(l => l.includes('val shape0 ='))!;
    expect(shape0).toContain('acc + x.legs.get(i).amount.amount else acc) == 7');

    const a = astToAlloy(m, { kind: 'probe-permit', exclusions: [facts], scope: 4, hi: c });
    const aShape0 = a.split('\n').find(l => l.includes('pred shape0'))!;
    expect(aShape0).toContain('l.amount_amount) = 7');
  });

  // conjunctTier wraps the sum field as `[c.field]`; a Path there nests to [[...]] and every
  // `evolving.has(seg)` compares a Set of strings against an ARRAY — always false, so an evolving
  // sum field silently mis-tiers as 'sound'.
  it('conjunctTier sees an evolving sum field through the Path form', () => {
    // `total` is a CONST Money (never evolving) and shares no segment name with the child's
    // field — so 'abstract' can only come from reading the sum field itself.
    const evolving: DomainModel = { ...m, aggregates: [{ kind: 'aggregate', name: 'Txn', fields: [
      { name: 'txnId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'prim', prim: 'Money' }, const: true },
      { name: 'legs', type: { kind: 'list', of: { kind: 'ref', target: 'Posting' } } }],
      entities: [{ kind: 'entity', name: 'Posting', fields: [
        { name: 'pid', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }] }] };
    const base = { ...c, total: ['total'] } as Candidate;
    // Control: the LEGACY string form already tiers abstract — so the Path form must too.
    expect(conjunctTier(evolving, { ...base, field: 'amount' } as Candidate)).toBe('abstract');
    expect(conjunctTier(evolving, { ...base, field: ['amount'] } as Candidate)).toBe('abstract');
  });

  it('renames rewrite the head segment of a two-segment sum field', () => {
    const inv = applyRenamesToInvariant({ id: 's', name: 'sum', prior: 1, source: 'template',
      candidate: JSON.parse(JSON.stringify(c)) as Candidate },
      [{ scope: 'field', path: 'Posting.amount', from: 'amount', to: 'money' }]);
    expect(sumFieldPath(inv.candidate as any)).toEqual(['money', 'amount']);
  });

  it('prose and code render the sum field dotted, not comma-joined', () => {
    expect(renderCandidateEnglish(c)).toContain('amount.amount');
    expect(candidateBodyText(c)).toContain('sum(legs, amount.amount)');
  });
});
