# Lattice — Slice 4 Design: Grammar & Machine Growth

- **Date:** 2026-07-07
- **Status:** Approved-pending-review design (brainstormed with the human 2026-07-07; forks below
  marked DECIDED were settled in that conversation; three items are flagged REVIEW).
- **Brief:** [`2026-07-05-lattice-slice-4-grammar-machine-growth-brief.md`](2026-07-05-lattice-slice-4-grammar-machine-growth-brief.md)
- **Parent design:** [`docs/plan.md`](../../plan.md) §5.1, §9.1, §10.2, §15.
- **Evidence:** fidelity gate rules b02 (sum-over-collection, 2× not-formalizable), b03/b10
  (process rules that are transition guards, not invariants), `lattice/fidelity/results/REPORT.md`
  grammar backlog, live ledger `.lattice-session-subscriptions/`.

---

## 1. Summary

Grow the language and its elicitation coverage along the two evidence-driven axes:

- **Pillar A — machine enrichment.** Transitions gain `requires` (guard predicate) and `emits`
  (checked reference to a declared `event`). The `machine { region … }` surface is replaced by
  named `lifecycle` blocks (transitions nest inside; `machine`/`region` keywords disappear).
  Phase 0 learns transition elicitation. No `effects`/`do` language this slice (DECIDED, §3.4).
- **Pillar B — invariant growth.** One new elicitable candidate kind: **sum-over-collection**
  (`totalDue == sum(lines, amount)`), ranging over a new structural capability: **entities nested
  inside an aggregate** with owned `List<ChildEntity>` collections (CML-inspired, DECIDED §3.2).
  Plus **value objects** (`value Period { … }`, flat, structural equality, optional structural
  invariant auto-adopted per use site) to cover CML's aggregate-contents triad (DECIDED §3.5).
- **Pillar C — services (added in review).** A `service` construct whose methods *reference*
  transitions (`performs Subscription.activate`) rather than redeclaring them — plus typed
  params, `creates`/`read-only` kinds, method-level `requires` over params, and multi-source
  transitions. Carried structure in v1: validated, printed, diffed, rendered; never
  solver-encoded (DECIDED §3.6–3.7).

Both pillars ship through the full seven-point institutional checklist (brief §2) and the
closed-grammar ceremony (reserved words, reference docs, `not-elicitable` guard, skill text) in
the same commits as the code.

## 2. Context that changed since the brief

Slice 3 (`.lat` parser) and the mermaid/docs slice both landed. Consequences absorbed here:

- `.lat` is the source of truth; every grammar change lands simultaneously in `lat.langium`,
  `fromLangium.ts`, the canonical printer (`emit/code.ts`), round-trip arbitraries, and the
  reconciliation diff (`parse/diff.ts`).
- The language reference (`docs/language/*.md`) exists with a CI parse gate; grammar growth
  updates those pages in the same commit.
- `service` remains unbuilt and owned by the generation slice (user's `command`-vocabulary
  objection recorded there as fork 0). Not touched by this slice.
- Commit ed6ea3b added a guard rejecting candidate paths through solver-dropped fields. List
  fields are dropped by both solvers today, so that guard currently (correctly) blocks
  sum-over-collection; it is narrowed in lockstep with the new encodings (§6.1).

## 3. Decisions (locked with the human, 2026-07-07)

### 3.1 Machine surface → `lifecycle` blocks — DECIDED

UML meta-vocabulary (`machine`, `region`) is replaced by domain vocabulary. One block per
orthogonal dimension; the block name **is** the region name; transitions nest inside their block
and lose the `region` parameter:

```
aggregate Invoice {
  invoiceId : Id key
  totalDue  : Money @total
  amountPaid: Money @balance

  lifecycle settlement {
    states { draft @initial, open @active, paid @terminal, void @terminal, uncollectible @terminal }

    transition finalize { from draft to open;
                          requires totalDue == licenseFeeAmount + usageAmount;
                          emits InvoiceFinalized }
    transition settle   { from open to paid;
                          requires amountPaid == totalDue;
                          emits InvoicePaid }
    transition voidOpen { from open to void }        // unguarded = always allowed
  }
}
```

Survey basis: CML has no machine construct (lifecycle = a marked enum + operation annotations);
XState/SCXML never say "region" user-facing; Event-B/P use "machine" for the whole model. Nobody
writes our current ceremony. XState-style state-nested transitions were rejected: transition
names are load-bearing (ledger anchors; future generation handler names).

