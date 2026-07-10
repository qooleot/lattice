import type { GenPlan, PlanAggregate, PlanInvariant, PlanTransition } from '../plan.js';
import type { Field } from '../../ast/domain.js';
import type { Term } from '../../ast/invariant.js';
import { predToTs } from '../invariantCheck.js';

// The generated check function name for a row-kind (statePredicate) invariant. The Task 7
// invariants.ts renderer emits a function under this exact name; commands.ts only calls it.
function checkFnName(invariantName: string): string {
  return `check${invariantName[0]!.toUpperCase()}${invariantName.slice(1)}`;
}

function keyField(a: PlanAggregate): string {
  const key = a.fields.find((f: Field) => f.key);
  if (!key) throw new Error(`aggregate ${a.name} has no key field — commands renderer requires exactly one`);
  return key.name;
}

// Collects every multi-segment field path (e.g. ['latestInvoice','amountPaid']) referenced by a
// statePredicate invariant's where/body. Multi-segment paths reach through a ref field on the
// aggregate into the referenced row — own-row fields are always single-segment.
function multiSegmentPaths(inv: PlanInvariant): string[][] {
  if (inv.candidate.kind !== 'statePredicate') return [];
  const paths: string[][] = [];
  const walkTerm = (t: Term): void => {
    if (t.kind === 'field' && t.path.length > 1) paths.push(t.path);
    if (t.kind === 'plus') { walkTerm(t.left); walkTerm(t.right); }
  };
  const walkPred = (p: import('../../ast/invariant.js').Predicate): void => {
    switch (p.kind) {
      case 'cmp': walkTerm(p.left); walkTerm(p.right); break;
      case 'inState': break;
      case 'and': case 'or': p.args.forEach(walkPred); break;
      case 'not': walkPred(p.arg); break;
      case 'implies': walkPred(p.left); walkPred(p.right); break;
    }
  };
  if (inv.candidate.where) walkPred(inv.candidate.where);
  walkPred(inv.candidate.body);
  return paths;
}

// Renders a `flattenForChecks` helper that pre-loads referenced rows into the flat `row` object so
// the compiled invariant checks' dotted paths (e.g. `row.latestInvoice.amountPaid` as an alias
// `row['latestInvoice.amountPaid']` is NOT what compileInvariantCheck emits — it emits real dotted
// member access `row.latestInvoice.amountPaid`) resolve at runtime. We therefore attach a nested
// object under the ref field's own name, keyed by the field name(s) the invariant reaches through.
function renderFlattenHelper(a: PlanAggregate, plan: GenPlan): string | undefined {
  const paths = a.invariants.flatMap(multiSegmentPaths);
  if (paths.length === 0) return undefined;

  // Group remaining path segments by the leading ref field name.
  const byRefField = new Map<string, Set<string>>();
  for (const path of paths) {
    const [refFieldName, ...rest] = path;
    if (!refFieldName || rest.length === 0) continue;
    if (!byRefField.has(refFieldName)) byRefField.set(refFieldName, new Set());
    for (const seg of rest) byRefField.get(refFieldName)!.add(seg);
  }

  const lines: string[] = [];
  lines.push(`export function flattenForChecks(db: Database.Database, row: any): any {`);
  lines.push(`  const flat: any = { ...row };`);
  for (const [refFieldName] of byRefField) {
    const refField = a.fields.find(f => f.name === refFieldName);
    if (!refField || refField.type.kind !== 'ref') {
      throw new Error(`aggregate ${a.name} invariant reaches through '${refFieldName}' but it is not a ref field`);
    }
    const targetName = refField.type.target;
    const target = plan.aggregates.find(t => t.name === targetName);
    if (!target) throw new Error(`aggregate ${a.name} field '${refFieldName}' targets unknown aggregate '${targetName}'`);
    const targetKey = keyField(target);
    lines.push(
      `  flat.${refFieldName} = db.prepare('SELECT * FROM ${targetName} WHERE ${targetKey} = ?').get(row.${refFieldName});`
    );
  }
  lines.push(`  return flat;`);
  lines.push(`}`);
  return lines.join('\n');
}

interface RowInvariantCheck { name: string; anchors: string[]; }

// Row-kind (statePredicate) invariants are the ones a single handler re-checks against the row it
// just wrote.
function rowInvariantChecks(a: PlanAggregate): RowInvariantCheck[] {
  return a.invariants
    .filter(inv => inv.candidate.kind === 'statePredicate')
    .map(inv => ({ name: inv.name, anchors: inv.anchors.provenance }));
}

// Table-kind (unique) invariants span the whole table. Every adopted transition handler must
// re-check them too (design: "adopted invariants checked after every command") — e.g. the real
// Subscriptions spec adopts `oneDraftInvoicePerSubscription`, a `unique` invariant, and a
// transition into the scoped state could violate it with nothing else catching it.
function tableInvariantChecks(a: PlanAggregate): RowInvariantCheck[] {
  return a.invariants
    .filter(inv => inv.candidate.kind === 'unique')
    .map(inv => ({ name: inv.name, anchors: inv.anchors.provenance }));
}

