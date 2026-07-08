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

### 3.5 Sequencing — DECIDED (brief fork 5)

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

TransitionDecl:                                  // 'region' param gone; requires/emits new
    'transition' name=ID '{' 'from' from=ID 'to' to=ID
        (';' 'when' when=ID)?
        (';' 'requires' requires=Predicate)?
        (';' 'emits' emits=ID)?
    '}';

SumBody:                                         // new InvariantBody alternative (closed form,
    total=PathExpr op=('=='|'<='|'>=')           //  like ConserveBody — NOT a general term)
        'sum' '(' collection=ID ',' field=ID ')';
```

Notes:
- `requires` reuses the existing `Predicate` rule verbatim — no new predicate syntax.
- `emits` is an `ID` cross-checked against declared `event` names (semantic validation, not a
  Langium cross-reference, consistent with how `ref` targets are handled).
- `when` stays a free identifier (unchecked), as today. Tightening it to declared
  events/commands is a generation-slice question.
- `sum` is a dedicated invariant-body form, not a term: the closed grammar grows by one shape,
  not by an expression language. Ops `==`/`<=`/`>=` share one machinery and give the loop
  genuinely distinct candidates to distinguish ("exactly" vs "at most").

### 4.2 Reserved words (`src/ast/reserved.ts` + grammar-sync test)

Add: `lifecycle`, `requires`, `emits`, `sum`. Remove: `machine`, `region` (no longer keywords).
The existing sync test enforces the lockstep.

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
  name: string; region: string; from: string; to: string;
  when?: string;
  requires?: Predicate;      // from ast/invariant.ts — same predicate AST as candidates
  emits?: string;            // name of a declared EventDef
}
export interface AggregateDef {
  kind: 'aggregate'; name: string; fields: Field[];
  entities?: EntityDef[];    // NEW: children owned by this aggregate
  machine?: Machine;         // shape unchanged; built from lifecycle blocks
  doc?: string;
}
```

`Candidate` grows one member:

```ts
| { kind: 'sumOverCollection'; aggregate: string;
    collection: string;      // owned List<E> field name on the aggregate
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

### 5.3 Evaluator semantics (checklist point 2 — pure-TS ground truth)

- Witness states gain child rows: an aggregate instance carries `collection → array of child
  records`. `evaluateCandidate` for `sumOverCollection` computes the exact fold with unbounded JS
  integers — the ground truth that backstops the bounded solver encodings (§6.2).
- Guards do not change `evaluateCandidate` (they are not candidates). The evaluator's witness
  model is unchanged for Pillar A.

## 6. Solver encodings (the section this design exists for)

Three audited gaps; each with a decided policy.

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

### 6.3 Guards and emits in the emitters

- **Quint:** declared-transition actions gain the guard as one more conjunct beside the
  from-state check: `all { rec.settlement_state == "open", <requires compiled by predToQuint>,
  … }`. `emits` has **no Quint semantics** this slice (no event-trace variable) — it is carried
  structure for projections/generation; stated in the reference docs.
- **Alloy:** no transition concept (structural solver, by slice-1 division). Guards/emits do not
  route to Alloy; per checklist point 3 this is an **explicit routing restriction** — behavioral
  guard queries are Quint-only, and the restriction is documented + tested, not silent.

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

Question budget: the structure budget grows from ~10 to **~14** — the transition-set proposal is
one question per lifecycle, plus 1–3 skip/guard probes per lifecycle chosen by domain-prior
salience, not exhaustive pair enumeration. (REVIEW #2, §10.)

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
  their aggregate with a composition edge.
- **`.lat` printer** (`emit/code.ts`) + round-trip arbitraries (`test/parse/arbitraries.ts`):
  print/parse identity for lifecycle blocks, requires/emits, nested entities, sum bodies.
- **Reference docs** (`docs/language/`): `machine.md` → `lifecycle.md` (rewrite),
  `transition.md` (requires/emits), `entity.md` (nesting + ownership), `invariant-forms.md`
  (sum), all passing the existing docs parse gate.
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
guards are not solver-loop candidates. Each restriction is stated in the reference docs.

## 12. Validation & definition of done

Real solvers throughout (durable no-simulation rule); `cd lattice && npx tsc --noEmit && npx
vitest run` before every commit; goldens A/B/C never weakened; never `git add -A`.

1. **Subscriptions demo (Pillar A):** transition elicitation runs on the committed Subscriptions
   spec; the machine gains guarded transitions (the b03-shaped `activate` guard via a surfaced
   field, the b10-shaped `dunningExhausted` guard); guards and events render in prose AND
   diagrams; `.lat` round-trips.
2. **b02 one-shot re-formalization:** the gate's b02 formalizer prompt (fresh context, same
   protocol) against the grown grammar formalizes sum-over-collection and passes its own judged
   cases — a one-rule smoke, not a gate re-run.
3. **Mini golden trace D:** an invoice-lines domain elicited end-to-end with real solvers where
   the residual invariant is a sum-over-collection form — covering propose → distinguish →
   verdict → adopt → emit with the new kind, including a masking regression (§6.4) in the
   assertions.
4. **Seven checklist points** demonstrably satisfied for each new form (`requires`, `emits`,
   `sumOverCollection`), with the two explicit routing restrictions (guards: Quint-only; sums:
   both engines) tested, not implied.
5. **Closed-grammar surfaces** (reserved words, reference docs, `not-elicitable`, skill text,
   committed spec migration) updated in the same commits as the features they describe.

## 13. Out of scope

Effects/`do` blocks; `value` objects; CML metadata attributes; `service`/endpoints (generation
slice); reverse-ref sum surface; guard candidates in the solver loop; entailment classification;
`when`-trigger checking; cross-aggregate guards; nested-entity `ref`/`List` fields; templates
#4/#5/#12.
