import { describe, it, expect } from 'vitest';
import { astToProse, renderCandidateEnglish } from '../../src/emit/prose.js';
import { astToCode } from '../../src/emit/code.js';
import { traceAModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const H3: CandidateInvariant = { id: 'H3', name: 'SingleActivePerFamily', prior: 0.9, source: 'regen',
  candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan', 'family']] } };
const ledger: LedgerEntry[] = [
  { kind: 'verdict', at: 't1', witnessId: 'w1', witness: { entities: [] }, salient: [], judge: 'forbid', question: 'Two active, same family?' },
  { kind: 'adopted', at: 't3', invariant: H3, provenance: 'elicited w1–w2' },
  { kind: 'open-decision', at: 't4', topic: 'dunning_exhausted', note: 'Unpaid or Canceled? undecided' }
];

describe('astToProse', () => {
  const prose = astToProse(traceAModel, [H3], ledger);
  it('renders lifecycle, invariants with anchors, and open decisions', () => {
    expect(prose).toContain('# Billing');
    expect(prose).toContain('**Access states:** Trialing, Active, Ended (terminal)');
    expect(prose).toContain('Only one Subscription may be Active per (customer, plan.family)');
    expect(prose).toContain('elicited w1–w2');
    expect(prose).toContain('## ⚠️ Open decisions');
    expect(prose).toContain('dunning_exhausted');
  });
});

describe('astToCode', () => {
  const code = astToCode(traceAModel, [H3]);
  it('pretty-prints the .lat projection', () => {
    expect(code).toContain('context Billing {');
    expect(code).toContain('aggregate Subscription {');
    expect(code).toContain('customer : ref Customer');
    expect(code).toContain('states { Trialing @initial, Active @active, Ended @terminal }');
    expect(code).toContain('invariant SingleActivePerFamily { unique while Access in {Active} by (customer, plan.family) }');
  });
  it('omits an adopted invariant whose candidate is structurally implied (spec §3.4)', () => {
    const impliedDup: CandidateInvariant = { id: 'tpl-refsResolve-Subscription', name: 'NoOrphanSubscription', prior: 0.9, source: 'template',
      candidate: { kind: 'refsResolve', aggregate: 'Subscription' } };
    const withImplied = astToCode(traceAModel, [H3, impliedDup]);
    expect(withImplied).not.toContain('NoOrphanSubscription');
  });
});

describe('DomainModel.doc rendering', () => {
  const withDoc = { ...traceAModel, doc: 'Subscriptions API: hybrid license-fee + usage-based billing' };

  it('renders doc as an italic subtitle under the prose title', () => {
    const prose = astToProse(withDoc, [H3], ledger);
    expect(prose).toContain('# Billing');
    expect(prose).toContain('*Subscriptions API: hybrid license-fee + usage-based billing*');
  });

  it('renders doc as a leading /// doc-comment above the context line in code', () => {
    const code = astToCode(withDoc, [H3]);
    expect(code).toContain('/// Subscriptions API: hybrid license-fee + usage-based billing');
    expect(code.indexOf('///')).toBeLessThan(code.indexOf('context Billing {'));
  });

  it('omits the doc line entirely when doc is unset', () => {
    const code = astToCode(traceAModel, [H3]);
    expect(code.startsWith('context Billing {')).toBe(true);
  });
});

describe('emitted .lat smoke tripwire', () => {
  it('first non-doc-comment line is a valid context declaration', () => {
    const withDoc = { ...traceAModel, doc: 'Subscriptions API: hybrid license-fee + usage-based billing' };
    const code = astToCode(withDoc, [H3]);
    const firstNonComment = code.split('\n').find(l => l.trim() !== '' && !l.trim().startsWith('///'));
    expect(firstNonComment).toMatch(/^context [A-Za-z_][A-Za-z0-9_]* \{$/);
  });
});

describe('astToProse — Services section (design §3.6, Task 12)', () => {
  const withService = { ...traceAModel, services: [{ name: 'SubscriptionOps', doc: 'Subscription lifecycle API.',
    methods: [
      { name: 'createSubscription', params: [{ name: 'customerId', type: { kind: 'prim' as const, prim: 'Id' as const } }],
        kind: { creates: 'Subscription' as const } },
      { name: 'getSubscription', params: [{ name: 'subId', type: { kind: 'prim' as const, prim: 'Id' as const } }],
        kind: { readOnly: true as const } },
      { name: 'activate', params: [{ name: 'subId', type: { kind: 'prim' as const, prim: 'Id' as const } }],
        kind: { performs: { aggregate: 'Subscription', transition: 'activate' } },
        requires: { kind: 'cmp' as const, op: 'ge' as const,
          left: { kind: 'param' as const, name: 'subId' }, right: { kind: 'int' as const, value: 0 } } },
    ] }] };

  it('renders a Services section with doc, method kind, params, and requires', () => {
    const prose = astToProse(withService, [H3], ledger);
    expect(prose).toContain('## Services');
    expect(prose).toContain('*Subscription lifecycle API.*');
    expect(prose).toContain('**createSubscription**(customerId) — creates a Subscription');
    expect(prose).toContain('**getSubscription**(subId) — reads');
    expect(prose).toContain('**activate**(subId) — performs Subscription.activate, requires subId ≥ 0');
  });

  it('omits the Services section entirely when there are no services', () => {
    const prose = astToProse(traceAModel, [H3], ledger);
    expect(prose).not.toContain('## Services');
  });
});

describe('renderCandidateEnglish', () => {
  it('covers every candidate kind', () => {
    expect(renderCandidateEnglish(H3.candidate)).toContain('Only one Subscription');
    expect(renderCandidateEnglish({ kind: 'terminal', aggregate: 'S', region: 'R', state: 'Closed' })).toBe('Once S is Closed, it stays Closed.');
    expect(renderCandidateEnglish({ kind: 'monotonic', aggregate: 'O', field: ['recognized'] })).toBe('O.recognized never decreases.');
    expect(renderCandidateEnglish({ kind: 'conservation', aggregate: 'O', parts: [['recognized'], ['deferred']], total: ['allocated'] }))
      .toBe('On every O, recognized + deferred always equals allocated.');
    expect(renderCandidateEnglish({ kind: 'refsResolve', aggregate: 'E' })).toBe('Every reference on E resolves to an existing record.');
    expect(renderCandidateEnglish({ kind: 'cardinality', aggregate: 'P', where: null, atMost: 1 })).toBe('At most 1 P may exist.');
  });
});
