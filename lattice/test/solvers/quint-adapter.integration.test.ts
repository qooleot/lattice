import { describe, it, expect } from 'vitest';
import type { DomainModel } from '../../src/ast/domain.js';
import { runQuint } from '../../src/solvers/quint-adapter.js';
import { astToQuint } from '../../src/emit/quint.js';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import { nextQuestion } from '../../src/engine/planner.js';
import { registerCandidates } from '../../src/engine/hypothesis.js';
import { newSession } from '../../src/engine/session.js';
import { realDeps } from '../../src/cli.js';
import { traceBModel, graceCandidate, invoicingModel, draftInvoiceUnique, graceCap, invoiceLinesModel, someStatePredicateOnInvoice, sumCandidate, periodModel } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';
import { remapValueKeys } from '../../src/engine/witness.js';

describe('quint adapter (integration)', () => {
  it('finds a disagreement witness between grace-0 and grace-window rules', async () => {
    const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(false), hj: graceCandidate(true), exclusions: [], maxSteps: 8 });
    const r = await runQuint(em, 8);
    expect(r.violated).toBe(true);
    const w = r.witness!;
    expect(w.now).toBeTypeOf('number');
    const sub = w.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields['Access.state']).toBeDefined();
    expect(r.ms).toBeLessThan(45_000);
  }, 180_000);

  it('reports no violation for a candidate against itself (merge signal)', async () => {
    const em = astToQuint(traceBModel, { kind: 'distinguish', hi: graceCandidate(true), hj: graceCandidate(true), exclusions: [], maxSteps: 5 });
    const r = await runQuint(em, 5);
    expect(r.violated).toBe(false);
  }, 180_000);

  // Regression (live session .lattice-session-subscriptions, witness w6): after adopting
  // One_Draft_Invoice_Per_Subscription (unique, Invoice, whileStates [Draft], by [[subscription]]),
  // a quint distinguish between two UNRELATED Subscription statePredicate candidates returned a
  // witness containing two Draft invoices for the same subscription — a state the adoption already
  // forbids (and the human had already judged forbid as w5). Every witness the planner surfaces
  // must satisfy every adopted invariant, including alloy-routed kinds like `unique`.
  it('quint distinguish witness satisfies an already-adopted unique invariant', async () => {
    const s = newSession(); s.phase = 'distinguish';
    s.candidates.push({ inv: { id: 'ADOPTED', name: 'One_Draft_Invoice_Per_Subscription', prior: 1,
      source: 'seed', candidate: draftInvoiceUnique }, status: 'adopted' });
    registerCandidates(s, [
      { id: 'G72', name: 'G72', prior: 0.6, source: 'seed', candidate: graceCap(72) },
      { id: 'G24', name: 'G24', prior: 0.5, source: 'seed', candidate: graceCap(24) }]);
    const q = await nextQuestion(s, [], invoicingModel, realDeps);
    expect(q.type).toBe('question');   // the candidates genuinely differ — a witness must exist
    const w = (q as any).witness;
    expect(evaluateCandidate(draftInvoiceUnique, w)).toBe('permit');
  }, 180_000);

  // Task 6 (review fix): owned collections (design §6.1) round-trip through the real solver, with
  // a witness that ACTUALLY carries at least one live InvoiceLine child. The plain `invoiceLinesModel`
  // Invoice is a non-machine aggregate (exists: false at init, only populated by create_Invoice), so
  // the original probe-permit query (`not(Hi)`, `Hi` a forall over existing records) was vacuously
  // true at the empty init state — Apalache always returned the trivial 0-step, zero-entity
  // counterexample, and the child-materialization assertions below iterated zero times. Confirmed via
  // raw ITF: exists:false, linesCount:0.
  //
  // Fix, two parts:
  //  1. Give Invoice a minimal lifecycle (test-local clone, NOT the shared fixture — later tasks
  //     depend on invoiceLinesModel's current shape). Machine-bearing aggregates are `exists: true`
  //     from init (astToQuint: `exists: ${machine ? 'true' : 'false'}`), so the record is live
  //     immediately without needing a create_Invoice step.
  //  2. Force a non-degenerate witness by strengthening the emitted q_inv for this test only: instead
  //     of the always-vacuous `not(Hi)`, require any counterexample to exhibit an Invoice with
  //     linesCount >= 1. This is test scaffolding only — the model/encoding under test (bounded-map
  //     owned-collection emission, ITF parsing, child materialization) is 100% emitter-generated and
  //     untouched; only the query predicate driving which counterexample Apalache is asked to find is
  //     replaced, exactly as astToQuint's own `q.kind` branches already do per query kind.
  const invoiceLinesModelWithLifecycle: DomainModel = {
    ...invoiceLinesModel,
    aggregates: [{
      ...invoiceLinesModel.aggregates[0]!,
      machine: { regions: [{ name: 'settlement', initial: 'draft', states: [
        { name: 'draft' }, { name: 'open' }] }], transitions: [] },
    }],
  };

  it('round-trips an owned collection through the real solver, materializing live children', async () => {
    const em = astToQuint(invoiceLinesModelWithLifecycle,
      { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], maxSteps: 2 });
    // Strengthen q_inv: force Apalache to find a witness containing an Invoice whose owned
    // InvoiceLine collection is non-empty (linesCount >= 1), instead of the vacuous `not(Hi)`.
    const strengthened = em.source.replace(
      /val q_inv = .*$/m,
      'val q_inv = not(invoices.keys().exists(k => { val x = invoices.get(k) x.exists and x.linesCount >= 1 }))');
    expect(strengthened).not.toBe(em.source);   // guard: the replace actually matched q_inv
    const emForced = { ...em, source: strengthened };

    const r = await runQuint(emForced, 2);
    expect(r.violated).toBe(true);
    const w = r.witness!;

    const invoices = w.entities.filter(e => e.type === 'Invoice');
    const withLines = invoices.filter(e => Number(e.fields['lines.count']) >= 1);
    expect(withLines.length).toBeGreaterThan(0);
    const parent = withLines[0]!;

    const lines = w.entities.filter(e => e.type === 'InvoiceLine' && String(e.fields.owner) === parent.id);
    expect(lines.length).toBeGreaterThan(0);   // guard: can never silently pass on an empty witness
    expect(lines.length).toBe(Number(parent.fields['lines.count']));
    for (const line of lines) {
      expect(line.fields.amount).toBeTypeOf('number');
      expect(line.fields.owner).toBe(parent.id);
      expect(line.id.startsWith(`${parent.id}#lines`)).toBe(true);
    }
  }, 180_000);

  // Task 9 (design §6.2/§6.4): the sum form's propose→distinguish reality check, ahead of golden
  // trace D. `total == sum` (sumCandidate) vs `total <= sum` (sumLe) genuinely differ whenever
  // sum > total — real Apalache must find such a witness, and evaluateCandidate must SPLIT the
  // pair on it (one permit, one forbid), not agree.
  it('distinguishes total==sum from total<=sum with a real Apalache witness that splits the two candidates', async () => {
    const sumLe: Candidate = { ...(sumCandidate as Extract<Candidate, { kind: 'sumOverCollection' }>), op: 'le' };
    const em = astToQuint(invoiceLinesModelWithLifecycle,
      { kind: 'distinguish', hi: sumCandidate, hj: sumLe, exclusions: [], maxSteps: 2 });
    // Same liveness-forcing scaffolding as the owned-collection round-trip above: the plain
    // `iff(Hi, Hj)` disjunction is satisfiable at the trivial empty-lines witness too (both
    // candidates agree — vacuously — when linesCount is 0), so force any counterexample to also
    // exhibit an Invoice with at least one live InvoiceLine, making the split witness non-vacuous.
    const strengthened = em.source.replace(
      /val q_inv = .*$/m,
      'val q_inv = iff(Hi, Hj) or not(invoices.keys().exists(k => { val x = invoices.get(k) x.exists and x.linesCount >= 1 }))');
    expect(strengthened).not.toBe(em.source);   // guard: the replace actually matched q_inv
    const emForced = { ...em, source: strengthened };

    const r = await runQuint(emForced, 2);
    expect(r.violated).toBe(true);
    const w = r.witness!;

    const invoices = w.entities.filter(e => e.type === 'Invoice');
    const withLines = invoices.filter(e => Number(e.fields['lines.count']) >= 1);
    expect(withLines.length).toBeGreaterThan(0);   // guard: can never silently pass on an empty witness
    const parent = withLines[0]!;
    const lines = w.entities.filter(e => e.type === 'InvoiceLine' && String(e.fields.owner) === parent.id);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBe(Number(parent.fields['lines.count']));

    const total = Number(parent.fields.totalDue);
    const sum = lines.reduce((acc, l) => acc + Number(l.fields.amount), 0);
    expect(total).not.toBe(sum);   // the actual disagreement driving the split (total==sum vs total<=sum)

    const eqVerdict = evaluateCandidate(sumCandidate, w);
    const leVerdict = evaluateCandidate(sumLe, w);
    expect(eqVerdict).not.toBe(leVerdict);   // the witness must genuinely split the pair
    expect([eqVerdict, leVerdict].sort()).toEqual(['forbid', 'permit']);
    // Witness consistency check: the reported verdicts match direct recomputation from the
    // witness's own child rows + parent total, not just "differ from each other" by accident.
    expect(eqVerdict).toBe(total === sum ? 'permit' : 'forbid');
    expect(leVerdict).toBe(total <= sum ? 'permit' : 'forbid');
  }, 180_000);

  // Task 11 (design §3.5): value semantics round-trip through the real quint/Apalache solver.
  // period is emitted as an inline nested record (astToQuint's fieldQType value case); the ITF
  // witness represents it as a plain (non-'#map') object, which the adapter flattens to
  // period_start/period_end (quint-adapter.ts's stateToEntities), then remapValueKeys (the same
  // normalization realDeps applies at the cli.ts boundary) converts to dotted period.start/
  // period.end — judged consistently by evaluateCandidate against the witness's own values.
  it('round-trips a value field through the real solver: witness carries period.start/period.end post-remap, judged consistently', async () => {
    const periodCand: Candidate = { kind: 'statePredicate', aggregate: 'Subscription',
      body: { kind: 'cmp', op: 'lt',
        left: { kind: 'field', owner: 'self', path: ['period', 'start'] },
        right: { kind: 'field', owner: 'self', path: ['period', 'end'] } } };
    const em = astToQuint(periodModel, { kind: 'probe-forbid', hi: periodCand, exclusions: [], maxSteps: 4 });
    expect(em.source).toContain('period: { start: int, end: int }');

    const r = await runQuint(em, 4);
    expect(r.violated).toBe(true);
    const raw = r.witness!;
    const rawSub = raw.entities.find(e => e.type === 'Subscription')!;
    expect(rawSub.fields).toHaveProperty('period_start');   // guard: pre-remap shape is underscore-flattened

    const w = remapValueKeys(periodModel, raw);
    const sub = w.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields['period.start']).toBeTypeOf('number');
    expect(sub.fields['period.end']).toBeTypeOf('number');
    expect(sub.fields).not.toHaveProperty('period_start');

    // probe-forbid asked for a violation of `period.start < period.end` — evaluateCandidate must
    // agree with the witness's own (now-dotted) field values, not just report SOME verdict.
    expect(evaluateCandidate(periodCand, w)).toBe('forbid');
    expect(Number(sub.fields['period.start'])).toBeGreaterThanOrEqual(Number(sub.fields['period.end']));
  }, 180_000);
});
