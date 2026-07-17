import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, realDeps, guardChangeWarnings } from '../src/cli.js';
import type { DomainModel } from '../src/ast/domain.js';

const SESSION_SRC = join(import.meta.dirname, '../../.lattice-session-subscriptions');

// NOTE: these tests run AFTER Task 12's migration in plan order, but they are written to be
// order-independent: they regenerate the .lat from the session model via `emit` first, so they
// never depend on the committed spec.lat's naming era.
let dir: string, sessionDir: string, specDir: string, latFile: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lat-apply-'));
  sessionDir = join(dir, 'session');
  specDir = join(dir, 'spec');
  cpSync(SESSION_SRC, sessionDir, { recursive: true });
  mkdirSync(specDir, { recursive: true });
  const r: any = await runCommand(['emit', '--session', sessionDir, '--out', specDir], realDeps);
  expect(r.written).toBeDefined();
  latFile = join(specDir, 'spec.lat');
});

const apply = (extra: string[] = []) =>
  runCommand(['apply', '--session', sessionDir, '--lat', latFile, ...extra], realDeps);

describe('engine apply', () => {
  it('no-op apply succeeds and is idempotent on the normalized file', async () => {
    const before = readFileSync(latFile, 'utf8');
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(readFileSync(latFile, 'utf8')).toBe(before);
    expect(existsSync(join(specDir, 'spec.prose.md'))).toBe(true);

    // diagrams are projections too: writeProjections also writes spec.diagrams.md + .mmd files
    const diagramsMd = join(specDir, 'spec.diagrams.md');
    const cdMmd = join(specDir, 'diagrams', 'CD_Subscriptions.mmd');
    expect(r.written).toContain(diagramsMd);
    expect(r.written).toContain(cdMmd);
    expect(existsSync(diagramsMd)).toBe(true);
    expect(existsSync(cdMmd)).toBe(true);
    // both member aggregates (Subscription/status, Invoice/settlement) get their own SD file
    const sdSubscription = join(specDir, 'diagrams', 'SD_Subscription_status.mmd');
    const sdInvoice = join(specDir, 'diagrams', 'SD_Invoice_settlement.mmd');
    expect(r.written).toContain(sdSubscription);
    expect(r.written).toContain(sdInvoice);
    expect(existsSync(sdSubscription)).toBe(true);
    expect(existsSync(sdInvoice)).toBe(true);
  });

  it('parse errors refuse and write nothing', async () => {
    const before = readFileSync(latFile, 'utf8');
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    writeFileSync(latFile, before + '\n// stray comment\n');
    const r: any = await apply();
    expect(r.error).toBe('parse-failed');
    expect(r.diagnostics[0]!.code).toBe('comment-banned');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });

  it('applying a contextMap file refuses as wrong-file-kind', async () => {
    writeFileSync(latFile, 'contextMap Acme {\n  contains Billing\n}\n');
    const r: any = await apply();
    expect(r.error).toBe('parse-failed');
    expect(r.diagnostics.some((d: any) => d.code === 'wrong-file-kind')).toBe(true);
  });

  it('new transition applies with provenance-free structural note', async () => {
    const text = readFileSync(latFile, 'utf8')
      .replace('transition recover { from pastDue to active }',
        'transition recover { from pastDue to active }\n      transition graceToExpired { from pastDue to expired }');
    writeFileSync(latFile, text);
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(r.applied.join(' ')).toContain('graceToExpired');
    expect(readFileSync(latFile, 'utf8')).toContain('graceToExpired');
    const model = JSON.parse(readFileSync(join(sessionDir, 'model.json'), 'utf8'));
    expect(JSON.stringify(model)).toContain('graceToExpired');
  });

  it('ledger-referenced field rename refuses without the flag, applies with it', async () => {
    const renamed = readFileSync(latFile, 'utf8').replaceAll('accruedUnits', 'usedUnits');
    writeFileSync(latFile, renamed);
    const r1: any = await apply();
    expect(r1.error).toBe('refused');
    expect(JSON.stringify(r1.refusals)).toContain('--rename Subscription.accruedUnits=usedUnits');
    const r2: any = await apply(['--rename', 'Subscription.accruedUnits=usedUnits']);
    expect(r2.ok).toBe(true);
    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"rename"');
    // append-only: original first line untouched
    expect(ledger.split('\n')[0]).toContain('"kind":"structure"');
  });

  it('invariant edit contradicting a judged forbid case is rejected naming the witness', async () => {
    // w5 is forbidden ONLY by the one-draft-per-subscription unique rule (see plan preamble analysis).
    // NOTE: `invoiceId` is a `key`-tagged field (spec P-key semantics; see src/emit/alloy.ts:32,
    // src/emit/quint.ts:26): solver-generated witnesses never populate key fields because the
    // entity's own atom identity already carries that role, so `by (invoiceId)` would resolve to
    // `undefined` for every subject and evaluate as a vacuous (always-forbid) uniqueness key —
    // it can never demonstrate a permit-flip for ANY witness. `totalDue` is a real witness-visible
    // field that differs between the two draft invoices in w5 (14 vs 15), so grouping by it
    // genuinely distinguishes them and flips the invariant to permit, which is what this test needs.
    const text = readFileSync(latFile, 'utf8')
      .replace('unique while settlement in {draft} by (subscription)',
        'unique while settlement in {draft} by (totalDue)');
    writeFileSync(latFile, text);
    const r: any = await apply();
    expect(r.error).toBe('refused');
    const f = r.refusals.find((x: any) => x.code === 'contradicts-verdict');
    expect(f.witnessId).toBe('w5');
    expect(f.verdict).toBe('forbid');
    expect(f.message).toContain('re-judge');
  });

  it('session mid-flight refuses', async () => {
    const state = JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8'));
    state.phase = 'distinguish';
    writeFileSync(join(sessionDir, 'state.json'), JSON.stringify(state));
    const r: any = await apply();
    expect(r.error).toBe('session-busy');
  });

  it('missing session dir hand-authors a fresh one', async () => {
    const fresh = join(dir, 'fresh-session');
    // --no-classify: this fixture carries several quint-expressible adopted invariants, and a
    // fresh-session apply's dependency set is "all of them" (Task 4) — reclassifying them for real
    // here would drive real Apalache calls (see engine/classify.integration.test.ts's 240s-per-call
    // timeouts) in what is otherwise a fast, solver-free unit test about hand-authoring. Reclassify-
    // on-apply itself is covered with scripted deps below.
    const r: any = await runCommand(['apply', '--session', fresh, '--lat', latFile, '--no-classify'], realDeps);
    expect(r.ok).toBe(true);
    const ledger = readFileSync(join(fresh, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('hand-authored');
    expect(r.classification).toBeUndefined();
    const state = JSON.parse(readFileSync(join(fresh, 'state.json'), 'utf8'));
    expect(state.phase).toBe('converged');
  });

  it('--dry-run reports and writes nothing', async () => {
    const text = readFileSync(latFile, 'utf8')
      .replace('transition recover { from pastDue to active }',
        'transition recover { from pastDue to active }\n      transition graceToExpired { from pastDue to expired }');
    writeFileSync(latFile, text);
    const modelBefore = readFileSync(join(sessionDir, 'model.json'), 'utf8');
    const r: any = await apply(['--dry-run']);
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(readFileSync(join(sessionDir, 'model.json'), 'utf8')).toBe(modelBefore);
  });

  it('typo in --rename bare name errors instead of silently ledgering', async () => {
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    const r: any = await apply(['--rename', 'noSuchInvariant=whatever']);
    expect(r.error).toBe('unknown-rename-path');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });

  it('unmatched --rename confirmation on an unchanged file refuses without poisoning the ledger', async () => {
    // the .lat is applied UNCHANGED — accruedUnits is still called accruedUnits, so this --rename
    // does not correspond to any detected rename proposal and must be refused, not ledgered.
    const ledgerBefore = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8');
    const r: any = await apply(['--rename', 'Subscription.accruedUnits=usedUnits']);
    expect(r.error).toBe('refused');
    expect(JSON.stringify(r.refusals)).toContain('unmatched-rename-confirmation');
    expect(readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
  });

  // Task 12, Step 3b: the force-remove declined entry's `reason` is the human's actual ruling
  // (the WHY behind dropping the invariant), not just fixed boilerplate — `--reason` threads
  // through reconcile() into the appended `declined` ledger entry.
  it('--force-remove with --reason records the given reason on the declined entry', async () => {
    // retryCapWhilePastDue is ledger-backed (hand-retryCapWhilePastDue, currently adopted, no
    // later decline) — a real removal target that exercises the needs-force-remove ceremony.
    const text = readFileSync(latFile, 'utf8').replace(
      /\n\s*\/\/\/ While past due, dunning retries on the current invoice never exceed the subscription's cap\.\n\s*invariant retryCapWhilePastDue where state status in \{pastDue\} \{ latestInvoice\.retryCount <= maxRetries \}\n/,
      '\n');
    expect(text).not.toContain('retryCapWhilePastDue');
    writeFileSync(latFile, text);

    const reason = 'settle guard: human ruled the eq bound wrong on 2026-07-16';
    const r: any = await apply(['--force-remove', 'retryCapWhilePastDue', '--reason', reason, '--no-classify']);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const declined = ledger.filter((e: any) => e.kind === 'declined' && e.invariant.name === 'retryCapWhilePastDue');
    expect(declined).toHaveLength(1);
    expect(declined[0].reason).toBe(reason);
  });

  it('--force-remove without --reason falls back to the fixed boilerplate reason', async () => {
    const text = readFileSync(latFile, 'utf8').replace(
      /\n\s*\/\/\/ While past due, dunning retries on the current invoice never exceed the subscription's cap\.\n\s*invariant retryCapWhilePastDue where state status in \{pastDue\} \{ latestInvoice\.retryCount <= maxRetries \}\n/,
      '\n');
    writeFileSync(latFile, text);

    const r: any = await apply(['--force-remove', 'retryCapWhilePastDue', '--no-classify']);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const ledger = readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const declined = ledger.filter((e: any) => e.kind === 'declined' && e.invariant.name === 'retryCapWhilePastDue');
    expect(declined).toHaveLength(1);
    expect(declined[0].reason).toBe('hand-removed via --force-remove');
  });
});

describe('engine apply: workspace context-map hook', () => {
  const MAP = `contextMap Acme {
  contains Catalog
  contains Subscriptions

  Catalog upstream of Subscriptions {
    exposes Plan
  }
}
`;
  const CATALOG_SPEC = `context Catalog {
  entity Plan {
    planId : Id key
    name : Text
  }
}
`;
  const SUBSCRIPTIONS_SPEC = `context Subscriptions {
  aggregate Subscription {
    subId : Id key
    plan : ref Catalog.Plan
  }
}
`;

  const writeMember = (wsDir: string, path: string, text: string) => {
    mkdirSync(join(wsDir, path), { recursive: true });
    writeFileSync(join(wsDir, path, 'spec.lat'), text);
  };

  it('apply inside a workspace attaches workspace.written', async () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'lat-apply-ws-'));
    writeFileSync(join(wsDir, 'context-map.lat'), MAP);
    writeMember(wsDir, 'catalog', CATALOG_SPEC);
    writeMember(wsDir, 'subscriptions', SUBSCRIPTIONS_SPEC);

    const fresh = join(wsDir, 'catalog-session');
    const r: any = await runCommand(
      ['apply', '--session', fresh, '--lat', join(wsDir, 'catalog', 'spec.lat')], realDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.workspace).toBeDefined();
    expect(r.workspace.written).toBeDefined();
    expect(r.workspace.diagnostics).toBeUndefined();
    expect(existsSync(join(wsDir, 'context-map.generated.md'))).toBe(true);
  });

  it('apply with a broken sibling member: ok:true AND workspace.diagnostics non-empty', async () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'lat-apply-ws-broken-'));
    writeFileSync(join(wsDir, 'context-map.lat'), MAP);
    writeMember(wsDir, 'catalog', CATALOG_SPEC);
    // subscriptions member spec.lat intentionally absent -> sibling is broken

    const fresh = join(wsDir, 'catalog-session');
    const r: any = await runCommand(
      ['apply', '--session', fresh, '--lat', join(wsDir, 'catalog', 'spec.lat')], realDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.workspace).toBeDefined();
    expect(r.workspace.diagnostics).toBeDefined();
    expect(r.workspace.diagnostics.length).toBeGreaterThan(0);
    expect(r.workspace.written).toBeUndefined();
  });

  it('apply outside any workspace has no workspace key', async () => {
    const r: any = await apply();
    expect(r.ok).toBe(true);
    expect(r.workspace).toBeUndefined();
  });
});

