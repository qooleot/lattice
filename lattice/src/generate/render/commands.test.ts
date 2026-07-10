import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { renderDdl } from './sql.js';
import { renderRepo } from './repo.js';
import { renderCommands } from './commands.js';
import { renderTypes } from './types.js';
import { buildPlan } from '../plan.js';
import { tinyInput } from '../fixtures.js';
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
