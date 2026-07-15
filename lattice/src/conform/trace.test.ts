import { describe, it, expect } from 'vitest';
import type { CaseEntity } from '../engine/evaluate.js';
import type { PlanAggregate } from '../generate/plan.js';
import { checkTraces, type ObservedEvent } from './trace.js';

const anchors = (el: string) => ({ specElement: el, provenance: [`spec:${el}`], witnessIds: [] });

// A Subscription-shaped machine: trialing→active (activate, EMITS Activated, guarded),
// trialing→expired (expireTrial, silent), active→pastDue (paymentFailed, silent),
// pastDue→active (recover, silent), {trialing,active,pastDue}→canceled (cancel, EMITS Canceled),
// pastDue→canceled (dunningExhausted, silent).
const SUB: PlanAggregate = {
  name: 'Subscription', fields: [], invariants: [], doc: undefined,
  regions: [{ name: 'status', initial: 'trialing', states: [
    { name: 'trialing' }, { name: 'active' }, { name: 'pastDue' },
    { name: 'canceled', tags: ['terminal'] }, { name: 'expired', tags: ['terminal'] }] }],
  transitions: [
    { name: 'activate', region: 'status', from: ['trialing'], to: 'active', emits: 'Activated',
      requires: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['paidInvoiceCount'] }, right: { kind: 'int', value: 1 } } as any,
      anchors: anchors('transition activate') },
    { name: 'expireTrial', region: 'status', from: ['trialing'], to: 'expired', anchors: anchors('transition expireTrial') },
    { name: 'paymentFailed', region: 'status', from: ['active'], to: 'pastDue', anchors: anchors('transition paymentFailed') },
    { name: 'recover', region: 'status', from: ['pastDue'], to: 'active', anchors: anchors('transition recover') },
    { name: 'cancel', region: 'status', from: ['trialing', 'active', 'pastDue'], to: 'canceled', emits: 'Canceled', anchors: anchors('transition cancel') },
    { name: 'dunningExhausted', region: 'status', from: ['pastDue'], to: 'canceled', anchors: anchors('transition dunningExhausted') },
  ],
};

const sub = (id: string, state: string): CaseEntity =>
  ({ type: 'Subscription', id, fields: { subId: id, 'status.state': state } });
const ev = (seq: number, eventType: string, aggregateId: string): ObservedEvent => ({ seq, eventType, aggregateId });

describe('checkTraces', () => {
  it('accepts legal histories: activation, silent churn, evented cancel, silent exhaustion', () => {
    const r = checkTraces(
      [sub('a', 'active'), sub('b', 'expired'), sub('c', 'canceled'), sub('d', 'canceled')],
      [ev(1, 'Activated', 'a'),                       // a: trialing →(Activated) active
        ev(2, 'Activated', 'c'), ev(3, 'Canceled', 'c'), // c: activate then cancel
        ev(4, 'Activated', 'd')],                        // d: activate, fail, exhaust silently
      [SUB], 't');
    expect(r.violations).toEqual([]);
    expect(r.rowsChecked).toBe(4);
    expect(r.guardedTransitions).toEqual(['activate']); // reported, not evaluated
  });

  it('catches a skipped emit: final state active with no Activated event (drift class 1)', () => {
    const r = checkTraces([sub('a', 'active')], [], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ witnessIds: ['a'], specElement: 'machine Subscription.status' });
    expect(r.violations[0]!.detail).toMatch(/active/);
  });

  it('catches a wrong event type: Canceled emitted by an activation (drift class 2)', () => {
    // history: row ends active but the only event is Canceled — no path consumes it into active
    const r = checkTraces([sub('a', 'active')], [ev(1, 'Canceled', 'a')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/Canceled/);
    expect(r.violations[0]!.anchors).toContain('spec:transition cancel');
    expect(r.violations[0]!.anchors).not.toContain('spec:transition expireTrial');
  });

  it('catches emit-outside-transaction: event exists for a row that was never created (class 3)', () => {
    const r = checkTraces([], [ev(1, 'Activated', 'ghost')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ specElement: 'outbox', witnessIds: ['ghost'] });
  });

  it('catches terminal resurrection: canceled row observed active after its Canceled event (class 5)', () => {
    const r = checkTraces([sub('a', 'active')], [ev(1, 'Activated', 'a'), ev(2, 'Canceled', 'a')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/canceled|final/i);
    expect(r.violations[0]!.anchors).toEqual(['spec:machine Subscription.status']);
  });

  it('catches an undeclared event type for the aggregate', () => {
    const r = checkTraces([sub('a', 'trialing')], [ev(1, 'InvoicePaid', 'a')], [SUB], 't');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.detail).toMatch(/InvoicePaid/);
  });

  it('silent cycles terminate: repeated fail/recover churn is legal and finite', () => {
    // a: Activated, then any number of silent paymentFailed/recover loops, end pastDue
    const r = checkTraces([sub('a', 'pastDue')], [ev(1, 'Activated', 'a')], [SUB], 't');
    expect(r.violations).toEqual([]);
  });
});
