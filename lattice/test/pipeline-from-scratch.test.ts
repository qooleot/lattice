import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, realDeps } from '../src/cli.js';
import { evaluateCandidate } from '../src/engine/evaluate.js';
import type { DomainModel } from '../src/ast/domain.js';
import type { Candidate } from '../src/ast/invariant.js';

const latticeDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// The one continuous from-scratch pipeline test: elicit -> emit -> apply (round-trip) -> generate
// -> execute, all in a single run, starting from nothing committed. Every other test in this suite
// exercises one hop of the pipeline in isolation (against fixtures or the committed subscriptions
// example); this is the only one that walks the whole path end to end with real solvers, the way a
// first-time user following docs/getting-started.md actually would.
//
// A tiny domain, chosen to keep solver turns fast: one aggregate (Order) with a 3-state lifecycle,
// one guarded/emitting transition, a Money field (for free NonNegative-template coverage and to
// drive the invariant-rollback scenario), and a `unique` invariant (Alloy-routed — ~1s/question,
// unlike arithmetic statePredicates which route to the slower Quint/Apalache path) that needs the
// Customer entity to be elicitable at all.
describe('pipeline from scratch: elicit -> emit -> apply -> generate -> execute', () => {
  it('walks structure -> init -> propose/converge -> emit -> apply round-trip -> generate -> a real running service', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'lat-pipeline-session-'));

    // --- Step 1: structure — two structure Q&A ledger entries, exactly as elicit-spec records
    // them before any model exists. ---
    const s1: any = await runCommand(['structure', '--session', sessionDir,
      '--question', 'What is the core aggregate and its lifecycle?',
      '--answer', 'Order: Pending -> Active (guarded by a settled balance, announces OrderActivated) -> Closed (terminal).'],
      realDeps);
    expect(s1.ok).toBe(true);
    expect(s1.ledgerCount).toBe(1);
    const s2: any = await runCommand(['structure', '--session', sessionDir,
      '--question', 'What business rule constrains concurrent orders?',
      '--answer', 'A customer may have at most one Pending order at a time, regardless of channel.'],
      realDeps);
    expect(s2.ok).toBe(true);
    expect(s2.ledgerCount).toBe(2);

    // --- Step 2: init — a tiny domain designed for fast (Alloy-routed) solver turns. ---
    const model: DomainModel = {
      context: 'Orders', ticksPerDay: 24,
      enums: [{ name: 'OrderChannel', values: ['Web', 'Phone'] }],
      values: [],
      entities: [
        { kind: 'entity', name: 'Customer', fields: [{ name: 'custId', type: { kind: 'prim', prim: 'Id' }, key: true }] },
      ],
      aggregates: [{
        kind: 'aggregate', name: 'Order',
        fields: [
          { name: 'orderId', type: { kind: 'prim', prim: 'Id' }, key: true },
          { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
          { name: 'channel', type: { kind: 'enum', enum: 'OrderChannel' } },
          { name: 'balance', type: { kind: 'prim', prim: 'Money' }, tags: ['unsigned'] },
        ],
        machine: {
          regions: [{ name: 'status', initial: 'Pending', states: [
            { name: 'Pending' }, { name: 'Active', tags: ['active'] }, { name: 'Closed', tags: ['terminal'] }] }],
          transitions: [{
            name: 'activate', region: 'status', from: ['Pending'], to: 'Active',
            requires: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['balance'] }, right: { kind: 'int', value: 0 } },
            emits: 'OrderActivated',
          }],
        },
      }],
      events: [{ name: 'OrderActivated', fields: [{ name: 'orderId', type: { kind: 'prim', prim: 'Id' } }] }],
      services: [{
        name: 'OrderService',
        methods: [
          { name: 'createOrder', params: [
              { name: 'customer', type: { kind: 'ref', target: 'Customer' } },
              { name: 'channel', type: { kind: 'enum', enum: 'OrderChannel' } },
              { name: 'balance', type: { kind: 'prim', prim: 'Money' } }],
            kind: { creates: 'Order' }, returns: { kind: 'ref', target: 'Order' } },
          { name: 'getOrder', params: [{ name: 'orderId', type: { kind: 'prim', prim: 'Id' } }],
            kind: { readOnly: true }, returns: { kind: 'ref', target: 'Order' } },
          { name: 'activate', params: [{ name: 'orderId', type: { kind: 'prim', prim: 'Id' } }],
            kind: { performs: { aggregate: 'Order', transition: 'activate' } } },
        ],
      }],
    };
    const modelFile = join(sessionDir, 'model.json');
    writeFileSync(modelFile, JSON.stringify(model));

    const init: any = await runCommand(['init', '--session', sessionDir, '--model', modelFile], realDeps);
    expect(init.adopted.map((a: any) => a.name)).toContain('nonNegativeOrderBalance');   // free Money template

    // --- Step 3: propose two `unique` rivals and drive next-question/verdict/probes/alternatives
    // until convergence, judged against the ground-truth candidate (H1: the real business rule from
    // the structure answer above — Pending is scoped by customer alone) via evaluateCandidate, never
    // hand-scripted. ---
    const groundTruth: Candidate = {
      kind: 'unique', aggregate: 'Order',
      whileStates: { region: 'status', states: ['Pending'] }, by: [['customer']],
    };
    const cands = [
      { id: 'H1', name: 'onePendingPerCustomer', prior: 0.5, source: 'seed', candidate: groundTruth },
      { id: 'H2', name: 'onePendingPerCustomerChannel', prior: 0.4, source: 'seed', candidate: {
        kind: 'unique', aggregate: 'Order',
        whileStates: { region: 'status', states: ['Pending'] }, by: [['customer'], ['channel']],
      } as Candidate },
    ];
    const prop: any = await runCommand(['propose', '--session', sessionDir, '--candidates', JSON.stringify(cands)], realDeps);
    expect(prop.registered).toBe(2);

    let firstVerdictWitnessId: string | undefined;
    let steps = 0;
    const MAX_STEPS = 8;
    let out: any = await runCommand(['next-question', '--session', sessionDir], realDeps);

    while (out.type !== 'converged' && steps < MAX_STEPS) {
      steps++;
      if (out.type === 'question') {
        const v: any = await runCommand(['verdict', '--session', sessionDir,
          '--witness', out.witnessId, '--judge', evaluateCandidate(groundTruth, out.witness)], realDeps);
        expect(v.error).toBeUndefined();
        if (!firstVerdictWitnessId) firstVerdictWitnessId = out.witnessId;
      } else if (out.type === 'probe-options') {
        for (const opt of out.options)
          await runCommand(['verdict', '--session', sessionDir,
            '--witness', opt.witnessId, '--judge', evaluateCandidate(groundTruth, opt.witness)], realDeps);
      } else if (out.type === 'need-alternatives') {
        const rg: any = await runCommand(['regenerate', '--session', sessionDir,
          '--candidate', JSON.stringify({ id: `ALT${steps}`, name: `alt${steps}`, candidate: groundTruth })], realDeps);
        expect(rg.ok).toBe(false);
        expect(rg.reason).toMatch(/equivalent/i);
      } else if (out.type === 'regenerate') {
        throw new Error(`unexpected regenerate-phase output: ${JSON.stringify(out)}`);
      }
      out = await runCommand(['next-question', '--session', sessionDir], realDeps);
    }
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(out.type).toBe('converged');
    expect(firstVerdictWitnessId).toBeDefined();

    const st: any = await runCommand(['status', '--session', sessionDir], realDeps);
    const h1 = st.candidates.find((c: any) => c.id === 'H1');
    expect(h1.status).toBe('adopted');

    // --- Step 4: emit — spec.lat + spec.prose.md, prose carries the adopted rule with its
    // witness-anchored provenance. ---
    const emitDir = join(sessionDir, 'emit-out');
    const emit: any = await runCommand(['emit', '--session', sessionDir, '--out', emitDir], realDeps);
    expect(emit.written.length).toBeGreaterThan(0);

    const specLatPath = join(emitDir, 'spec.lat');
    expect(existsSync(specLatPath)).toBe(true);
    const prosePath = join(emitDir, 'spec.prose.md');
    expect(existsSync(prosePath)).toBe(true);
    const prose = readFileSync(prosePath, 'utf8');
    expect(prose).toMatch(/Only one Order may be Pending per \(customer\)\./);
    expect(prose).toContain(firstVerdictWitnessId!);   // anchor: the judged case that convergence rests on

    // --- Step 5: round-trip hop — apply the freshly emitted spec.lat back against the SAME
    // session. Nothing changed since emit, so this must be a clean no-op (pins emit ≡ parse).
    // --no-classify: classification re-runs quint on every adopted invariant × method, adding
    // solver time this pipeline test doesn't need to pay for (its behavior is already covered by
    // cli-classify.test.ts and cli-apply.test.ts). ---
    const apply: any = await runCommand(['apply', '--session', sessionDir, '--lat', specLatPath, '--no-classify'], realDeps);
    expect(apply.error).toBeUndefined();
    expect(apply.ok).toBe(true);
    expect(apply.applied).toEqual([]);   // no additions/removals/renames — model and ledger already agree

    // --- Step 6: generation hop via the .lat-canonical seam (commit 8bcc65c) — generate straight
    // from the emitted spec.lat, with the session ledger for provenance. The output directory must
    // live inside lattice/ (not OS tmpdir): the generated commands.ts/db.ts import 'better-sqlite3'
    // by bare specifier, and Node's ESM resolver walks up from the importing file looking for a
    // node_modules that has it — lattice/node_modules already carries better-sqlite3 as a
    // devDependency (used by the committed generated/subscriptions package too), so placing the
    // output under lattice/ lets that resolution succeed with no npm install, no symlink, and no
    // new dependency. This is also required for vitest's own module loader to be willing to
    // transform the dynamically-imported .ts files below (they must be inside the project root).
    const genOut = mkdtempSync(join(latticeDir, '.tmp-pipeline-gen-'));
    try {
      const gen: any = await runCommand(
        ['generate', '--spec', specLatPath, '--ledger', sessionDir, '--out', genOut], realDeps);
      expect(gen.error).toBeUndefined();
      expect(existsSync(join(genOut, 'commands.ts'))).toBe(true);
      expect(existsSync(join(genOut, 'schema.sql'))).toBe(true);

      // --- Step 7: execute the generated service for real — import the generated modules
      // in-process (plain relative/absolute TS imports; no build step) and drive three scenarios
      // against a real on-disk-format (here in-memory) better-sqlite3 database. No network calls,
      // no mocks. ---
      const dbMod: any = await import(pathToFileURL(join(genOut, 'db.ts')).href);
      const repoMod: any = await import(pathToFileURL(join(genOut, 'repo.ts')).href);
      const commandsMod: any = await import(pathToFileURL(join(genOut, 'commands.ts')).href);
      const { openDb } = dbMod;
      const { insertOrder, getOrder } = repoMod;   // repos exist per AGGREGATE; Customer is an entity (no table)
      const { activate } = commandsMod;

      const db = openDb(':memory:');
      try {
        // (a) guard-rejected: balance > 0 (not settled) fails the `activate` guard (balance <= 0)
        // before any state change.
        insertOrder(db, { orderId: 'ord-reject', customer: 'cust-1', channel: 'Web', balance: 50, status: 'Pending' });
        const rejected = activate(db, 'ord-reject');
        expect(rejected.ok).toBe(false);
        expect(rejected.rejected).toMatch(/requires guard failed/);
        expect((getOrder(db, 'ord-reject') as any).status).toBe('Pending');   // no state change
        expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c).toBe(0);

        // (b) successful transition: balance settled (<=0) passes the guard, status flips to
        // Active, and the declared `emits` event lands as an outbox row.
        insertOrder(db, { orderId: 'ord-ok', customer: 'cust-1', channel: 'Web', balance: 0, status: 'Pending' });
        const ok = activate(db, 'ord-ok');
        expect(ok.ok).toBe(true);
        expect(ok.event).toBe('OrderActivated');
        expect((getOrder(db, 'ord-ok') as any).status).toBe('Active');
        const outboxRows = db.prepare('SELECT * FROM outbox WHERE aggregate_id = ?').all('ord-ok') as any[];
        expect(outboxRows.length).toBe(1);
        expect(outboxRows[0].event_type).toBe('OrderActivated');
        expect(JSON.parse(outboxRows[0].payload)).toEqual({ orderId: 'ord-ok' });

        // (c) invariant-violating write rejected: balance is negative (still <= 0, so the guard
        // itself passes) but the free nonNegativeOrderBalance implied invariant fails at
        // commit time — the whole transaction rolls back, leaving the aggregate at Pending and no
        // outbox row, exactly like generated/subscriptions/demo.ts's scenario 3.
        insertOrder(db, { orderId: 'ord-rollback', customer: 'cust-1', channel: 'Web', balance: -25, status: 'Pending' });
        const rolledBack = activate(db, 'ord-rollback');
        expect(rolledBack.ok).toBe(false);
        expect(rolledBack.rejected).toMatch(/invariant/);
        expect((getOrder(db, 'ord-rollback') as any).status).toBe('Pending');   // rolled back
        expect((db.prepare('SELECT COUNT(*) c FROM outbox WHERE aggregate_id = ?').get('ord-rollback') as any).c).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(genOut, { recursive: true, force: true });
    }
  }, 90_000);
});