The **AST is unchanged in shape**: each `lifecycle` block maps to a `Region` plus its
`TransitionDef`s (with `region` = block name). Invariant surface syntax
(`state settlement in {paid}`, `unique while settlement in {draft}`) is untouched. Solver
emitters, evaluator, mermaid emitters read the AST and are unaffected by the rename.

### 3.2 Nested entities + owned collections — DECIDED

`entity` declarations become legal inside an `aggregate` body (they remain legal at context
level). A field of type `List<E>` where `E` is an entity nested in the *same* aggregate is an
**owned collection** — the child lives inside the aggregate's consistency boundary:

```
aggregate Invoice {
  invoiceId : Id key
  totalDue  : Money @total

  entity InvoiceLine {
    lineId : Id key
    amount : Money
  }
  lines : List<InvoiceLine>

  invariant totalMatchesLines { totalDue == sum(lines, amount) }
}
```

CML triage (from its aggregate doc): **take** nested entities (they are the b02 surface and give
the transaction boundary real teeth); **already have better** — lifecycle (first-class guarded
transitions vs. CML's enum + operation annotations); **skip** the metadata layer (owner,
volatility, criticality, security zones) — nothing consumes it; closed-grammar policy rejects
speculative breadth. `value` objects likewise deferred (no evidence item).

Sum-over-collection's surface is **owned collections only** (not reverse-refs like "all Invoices
whose subscription = self" — that drags in the r04 cross-entity machinery; stays evidence-gated).

### 3.3 Guards are elicitation-only this slice — DECIDED (brief fork 6)

`requires` predicates are validated, carried in the AST, rendered in all projections, and
conjoined into the Quint transition actions — but guards are **not** candidate objects in the
hypothesis loop: no distinguishing questions *about* guards, no guard adoption/pruning. That
machinery is the §9.1 entailment/CTI work, explicitly future. Phase 0 elicits guards as structure
(§7), recorded as structure Q&A in the ledger like states are today.

### 3.4 No effects language — DECIDED (brief fork 1)

