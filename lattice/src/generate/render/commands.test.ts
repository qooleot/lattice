import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { renderDdl } from './sql.js';
import { renderRepo } from './repo.js';
import { renderCommands } from './commands.js';
import { renderTypes } from './types.js';
import { buildPlan } from '../plan.js';
import { tinyInput } from '../fixtures.js';
import type { GenInput } from '../types.js';
import { loadGeneratedModule } from '../../../test-support/loadGenerated.js';

// Task 6 in isolation: the real invariants.ts renderer is Task 7. Stub the one check the
// tinyInput fixture's adopted invariant (nonNegativeBalance) needs, over the flat row shape
// commands.ts expects.
const invariantsStub = `export const checkNonNegativeBalance = (row) => row.balance >= 0;\n`;

function getStatus(db: Database.Database, accountId: string): string {
  return (db.prepare('SELECT status FROM Account WHERE accountId=?').get(accountId) as { status: string }).status;
}

describe('generated command handlers', () => {
  it('rejects a guarded transition and rolls back; permits when the guard holds', async () => {
    const plan = buildPlan(tinyInput);
    const db = new Database(':memory:');
    db.exec(renderDdl(plan));
    const mod = await loadGeneratedModule({
      'types.ts': renderTypes(plan),
      'invariants.ts': invariantsStub,
      'repo.ts': renderRepo(plan),
      'commands.ts': renderCommands(plan),
    });
    mod.insertAccount(db, { accountId: 'a1', balance: 5, status: 'open' });

    const bad = mod.close(db, 'a1');           // guard: balance == 0, but balance is 5
    expect(bad.ok).toBe(false);
    expect(bad.rejected).toMatch(/close/);
    expect(getStatus(db, 'a1')).toBe('open'); // rolled back

    db.prepare('UPDATE Account SET balance=0 WHERE accountId=?').run('a1');
    const good = mod.close(db, 'a1');
    expect(good.ok).toBe(true);
    expect(getStatus(db, 'a1')).toBe('closed');
  });

  it('rejects a transition attempted from an illegal from-state', async () => {
    const plan = buildPlan(tinyInput);
    const db = new Database(':memory:');
    db.exec(renderDdl(plan));
    const mod = await loadGeneratedModule({
      'types.ts': renderTypes(plan),
      'invariants.ts': invariantsStub,
      'repo.ts': renderRepo(plan),
      'commands.ts': renderCommands(plan),
    });
    mod.insertAccount(db, { accountId: 'a1', balance: 0, status: 'closed' });

    const res = mod.close(db, 'a1');
    expect(res.ok).toBe(false);
    expect(res.rejected).toMatch(/illegal from-state/);
    expect(getStatus(db, 'a1')).toBe('closed');
  });

  it('rejects a transition against a missing row', async () => {
    const plan = buildPlan(tinyInput);
    const db = new Database(':memory:');
    db.exec(renderDdl(plan));
    const mod = await loadGeneratedModule({
      'types.ts': renderTypes(plan),
      'invariants.ts': invariantsStub,
      'repo.ts': renderRepo(plan),
      'commands.ts': renderCommands(plan),
    });

    const res = mod.close(db, 'does-not-exist');
    expect(res.ok).toBe(false);
    expect(res.rejected).toMatch(/not found/);
  });
});

// Task 6 review fix: table-kind (unique) invariants must be re-checked at commit too, not just
// row-kind (statePredicate) ones. Real spec precedent: Subscriptions adopts
// `oneDraftInvoicePerSubscription` (a `unique` invariant) — a transition into the scoped state
// could violate it with nothing re-checking it before commit.
const docInput: GenInput = {
  model: {
    context: 'Docs', enums: [], values: [], entities: [], events: [], services: [],
    aggregates: [{
      kind: 'aggregate', name: 'Doc',
      fields: [
        { name: 'docId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'owner', type: { kind: 'prim', prim: 'Text' } },
      ],
      machine: {
        regions: [{ name: 'status', initial: 'draft', states: [
          { name: 'draft', tags: [] }, { name: 'published', tags: [] }] }],
        transitions: [{ name: 'publish', region: 'status', from: ['draft'], to: 'published' }],
      },
    }],
  },
  adopted: [{
    id: 'inv-onepub', name: 'onePublishedPerOwner', prior: 1, source: 'seed',
    candidate: { kind: 'unique', aggregate: 'Doc',
      whileStates: { region: 'status', states: ['published'] }, by: [['owner']] },
  }],
  ledger: [
    { kind: 'adopted', at: '2026-01-01', invariant: { id: 'inv-onepub', name: 'onePublishedPerOwner', prior: 1, source: 'seed',
        candidate: { kind: 'unique', aggregate: 'Doc',
          whileStates: { region: 'status', states: ['published'] }, by: [['owner']] } },
      provenance: 'seed:template' } as any,
  ],
};

// The Task 7 invariants.ts renderer emits the real check function; here we stub it exactly the
// way the compiled `unique` bodyTs (src/generate/invariantCheck.ts) expects: a function of `rows`.
const docInvariantsStub =
  `export const checkOnePublishedPerOwner = (rows) => (() => { const seen = new Set(); ` +
  `for (const r of rows) { if (!(['published'].includes(r.status))) continue; ` +
  `const k = r.owner; if (seen.has(k)) return false; seen.add(k); } return true; })();\n`;

function getDocStatus(db: Database.Database, docId: string): string {
  return (db.prepare('SELECT status FROM Doc WHERE docId=?').get(docId) as { status: string }).status;
}

describe('generated command handlers — table-kind (unique) invariant re-check', () => {
  it('rejects a transition that would violate a unique invariant, and rolls back', async () => {
    const plan = buildPlan(docInput);
    const db = new Database(':memory:');
    db.exec(renderDdl(plan));
    const mod = await loadGeneratedModule({
      'types.ts': renderTypes(plan),
      'invariants.ts': docInvariantsStub,
      'repo.ts': renderRepo(plan),
      'commands.ts': renderCommands(plan),
    });
    mod.insertDoc(db, { docId: 'doc1', owner: 'o1', status: 'published' });
    mod.insertDoc(db, { docId: 'doc2', owner: 'o1', status: 'draft' });

    const res = mod.publish(db, 'doc2');
    expect(res.ok).toBe(false);
    expect(res.rejected).toMatch(/onePublishedPerOwner/);
    expect(getDocStatus(db, 'doc2')).toBe('draft'); // rolled back
  });

  it('permits a transition that does not violate the unique invariant', async () => {
    const plan = buildPlan(docInput);
    const db = new Database(':memory:');
    db.exec(renderDdl(plan));
    const mod = await loadGeneratedModule({
      'types.ts': renderTypes(plan),
      'invariants.ts': docInvariantsStub,
      'repo.ts': renderRepo(plan),
      'commands.ts': renderCommands(plan),
    });
    mod.insertDoc(db, { docId: 'doc1', owner: 'o1', status: 'published' });
    mod.insertDoc(db, { docId: 'doc2', owner: 'o2', status: 'draft' });

    const res = mod.publish(db, 'doc2');
    expect(res.ok).toBe(true);
    expect(getDocStatus(db, 'doc2')).toBe('published');
  });
});
