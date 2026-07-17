import type { Path, Predicate } from './invariant.js';

export type PrimType = 'Int' | 'Text' | 'Date' | 'Duration' | 'Money' | 'Id';

export type TypeRef =
  | { kind: 'prim'; prim: PrimType }
  | { kind: 'enum'; enum: string }
  | { kind: 'ref'; target: string }
  | { kind: 'list'; of: TypeRef }
  | { kind: 'value'; value: string };

export interface Field {
  name: string;
  type: TypeRef;
  key?: boolean;
  const?: boolean;
  optional?: boolean;   // `Type?` — the fact may be absent. Absence is never inferred: an
                        // invariant reading an optional path must say what absence means
                        // (see grammar.ts's absence-undecided).
  tags?: string[];   // semantic tags (spec plan §10.1): 'balance', 'total', 'monotonic', …
}
export interface StateDef { name: string; tags?: ('active' | 'terminal')[] }
export interface Region { name: string; initial: string; states: StateDef[] }
export interface TransitionDef {
  name: string; region: string; from: string[]; to: string;
  when?: string;
  requires?: Predicate;   // guard over the OWN aggregate's fields + machine state (design §3.3)
  emits?: string;         // declared event this transition announces on firing (design §3.6)
}
export interface Machine { regions: Region[]; transitions: TransitionDef[] }
export interface EnumDef { name: string; values: string[] }
/** Structural, keyless value type (design §3.5): compared by structure, not identity — fields are
 *  prim, enum, or ANOTHER VALUE (slice B2: values nest; `value-flat` now rejects only ref/list, and
 *  `value-cycle` rejects a cycle in the value→value graph, which has no finite flattening). Its
 *  invariants are own-field laws auto-enforced at every use site — fully solver-encoded, not
 *  surface-only: quint nests a record (`fieldQType`), alloy flattens to `<field>_<sub>` relations
 *  (`valueSubRelations`), and implied.ts's `valueLawInstances` instantiates each law per use site —
 *  on an aggregate, a top-level entity, or an aggregate-owned CHILD alike (its owner list matches
 *  impliedInvariants' own, right below it). See derived-invariants.md. */
export interface ValueDef {
  kind: 'value'; name: string; fields: Field[];
  invariants?: { name: string; body: Predicate; doc?: string }[];
  doc?: string;
}
export interface EntityDef { kind: 'entity'; name: string; fields: Field[]; doc?: string }
export interface AggregateDef { kind: 'aggregate'; name: string; fields: Field[]; entities?: EntityDef[]; machine?: Machine; doc?: string }
export interface EventDef { name: string; fields: Field[]; doc?: string }

/** Service methods (design §3.6): carried structure only — never solver-encoded. A method's
 *  `kind` names exactly one of: a read-only query, a `performs`-reference to a declared transition
 *  on an aggregate (the "one method, one transition" rule), or a `creates` reference to an
 *  aggregate. `requires` is a method-level guard over params + (for performs/creates) the target
 *  aggregate's own fields/states — its Term may use the 'param' kind, legal ONLY here. */
export interface ParamDef { name: string; type: TypeRef }
export interface MethodDef {
  name: string; params: ParamDef[]; returns?: TypeRef; doc?: string;
  kind: { readOnly: true } | { performs: { aggregate: string; transition: string } } | { creates: string };
  requires?: Predicate;
}
export interface ServiceDef { name: string; methods: MethodDef[]; doc?: string }

/** The nested child an owned collection ranges over, or null (design §3.2). */
export function ownedCollectionChild(a: AggregateDef, f: Field): EntityDef | null {
  if (f.type.kind !== 'list' || f.type.of.kind !== 'ref') return null;
  return a.entities?.find(e => e.name === (f.type as any).of.target) ?? null;
}