describe('engine apply: reclassify-on-apply (Task 4)', () => {
  // A minimal hand-authored spec with one quint-expressible (statePredicate) invariant, so applying
  // it fresh gives reclassify-on-apply exactly one candidate to classify.
  const MINI_SPEC = `context Mini {
  aggregate Widget {
    widgetId : Id key
    units    : Int
    invariant unitsSane { units >= 0 }
  }
}
`;

  // Scripted quintVerify: returns queued results in call order (mirrors cli-classify.test.ts's
  // scriptedDeps). classifyInvariant makes 2 calls per invariant — [consecution, reachability].
  function scriptedDeps(results: { violated: boolean; witness?: any }[]) {
    let i = 0;
    const calls: unknown[] = [];
    const deps: any = {
      alloy: async () => ({ sat: false, instances: [], ms: 0 }),
      quint: async () => ({ violated: false, ms: 0 }),
      quintVerify: async (_em: any, opts: any) => { calls.push(opts); return { ...results[i++]!, ms: 0 }; },
    };
    return { deps, calls };
  }

  const readClassifiedEntries = (sessionDir: string) =>
    readFileSync(join(sessionDir, 'ledger.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l)).filter((e: any) => e.kind === 'classified');

  it('fresh apply classifies the adopted set (everything is "new")', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lat-apply-classify-'));
    const latPath = join(fresh, 'spec.lat');
    writeFileSync(latPath, MINI_SPEC);
    const sessionDir = join(fresh, 'session');
    const { deps, calls } = scriptedDeps([{ violated: false }, { violated: false }]);   // unitsSane -> entailed

    const r: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath], deps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.classification).toEqual({ reclassified: 1 });
    expect(calls).toHaveLength(2);   // exactly the one invariant's 2-probe pair, not more

    const classified = readClassifiedEntries(sessionDir);
    expect(classified).toHaveLength(1);
    expect(classified[0].invariant).toBe('unitsSane');
    expect(classified[0].verdict).toBe('entailed');
  });

  it('apply --no-classify skips the hook entirely — no classified entries, no solver calls', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lat-apply-noclassify-'));
    const latPath = join(fresh, 'spec.lat');
    writeFileSync(latPath, MINI_SPEC);
    const sessionDir = join(fresh, 'session');
    const { deps, calls } = scriptedDeps([]);   // if the hook fires anyway, quintVerify starves and this fails loudly

    const r: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], deps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.classification).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(readClassifiedEntries(sessionDir)).toHaveLength(0);
  });

  it('a no-op re-apply reclassifies nothing — the dependency set is scoped, not the whole adopted set', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lat-apply-scoped-'));
    const latPath = join(fresh, 'spec.lat');
    writeFileSync(latPath, MINI_SPEC);
    const sessionDir = join(fresh, 'session');

    const first = scriptedDeps([{ violated: false }, { violated: false }]);   // unitsSane -> entailed
    const r1: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath], first.deps);
    expect(r1.classification).toEqual({ reclassified: 1 });
    expect(readClassifiedEntries(sessionDir)).toHaveLength(1);

    // re-apply the SAME .lat unchanged: reconcile finds nothing added/changed, so classifyOnApply's
    // dependency set is empty — it must not re-walk the full adopted set (which would also re-append
    // a redundant `classified` entry for unitsSane).
    const second = scriptedDeps([]);   // starves if the hook incorrectly re-classifies unitsSane
    const r2: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath], second.deps);
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    expect(r2.classification).toEqual({ reclassified: 0 });
    expect(second.calls).toHaveLength(0);
    expect(readClassifiedEntries(sessionDir)).toHaveLength(1);   // still just the one from the first apply
  });
});

