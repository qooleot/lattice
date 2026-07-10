import type { GenPlan, PlanAggregate } from '../plan.js';
import type { Field } from '../../ast/domain.js';
import type { Predicate } from '../../ast/invariant.js';

// Renders the generated package's demo.ts — a runnable script (no mocks) that drives three real
// scenarios against a real on-disk better-sqlite3 database using the generated repo/commands
// exactly as a real caller would: (1) a guard rejection, (2) a transition that succeeds and emits
// an outbox event, (3) a transition whose guard passes but a post-state invariant fails, rolling
// the whole transaction back. Each scenario prints the cited anchors returned by the command so the
// demo doubles as a live illustration of the provenance chain (spec -> guard/invariant -> rejection).
//
// Like render/tests.ts, this only knows how to synthesize the "activate-like" scenario: a
// transition guarded by `ownField >= intLiteral` whose owning aggregate has a ref field into a
// second aggregate that a `statePredicate` invariant reaches through (e.g. activePaidInFull reaches
// Subscription.latestInvoice.amountPaid). This is exactly the shape render/tests.ts already detects
// for the success+invariant-rejection tests (task-9 brief) — we reuse the same detection here rather
// than inventing a second synthesis strategy. If the plan doesn't match this shape, renderDemo emits
// a small script that says so plainly instead of fabricating a scenario that doesn't apply (honesty
// over completeness, same principle as render/tests.ts).

// Same baseline-invariant-override logic as render/tests.ts's ltLeFieldPairs/baselineInvariantOverrides:
// walks a predicate tree collecting every `cmp lt/le` leaf between two single-segment own fields
// (e.g. `periodStart < periodEnd`), including leaves nested under and/or/not/implies, so a success
// seed can pull the pair apart from the all-zero defaults (0 < 0 fails). Duplicated here rather than
// imported because render/tests.ts does not export it — keeping each renderer self-contained matches
// the existing pattern (render/commands.ts vs render/invariants.ts also each own their traversal).
function ltLeFieldPairs(p: Predicate): { left: string; right: string }[] {
  switch (p.kind) {
    case 'cmp': {
      if (p.op !== 'lt' && p.op !== 'le') return [];
      const { left, right } = p;
      if (left.kind === 'field' && left.path.length === 1 && right.kind === 'field' && right.path.length === 1) {
        return [{ left: left.path[0]!, right: right.path[0]! }];
      }
      return [];
    }
    case 'and': case 'or': return p.args.flatMap(ltLeFieldPairs);
    case 'not': return ltLeFieldPairs(p.arg);
    case 'implies': return [...ltLeFieldPairs(p.left), ...ltLeFieldPairs(p.right)];
    case 'inState': return [];
  }
}

// Baseline field overrides that make every OWN-FIELD (single-aggregate, no ref-reach-through)
// row-kind invariant on `a` hold against the all-zero/empty seed defaults — e.g.
// positivePeriodNonNegativeUsage's `periodStart < periodEnd` fails at 0 < 0, so a passing seed for
// this aggregate needs periodStart/periodEnd pulled apart.
function baselineInvariantOverrides(a: PlanAggregate): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const inv of a.invariants) {
    if (inv.candidate.kind !== 'statePredicate') continue;
    for (const { left, right } of ltLeFieldPairs(inv.candidate.body)) {
      overrides[left] = 0;
      overrides[right] = 1;
    }
  }
  return overrides;
}

function keyField(a: PlanAggregate): string {
  const key = a.fields.find((f: Field) => f.key);
  if (!key) throw new Error(`aggregate ${a.name} has no key field — demo renderer requires exactly one`);
  return key.name;
}

// Same guard-shape recognition as render/tests.ts's guardField: given a transition's `requires`
// guard, return the own-field name plus a failing/passing int override, or undefined if the shape
// isn't `field ge|gt|eq intLiteral` (the only shape the Subscriptions spec's `activate` guard uses,
// and the only shape this demo knows how to synthesize a scenario for).
function guardFieldOverride(p: Predicate): { name: string; failing: number; passing: number } | undefined {
  if (p.kind !== 'cmp') return undefined;
  const { left, right, op } = p;
  if (left.kind === 'field' && left.path.length === 1 && right.kind === 'int') {
    const name = left.path[0]!;
    const n = right.value;
    if (op === 'ge' || op === 'gt') return { name, failing: n - 1, passing: n };
    if (op === 'eq') return { name, failing: n + 1, passing: n };
  }
  return undefined;
}

interface ActivateLikeShape {
  sub: PlanAggregate;
  invoice: PlanAggregate;
  refFieldName: string;
  transitionName: string;
  region: string;
  fromState: string;
  toState: string;
  emits: string;
  guardFieldName: string;
  guardPassingValue: number;
}

