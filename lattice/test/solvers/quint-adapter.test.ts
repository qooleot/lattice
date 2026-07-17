import { describe, it, expect, vi } from 'vitest';
import { runQuint, parseITF, runQuintVerify } from '../../src/solvers/quint-adapter.js';
import type { QuintEmission } from '../../src/emit/quint.js';
import { childVarKey } from '../../src/engine/owned.js';

const em: QuintEmission = { source: 'module m {}', invariantName: 'q_inv', varTypes: {} };

const failWith = (stderr: string) =>
  Object.assign(new Error(`Command failed: npx quint verify\n${stderr}`), { code: 1, stderr });

// Each quint verify spawns its own Apalache JVM and SIGTERMs it at exit. On quint's default
// fixed port 8822, a back-to-back call raced the dying JVM for the port and lost (observed live:
// quint connects to the dying server, which drops the call), exiting 1 WITHOUT an ITF file — the
// same surface as a deterministic failure. The adapter now isolates every invocation on its own
// ephemeral port and retries exactly once on the transient gRPC classes, never on anything else.
describe('quint adapter retry-once on transient gRPC startup contention', () => {
  it('retries once when quint dies with a transient gRPC error, then succeeds', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 14 UNAVAILABLE: Connection dropped\n    at callErrorFromStatus (...)'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    const r = await runQuint(em, 5, exec);
    expect(r.violated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('retries once on RST_STREAM (dying server closes the HTTP/2 stream mid-call)', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 13 INTERNAL: Received RST_STREAM with code 0 (Call ended without gRPC status)'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    const r = await runQuint(em, 5, exec);
    expect(r.violated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry deterministic failures (parse/typecheck errors)', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('error: parsing failed\nsyntax error near token'));
    await expect(runQuint(em, 5, exec)).rejects.toThrow(/quint verify failed without a counterexample/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('gives up after the single retry if the transient error persists', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('Error: 14 UNAVAILABLE: Connection dropped'));
    await expect(runQuint(em, 5, exec)).rejects.toThrow(/UNAVAILABLE/);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  // The root fix for the port-8822 contention: every invocation runs its Apalache server on its
  // own ephemeral port, so back-to-back calls (and concurrent checkouts) never share a server.
  // The retry attempt must pick a FRESH port — retrying the contended one defeats the purpose.
  it('passes a unique ephemeral --server-endpoint per attempt', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 14 UNAVAILABLE: Connection dropped'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    await runQuint(em, 5, exec);
    const endpoints = exec.mock.calls.map((c: any[]) => {
      const args = c[1] as string[];
      return args[args.indexOf('--server-endpoint') + 1]!;
    });
    for (const ep of endpoints) {
      const port = Number(ep.match(/^localhost:(\d+)$/)![1]);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(60000);
    }
    expect(endpoints[0]).not.toBe(endpoints[1]);
  });
});

// Task 6: owned collections (design §6.1) — ITF parsing is solver-free, so this exercises
// parseITF directly against a hand-built trace state shaped like real quint ITF output (map
// values as `{'#map': [[k, v], …]}`, bigints as `{'#bigint': "…"}`).
describe('quint adapter materializes owned-collection children from ITF', () => {
  const varTypes = { invoices: 'Invoice', 'invoices#lines': 'InvoiceLine' };

  it('emits exactly the live children (index < count), each with an owner and numeric fields', () => {
    const itf = {
      states: [{
        now: { '#bigint': '0' },
        invoices: {
          '#map': [[
            'invoice1',
            {
              exists: true,
              totalDue: { '#bigint': '100' },
              linesCount: { '#bigint': '2' },
              lines: {
                '#map': [
                  [{ '#bigint': '0' }, { amount: { '#bigint': '10' } }],
                  [{ '#bigint': '1' }, { amount: { '#bigint': '20' } }],
                  [{ '#bigint': '2' }, { amount: { '#bigint': '30' } }],   // beyond linesCount — not live
                ],
              },
            },
          ]],
        },
      }],
    };
    const state = parseITF(itf, varTypes);
    const invoice = state.entities.find(e => e.type === 'Invoice')!;
    expect(invoice.fields['lines.count']).toBe(2);
    const lines = state.entities.filter(e => e.type === 'InvoiceLine');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.fields.owner).toBe('invoice1');
    expect(lines.map(l => l.fields.amount).sort()).toEqual([10, 20]);
    expect(lines.map(l => l.id).sort()).toEqual(['invoice1#lines0', 'invoice1#lines1']);
  });

  it('accepts plain-number map keys (not just {#bigint})', () => {
    const itf = {
      states: [{
        invoices: {
          '#map': [[
            'invoice1',
            { exists: true, totalDue: 5, linesCount: 1, lines: { '#map': [[0, { amount: 42 }]] } },
          ]],
        },
      }],
    };
    const state = parseITF(itf, varTypes);
    const lines = state.entities.filter(e => e.type === 'InvoiceLine');
    expect(lines).toEqual([{ type: 'InvoiceLine', id: 'invoice1#lines0', fields: { owner: 'invoice1', amount: 42 } }]);
  });
});

// Task 11: value semantics (design §3.5) — quint encodes a value-typed field as an inline nested
// record (astToQuint's fieldQType value case), so ITF represents an instance as a plain object
// with NO '#map' key (unlike owned collections/refs, which are always '#map'-wrapped). The
// adapter must flatten that plain object to underscore-joined keys so it matches Alloy's native
// underscore-flattened sig-relation shape — remapValueKeys (witness.ts) is the shared downstream
// step that converts both adapters' underscore keys to the engine's dotted-path convention.
describe('quint adapter flattens nested value-record fields to underscore keys', () => {
  it('flattens a plain-object (non-#map) record field to <field>_<subfield> keys', () => {
    const varTypes = { subscriptions: 'Subscription' };
    const itf = {
      states: [{
        subscriptions: {
          '#map': [[
            'sub1',
            { exists: true, period: { start: { '#bigint': '3' }, end: { '#bigint': '9' } } },
          ]],
        },
      }],
    };
    const state = parseITF(itf, varTypes);
    const sub = state.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields).toEqual({ period_start: 3, period_end: 9 });
  });

  it('flattens plain-number (non-bigint) sub-field values too', () => {
    const varTypes = { subscriptions: 'Subscription' };
    const itf = {
      states: [{
        subscriptions: { '#map': [['sub1', { exists: true, period: { start: 3, end: 9 } }]] },
      }],
    };
    const state = parseITF(itf, varTypes);
    const sub = state.entities.find(e => e.type === 'Subscription')!;
    expect(sub.fields).toEqual({ period_start: 3, period_end: 9 });
  });

  // Slice B2 legalised value-in-value, so quint's fieldQType nests records to arbitrary depth —
  // but this flatten step stopped after ONE level, leaving `total_inner` bound to the raw,
  // un-deBig'd ITF sub-record. Downstream that means no `total_inner_amount` key for the judge to
  // read (it PERMITS what Apalache FORBADE) and `total.inner: [object Object]` for the human.
  it('flattens a TWO-level nested record to leaf keys, every leaf de-big\'d', () => {
    const varTypes = { bills: 'Bill' };
    const itf = {
      states: [{
        bills: { '#map': [['b1', { exists: true,
          total: { inner: { amount: { '#bigint': '-5' }, currency: 'usd' } } }]] },
      }],
    };
    const bill = parseITF(itf, varTypes).entities.find(e => e.type === 'Bill')!;
    expect(bill.fields).toEqual({ total_inner_amount: -5, total_inner_currency: 'usd' });
    // Stated separately from the toEqual above: this is the property that matters (no raw ITF
    // object survives anywhere), and it holds at any depth, not just for these two keys.
    expect(Object.values(bill.fields).every(v => typeof v !== 'object')).toBe(true);
  });

  it('flattens a value record on an owned-collection CHILD too', () => {
    const varTypes = { txns: 'Txn', [childVarKey('txns', 'legs')]: 'Posting' };
    const itf = {
      states: [{
        txns: { '#map': [['t1', { exists: true, legsCount: { '#bigint': '1' },
          legs: { '#map': [[{ '#bigint': '0' },
            { amount: { inner: { amount: { '#bigint': '-7' } } } }]] } }]] },
      }],
    };
    const posting = parseITF(itf, varTypes).entities.find(e => e.type === 'Posting')!;
    expect(posting.fields).toEqual({ owner: 't1', amount_inner_amount: -7 });
  });
});

// The other half of isValueRecord's contract, and the level the unit tests missed: what must NOT
// flatten. Every test above feeds the walker a record that IS a value, so all of them stay green
// under a predicate that answers "yes" too often — and the only coverage of the value-FREE case
// was cli-strengthen.integration.test.ts, a ~5.5-minute real-Apalache test whose model
// (test/fixtures.ts's subscriptionsModel) declares `values: []`. These states are transcribed from
// that test's actual ITF, captured by instrumenting stateToEntities.
//
// The shape matters because fieldQType renders EVERY field of such a model as a scalar: refs and
// enums to `str`, Int/Money to `int`, Id/Text dropped. So an over-eager isValueRecord cannot mangle
// a value here — there are none — it can only flatten a scalar carrier into keys the judge does not
// know, or (for a record with no leaves) delete the key outright. Pinned here so that fails in
// milliseconds rather than via a real-solver integration run.
describe('quint adapter leaves a value-FREE record alone', () => {
  it('passes scalars, #bigints, refs-as-str and _state through unflattened', () => {
    const varTypes = { invoices: 'Invoice' };
    const itf = {
      states: [{
        invoices: {
          '#map': [[
            'invoice1',
            {
              exists: true,
              subscription: 'subscription1',            // ref — fieldQType renders it `str`
              amountPaid: { '#bigint': '24' },
              totalDue: { '#bigint': '100' },
              retryCount: { '#bigint': '0' },
              settlement_state: 'draft',                // machine region — dotted, not flattened
            },
          ]],
        },
      }],
    };
    const invoice = parseITF(itf, varTypes).entities.find(e => e.type === 'Invoice')!;
    // Exact: names an over-eager flatten either way — a vanished key OR an invented `x_y` one.
    expect(invoice.fields).toEqual({
      subscription: 'subscription1', amountPaid: 24, totalDue: 100,
      retryCount: 0, 'settlement.state': 'draft',
    });
    // The property behind the toEqual: no underscore-joined key can exist for a model with no
    // values, since underscore keys are the value convention remapValueKeys later dots.
    expect(Object.keys(invoice.fields).some(k => k.includes('_'))).toBe(false);
  });

  // `#bigint` is the tag the walker is most likely to swallow: it is the ONE composite that wraps a
  // scalar, so mistaking it for a value record binds `x_#bigint` and drops `x` — silently changing
  // a number the judge reads into a key it never looks up.
  it('never descends INTO a #bigint wrapper', () => {
    const varTypes = { invoices: 'Invoice' };
    const itf = { states: [{ invoices: { '#map': [['i1', { exists: true, totalDue: { '#bigint': '100' } }]] } }] };
    const invoice = parseITF(itf, varTypes).entities.find(e => e.type === 'Invoice')!;
    expect(invoice.fields).toEqual({ totalDue: 100 });
  });
});

describe('runQuintVerify flag construction', () => {
  it('passes a custom --init and --invariant when given', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('error: parsing failed\nsyntax error'));
    await expect(runQuintVerify(em, { init: 'indInit', invariant: 'PaidConjunct', maxSteps: 1 }, exec))
      .rejects.toThrow(/quint verify failed without a counterexample/);
    const args = exec.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--init') + 1]).toBe('indInit');
    expect(args[args.indexOf('--invariant') + 1]).toBe('PaidConjunct');
    expect(args[args.indexOf('--max-steps') + 1]).toBe('1');
  });

  it('defaults --invariant to em.invariantName and omits --init when not given', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('error: parsing failed'));
    await expect(runQuintVerify(em, { maxSteps: 3 }, exec)).rejects.toThrow();
    const args = exec.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--invariant') + 1]).toBe('q_inv'); // em.invariantName
    expect(args).not.toContain('--init');
  });

  it('retries once on a transient gRPC error, like runQuint', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 14 UNAVAILABLE: Connection dropped'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    const r = await runQuintVerify(em, { init: 'indInit', maxSteps: 1 }, exec);
    expect(r.violated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
