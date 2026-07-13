import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { subscriptionsModel } from './fixtures.js';
import type { AggregateDef, DomainModel } from '../src/ast/domain.js';

const inertDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 0 }), quint: async () => ({ violated: false, ms: 0 }) };

// Deep-clone subscriptionsModel and strip `settle`'s authored `requires` (mirrors
// strengthen.integration.test.ts's stripSettleGuard) — genuinely violates the `paidExact` invariant
// below (paid ⇒ amountPaid == totalDue) since nothing forces it anymore, giving `strengthen` a real
// CTI to re-close via a guard on `settle`.
function stripSettleGuard(m: DomainModel): DomainModel {
  const variant = structuredClone(m);
  const invoice = (variant.aggregates as AggregateDef[]).find(a => a.name === 'Invoice')!;
  const settle = invoice.machine!.transitions.find(t => t.name === 'settle')!;
  delete settle.requires;
  return variant;
}

const paidExactCandidate = {
  kind: 'statePredicate', aggregate: 'Invoice',
  where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
  body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } },
};

// A witness whose last-trace-step region move is Invoice.settlement open->paid (evaluate.ts's
// CaseEntity shape, region state keyed '<region>.state') — ctiTransition (pure JS, exercised for
// real here, not stubbed) resolves this to the `settle` transition, same worked example as
// strengthen.test.ts's `ctiTransition` describe block.
const ctiWitness = {
  entities: [{ type: 'Invoice', id: 'i1', fields: { 'settlement.state': 'paid', amountPaid: 3, totalDue: 5 } }],
  trace: [[{ type: 'Invoice', id: 'i1', fields: { 'settlement.state': 'open', amountPaid: 3, totalDue: 5 } }]],
};

// Scripts BOTH `quint` (probe-permit consistency checks, §8.5 step 3a) and `quintVerify` (the
// reachability probe + probe-forbid closes-checks, step 1 and 3b) by call order — mirrors
// cli-classify.test.ts's scriptedDeps pattern, extended to cover strengthenInvariant's two distinct
// solver entry points. guardVariants generates {eq, le, ge} in that fixed order (strengthen.ts), so:
//   quintVerify call order: [reachability, closes-eq, closes-le, closes-ge]
//   quint call order:       [consistent-eq, consistent-le, consistent-ge]
// All three variants are consistent; only `eq` closes the CTI ⇒ a single survivor ⇒ auto-adopt.
function scriptedDeps() {
  let qi = 0, qvi = 0;
  const quintResults = [{ violated: true }, { violated: true }, { violated: true }];             // eq, le, ge all consistent
  const quintVerifyResults = [
    { violated: true, witness: ctiWitness },   // reachability: CTI confirmed
    { violated: false },                       // closes-eq: closed (violated:false ⇒ closes)
    { violated: true },                        // closes-le: does NOT close
    { violated: true },                        // closes-ge: does NOT close
  ];
  const calls: { fn: 'quint' | 'quintVerify' }[] = [];
  const deps: any = {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => { calls.push({ fn: 'quint' }); return { ...quintResults[qi++]!, ms: 0 }; },
    quintVerify: async () => { calls.push({ fn: 'quintVerify' }); return { ...quintVerifyResults[qvi++]!, ms: 0 }; },
  };
  return { deps, calls };
}

async function setup(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-strengthen-'));
  const modelFile = join(dir, 'm.json');
  writeFileSync(modelFile, JSON.stringify(stripSettleGuard(subscriptionsModel)));
  await runCommand(['init', '--session', dir, '--model', modelFile], inertDeps);
  await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
    { id: 'pe', name: 'paidExact', prior: 1, source: 'seed', candidate: paidExactCandidate },
  ])], inertDeps);

  // Adopt paidExact directly (skip elicitation), same pattern as cli-classify.test.ts's setup.
  const stateFile = join(dir, 'state.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const c = st.candidates.find((c: any) => c.inv.id === 'pe');
  c.status = 'adopted';
  writeFileSync(stateFile, JSON.stringify(st));
  const ledgerFile = join(dir, 'ledger.jsonl');
  writeFileSync(ledgerFile, JSON.stringify({ kind: 'adopted', at: new Date().toISOString(), invariant: c.inv, provenance: 'test' }) + '\n');
  return dir;
}

describe('engine strengthen CLI', () => {
  it('missing --name is rejected before touching the model', async () => {
    const r: any = await runCommand(['strengthen', '--session', '/nonexistent'], inertDeps);
    expect(r).toEqual({ error: 'missing-arg', arg: 'name' });
  });

  it('--name naming a non-adopted invariant returns not-found, never a silent no-op', async () => {
    const dir = await setup();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'noSuchInvariant'], inertDeps);
    expect(r.error).toBe('unknown-invariant');
    expect(r.name).toBe('noSuchInvariant');
  });

  it('auto-adopt: runs the engine, adopts the winning guard, and appends a ledger entry', async () => {
    const dir = await setup();
    const { deps, calls } = scriptedDeps();
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], deps);

    expect(r.strengthened).toMatchObject({
      kind: 'auto-adopt',
      guard: { transition: 'settle', predicate: { op: 'eq' } },
    });
    // 1 reachability + 3 consistency + 3 closes-check calls = 4 quintVerify, 3 quint.
    expect(calls.filter((c) => c.fn === 'quintVerify')).toHaveLength(4);
    expect(calls.filter((c) => c.fn === 'quint')).toHaveLength(3);

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const guardCandidate = st.candidates.find((c: any) => c.inv.candidate.kind === 'guard');
    expect(guardCandidate).toBeDefined();
    expect(guardCandidate.status).toBe('adopted');
    expect(guardCandidate.inv.candidate).toMatchObject({
      kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
      predicate: { kind: 'cmp', op: 'eq' },
    });

    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const adoptedGuardEntries = ledger.filter((e: any) => e.kind === 'adopted' && e.invariant.candidate.kind === 'guard');
    expect(adoptedGuardEntries).toHaveLength(1);
    expect(adoptedGuardEntries[0].provenance).toMatch(/^strengthen /);
  });

  it('a non auto-adopt Resolution (e.g. no-transition) is surfaced without mutating adopted candidates', async () => {
    const dir = await setup();
    // A reachability probe that reports no violation ⇒ 'no-transition' (nothing to strengthen) —
    // the engine returns after its very first quintVerify call, no further probes.
    const deps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 0 }),
      quint: async () => ({ violated: false, ms: 0 }),
      quintVerify: async () => ({ violated: false, ms: 0 }),
    };
    const r: any = await runCommand(['strengthen', '--session', dir, '--name', 'paidExact'], deps);
    expect(r.strengthened.kind).toBe('no-transition');

    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(st.candidates.some((c: any) => c.inv.candidate.kind === 'guard')).toBe(false);
  });
});
