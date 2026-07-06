import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { traceAModel } from './fixtures.js';

const dpsf = { entities: [
  { type: 'Customer', id: 'c1', fields: {} }, { type: 'Family', id: 'f1', fields: {} },
  { type: 'Plan', id: 'p1', fields: { family: 'f1' } }, { type: 'Plan', id: 'p2', fields: { family: 'f1' } },
  { type: 'Subscription', id: 's1', fields: { customer: 'c1', plan: 'p1', 'Access.state': 'Active' } },
  { type: 'Subscription', id: 's2', fields: { customer: 'c1', plan: 'p2', 'Access.state': 'Active' } }
]};
const fakeDeps: any = { alloy: async () => ({ sat: true, instances: [dpsf], ms: 3 }), quint: async () => ({ violated: false, ms: 3 }) };

describe('engine CLI', () => {
  it('drives init → propose → next-question → verdict end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const modelFile = join(dir, 'model.json');
    writeFileSync(modelFile, JSON.stringify(traceAModel));

    const init: any = await runCommand(['init', '--session', dir, '--model', modelFile], fakeDeps);
    expect(init.adopted.length).toBeGreaterThan(0);          // templates fired (NoOrphan at least)
    expect(init.seeds.length).toBeGreaterThan(0);            // unique-per-ref seeds

    const cands = [
      { id: 'H1', name: 'perCustomer', prior: 0.35, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'perPlan', prior: 0.4, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer'], ['plan']] } }
    ];
    const prop: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(cands)], fakeDeps);
    expect(prop.registered).toBe(2);

    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    expect(q.type).toBe('question');
    expect(q.table).toContain('| Subscription |');

    const v: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'forbid'], fakeDeps);
    expect(v.pruned).toContain('H2');

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.find((c: any) => c.id === 'H1').status).toBe('active');
  });

  it('rejects out-of-grammar proposals with diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = [{ id: 'X', name: 'x', prior: 0.5, source: 'seed',
      candidate: { kind: 'unique', aggregate: 'Nope', whileStates: { region: 'R', states: ['S'] }, by: [['f']] } }];
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('out-of-grammar');
    expect(r.diagnostics[0].code).toBe('unknown-aggregate');
  });

  it('undecided verdicts park an open decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'h2', prior: 0.4, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['plan']] } }
    ])], fakeDeps);
    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    const r: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'undecided', '--topic', 'family-policy', '--note', 'experts disagree'], fakeDeps);
    expect(r.parked).toBe(true);
    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.openDecisions).toBe(1);
  });

  it('regenerate in alternatives phase runs checkDistinct before admit — equivalent candidate is rejected without admitting and bumps alternativeAttempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Force the session straight into the alternatives phase with a sole active survivor H1.
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    writeFileSync(stateFile, JSON.stringify(st));

    // checkDistinct calls deps.alloy for a 'distinguish' query between the survivor and the new
    // candidate; returning sat:false (UNSAT) means no distinguishing witness exists ⇒ equivalent.
    const equivalentDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };

    const alt = { id: 'A1', name: 'a1', prior: 0.6, source: 'alternative',
      candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } };
    const r: any = await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(alt)], equivalentDeps);

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/equivalent/i);
    expect(r.attemptsLeft).toBe(1);

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st2.alternativeAttempts).toBe(1);
    // The equivalent candidate must NOT have been admitted as a new tracked candidate.
    expect(st2.candidates.find((c: any) => c.id === 'A1')).toBeUndefined();
  });

  it('next-question returning converged marks the sole survivor adopted and appends a ledger adopted entry with elicited provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Drive the session to the brink of convergence: sole active survivor, both probes already
    // asked, alternativeAttempts already exhausted (2) — next-question should return converged.
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    // Seed a verdict ledger entry so we can check provenance references it.
    const ledgerFile = join(dir, 'ledger.jsonl');
    writeFileSync(ledgerFile, JSON.stringify({ kind: 'verdict', at: 't', witnessId: 'w1', witness: { entities: [] }, salient: [], judge: 'forbid', question: '' }) + '\n');

    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);
    expect(q.type).toBe('converged');

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    const h1 = st2.candidates.find((c: any) => c.id === 'H1');
    expect(h1.status).toBe('adopted');

    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const adoptedEntry = ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H1');
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry.provenance).toContain('w1');
  });

  it('next-question returning converged with zero verdicts parks the survivor as an unanchored-survivor open decision instead of adopting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } }
    ])], fakeDeps);

    // Drive the session to the brink of convergence: sole active survivor, both probes already
    // asked, alternativeAttempts already exhausted (2) — next-question should return converged.
    // Crucially, the ledger has NO verdict entries (probes returned UNSAT, alternatives exhausted
    // without ever getting a judged case) — the survivor must not be silently adopted.
    const stateFile = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    st.phase = 'alternatives';
    st.alternativeAttempts = 2;
    st.probesAsked = { forbid: true, permit: true };
    writeFileSync(stateFile, JSON.stringify(st));

    // sat:false deps ⇒ no witnesses were ever produced for this candidate; UNSAT throughout.
    const unsatDeps: any = { alloy: async () => ({ sat: false, instances: [], ms: 1 }), quint: async () => ({ violated: false, ms: 1 }) };

    const q: any = await runCommand(['next-question', '--session', dir], unsatDeps);
    expect(q.type).toBe('converged');
    expect(q.warning).toBe('unanchored-survivor-parked');

    const st2: any = await runCommand(['status', '--session', dir], fakeDeps);
    const h1 = st2.candidates.find((c: any) => c.id === 'H1');
    expect(h1.status).toBe('parked');

    const ledgerFile = join(dir, 'ledger.jsonl');
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    const openDecision = ledger.find((e: any) => e.kind === 'open-decision' && e.topic === 'unanchored-survivor');
    expect(openDecision).toBeDefined();
    // Template auto-adopts at init (e.g. NoOrphan_Subscription) are unrelated and expected; the
    // elicited survivor H1 specifically must never get an 'adopted' ledger entry.
    expect(ledger.find((e: any) => e.kind === 'adopted' && e.invariant.id === 'H1')).toBeUndefined();
  });

  it('emit writes prose + code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const out: any = await runCommand(['emit', '--session', dir, '--out', dir], fakeDeps);
    expect(existsSync(join(dir, 'spec.prose.md'))).toBe(true);
    expect(readFileSync(join(dir, 'spec.lat'), 'utf8')).toContain('context Billing {');
    expect(out.written.length).toBe(2);
  });

  it('emit lists an adopted implied-shape rule once in prose even with jumbled key order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-dedup-'));
    const model = {
      context: 'Dedup', enums: [], events: [], entities: [],
      aggregates: [{ kind: 'aggregate', name: 'Box', fields: [
        { name: 'boxId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    };
    writeFileSync(join(dir, 'm.json'), JSON.stringify(model));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    // jumble the stored adopted candidate's key order so raw JSON.stringify comparison would differ
    const statePath = join(dir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const adoptedEntry = state.candidates.find((c: any) => c.status === 'adopted' && c.inv.candidate.kind === 'statePredicate');
    const reorder = (o: any): any => Array.isArray(o) ? o.map(reorder)
      : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).reverse().map(k => [k, reorder(o[k])])) : o;
    adoptedEntry.inv.candidate = reorder(adoptedEntry.inv.candidate);
    writeFileSync(statePath, JSON.stringify(state));
    // init template-adopts NonNegative_Box_amount whose candidate matches the implied rule
    const r: any = await runCommand(['emit', '--session', dir, '--out', dir], fakeDeps);
    expect(r.written).toBeDefined();
    const prose = readFileSync(join(dir, 'spec.prose.md'), 'utf8');
    const hits = prose.split('\n').filter(l => l.includes('amount') && l.includes('never') === false && l.includes('≥ 0'));
    expect(hits.length).toBe(1);
  });

  it('rejects an invalid --judge without touching state or ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify([
      { id: 'H1', name: 'h1', prior: 0.5, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['customer']] } },
      { id: 'H2', name: 'h2', prior: 0.4, source: 'seed', candidate: { kind: 'unique', aggregate: 'Subscription', whileStates: { region: 'Access', states: ['Active'] }, by: [['plan']] } }
    ])], fakeDeps);
    const q: any = await runCommand(['next-question', '--session', dir], fakeDeps);

    const beforeLedgerCount = ((await runCommand(['status', '--session', dir], fakeDeps)) as any).ledgerCount;

    const r: any = await runCommand(['verdict', '--session', dir, '--witness', q.witnessId, '--judge', 'bogus'], fakeDeps);
    expect(r.error).toBe('invalid-judge');
    expect(r.allowed).toEqual(['permit', 'forbid', 'undecided']);

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.find((c: any) => c.id === 'H1').status).toBe('active');
    expect(st.candidates.find((c: any) => c.id === 'H2').status).toBe('active');
    expect(st.ledgerCount).toBe(beforeLedgerCount);
  });

  it('propose rejects unsolvable candidate kinds (terminal/monotonic/leadsTo/refsResolve) as not-elicitable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = [
      { id: 'T1', name: 't1', prior: 0.5, source: 'seed', candidate: { kind: 'terminal', aggregate: 'Subscription', region: 'Access', state: 'Ended' } },
      { id: 'M1', name: 'm1', prior: 0.5, source: 'seed', candidate: { kind: 'monotonic', aggregate: 'Subscription', field: ['grace'] } }
    ];
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('not-elicitable');
    expect(r.kinds).toEqual(['terminal', 'monotonic']);
    expect(r.hint).toMatch(/template-adopted/);

    const st: any = await runCommand(['status', '--session', dir], fakeDeps);
    expect(st.candidates.some((c: any) => c.id === 'T1' || c.id === 'M1')).toBe(false);
  });

  it('regenerate rejects an unsolvable candidate kind as not-elicitable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(dir, 'm.json'), JSON.stringify(traceAModel));
    await runCommand(['init', '--session', dir, '--model', join(dir, 'm.json')], fakeDeps);
    const bad = { id: 'R1', name: 'r1', candidate: { kind: 'refsResolve', aggregate: 'Subscription' } };
    const r: any = await runCommand(['regenerate', '--session', dir, '--candidate', JSON.stringify(bad)], fakeDeps);
    expect(r.error).toBe('not-elicitable');
    expect(r.kinds).toEqual(['refsResolve']);
  });

  it('structure command appends a structure ledger entry and works pre-init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['structure', '--session', dir, '--question', 'What are the aggregates?', '--answer', 'Subscription, Customer'], fakeDeps);
    expect(r.ok).toBe(true);
    expect(r.ledgerCount).toBe(1);
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
    expect(ledger[0].kind).toBe('structure');
    expect(ledger[0].question).toBe('What are the aggregates?');
    expect(ledger[0].answer).toBe('Subscription, Customer');
  });

  it('missing --model on init returns a structured missing-arg error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['init', '--session', dir], fakeDeps);
    expect(r.error).toBe('missing-arg');
    expect(r.arg).toBe('model');
  });

  it('propose before init returns no-model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['propose', '--session', dir, '--candidates', '[]'], fakeDeps);
    expect(r.error).toBe('no-model');
  });

  it('malformed inline JSON returns bad-json-or-path instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['init', '--session', dir, '--model', '{not valid json'], fakeDeps);
    expect(r.error).toBe('bad-json-or-path');
    expect(typeof r.detail).toBe('string');
  });

  it('unknown command still returns a structured error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const r: any = await runCommand(['bogus-command', '--session', dir], fakeDeps);
    expect(r.error).toBe('unknown-command');
    expect(r.cmd).toBe('bogus-command');
  });
});
