import { describe, it, expect } from 'vitest';
import { runQuint } from '../../src/solvers/quint-adapter.js';
import { astToQuint } from '../../src/emit/quint.js';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import { nextQuestion } from '../../src/engine/planner.js';
import { registerCandidates } from '../../src/engine/hypothesis.js';
import { newSession } from '../../src/engine/session.js';
import { realDeps } from '../../src/cli.js';
import { traceBModel, graceCandidate, invoicingModel, draftInvoiceUnique, graceCap, invoiceLinesModel, someStatePredicateOnInvoice } from '../fixtures.js';

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

  // Task 6: owned collections (design §6.1) round-trip through the real solver — the bounded-map
  // encoding must actually verify/produce a witness, and the adapter must materialize any
  // InvoiceLine children found in that witness with numeric fields and a matching owner.
  it('round-trips an owned collection through the real solver', async () => {
    const em = astToQuint(invoiceLinesModel, { kind: 'probe-permit', hi: someStatePredicateOnInvoice, exclusions: [], maxSteps: 2 });
    const r = await runQuint(em, 2);
    expect(r.violated).toBe(true);
    const w = r.witness!;
    const invoiceIds = new Set(w.entities.filter(e => e.type === 'Invoice').map(e => e.id));
    const lines = w.entities.filter(e => e.type === 'InvoiceLine');
    for (const line of lines) {
      expect(line.fields.amount).toBeTypeOf('number');
      expect(invoiceIds.has(String(line.fields.owner))).toBe(true);
    }
  }, 180_000);
});