/**
 * Shared recursive walk behind both `moneyFieldPaths` and `numericFieldPaths` below: `[f.name]` when
 * `f` is a prim whose `PrimType` satisfies `match`, `[f.name, ...sub]` for each matching path
 * reachable through a value-typed field — recursing through however many value hops it takes
 * (`total : Outer`, `Outer { inner : Amount }`, `Amount { amount : Money }` yields
 * `[["total","inner","amount"]]`) — `[]` for anything else. One walker, two questions asked of it
 * (`=== 'Money'` vs. the wider solver-numeric set) rather than two hand-maintained recursions that
 * could independently drift on the same shape fact.
 *
 * `visiting` guards a value cycle (`value A { b : B }` + `value B { a : A }`): validate.ts's
 * `value-cycle` check now rejects one at init, so this function is unreachable on a validated
 * model — but it stays as defense-in-depth for hand-built models (tests construct a DomainModel
 * directly, bypassing validateModel), so a value name already on the current descent still stops
 * recursion instead of looping forever. Total and side-effect-free — a fresh Set per branch, never
 * mutated in place — since both call sites depend on that.
 */
function fieldPathsWhere(m: DomainModel, f: Field, match: (p: PrimType) => boolean,
    visiting: ReadonlySet<string> = new Set()): Path[] {
  if (f.type.kind === 'prim') return match(f.type.prim) ? [[f.name]] : [];
  if (f.type.kind !== 'value') return [];
  const valueName = (f.type as { kind: 'value'; value: string }).value;
  if (visiting.has(valueName)) return [];
  const vdef = m.values.find(v => v.name === valueName);
  if (!vdef) return [];
  const nested = new Set(visiting).add(valueName);
  return vdef.fields.flatMap(sub =>
    fieldPathsWhere(m, sub, match, nested).map(path => [f.name, ...path]));
}

/**
 * Every solver-visible `Money` path field `f` contributes on its own (see `fieldPathsWhere` for the
 * recursion/cycle-guard shape). Single source of truth for "what carries money" — shared by the
 * DEMAND side (validate.ts's undecidedMoneySigns, which asks whether a sign was ever decided for a
 * path) and the DERIVATION side (implied.ts's moneyPaths, which turns each path into a non-negative
 * candidate) so the two cannot independently drift on the same shape fact. Deliberately silent on
 * sign/tags: `@signed` filtering is a derivation policy that stays in implied.ts, not a shape fact,
 * because undecidedMoneySigns must still demand a decision on an untagged field while moneyPaths
 * must skip a `@signed` one — same shape, different question asked of it.
 */
export function moneyFieldPaths(m: DomainModel, f: Field, visiting: ReadonlySet<string> = new Set()): Path[] {
  return fieldPathsWhere(m, f, p => p === 'Money', visiting);
}

/**
 * Every path reachable from `f` whose PRIM is one of the four solver-numeric types (`Int`, `Money`,
 * `Date`, `Duration` — the types arithmetic/comparison actually means something for), recursing
 * through value hops exactly as `moneyFieldPaths` does. This is a DIFFERENT question from
 * `moneyFieldPaths`: a `@balance`/`@total` tag (templates.ts's `numericTagPath`, validate.ts's
 * `ambiguous-numeric-tag`) needs "the one summable number `f` names", which is `Int`/`Date`/
 * `Duration`-inclusive and cares about ambiguity (>=2 matches), not "every Money amount in the
 * model" — so this stays a distinct function rather than being folded into moneyFieldPaths, even
 * though the recursion it rides on (`fieldPathsWhere`) is shared.
 */
export function numericFieldPaths(m: DomainModel, f: Field, visiting: ReadonlySet<string> = new Set()): Path[] {
  const NUM = new Set<PrimType>(['Int', 'Money', 'Date', 'Duration']);
  return fieldPathsWhere(m, f, p => NUM.has(p), visiting);
}

export interface DomainModel {
  context: string;
  doc?: string;              // free-form human description; exempt from identifier validation
  ticksPerDay?: number;      // time granularity; default 24 (tick = 1 hour)
  enums: EnumDef[];
  values: ValueDef[];
  entities: EntityDef[];
  aggregates: AggregateDef[];
  events: EventDef[];
  services: ServiceDef[];
}

/** Cross-context reference (spec §4.2): target is 'Context.Type'. Structural only —
 *  excluded from NoOrphan/refs-resolve derivation and all solver encodings. */
export const isQualifiedRef = (t: TypeRef): t is TypeRef & { kind: 'ref' } =>
  t.kind === 'ref' && t.target.includes('.');