describe('engine apply: guard-change staleness warning (item 3a)', () => {
  // A machine-bearing spec: `close`'s guard is a `requires` clause on the transition itself, wholly
  // separate from `unitsSane` (an invariant on the aggregate's fields). Editing ONLY the guard, with
  // the invariant body untouched, is exactly the case reconcile's own doc comment flags as producing
  // "no structural note at all" — nothing else would ever surface this edit.
  const GUARD_SPEC = (op: string) => `context Mini {
  aggregate Widget {
    widgetId : Id key
    units    : Int
    lifecycle status {
      states { active @initial, closed }
      transition close { from active to closed; requires units ${op} 0 }
    }
    invariant unitsSane { units >= 0 }
  }
}
`;

  it('a guard-only edit (no invariant body changed) warns that classifications may be stale', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lat-apply-guardwarn-'));
    const latPath = join(fresh, 'spec.lat');
    writeFileSync(latPath, GUARD_SPEC('>='));
    const sessionDir = join(fresh, 'session');

    const r1: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], realDeps);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    expect(r1.warnings.some((w: string) => w.includes('may be stale'))).toBe(false);   // fresh apply: nothing stored yet to diff against

    // edit ONLY the transition's guard predicate — unitsSane's body is untouched
    writeFileSync(latPath, GUARD_SPEC('>'));
    const r2: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], realDeps);
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    const warning = r2.warnings.find((w: string) => w.includes('may be stale'));
    expect(warning, JSON.stringify(r2.warnings)).toBeDefined();
    expect(warning).toContain('Widget.close');
    expect(warning).toContain('run classify');
  });

  it('a no-op re-apply (guard unchanged) never warns', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lat-apply-guardwarn-noop-'));
    const latPath = join(fresh, 'spec.lat');
    writeFileSync(latPath, GUARD_SPEC('>='));
    const sessionDir = join(fresh, 'session');

    const r1: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], realDeps);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);

    const r2: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], realDeps);
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    expect(r2.warnings.some((w: string) => w.includes('may be stale'))).toBe(false);
  });

  it('a guard edit alongside an invariant-body edit on the SAME aggregate does not double-warn', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lat-apply-guardwarn-adopted-'));
    const latPath = join(fresh, 'spec.lat');
    writeFileSync(latPath, GUARD_SPEC('>='));
    const sessionDir = join(fresh, 'session');

    const r1: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], realDeps);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);

    // change BOTH the guard AND the invariant body on Widget — the invariant edit already re-adopts
    // (and classifyOnApply already reclassifies) this aggregate, so the guard-change warning is
    // redundant noise here and must be suppressed.
    const text = GUARD_SPEC('>').replace('units >= 0 }', 'units >= 1 }');
    writeFileSync(latPath, text);
    const r2: any = await runCommand(['apply', '--session', sessionDir, '--lat', latPath, '--no-classify'], realDeps);
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    expect(r2.warnings.some((w: string) => w.includes('may be stale'))).toBe(false);
  });

  // Robustness follow-up: guardChangeWarnings must compare `requires` via a canonical (key-order-
  // insensitive) JSON encoding, not raw JSON.stringify. Two independently-constructed predicate
  // objects that are the SAME shape but built with keys in a different order would false-fire a
  // "guard changed" warning under raw JSON.stringify (property insertion order differs), even though
  // nothing semantically changed. Hand-build the models directly rather than round-tripping through
  // the parser, since the parser always emits predicates with a fixed key order.
  it('does not warn when requires is the same predicate with keys in a different order', () => {
    const mkModel = (requires: unknown): DomainModel => ({
      context: 'Mini', enums: [], values: [], entities: [], events: [], services: [],
      aggregates: [{
        kind: 'aggregate', name: 'Widget',
        fields: [{ name: 'widgetId', type: { kind: 'prim', prim: 'Id' }, key: true },
                 { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
        machine: {
          regions: [{ name: 'status', initial: 'active',
            states: [{ name: 'active', tags: ['active'] }, { name: 'closed', tags: ['terminal'] }] }],
          transitions: [{ name: 'close', region: 'status', from: ['active'], to: 'closed',
            requires: requires as any }],
        },
      }],
    });
    const requiresA = { kind: 'cmp', op: '>', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } };
    // same predicate, keys inserted in a different order at every nesting level
    const requiresB = { right: { value: 0, kind: 'int' }, op: '>', left: { path: ['units'], owner: 'self', kind: 'field' }, kind: 'cmp' };
    const stored = mkModel(requiresA);
    const fresh = mkModel(requiresB);
    expect(guardChangeWarnings(stored, fresh, new Set())).toEqual([]);
  });
});

