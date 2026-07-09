import { describe, it, expect } from 'vitest';
import { validateCandidate } from '../../src/ast/grammar.js';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { Candidate } from '../../src/ast/invariant.js';
import type { CaseState, CaseEntity } from '../../src/engine/evaluate.js';

// DoD item 2 — b02 one-shot re-formalization smoke. b02 ("line items sum to invoice total") was
// twice not-formalizable under the pre-growth grammar (fidelity/results/AMENDMENT.md: "unknown-path
// — sum over a list field is inexpressible"). Its final recorded attempt (fidelity/results/b02.json,
// the re-dispatch — first attempt archived verbatim at fidelity/results/first-shot/b02.json) modeled
// the rule as `conservation` over a path hopping through a `List<ref<LineItem>>` field, which
// `conservation.parts: Path[]` cannot represent (a Path is a single field-hop chain, not a
// collection-aggregation). The grown grammar adds `sumOverCollection` expressly for this shape
// (Task 9, design §6.2/§6.4). This test hand-authors the formalization the formalizer SHOULD now
// produce and checks it (a) validates against a model mirroring b02's recorded shape and (b) passes
// b02's own judged cases — NOT a gate re-run, one rule only.
//
// b02.json's recorded model put `LineItem` at the top level (`entities: [...]`), referencing its
// owner via `invoice: ref<Invoice>`, with `Invoice.lineItems: List<ref<LineItem>>`. sumOverCollection
// requires an OWNED collection (grammar.ts ownedCollectionChild — child nested inside the aggregate
// via `aggregate.entities`, per Task 5/6 §3.2/§6.1), so this test mirrors b02's rule as a nested
// entity in a test-local model (same field names: `lineItems`, `LineItem`, `amount`, `total`) —
// the point is the FORM formalizes against the grown grammar, not that b02's exact top-level-ref
// shape is retroactively legalized.
const b02Model: DomainModel = {
  context: 'Invoicing', ticksPerDay: 24,
  enums: [], values: [], entities: [], events: [], services: [],
  aggregates: [{
    kind: 'aggregate', name: 'Invoice',
    fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'prim', prim: 'Money' } },
      { name: 'lineItems', type: { kind: 'list', of: { kind: 'ref', target: 'LineItem' } } }],
    entities: [{ kind: 'entity', name: 'LineItem', fields: [
      { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
  }],
};

// The formalization the formalizer should now produce against the grown grammar — b02's rule
// ("line items sum to invoice total") is an exact-equality sum, so op: 'eq' (matches b02.json's
// recorded `conservation` attempt, which also used equality between parts-sum and total).
const b02Candidate: Candidate = {
  kind: 'sumOverCollection', aggregate: 'Invoice',
  collection: 'lineItems', child: 'LineItem', field: 'amount', op: 'eq', total: ['total'],
};

// b02.json's judged cases encode each LineItem as its own top-level entity with an `invoice: ref`
// field pointing at the parent, plus the parent's `lineItems` array of child ids. The
// Task-6/evaluator convention for sumOverCollection (src/engine/evaluate.ts, case
// 'sumOverCollection') instead expects child CaseEntities to carry `owner: <parentId>` and does NOT
// consult the parent's collection-array field at all. This adapter re-shapes b02's recorded case
// JSON into that convention without touching the original file (append-only evidence per
// fidelity/PROTOCOL.md) — drop each child's `invoice` field, add `owner` in its place; the parent's
// `lineItems` id-array field is simply left in place (unread by the evaluator) rather than stripped.
function adaptB02Case(raw: { entities: Array<{ type: string; id: string; fields: Record<string, unknown> }> }): CaseState {
  const entities: CaseEntity[] = raw.entities.map(e => {
    if (e.type !== 'LineItem') return e as CaseEntity;
    const { invoice, ...rest } = e.fields as { invoice: string; [k: string]: unknown };
    return { type: e.type, id: e.id, fields: { ...rest, owner: invoice } } as CaseEntity;
  });
  return { entities };
}

// b02.json's three judged cases, verbatim in content (desc/expected/state), reproduced here as
// TS literals so the adapter above can run over them — see fidelity/results/b02.json for the
// original append-only record.
const b02Cases: Array<{ desc: string; expected: 'permit' | 'forbid'; raw: { entities: Array<{ type: string; id: string; fields: Record<string, unknown> }> } }> = [
  {
    desc: 'Two line items sum exactly to the invoice total',
    expected: 'permit',
    raw: { entities: [
      { type: 'Invoice', id: 'inv1', fields: { total: 150, lineItems: ['li1', 'li2'] } },
      { type: 'LineItem', id: 'li1', fields: { invoice: 'inv1', amount: 100 } },
      { type: 'LineItem', id: 'li2', fields: { invoice: 'inv1', amount: 50 } },
    ] },
  },
  {
    desc: 'Single line item exactly matches the invoice total',
    expected: 'permit',
    raw: { entities: [
      { type: 'Invoice', id: 'inv2', fields: { total: 75, lineItems: ['li3'] } },
      { type: 'LineItem', id: 'li3', fields: { invoice: 'inv2', amount: 75 } },
    ] },
  },
  {
    desc: 'Line items sum to less than the stated total',
    expected: 'forbid',
    raw: { entities: [
      { type: 'Invoice', id: 'inv3', fields: { total: 200, lineItems: ['li4', 'li5'] } },
      { type: 'LineItem', id: 'li4', fields: { invoice: 'inv3', amount: 100 } },
      { type: 'LineItem', id: 'li5', fields: { invoice: 'inv3', amount: 90 } },
    ] },
  },
];

describe('b02 re-formalization (DoD 2): sum-over-collection against the grown grammar', () => {
  it('validates — the form that was 2x not-formalizable now formalizes', () => {
    expect(validateCandidate(b02Candidate, b02Model)).toEqual([]);
  });

  for (const { desc, expected, raw } of b02Cases) {
    it(`passes its own judged case: ${desc}`, () => {
      expect(evaluateCandidate(b02Candidate, adaptB02Case(raw))).toBe(expected);
    });
  }
});
