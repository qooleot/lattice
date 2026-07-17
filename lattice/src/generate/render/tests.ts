import type { GenPlan, PlanAggregate, PlanTransition } from '../plan.js';
import type { Field, TypeRef } from '../../ast/domain.js';
import type { Predicate, Term } from '../../ast/invariant.js';

// Renders the generated package's OWN vitest suite (service.test.ts): guard-rejection tests over a
// real in-memory better-sqlite3, plus (for the transitions where we can synthesize a valid full seed)
// a success+outbox test and an invariant-rejection test. Honesty over completeness (task-9 brief):
// we do NOT attempt a fully general success test across every transition — some transitions' guards
// are trivially satisfiable by defaults but land the aggregate in a region scoped by a cross-row
// invariant (e.g. activePaidInFull reaches through `latestInvoice`), and synthesizing a seed that
// satisfies every adopted invariant for an arbitrary plan is out of scope for v1. Guard-rejection
// tests are the robustly-generatable core: a failing guard rejects before any invariant/ref logic
// runs, so they never depend on the rest of the aggregate's invariants holding.

function keyField(a: PlanAggregate): string {
  const key = a.fields.find((f: Field) => f.key);
  if (!key) throw new Error(`aggregate ${a.name} has no key field — tests renderer requires exactly one`);
  return key.name;
}

// Safe default literal (as TS source) for a field's type — 0 for numeric-ish prims, '' for text/id/
// ref/enum. These are the "fills every column" defaults the seed helper falls back to when a test
// doesn't override a field.
function defaultLiteral(t: TypeRef): string {
  switch (t.kind) {
    case 'prim': return t.prim === 'Text' || t.prim === 'Id' ? "''" : '0'; // Int/Money/Date/Duration -> 0 (ticks)
    case 'enum': return "''";
    case 'ref': return "''";
    case 'list': return '[]';
    case 'value': return '{}';
    case 'optional': return 'null';
    case 'map': return '{}';
    case 'generic': return 'null';   // no general default for an arbitrary type constructor
    case 'union': return defaultLiteral(t.arms[0]!);
    case 'carrier': return 'null';
  }
}

// Renders `export function make<Name>(overrides: Partial<Name> = {}): Name { ... }` — a seed helper
// that fills EVERY column (own fields + region-state columns) with a safe default, letting a test
// override only the field(s) it cares about. This is the seed-data strategy the task-9 brief calls
// for: named-param inserts need every column, and per-test literals would be unreadable/fragile.
function seedHelper(a: PlanAggregate): string {
  const key = keyField(a);
  const lines: string[] = [];
  lines.push(`export function make${a.name}(overrides: Partial<${a.name}> = {}): ${a.name} {`);
  lines.push(`  return {`);
  for (const f of a.fields) {
    const dflt = f.key ? `'${a.name.toLowerCase()}-1'` : defaultLiteral(f.type);
    lines.push(`    ${f.name}: ${dflt},`);
  }
  for (const r of a.regions) {
    lines.push(`    ${r.name}: '${r.initial}',`);
  }
  lines.push(`    ...overrides,`);
  lines.push(`  };`);
  lines.push(`}`);
  void key;
  return lines.join('\n');
}

// A guard predicate we know how to (a) synthesize a FAILING field-override set for, and (b)
// synthesize a PASSING field-override set for (passing is optional — only the activate-success path
// needs it). Both directions compile the same `cmp` shapes the engine actually emits for guards
// (design §3.3): field `ge`/`gt`/`eq` an int literal, field `eq` a plus-of-two-fields (e.g.
// Invoice.finalize: totalDue == licenseFeeAmount + usageAmount), or field `eq` another own-field
// (e.g. Invoice.settle: amountPaid == totalDue).
interface GuardField { name: string; failing: Record<string, number>; passing?: Record<string, number>; }