Transitions get `requires` + `emits` only. The honest consequence, stated: guards over fields the
machine itself evolves (b10's `retryCount >= maxRetries`) are **declarative-only** this slice —
Quint models non-enum data fields as init-nondeterministic and frozen, so accumulate-then-cap
dynamics are unmodeled; the guard is elicited, rendered, and carried, but temporal claims that
depend on the counter *evolving* are not checkable until an effects language lands. Effects
become necessary exactly when generation wants machine-evolved state; that slice can demand them
with evidence about their required shape.

### 3.5 Value objects — DECIDED (user, review pass 2026-07-07)

`value` joins the language to cover CML's aggregate contents (its entities/VOs/events triad).
v1 scope, deliberately flat:

```
value Period {
  start : Date
  end   : Date
  invariant wellOrdered { start < end }     // optional structural invariant, own fields only
}

aggregate Subscription {
  ...
  period : Period                            // usable as a field type; structural equality
}
```

- Fields are prim/enum only in v1 (`value-flat` diagnostic for refs/lists/values-in-values);
  no `key` (`value-no-key`) — identity-free by definition.
- A value's structural invariant materializes as an **auto-adopted invariant at each use site**
  through the type-carried channel (plan §9 source 6): authored once on the type, applied to
  every owner with provenance `from value Period`. Same trust model as templates (human-authored,
  self-tested schema — not the LLM one-shot channel the gate measured).
- Encodings: **Quint** — nested record inside the owner (`period: { start: Int, end: Int }`),
  paths compile to `.period.start`. **Alloy** — flattened owner fields (`period_start: one Int`);
  a value *sig* would acquire identity, which is exactly the wrong semantics for structural
  equality. Path resolution and salient dims extend to value-field paths in both.

### 3.6 Services via `performs`-reference — DECIDED (user, review pass 2026-07-07)

The `service` construct joins this slice (pulled forward from the generation slice, which becomes
a pure consumer). The CML shape — transitions declared inline on operations, no machine — was
considered and rejected: not every transition is an operation (`expireTrial` is clock-driven,
`dunningExhausted` is a system process — the b10 evidence rule); the solvers walk the machine and
phase 0 builds it before services exist; plan §9.1 prefers machine-encoded safety. Instead,
**reference, not redeclaration**: a method *names* the transition it performs; the transition
remains the single owner of `from/to/requires/emits`; the method adds what only an operation has
— parameters, return type, read/write character:

```
service SubscriptionService {
  createSubscription(plan: ref Catalog.Plan, seats: Int): Subscription creates Subscription
  getSubscription(subId: Id): Subscription read-only
  activate(subId: Id) performs Subscription.activate
  cancel(subId: Id) performs Subscription.cancel
  reserve(subId: Id, delta: Int) performs Subscription.reserve
      requires available >= delta            // method-level guard: params + target fields
}
```

Drift between service and machine is impossible by construction — deleting a transition breaks
the `performs` reference at validation. This also resolves the user's `command`-vocabulary
objection (generation brief fork 0): the surface is methods with typed parameters, no
`command {}` record block; transport stays a generated projection.

**One method, one transition (the `archive` rule).** `performs` references exactly one
transition (which may be multi-source, §3.7). A UI verb whose *outcomes* diverge by state
("archive = cancel if active, delete if draft") is not a domain intention — Evans'
intention-revealing-interfaces principle; production precedent: Stripe's invoice API, where
drafts are `delete`d but finalized invoices must be `void`ed, two operations with state guards.
Divergent outcomes = separate methods; a one-button UX is a UI/projection concern. The language
makes the anti-pattern unrepresentable, and `service.md` documents the rationale.

**Method kinds (exhaustive in v1):** `read-only` (no lifecycle effect), `performs A.t`
(lifecycle operation), `creates A` (constructor — enters the `@initial` state; CML's
`[-> CREATED]`). Data-write methods with no lifecycle move (`recordUsage` mutating
`accruedUnits`) are NOT representable in v1 — they need the effects language and stay with the
generation slice (registry §11.1).

**Method-level `requires`** may reference the method's parameters and the target aggregate's
fields — plan §9.1's canonical `reserve requires available >= delta`, finally expressible
because methods have inputs (transitions never will). `Term` gains a `param` kind, legal only in
method guards. v1: validated + rendered + carried; not solver-encoded (§6.3).

### 3.7 Multi-source transitions — DECIDED (with §3.6)

`transition cancel { from trialing, active, pastDue to canceled }` — one intention, several
legal sources, mirroring CML's `[ S1, S2 -> S3 ]` and collapsing the committed spec's
`cancelFromTrial`/`cancelFromActive`/`cancelFromPastDue` triplet. The guard (if any) is shared
across sources; if the guard should differ per source, that is two intentions → two transitions.
AST: `TransitionDef.from` becomes `string[]`. Quint: the from-state check becomes a disjunction
in the action guard. Templates/evaluator/diff treat the transition as one named object.

### 3.8 Sequencing — DECIDED (brief fork 5)

Slice 3 landed first; this slice extends the landed `.lat` grammar/parser/printer as part of its
own definition of done. The generation slice is told (via its brief) that machine enrichment
arrives with this slice.

## 4. Surface syntax & grammar deltas

### 4.1 `lat.langium`

```
AggregateDecl:
    docs+=DOC* 'aggregate' name=ID '{'
        (fields+=FieldDecl | entities+=EntityDecl)*
        lifecycles+=LifecycleDecl*
        invariants+=InvariantDecl*
    '}';

LifecycleDecl:                                   // replaces MachineDecl + RegionDecl
    'lifecycle' name=ID '{'
        'states' '{' states+=StateDecl (',' states+=StateDecl)* '}'
        transitions+=TransitionDecl*
    '}';

TransitionDecl:                                  // 'region' param gone; requires/emits new;
    'transition' name=ID '{'                     // multi-source 'from'
        'from' from+=ID (',' from+=ID)* 'to' to=ID
        (';' 'when' when=ID)?
        (';' 'requires' requires=Predicate)?
        (';' 'emits' emits=ID)?
    '}';

ServiceDecl:                                     // new ContextItem alternative
    docs+=DOC* 'service' name=ID '{' methods+=MethodDecl* '}';

MethodDecl:
    docs+=DOC* name=ID '(' (params+=ParamDecl (',' params+=ParamDecl)*)? ')'
        (':' returns=LatType)?
        ( readOnly?='read-only'
        | 'performs' performsAgg=ID '.' performsTransition=ID
        | 'creates' creates=ID )
        ('requires' requires=Predicate)?;

ParamDecl:
    name=ID ':' type=LatType;

SumBody:                                         // new InvariantBody alternative (closed form,
    total=PathExpr op=('=='|'<='|'>=')           //  like ConserveBody — NOT a general term)
        'sum' '(' collection=ID ',' field=ID ')';

ValueDecl:                                       // new ContextItem alternative
    docs+=DOC* 'value' name=ID '{' fields+=FieldDecl* invariants+=InvariantDecl* '}';
```

Notes:
- `requires` reuses the existing `Predicate` rule verbatim — no new predicate syntax.
- `emits` is an `ID` cross-checked against declared `event` names (semantic validation, not a
  Langium cross-reference, consistent with how `ref` targets are handled).
- `when` stays as today — note (correction, 2026-07-07 code read): it is already validated
  against declared events (`unknown-event`, validate.ts) — the trigger vocabulary is events, and
  `emits` reuses the same check for the published side.
- `sum` is a dedicated invariant-body form, not a term: the closed grammar grows by one shape,
  not by an expression language. Ops `==`/`<=`/`>=` share one machinery and give the loop
  genuinely distinct candidates to distinguish ("exactly" vs "at most").

### 4.2 Reserved words (`src/ast/reserved.ts` + grammar-sync test)

Add: `lifecycle`, `requires`, `emits`, `sum`, `value`, `service`, `performs`, `creates`,
`read-only`. Remove: `machine`, `region` (no longer keywords). The existing sync test enforces
the lockstep.

### 4.3 Migration of committed specs

`specs/subscriptions/spec.lat` and `specs/catalog/spec.lat` are rewritten to the new surface in
the **same commit** as the grammar+printer change (parse of old syntax is not preserved — the
language is pre-1.0 and `.lat` files are regenerable from the engine; the reconciliation diff
keys on names, not syntax, so ledger continuity is unaffected). Prose/diagram projections
regenerate in that commit.

## 5. AST & validation

### 5.1 Types (`src/ast/domain.ts`)

```ts
export interface TransitionDef {
  name: string; region: string; from: string[]; to: string;   // from: multi-source (§3.7)
  when?: string;
  requires?: Predicate;      // from ast/invariant.ts — same predicate AST as candidates
  emits?: string;            // name of a declared EventDef
}
export interface ParamDef { name: string; type: TypeRef }
export interface MethodDef {
  name: string; params: ParamDef[]; returns?: TypeRef; doc?: string;
  kind: { readOnly: true }
      | { performs: { aggregate: string; transition: string } }
      | { creates: string };
  requires?: Predicate;      // may use Term kind 'param' (only here)
}
export interface ServiceDef { name: string; methods: MethodDef[]; doc?: string }
export interface AggregateDef {
  kind: 'aggregate'; name: string; fields: Field[];
  entities?: EntityDef[];    // NEW: children owned by this aggregate
  machine?: Machine;         // shape unchanged; built from lifecycle blocks
  doc?: string;
}
export interface ValueDef {  // NEW
  kind: 'value'; name: string; fields: Field[];   // prim/enum fields only (v1)
  invariants?: { name: string; body: Predicate; doc?: string }[];  // own-field structural laws
  doc?: string;
}
// DomainModel gains `values: ValueDef[]` and `services: ServiceDef[]`;
// TypeRef gains { kind: 'value'; value: string };
// Term gains { kind: 'param'; name: string } — legal only in method-level requires.
```

`Candidate` grows one member:

```ts
| { kind: 'sumOverCollection'; aggregate: string;
    collection: string;      // owned List<E> field name on the aggregate
    child: string;           // E's name — carried so the model-free evaluator can find child rows
    field: string;           // numeric field on the child entity E
    op: 'eq' | 'le' | 'ge';
    total: Path }            // numeric path on the aggregate (own fields; no ref-hops in v1)
```

### 5.2 Validation rules (checklist point 1 — never throws, named codes)

- `requires`: predicate validated against the **owning aggregate only** — own fields + own
  region states; `inState` must name a region of this aggregate; ref-hops and cross-aggregate
  owners rejected (`guard-cross-aggregate`); `from`/`to`/states validated as today.
- `emits`: must name a declared context event (`unknown-event`).
- Nested entities: exactly one `key` field (`child-key-required`); child names share the context
  identifier namespace (globally unique — solver sig naming stays flat); nested entity fields may
  not be `List` or `ref` in v1 (`nested-entity-flat` — evidence-gated later).
- Owned collection: `List<E>` is *owned* iff `E` is nested in the same aggregate. `List` of
  anything else remains solver-dropped exactly as today.
- `sumOverCollection`: `collection` must be an owned collection of the subject aggregate
  (`sum-not-owned-collection`); `field` numeric (Int/Money) on the child (`ill-typed`); `total`
  numeric on the aggregate (`ill-typed`).
- Lifecycle blocks: ≥1 state, exactly one `@initial`, unique block names per aggregate — the
  existing Region validations, re-homed.
- Values: fields prim/enum only (`value-flat`); no `key` (`value-no-key`); structural invariants
  reference own fields only; value names share the context identifier namespace.
- Transitions: `from` sources are distinct states of the region (`duplicate-source`); the
  `to` state may not appear in `from` (self-loops need evidence before we admit them).
- Services: `performs` target must be a declared transition of a declared aggregate
  (`unknown-transition`); `creates` target a declared aggregate (`unknown-aggregate`); method
  `requires` may reference method params plus the target aggregate's own fields/states — `param`
  terms anywhere else are `ill-typed`, and a `requires` on a `read-only` method (which has no
  target aggregate) may reference params only; method/param names follow existing identifier
  hygiene; a method's return type must name a declared type.

### 5.2.1 Guard expressiveness (reviewed against the formal-verification claim)

`requires` reuses the closed `Predicate`/`Term` types — linear integer arithmetic (plus-only),
enum values, `now`, state membership, boolean connectives. For what this slice claims (legality
of steps, checked bounded), this fragment is decidable and comfortably inside both engines. Its
real limits, stated so nobody discovers them as surprises:

1. **No command parameters** — the biggest gap. Plan §9.1's canonical guard is
   `reserve requires available >= delta` where `delta` is an *input*; inputs do not exist until
   the service construct lands (generation slice owns it). v1 guards range over current state
   only — which is exactly what the b03/b10 evidence needs.
2. **Plus-only terms** — no minus (rewritable as addition on the other side), no constant
   multiplication. Same restriction invariant bodies already live with.
3. **No collection atoms** — `requires sum(lines, amount) == totalDue` is not expressible; `sum`
   is an invariant-body form, not a term. Evidence-gated widening if a real domain demands it.
4. **Own-aggregate only** (§3.3) — cross-aggregate guards are the r04 ref-hop class.

Each limit is an additive widening of the same closed types; (1) is already owned by the
service-construct design.

### 5.3 Evaluator semantics (checklist point 2 — pure-TS ground truth)

- Witness states gain child rows: an aggregate instance carries `collection → array of child
  records`. `evaluateCandidate` for `sumOverCollection` computes the exact fold with unbounded JS
  integers — the ground truth that backstops the bounded solver encodings (§6.2).
- Guards do not change `evaluateCandidate` (they are not candidates). The evaluator's witness
  model is unchanged for Pillar A.

## 6. Solver encodings (the section this design exists for)

Three audited gaps; each with a decided policy. Capabilities were reviewed against current docs
(Quint builtin/language reference; Alloy 6 feature docs), not just our emitted subset. Two
findings worth recording:

- **Alloy 6 has native temporal checking** (`var` sigs, `always`/`eventually`, lasso traces,
  `for 1.. steps`). "Alloy = structural, Quint = behavioral" is therefore *our* architectural
  choice, kept deliberately: encoding the machine behaviorally twice would create a two-truths
  problem inside our own toolchain. Alloy stays the single-state structural witness engine.
- Quint docs confirm the encoding §6.1 relies on: `setOfMaps(Set[a], Set[b]) => Set[(a -> b)]`
  with `nondet … = oneOf(…)` legal only at action scope, and `foldl`/`range` for the sum.

### 6.1 Owned collections exist in neither solver today

`emit/quint.ts:31` returns null for lists; Alloy drops list fields; ed6ea3b's dropped-path guard
rejects candidates over them. The encodings:

- **Quint:** an owned collection is a **bounded map** inside the parent record:
  `lines: Int -> { amount: Int, … }` over fixed index domain `0..M-1` plus `lineCount: Int`
  (`0 <= lineCount <= M`). Init draws the map and count nondeterministically (`oneOf(setOfMaps…)`
  at action top level — Quint's nondet-placement rule makes per-element nondet inside folds
  illegal, hence the map draw). `sum(lines, amount)` compiles to a fold over `0..lineCount-1` —
  within plan §15's fold-only discipline; Apalache handles bounded folds. Like other non-enum
  data, collections are **frozen after init** this slice (no line-mutation actions) — consistent
  with how scalar fields already behave, and sufficient for structural sum witnesses.
  **Default bound M = 3**, a per-query knob like `scope`.
- **Alloy:** child sig with by-construction containment — `sig InvoiceLine { owner: one Invoice,
  amount: one Int }`; the parent's collection is the relational inverse (`owner.i`). Ownership
  needs no extra fact (`one owner` is the containment); child-key uniqueness *within parent* is
  one fact per nested entity. `sum(lines, amount)` compiles to Alloy's native
  `(sum l: owner.i | l.amount)`. Child sig cardinality bounded by the query scope.
- The ed6ea3b dropped-path guard is narrowed to admit exactly: owned-collection paths appearing
  in `sumOverCollection` candidates. All other list paths stay rejected.

Ownership as a verification statement: orphan children are unrepresentable (Quint: nesting;
Alloy: `one owner`), and `refsResolve` is neither needed nor derived for owned children.

### 6.2 Alloy integer bitwidth (soundness)

Queries run `for <scope> but 5 Int` (−16..15). A 3-line sum of amounts ≤15 reaches 45 and wraps
silently — spurious or missed witnesses. Policy:

- When a query involves any `sum` form: bitwidth rises to **7 Int** (−64..63), witness value
  bounds stay 0..15, collection cardinality ≤ M = 3, so `M × maxVal = 45 < 63` — no overflow is
  reachable. The bitwidth choice is computed, asserted in a test, and documented in the query
  header comment (no silent constant).
- `evaluateCandidate` (unbounded ints) remains the adjudicating semantics for every witness
  before it reaches a human — a residual solver artifact loses to the evaluator, as today.
- Defense-in-depth: Alloy's API exposes a `noOverflow` option (excludes instances reachable only
  via wrapped arithmetic). If our runner exposes it cleanly, set it for sum queries; the bitwidth
  policy above is the primary guarantee either way.