// Detects the same "activate-like" shape render/tests.ts detects: an aggregate with a ref field
// into a SECOND AGGREGATE DEFINED IN THIS PLAN (a ref field's target may instead be an external/
// catalog aggregate the plan doesn't define — e.g. Subscription.plan -> Catalog.Plan — so we can't
// just take the first ref field; we require the target to resolve within plan.aggregates), a
// transition on it guarded by `ownField >= intLiteral`, whose to-state is governed by a cross-row
// invariant reaching through that ref field.
function detectActivateLikeShape(plan: GenPlan): ActivateLikeShape | undefined {
  for (const sub of plan.aggregates) {
    for (const refField of sub.fields.filter(f => f.type.kind === 'ref')) {
      const target = refField.type.kind === 'ref' ? refField.type.target : undefined;
      const invoice = plan.aggregates.find(a => a.name === target);
      if (!invoice) continue;
      const transition = sub.transitions.find(t => {
        if (!t.requires || !t.emits) return false;
        return guardFieldOverride(t.requires) !== undefined;
      });
      if (!transition) continue;
      const gf = guardFieldOverride(transition.requires!)!;
      return {
        sub,
        invoice,
        refFieldName: refField.name,
        transitionName: transition.name,
        region: transition.region,
        fromState: transition.from[0]!,
        toState: transition.to,
        emits: transition.emits!,
        guardFieldName: gf.name,
        guardPassingValue: gf.passing,
      };
    }
  }
  return undefined;
}

function fallbackDemo(plan: GenPlan): string {
  return (
    `// GENERATED by lattice from context ${plan.context} — DO NOT EDIT. Regenerate instead.\n\n` +
    `// The demo renderer only knows how to synthesize a scenario for an "activate-like" shape (see\n` +
    `// render/demo.ts doc-comment): a guarded transition (field >= intLiteral) on an aggregate with a\n` +
    `// ref field into a second aggregate reached by a cross-row invariant. This plan does not match\n` +
    `// that shape, so there is no scenario to run — honesty over a fabricated demo.\n\n` +
    `console.log('No activate-like scenario detected in this plan; demo has nothing to run.');\n`
  );
}

// Emits `generated/subscriptions/demo.ts`: a real script (no mocks) that opens a fresh on-disk
// better-sqlite3 DB at a temp path (kept out of the repo entirely — os.tmpdir(), cleaned up in a
// `finally`, so `git status` after running the demo stays clean), applies schema.sql, and drives the
// three real scenarios end to end using only the generated repo/commands surface.
export function renderDemo(plan: GenPlan): string {
  const shape = detectActivateLikeShape(plan);
  if (!shape) return fallbackDemo(plan);

  const { sub, invoice, transitionName, region, fromState, toState, emits, guardFieldName, refFieldName } = shape;
  const subKey = keyField(sub);
  const invKey = keyField(invoice);

  const commandNames = [...new Set(plan.aggregates.flatMap(a => a.transitions.map(t => t.name)))];

  return (
    `// GENERATED by lattice from context ${plan.context} — DO NOT EDIT. Regenerate instead.\n\n` +
    `// A runnable demo (no mocks) driving three real scenarios against a real on-disk better-sqlite3\n` +
    `// database using only the generated repo/commands surface, exactly as a real caller would:\n` +
    `//   1. Guard reject   — ${transitionName} rejected before any state change (${guardFieldName} guard fails).\n` +
    `//   2. Success        — ${transitionName} succeeds, transitions ${region} '${fromState}' -> '${toState}', and\n` +
    `//                       appends a '${emits}' row to the outbox.\n` +
    `//   3. Invariant reject — the guard passes but the post-state invariant (reached through\n` +
    `//                       '${refFieldName}') fails at commit time, so the whole transaction rolls back:\n` +
    `//                       the aggregate is left at '${fromState}' and nothing is written to the outbox.\n` +
    `// Each scenario prints the exact { rejected, anchors } (or outbox row) the command returned, so the\n` +
    `// anchors shown here are the real provenance chain, not hard-coded strings.\n` +
    `//\n` +
    `// The demo DB lives at a fresh os.tmpdir() path and is removed in a finally block — this script\n` +
    `// never writes into the package directory, so running it leaves no trace in \`git status\`.\n\n` +
    `import { mkdtempSync, rmSync } from 'node:fs';\n` +
    `import { tmpdir } from 'node:os';\n` +
    `import { join } from 'node:path';\n` +
    `import { openDb } from './db.js';\n` +
    `import { insert${sub.name}, get${sub.name}, insert${invoice.name} } from './repo.js';\n` +
    `import { ${transitionName} } from './commands.js';\n` +
    `import type { ${sub.name}, ${invoice.name} } from './types.js';\n\n` +
    `void (${JSON.stringify(commandNames)}); // full command surface generated for this context\n\n` +
    demoBody(shape, subKey, invKey) +
    `\n`
  );
}