// Given a transition's `requires` guard, find the own-field override(s) that make the guard fail
// (paired with the aggregate's defaults for every other field), or undefined if the guard's shape
// isn't one we recognize. Recognized shapes are exactly the ones the real Subscriptions spec uses; a
// broader grammar would need a broader synthesis strategy (see the module doc-comment).
function guardField(p: Predicate): GuardField | undefined {
  if (p.kind !== 'cmp') return undefined;
  const { left, right, op } = p;
  // field <op> int
  if (left.kind === 'field' && left.path.length === 1 && right.kind === 'int') {
    const name = left.path[0]!;
    const n = right.value;
    if (op === 'ge' || op === 'gt') return { name, failing: { [name]: n - 1 }, passing: { [name]: n } };
    if (op === 'eq') return { name, failing: { [name]: n + 1 }, passing: { [name]: n } };
    return undefined;
  }
  // field eq (field + field): fails by setting the LHS field to something other than the (zero-
  // defaulted) sum of the two parts — -1 is unambiguous against any non-negative defaults.
  if (op === 'eq' && left.kind === 'field' && left.path.length === 1 && right.kind === 'plus') {
    const name = left.path[0]!;
    return { name, failing: { [name]: -1 } };
  }
  // field eq field: fails by pinning the LHS away from the (zero-defaulted) RHS field.
  if (op === 'eq' && left.kind === 'field' && left.path.length === 1 && right.kind === 'field' && right.path.length === 1) {
    const name = left.path[0]!;
    return { name, failing: { [name]: -1 } };
  }
  return undefined;
}

// Emits `it('rejects <t.name> when the guard ... fails', ...)`: seed a row that satisfies the
// from-state but fails the guard, run the transition, and assert it was rejected with no outbox
// row written (a rejected guard throws before the transition ever calls appendOutbox).
function guardRejectionTest(a: PlanAggregate, t: PlanTransition): string | undefined {
  if (!t.requires) return undefined;
  const gf = guardField(t.requires);
  if (!gf) return undefined;
  const key = keyField(a);
  const fromState = t.from[0]!;
  const failingOverride = Object.entries(gf.failing).map(([k, v]) => `${k}: ${v}`).join(', ');
  return (
    `it('rejects ${t.name} when the guard fails', () => {\n` +
    `  const db = new Database(':memory:'); db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));\n` +
    `  insert${a.name}(db, make${a.name}({ ${key}: 'x1', ${t.region}: '${fromState}', ${failingOverride} }));\n` +
    `  const r = ${t.name}(db, 'x1');\n` +
    `  expect(r.ok).toBe(false);\n` +
    `  expect((get${a.name}(db, 'x1') as any).${t.region}).toBe('${fromState}');\n` +
    `  expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c).toBe(0);\n` +
    `});`
  );
}

