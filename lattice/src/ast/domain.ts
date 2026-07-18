import type { Path, Predicate } from './invariant.js';

export type PrimType = 'Int' | 'Text' | 'Date' | 'Duration' | 'Money' | 'Id' | 'Boolean';

/**
 * A field/param type. Kinds fall into two tiers (see derived-invariants.md, "carried vs solved") — the
 * split is what lets the full CML rich type system coexist with bounded, decidable verification:
 *
 *   SOLVED core — solver-encoded; derivation reaches semantic leaves (Money, refs, value laws) through
 *   these. `prim`, `enum`, `ref`, `value`, `list` (in its owned-collection form), and `optional` (a
 *   transparent 1:1 wrapper the fold sees straight through).
 *
 *   CARRIED surface — represented for FAITHFUL codegen (Ruby `T::Struct` / TS interfaces) but NOT
 *   solver-encoded. Derivation folds to no leaf and the encoders drop them — exactly as a non-owned
 *   `List<Int>` is dropped today. `map`, `generic`, `union`, and `carrier`.
 *
 * Slice 1 (this change) introduces the CARRIED kinds as first-class representation so the whole CML
 * surface — `Map<K,V>`, `Result<T,E>` and other generics, `A | B` unions, and opaque builtins like
 * `Metadata`/`Currency`/`Decimal`/`TimeRange` — round-trips through the AST. Deriving an invariant
 * OVER a collection/arm (∀ entries of a map, per union arm) is a LATER slice: it adds a
 * collection-scoped Candidate that reuses the owned-collection encoding quint.ts/alloy.ts already have
 * (`sumOverCollection` is the existing precedent). It does NOT widen `Path` — element quantification
 * lives in the Candidate, not the path.
 */
export type TypeRef =
  | { kind: 'prim'; prim: PrimType }
  | { kind: 'enum'; enum: string }
  | { kind: 'ref'; target: string }
  | { kind: 'list'; of: TypeRef }
  | { kind: 'value'; value: string }
  // — rich CML types (Slice 1) —
  | { kind: 'optional'; of: TypeRef }                  // Optional<T>: the fact may be absent. Transparent
                                                       // to the fold; at a FIELD HEAD it is equivalent to
                                                       // Field.optional (the parser normalizes head
                                                       // `Optional<T>` to the flag; this kind carries a
                                                       // NESTED optional, e.g. `Map<K, Optional<V>>`).
  | { kind: 'map'; key: TypeRef; of: TypeRef }         // Map<K,V> — carried; ∀-entry derivation is later.
  | { kind: 'generic'; ctor: string; args: TypeRef[] } // Result<T,E>, user generics — carried; per-arm later.
  | { kind: 'union'; arms: TypeRef[] }                 // A | B | C — carried; per-arm derivation later.
  | { kind: 'carrier'; name: string };                 // opaque builtin/external named type — codegen-only.

/** Unwrap a head `optional` wrapper (idempotent for non-optional types). */
export const unwrapOptional = (t: TypeRef): TypeRef => (t.kind === 'optional' ? unwrapOptional(t.of) : t);

/** True for the CARRIED-surface kinds: represented for codegen, dropped from solving/derivation. */
export const isCarriedType = (t: TypeRef): boolean => {
  switch (t.kind) {
    case 'map': case 'generic': case 'union': case 'carrier': return true;
    case 'optional': return isCarriedType(t.of);
    default: return false;   // prim, enum, ref, list, value — solved core
  }
};

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
export interface EnumDef {
  name: string;
  values: string[];   // variant names — unchanged; every existing consumer (predicates, solvers) reads these
  // Sum-type payloads (Slice 4): present only for variants carrying one (`monetary(Amount)`). Carried
  // (dropped from solving); codegen lowers a payload-bearing enum to a discriminated union.
  payloads?: { [variant: string]: TypeRef };
}
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
/** Free-form carried struct/DTO (Slice 4, `type Name = { … }`). Unlike `value` it is NOT
 *  solver-encoded and has no field restrictions — its fields may be lists/optionals/refs/generics/
 *  other records. A field typed with a record resolves to a `carrier` TypeRef (dropped from solving);
 *  codegen emits it as an interface. Use `value` when you want structural equality + verification;
 *  use `type X = {}` for a plain data shape (e.g. a service/hook DTO). */
export interface RecordDef { name: string; fields: Field[]; doc?: string }

/** A type alias (Slice 4, `type Name = <TypeExpr>`). Resolved (inlined) at parse like CML, so use
 *  sites carry the resolved `target`; the declaration is retained here only so it round-trips. */
export interface TypeAliasDef { name: string; target: TypeRef; doc?: string }

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
  // `optional` is a transparent 1:1 wrapper (Slice 1): fold straight through to the inner type,
  // reusing `f.name` so the path is unchanged — `Optional<Amount>` yields exactly what `Amount`
  // would. Presence is handled at the derivation site (impliedInvariants reads headOptional).
  if (f.type.kind === 'optional') return fieldPathsWhere(m, { ...f, type: f.type.of }, match, visiting);
  // Everything else with no FLAT leaf — list/map/generic/union/carrier/enum/ref — folds to nothing:
  // carried to codegen, dropped from solving. Deriving THROUGH a collection (∀ entries) is a later
  // slice via a collection-scoped Candidate, not this flat-path walk.
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

/** A declared opaque `builtin` carrier type (Slice 2/4). A field typed with one resolves to a
 *  `carrier` TypeRef — codegen represents it, the solver never encodes it. `ref` (Slice 4) is an
 *  optional external identifier (e.g. a Ruby FQN `Opus::Monetary::Core::Types::Amount`) so a codegen
 *  backend imports the existing type rather than emitting a definition. */
export interface BuiltinDef { name: string; ref?: string }

export interface DomainModel {
  context: string;
  doc?: string;              // free-form human description; exempt from identifier validation
  ticksPerDay?: number;      // time granularity; default 24 (tick = 1 hour)
  builtins?: BuiltinDef[];   // declared `builtin` carriers. Omitted (not []) when none are declared,
                             // so a model without builtins is byte-identical to before.
  typeAliases?: TypeAliasDef[]; // `type Name = T` aliases (Slice 4). Inlined at use sites; retained for round-trip.
  records?: RecordDef[];     // `type Name = { … }` free-form carried structs (Slice 4).
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