### 6.3 Guards and emits in the emitters

- **Quint:** declared-transition actions gain the guard as one more conjunct beside the
  from-state check: `all { rec.settlement_state == "open", <requires compiled by predToQuint>,
  … }`. Multi-source transitions compile the from-check to a disjunction over the source states.
  `emits` has **no Quint semantics** this slice (no event-trace variable) — it is carried
  structure for projections/generation; stated in the reference docs.
- **Alloy:** no transition concept (structural solver, by slice-1 division). Guards/emits do not
  route to Alloy; per checklist point 3 this is an **explicit routing restriction** — behavioral
  guard queries are Quint-only, and the restriction is documented + tested, not silent.
- **Services: not solver-encoded at all in v1** (second explicit routing restriction). The
  machine remains the verified object; method contracts (params, `performs`, method `requires`)
  are validated, printed, diffed, and rendered, but no Quint action or Alloy sig derives from a
  service. Execution semantics arrive with the generation slice; entailment between method
  guards and transition guards is inference-slice work (§11.1).

### 6.4 Salient dims & shape rebuilders (checklist points 4, 5, 7)

For `sumOverCollection` witnesses the salient dims are exactly: the **collection count**, the
**fold value**, and the **total field** (with the all-subjects-agree guard as usual). Individual
child rows are rendered in the witness table for the human but are **not** dims — shapes never
constrain per-row values, so a judged shape constrains {count, sum, total} and can never be
broader than the judged violation nor cancel a distinct pair differing only in row arrangement.
Masking regression tests (the Task-17/18 class) cover: two witnesses with equal sums but
different row splits (must not be distinguished by shape), and unequal sums (must be).
`shapeToQuint`/`shapeToPred` rebuild count/sum/total constraints in both encodings.