// Walks a predicate tree collecting every `cmp lt/le` leaf between two single-segment own fields
// (e.g. `periodStart < periodEnd`) — including leaves nested under and/or/not/implies — so
// baselineInvariantOverrides can pull the pair apart regardless of how the top-level invariant
// combines its clauses. `inState` leaves and cross-row (multi-segment) field paths are ignored: the
// caller handles those explicitly (activate's tests override latestInvoice-scoped invariants).
function ltLeFieldPairs(p: Predicate): { left: string; right: string }[] {
  switch (p.kind) {
    case 'cmp': {
      if ((p.op !== 'lt' && p.op !== 'le')) return [];
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
    case 'present': return [];
  }
}

// Baseline field overrides that make every OWN-FIELD (single-aggregate, no ref-reach-through)
// row-kind invariant on `a` hold against the all-zero/empty seed defaults — e.g.
// positivePeriodNonNegativeUsage's `periodStart < periodEnd` fails at 0 < 0, so a success seed for
// this aggregate needs periodStart/periodEnd pulled apart. Only handles `cmp lt/le` leaves between
// two single-segment own fields; anything else (cross-row reaches, disjunctions where another
// branch already holds, etc.) is left alone — the caller is responsible for overriding those
// explicitly (as activate's tests do for latestInvoice-scoped invariants).
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

// Walks a predicate tree collecting every multi-segment `field` term path (a cross-row reach
// through a ref, e.g. `latestInvoice.amountPaid`) so the activate special-case below can confirm
// the cross-row invariant it exercises actually exists in the plan.
function refReachPaths(p: Predicate): string[][] {
  const fromTerm = (t: Term): string[][] => {
    switch (t.kind) {
      case 'field': return t.path.length > 1 ? [t.path as string[]] : [];
      case 'plus': return [...fromTerm(t.left), ...fromTerm(t.right)];
      default: return [];
    }
  };
  switch (p.kind) {
    case 'cmp': return [...fromTerm(p.left), ...fromTerm(p.right)];
    case 'and': case 'or': return p.args.flatMap(refReachPaths);
    case 'not': return refReachPaths(p.arg);
    case 'implies': return [...refReachPaths(p.left), ...refReachPaths(p.right)];
    case 'inState': return [];
    case 'present': return p.path.length > 1 ? [p.path as string[]] : [];
  }
}

// The `activate` success + outbox scenario is the one place the task-9 brief asks us to synthesize
// a FULL passing seed across a cross-row invariant (activePaidInFull reaches through
// `latestInvoice`). We special-case it here rather than trying to generalize invariant-satisfying
// seed synthesis to an arbitrary plan (out of scope for v1 — see module doc-comment). We detect the
// shape defensively (Subscription aggregate, an `activate`-like transition with a `ge 1` guard on
// `paidInvoiceCount`, and a `latestInvoice` ref field) and skip silently if the real plan doesn't
// match, rather than emitting a test that doesn't apply.
function activateSuccessAndInvariantRejectionTests(plan: GenPlan): string[] {
  const sub = plan.aggregates.find(a => a.fields.some(f => f.name === 'latestInvoice' && f.type.kind === 'ref'));
  if (!sub) return [];
  const invoiceField = sub.fields.find(f => f.name === 'latestInvoice')!;
  const invoiceAggName = invoiceField.type.kind === 'ref' ? invoiceField.type.target : undefined;
  const invoice = plan.aggregates.find(a => a.name === invoiceAggName);
  if (!invoice) return [];
  const activate = sub.transitions.find(t => {
    if (!t.requires) return false;
    const gf = guardField(t.requires);
    return gf?.name === 'paidInvoiceCount' && gf.passing !== undefined;
  });
  if (!activate) return [];
  const invKey = keyField(invoice);
  const subKey = keyField(sub);
  const region = activate.region;
  const gf = guardField(activate.requires!)!;
  const baseline = baselineInvariantOverrides(sub);
  const passingOverride = Object.entries({ ...baseline, ...gf.passing! }).map(([k, v]) => `${k}: ${v}`).join(', ');

  const success =
    `it('${activate.name} succeeds and emits an outbox event when the guard and invariants hold', () => {\n` +
    `  const db = new Database(':memory:'); db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));\n` +
    `  insert${invoice.name}(db, make${invoice.name}({ ${invKey}: 'inv1', totalDue: 100, amountPaid: 100 }));\n` +
    `  insert${sub.name}(db, make${sub.name}({ ${subKey}: 'x1', ${region}: '${activate.from[0]}', ${passingOverride}, latestInvoice: 'inv1' }));\n` +
    `  const r = ${activate.name}(db, 'x1');\n` +
    `  expect(r.ok).toBe(true);\n` +
    `  expect((get${sub.name}(db, 'x1') as any).${region}).toBe('${activate.to}');\n` +
    `  const rows = db.prepare('SELECT * FROM outbox').all() as any[];\n` +
    `  expect(rows.length).toBe(1);\n` +
    `  expect(rows[0].event_type).toBe('${activate.emits}');\n` +
    `  expect(rows[0].aggregate_id).toBe('x1');\n` +
    `});`;

  // The rejection scenario exercises a cross-row invariant reaching through the latestInvoice ref
  // in the POST-activate state (historically activePaidInFull: `where active`, an unpaid latest
  // invoice forbids the state activate lands in). Its premise needs an invariant that (a) applies
  // in activate's target state — no `where`, or a `where inState` naming `activate.to` — and (b)
  // ref-reaches through the invoice ref in its body. A `where`-scope elsewhere (e.g.
  // retryCapWhilePastDue's `pastDue`) is vacuous post-activate and does not count. If no such
  // invariant exists anymore — e.g. the w6 finalize-on-active ruling retired activePaidInFull
  // (net-30: an active sub may legitimately carry an unpaid latest invoice) — the seeded partial
  // payment is spec-legal post-activate and the test's premise is gone: skip it (same
  // skip-silently posture as the shape detection above), keep the success test.
  const appliesPostActivate = (where: Predicate | undefined): boolean =>
    where === undefined || (where.kind === 'inState' && where.states.includes(activate.to));
  const reachesThroughInvoiceRef = sub.invariants.some(inv =>
    inv.candidate.kind === 'statePredicate'
    && appliesPostActivate(inv.candidate.where)
    && refReachPaths(inv.candidate.body).some(path => path[0] === invoiceField.name));
  if (!reachesThroughInvoiceRef) return [success];

  const invariantRejection =
    `it('${activate.name} rejects when the guard passes but the post-state invariant fails, and rolls back', () => {\n` +
    `  const db = new Database(':memory:'); db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));\n` +
    `  insert${invoice.name}(db, make${invoice.name}({ ${invKey}: 'inv1', totalDue: 100, amountPaid: 40 }));\n` +
    `  insert${sub.name}(db, make${sub.name}({ ${subKey}: 'x1', ${region}: '${activate.from[0]}', ${passingOverride}, latestInvoice: 'inv1' }));\n` +
    `  const r = ${activate.name}(db, 'x1');\n` +
    `  expect(r.ok).toBe(false);\n` +
    `  expect((get${sub.name}(db, 'x1') as any).${region}).toBe('${activate.from[0]}');\n` +
    `  expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c).toBe(0);\n` +
    `});`;

  return [success, invariantRejection];
}

// Guarded transitions (t.requires set) whose guard predicate shape guardField doesn't recognize —
// no rejection test is emitted for these. Named explicitly in the header (no-silent-gaps discipline,
// design §5) rather than just vanishing from the suite, so a future spec that grows a new guard shape
// shows up as a visible coverage gap instead of a silent one.
function unrecognizedGuardShapeTransitions(plan: GenPlan): string[] {
  const names: string[] = [];
  for (const a of plan.aggregates) {
    for (const t of a.transitions) {
      if (t.requires && guardField(t.requires) === undefined) names.push(`${a.name}.${t.name}`);
    }
  }
  return names;
}

export function renderTests(plan: GenPlan): string {
  const skipped = unrecognizedGuardShapeTransitions(plan);
  const skippedNote = skipped.length
    ? `// SKIPPED (guard predicate shape not recognized — no rejection test emitted): ${skipped.join(', ')}\n\n`
    : '';
  const header =
    `// GENERATED by lattice from context ${plan.context} — DO NOT EDIT. Regenerate instead.\n\n` +
    `// This suite is generated from the plan's transitions/invariants (task-9 brief): guard-rejection\n` +
    `// tests for every guarded transition whose predicate shape we can invert, plus (where the plan\n` +
    `// matches a recognizable "activate-like" shape) a success+outbox test and an invariant-rejection\n` +
    `// test. It intentionally does not attempt a fully general success test for every transition —\n` +
    `// synthesizing a seed that satisfies ALL adopted invariants for an arbitrary transition is out of\n` +
    `// scope for v1 (see render/tests.ts doc-comment). Honesty over completeness.\n\n` +
    skippedNote +
    `import { describe, it, expect } from 'vitest';\n` +
    `import Database from 'better-sqlite3';\n` +
    `import { readFileSync } from 'node:fs';\n` +
    `import { ${plan.aggregates.map(a => `insert${a.name}, get${a.name}`).join(', ')} } from './repo.js';\n` +
    `import { ${[...new Set(plan.aggregates.flatMap(a => a.transitions.map(t => t.name)))].join(', ')} } from './commands.js';\n` +
    `import type { ${plan.aggregates.map(a => a.name).join(', ')} } from './types.js';\n\n`;

  const seedHelpers = plan.aggregates.map(seedHelper).join('\n\n');

  const guardTests = plan.aggregates
    .flatMap(a => a.transitions.map(t => guardRejectionTest(a, t)))
    .filter((s): s is string => s !== undefined);

  const activateTests = activateSuccessAndInvariantRejectionTests(plan);

  const allTests = [...guardTests, ...activateTests];
  const body =
    `describe('generated service', () => {\n` +
    allTests.map(t => t.split('\n').map(l => '  ' + l).join('\n')).join('\n\n') +
    `\n});\n`;

  return header + seedHelpers + '\n\n' + body;
}