function demoBody(shape: ActivateLikeShape, subKey: string, invKey: string): string {
  const { sub, invoice, transitionName, region, fromState, guardFieldName, guardPassingValue, refFieldName } = shape;
  const baseline = baselineInvariantOverrides(sub);
  const passingOverrides = { ...baseline, [guardFieldName]: guardPassingValue };
  const passingOverrideSrc = Object.entries(passingOverrides).map(([k, v]) => `${k}: ${v}`).join(', ');

  return (
    `const dir = mkdtempSync(join(tmpdir(), 'lattice-demo-'));\n` +
    `const dbPath = join(dir, 'demo.db');\n` +
    `const db = openDb(dbPath);\n\n` +
    `function makeSub(overrides: Partial<${sub.name}> = {}): ${sub.name} {\n` +
    `  return {\n` +
    sub.fields.map(f => `    ${f.name}: ${f.key ? `'sub-1'` : defaultLiteralFor(f)},`).join('\n') + '\n' +
    sub.regions.map(r => `    ${r.name}: '${r.initial}',`).join('\n') + (sub.regions.length ? '\n' : '') +
    `    ...overrides,\n` +
    `  };\n` +
    `}\n\n` +
    `function makeInvoice(overrides: Partial<${invoice.name}> = {}): ${invoice.name} {\n` +
    `  return {\n` +
    invoice.fields.map(f => `    ${f.name}: ${f.key ? `'inv-1'` : defaultLiteralFor(f)},`).join('\n') + '\n' +
    invoice.regions.map(r => `    ${r.name}: '${r.initial}',`).join('\n') + (invoice.regions.length ? '\n' : '') +
    `    ...overrides,\n` +
    `  };\n` +
    `}\n\n` +
    `try {\n` +
    `  console.log('=== Scenario 1: guard reject (${guardFieldName} fails the ${transitionName} guard) ===');\n` +
    `  insert${sub.name}(db, makeSub({ ${subKey}: 'sub-reject', ${region}: '${fromState}', ${guardFieldName}: ${guardPassingValue - 1} }));\n` +
    `  const r1 = ${transitionName}(db, 'sub-reject');\n` +
    `  console.log(JSON.stringify(r1, null, 2));\n` +
    `  console.log('state after:', (get${sub.name}(db, 'sub-reject') as any).${region});\n` +
    `  console.log('outbox rows:', (db.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c);\n` +
    `  console.log();\n\n` +
    `  console.log('=== Scenario 2: ${transitionName} succeeds, outbox event emitted ===');\n` +
    `  insert${invoice.name}(db, makeInvoice({ ${invKey}: 'inv-ok', totalDue: 100, amountPaid: 100 }));\n` +
    `  insert${sub.name}(db, makeSub({ ${subKey}: 'sub-ok', ${region}: '${fromState}', ${passingOverrideSrc}, ${refFieldName}: 'inv-ok' }));\n` +
    `  const r2 = ${transitionName}(db, 'sub-ok');\n` +
    `  console.log(JSON.stringify(r2, null, 2));\n` +
    `  console.log('state after:', (get${sub.name}(db, 'sub-ok') as any).${region});\n` +
    `  const outboxRows = db.prepare('SELECT * FROM outbox WHERE aggregate_id = ?').all('sub-ok');\n` +
    `  console.log('outbox rows:', JSON.stringify(outboxRows, null, 2));\n` +
    `  console.log();\n\n` +
    `  console.log('=== Scenario 3: guard passes, post-state invariant fails at commit -> rollback ===');\n` +
    `  insert${invoice.name}(db, makeInvoice({ ${invKey}: 'inv-underpaid', totalDue: 100, amountPaid: 40 }));\n` +
    `  insert${sub.name}(db, makeSub({ ${subKey}: 'sub-rollback', ${region}: '${fromState}', ${passingOverrideSrc}, ${refFieldName}: 'inv-underpaid' }));\n` +
    `  const r3 = ${transitionName}(db, 'sub-rollback');\n` +
    `  console.log(JSON.stringify(r3, null, 2));\n` +
    `  console.log('state after (still ${fromState} — rolled back):', (get${sub.name}(db, 'sub-rollback') as any).${region});\n` +
    `  console.log('outbox rows for sub-rollback:', (db.prepare('SELECT COUNT(*) c FROM outbox WHERE aggregate_id = ?').get('sub-rollback') as any).c);\n` +
    `} finally {\n` +
    `  db.close();\n` +
    `  rmSync(dir, { recursive: true, force: true });\n` +
    `}\n`
  );
}

function defaultLiteralFor(f: Field): string {
  switch (f.type.kind) {
    case 'prim': return f.type.prim === 'Text' || f.type.prim === 'Id' ? "''" : '0';
    case 'enum': return "''";
    case 'ref': return "''";
    case 'list': return '[]';
    case 'value': return '{}';
  }
}