function transitionHandler(a: PlanAggregate, t: PlanTransition, hasFlatten: boolean): string {
  const fromStates = t.from.map(s => `'${s}'`).join(', ');
  const guardTs = t.requires ? predToTs(t.requires, 'row') : undefined;
  const checks = rowInvariantChecks(a);
  const tableChecks = tableInvariantChecks(a);

  const lines: string[] = [];
  lines.push(`// spec: transition ${t.name}  [anchors: ${t.anchors.provenance.join(', ') || 'none'}]`);
  lines.push(
    `export function ${t.name}(db: Database.Database, id: string): ` +
    `{ ok: true; event?: string } | { ok: false; rejected: string; anchors: string[] } {`
  );
  lines.push(`  const tx = db.transaction(() => {`);
  lines.push(`    const row = get${a.name}(db, id);`);
  lines.push(`    if (!row) throw { rejected: '${t.name}: not found', anchors: [] };`);
  lines.push(`    if (!([${fromStates}].includes(row.${t.region}))) throw { rejected: '${t.name}: illegal from-state', anchors: [] };`);
  if (guardTs) {
    lines.push(
      `    if (!(${guardTs})) throw { rejected: '${t.name}: requires guard failed', ` +
      `anchors: ${JSON.stringify(t.anchors.provenance.length ? t.anchors.provenance : [`spec:transition ${t.name}`])} };`
    );
  }
  lines.push(`    row.${t.region} = '${t.to}';`);
  lines.push(`    update${a.name}(db, row);`);
  if (hasFlatten && checks.length > 0) {
    lines.push(`    const checkRow = flattenForChecks(db, row);`);
  }
  const checkRowVar = hasFlatten ? 'checkRow' : 'row';
  for (const c of checks) {
    const anchors = c.anchors.length ? c.anchors : ['seed:template'];
    lines.push(
      `    if (!(${checkFnName(c.name)}(${checkRowVar}))) ` +
      `throw { rejected: 'invariant ${c.name}', anchors: ${JSON.stringify(anchors)} };`
    );
  }
  for (const c of tableChecks) {
    const anchors = c.anchors.length ? c.anchors : ['seed:template'];
    lines.push(`    const rows_${c.name} = db.prepare('SELECT * FROM ${a.name}').all();`);
    lines.push(
      `    if (!(${checkFnName(c.name)}(rows_${c.name}))) ` +
      `throw { rejected: 'invariant ${c.name}', anchors: ${JSON.stringify(anchors)} };`
    );
  }
  if (t.emits) {
    lines.push(`    appendOutbox(db, '${t.emits}', id, row);`);
    lines.push(`    return '${t.emits}';`);
  } else {
    lines.push(`    return undefined;`);
  }
  lines.push(`  });`);
  lines.push(`  try { const event = tx(); return { ok: true, event }; }`);
  lines.push(`  catch (e: any) { return { ok: false, rejected: e.rejected ?? String(e), anchors: e.anchors ?? [] }; }`);
  lines.push(`}`);
  return lines.join('\n');
}

function aggregateCommands(a: PlanAggregate, plan: GenPlan): { src: string; flattenSrc?: string } {
  const flattenSrc = renderFlattenHelper(a, plan);
  const hasFlatten = flattenSrc !== undefined;
  const handlers = a.transitions.map(t => transitionHandler(a, t, hasFlatten)).join('\n\n');
  return { src: handlers, flattenSrc };
}

export function renderCommands(plan: GenPlan): string {
  const repoNames = new Set<string>();
  for (const a of plan.aggregates) {
    repoNames.add(`get${a.name}`);
    repoNames.add(`update${a.name}`);
  }
  const invariantNames = new Set<string>();
  for (const a of plan.aggregates) {
    for (const c of rowInvariantChecks(a)) invariantNames.add(checkFnName(c.name));
    for (const c of tableInvariantChecks(a)) invariantNames.add(checkFnName(c.name));
  }

  const bodies = plan.aggregates.map(a => aggregateCommands(a, plan));
  const flattenHelpers = bodies.map(b => b.flattenSrc).filter((s): s is string => s !== undefined);
  const commandSrc = bodies.map(b => b.src).filter(s => s.length > 0).join('\n\n');

  const header =
    `// GENERATED by lattice from context ${plan.context} — DO NOT EDIT. Regenerate instead.\n\n` +
    `import type Database from 'better-sqlite3';\n` +
    `import { ${[...repoNames, 'appendOutbox'].join(', ')} } from './repo.js';\n` +
    `export * from './repo.js';\n` +
    (invariantNames.size > 0 ? `import { ${[...invariantNames].join(', ')} } from './invariants.js';\n` : '') +
    `\n`;

  return header + (flattenHelpers.length ? flattenHelpers.join('\n\n') + '\n\n' : '') + commandSrc + '\n';
}