## 7. Phase-0 transition elicitation (brief fork 4)

Recognition-over-recall, extending the existing skill flow; recorded via `engine structure` Q&A
into the ledger as today:

1. After a lifecycle's states are agreed, **propose the full transition set** from domain
   knowledge, named, as one list ("here are the legal moves I believe exist — `activate`:
   trialing→active, … — any missing? any that shouldn't exist?"). One correction round.
2. **Skip probes** for the no-skip/#10 class: for state pairs with no direct edge that domain
   priors flag as tempting ("can a Subscription go trialing→canceled directly, skipping
   active?"). The confirmed *absence* of an edge is the no-skip property — enforced by
   construction, because Quint only steps declared transitions once any are declared. Template
   #10 is thereby realized as an elicitation behavior + the closed transition set, **not** a new
   invariant kind.
3. **Guard elicitation** per transition: "is `settle` always allowed from `open`, or only under
   a condition?" — multiple choice with proposed guard candidates over own fields. When the
   honest guard needs a fact the model lacks (b03: payment truth lives on Invoice), the move is
   to **surface the missing field** ("what on Subscription records that payment succeeded?") and
   add it — the pre-aggregated-field pattern the live session already used.
4. **Event elicitation**: propose past-tense event names for the notable transitions
   (`InvoicePaid`); confirm/decline; declared `event`s and `emits` links recorded.
5. **Service seeding**: one question per aggregate — "which of these moves are operations
   someone invokes (vs. system/time-driven)?" — the invokable ones seed `performs` methods, plus
   proposed `creates`/read methods; user corrects the list. (The compressible step if the budget
   strains.)

Question budget: the structure budget grows from ~10 to **~15** — the transition-set proposal is
one question per lifecycle, plus 1–3 skip/guard probes per lifecycle chosen by domain-prior
salience (not exhaustive pair enumeration), plus service seeding. (REVIEW #2, §10.)

## 8. Template triage (brief fork 3)

- **#10 ordered-lifecycle/no-skip — IN**, as elicitation behavior (§7.2), no new invariant kind.
- **#4 idempotency, #12 saga net-zero — DEFERRED** (need `external`/saga constructs; own slice).
- **#5 reservation-release — DEFERRED** (REVIEW #1, §10): `leadsTo` exists template-only and the
  checking machinery suffices at bounded depth, but the template needs a `@reservation` tag
  convention that no gate rule or live session has demanded. Evidence-gated: first real domain
  with a reservation bucket revives it as a small follow-up.

## 9. Projections & closed-grammar ceremony

Per new form, in the same commits as the code:

- **Prose** (`emit/prose.ts`): lifecycle sections render guards ("only if amountPaid ==
  totalDue") and emitted events ("announces InvoicePaid"); nested entities render as owned
  sub-tables; sum invariants render as English with their ledger anchors.
- **Diagrams** (`emit/mermaid*`): statechart edges gain labels
  `finalize [totalDue == …] / InvoiceFinalized`; domain classDiagram shows nested entities inside
  their aggregate with a composition edge, and service boxes with method signatures — filling the
  follow-up slot the mermaid slice explicitly left for the service construct.
- **`.lat` printer** (`emit/code.ts`) + round-trip arbitraries (`test/parse/arbitraries.ts`):
  print/parse identity for lifecycle blocks, requires/emits, nested entities, sum bodies.
- **Reference docs** (`docs/language/`): `machine.md` → `lifecycle.md` (rewrite),
  `transition.md` (requires/emits/multi-source), `entity.md` (nesting + ownership),
  `invariant-forms.md` (sum), new `value.md`, new `service.md` (including the one-method-one-
  transition rationale, §3.6), all passing the existing docs parse gate.
- **Elicitable-kind guard** (`src/cli.ts`): `sumOverCollection` joins the proposable set;
  `not-elicitable` list otherwise unchanged.
- **Skill** (`.claude/skills/elicit-spec/SKILL.md`): Phase 0 gains §7's transition elicitation;
  Phase 1's elicitable-kinds sentence gains `sumOverCollection`.

## 10. Items flagged for the human's review pass

1. **Template #5 deferred** (§8) — the brief said "evaluate"; my call is defer on
   no-evidence grounds. Cheap to include if you disagree.
2. **Phase-0 question budget ~14** (§7) — the transition questions add ~4 to the structure
   budget. If that feels heavy, the skip-probes (step 2) are the compressible part.
3. **Sum ops `==`/`<=`/`>=`** (§4.1) — b02's evidence is equality-only; the two inequalities are
   near-free on the same machinery and improve the loop's alternatives, but they are, strictly,
   beyond the letter of the evidence.

## 11. Honest ceiling (what this slice does NOT claim)

No guard-completeness/deadlock checking; no reachability analysis; no entailment classification
(§9.1) — guards may make existing invariant conjuncts redundant (e.g. `settle`'s guard vs.
`neverOverpaidAndPaidExact`), and we keep the invariants as regression anchors rather than
classifying them; no effects → machine-evolved data dynamics unmodeled (b10 declarative-only,
§3.4); `emits` carries no verification semantics; collections are frozen after init in Quint;
guards are not solver-loop candidates; services are carried structure — validated and rendered,
never solver-encoded or executed (no atomicity/saga analysis, no transport, no entailment
between method guards and transition guards). Each restriction is stated in the reference docs.

### 11.1 Deferred-work registry (every ceiling item has an address, not a shrug)

| Deferred item | Future home | Evidence trigger |
|---|---|---|
| Effects/`do` language; collection mutation actions | New brief, demanded by the **generation slice** | Generation needs machine-evolved state; its design says what shape effects must take |
| Guard candidates in the solver loop; entailment classification; CTI-guided inference; guard-completeness / deadlock / reachability | An **inference slice** (plan §9.1) — no brief yet; **write its brief once slice 4 ships** and real guard usage exists | Guards on committed specs = the corpus §9.1 classifies |
| `emits` verification semantics (event traces) | **Conformance slice** (already sequenced after generation) | Outbox trace diffing per generation brief §5 |
| Method execution semantics (atomicity, sagas, `external`, transport/OpenAPI); data-write methods with no lifecycle move | **Generation slice** (now a pure consumer of the §3.6 surface) | Its brainstorm; effects evidence |
| Method-guard ⊨ transition-guard entailment; solver encoding of methods | **Inference slice** | Real `performs` + method-`requires` usage from this slice |
| Cross-aggregate guards; reverse-ref sums; collection atoms in predicates | Evidence-gated grammar growth | r04-class or new gate/live-session failures |
| Templates #4 idempotency, #12 saga net-zero | `external`/saga slice of their own | Per brief triage |
| Template #5 reservation-release | Small follow-up | First real domain with a reservation bucket |

## 12. Validation & definition of done

Real solvers throughout (durable no-simulation rule); `cd lattice && npx tsc --noEmit && npx
vitest run` before every commit; goldens A/B/C never weakened; never `git add -A`.

1. **Subscriptions demo (Pillar A):** transition elicitation runs on the committed Subscriptions
   spec; the machine gains guarded transitions (the b03-shaped `activate` guard via a surfaced
   field, the b10-shaped `dunningExhausted` guard); the `cancelFrom*` triplet collapses into one
   multi-source `cancel`; a `SubscriptionService` with `performs`/`creates`/`read-only` methods
   is elicited and rendered; guards, events, and services render in prose AND diagrams; `.lat`
   round-trips.
2. **b02 one-shot re-formalization:** the gate's b02 formalizer prompt (fresh context, same
   protocol) against the grown grammar formalizes sum-over-collection and passes its own judged
   cases — a one-rule smoke, not a gate re-run.
3. **Mini golden trace D:** an invoice-lines domain elicited end-to-end with real solvers where
   the residual invariant is a sum-over-collection form — covering propose → distinguish →
   verdict → adopt → emit with the new kind, including a masking regression (§6.4) in the
   assertions. The domain carries a `value` object (e.g. `Period` with `start < end`) so value
   round-trip, solver inlining, and the type-carried auto-adoption are exercised for real.
4. **Seven checklist points** demonstrably satisfied for each new form (`requires`, `emits`,
   `sumOverCollection`, value structural invariants — which ride the existing statePredicate
   machinery per use site), with the three explicit routing restrictions (guards: Quint-only;
   sums: both engines; services: neither engine) tested, not implied. Multi-source transitions
   and service declarations get the surface treatment (validate / print / round-trip / diff /
   render) plus the Quint from-disjunction test.
5. **Closed-grammar surfaces** (reserved words, reference docs, `not-elicitable`, skill text,
   committed spec migration) updated in the same commits as the features they describe.

## 13. Out of scope

Effects/`do` blocks; CML metadata attributes; service *execution* semantics — atomicity, sagas,
`external`, transport/OpenAPI projection, data-write methods (generation slice); solver encoding
of methods and method↔transition guard entailment (inference slice); reverse-ref sum surface;
guard candidates in the solver loop; entailment classification; `when`-trigger checking;
cross-aggregate guards; nested-entity `ref`/`List` fields; values containing refs/lists/values;
self-loop transitions; templates #4/#5/#12.