// Review finding: derivedNameCollisions was wired into `init` only, on the rationale that
// matchTemplates has a single caller. True, but about the wrong function — `impliedInvariants` mints
// the names, and apply reaches it on BOTH its branches without ever passing init: reconcile.ts's
// canonicalSet, and the §5.8 fresh-session branch that builds a whole session with no init at all.
// apply gates only on loadLatText → validateModel, which does not include this check. Before the
// fix, both branches returned ok:true and wrote a prose projection carrying two distinct rules under
// one derived name.
describe('apply refuses a .lat whose derived names collide', () => {
  // `total : Amount{amount : Money}` alone — derives nonNegativeInvoiceTotalAmount exactly once.
  const cleanModel = {
    context: 'L', enums: [], events: [], services: [], entities: [],
    values: [{ kind: 'value', name: 'Amount', fields: [
      { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }],
    aggregates: [{ kind: 'aggregate', name: 'Invoice', fields: [
      { name: 'invId', type: { kind: 'prim', prim: 'Id' }, key: true },
      { name: 'total', type: { kind: 'value', value: 'Amount' }, tags: ['unsigned'] }] }],
  };
  // Adding `totalAmount : Money` makes a SECOND rule fold onto that same name.
  const COLLIDING_LAT = `context L {
  value Amount {
    amount : Money
  }
  aggregate Invoice {
    invId : Id key
    totalAmount : Money @unsigned
    total : Amount @unsigned
  }
}
`;
  const expectCollisionRefusal = (r: any) => {
    expect(r.error).toBe('ill-formed-model');
    const d = r.diagnostics.find((x: any) => x.code === 'derived-name-collision');
    expect(d).toBeDefined();
    expect(d.at).toBe('Invoice');
    expect(d.message).toContain('nonNegativeInvoiceTotalAmount');
    expect(d.message).toContain('Invoice.totalAmount');
    expect(d.message).toContain('Invoice.total.amount');
  };

  it('branch 1 (reconcile): an init-ed session refuses an edit that introduces a collision', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lat-collide-recon-'));
    const session = join(d, 'session'), spec = join(d, 'spec');
    const modelFile = join(d, 'm.json');
    writeFileSync(modelFile, JSON.stringify(cleanModel));

    // init the CLEAN model — the collision must be introduced by the hand edit, not present at init,
    // or init's own gate would be what refuses and this would prove nothing about apply.
    const init: any = await runCommand(['init', '--session', session, '--model', modelFile], realDeps);
    expect(init.error).toBeUndefined();
    expect(init.adopted.map((a: any) => a.name)).toEqual(['nonNegativeInvoiceTotalAmount']);

    // apply operates on a converged session (see isSessionBusy); init leaves it mid-elicitation.
    const st = JSON.parse(readFileSync(join(session, 'state.json'), 'utf8'));
    st.phase = 'converged';
    writeFileSync(join(session, 'state.json'), JSON.stringify(st));

    await runCommand(['emit', '--session', session, '--out', spec], realDeps);
    const lat = join(spec, 'spec.lat');
    const ledgerBefore = readFileSync(join(session, 'ledger.jsonl'), 'utf8');
    const stateBefore = readFileSync(join(session, 'state.json'), 'utf8');
    const proseBefore = readFileSync(join(spec, 'spec.prose.md'), 'utf8');
    writeFileSync(lat, COLLIDING_LAT);

    const r: any = await runCommand(['apply', '--session', session, '--lat', lat, '--no-classify'], realDeps);
    expectCollisionRefusal(r);
    // Refused before anything is written: no shadowed rule in the ledger, session, or projection.
    // The prose check is the one that matters — pre-fix it grew a SECOND bullet under the same
    // derived name (`totalAmount ≥ 0` beside `total.amount ≥ 0`), which is the shadowing made
    // visible. model.json is apply-only (init does not write one), so its absence is the assertion.
    expect(readFileSync(join(session, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
    expect(readFileSync(join(session, 'state.json'), 'utf8')).toBe(stateBefore);
    expect(readFileSync(join(spec, 'spec.prose.md'), 'utf8')).toBe(proseBefore);
    expect(proseBefore).not.toContain('totalAmount ≥ 0');
    expect(existsSync(join(session, 'model.json'))).toBe(false);
  });

  it('branch 2 (fresh session, §5.8): apply --lat onto an empty session dir refuses', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lat-collide-fresh-'));
    const session = join(d, 'session'), spec = join(d, 'spec');
    mkdirSync(spec, { recursive: true });
    const lat = join(spec, 'spec.lat');
    writeFileSync(lat, COLLIDING_LAT);

    // No init, no state.json — this branch builds the whole session from the .lat.
    expect(existsSync(join(session, 'state.json'))).toBe(false);
    const r: any = await runCommand(['apply', '--session', session, '--lat', lat, '--no-classify'], realDeps);
    expectCollisionRefusal(r);
    expect(existsSync(join(session, 'ledger.jsonl'))).toBe(false);
    expect(existsSync(join(session, 'model.json'))).toBe(false);
  });

  it('the same .lat applies clean once the colliding field is renamed', async () => {
    // Guards against the fix over-refusing: it is the COLLISION that is rejected, not the shape.
    const d = mkdtempSync(join(tmpdir(), 'lat-collide-ok-'));
    const session = join(d, 'session'), spec = join(d, 'spec');
    mkdirSync(spec, { recursive: true });
    const lat = join(spec, 'spec.lat');
    writeFileSync(lat, COLLIDING_LAT.replace('totalAmount : Money', 'surcharge : Money'));

    const r: any = await runCommand(['apply', '--session', session, '--lat', lat, '--no-classify'], realDeps);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const prose = readFileSync(join(spec, 'spec.prose.md'), 'utf8');
    expect(prose).toContain('nonNegativeInvoiceSurcharge');
    expect(prose).toContain('nonNegativeInvoiceTotalAmount');
  });
});
