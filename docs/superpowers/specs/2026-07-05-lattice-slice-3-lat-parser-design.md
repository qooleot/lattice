# Lattice — Slice #3 Design: The `.lat` Parser (Engineer Authoring)

- **Date:** 2026-07-05
- **Status:** Approved design (brainstormed with the human 2026-07-05; all six forks from the
  [pre-design brief](2026-07-05-lattice-slice-3-lat-parser-brief.md) resolved below).
- **Parent design:** [`docs/plan.md`](../../plan.md) §6 (authoring boundary), §5.5 (doc comments),
  §19 Risk 4 (round-trip).
- **Prior slice:** [`2026-07-03-lattice-elicitation-slice-1-design.md`](2026-07-03-lattice-elicitation-slice-1-design.md)
  (complete, merged; D6 deferred this parser).

## 1. What this slice is

Make the `.lat` code projection **read-write**. An engineer hand-edits `specs/<name>/spec.lat`;
the system parses it, diffs it against the stored model, reconciles every semantic change against
the verdict ledger (the canonical judgment record — gate binding), applies what is consistent with
provenance, rejects what contradicts a judged case naming the exact witness and verdict, and
re-renders every projection from the updated canonical store.

**Definition of done:** an engineer edits `specs/subscriptions/spec.lat` by hand — a rename, a new
transition, and an invariant change that contradicts a judged case — and the system applies the
first two with provenance, rejects the third naming the exact witness and verdict, and every
projection re-renders from the updated canonical store, with round-trip identity
(`parse ∘ print = id`) property-tested across all committed specs and fixtures.

## 2. Decisions (all forks resolved with the human, 2026-07-05)

| # | Decision | Choice |
|---|---|---|
| P1 | Storage model | **`.lat` is the git-facing canonical spec.** No `spec.json` ever. The language is extended to carry everything spec-shaped. `ledger.jsonl` remains the canonical judgment log beside it (that split is inherent — judgments are not spec text). The session dir (`model.json`, `state.json`) becomes engine working state, updated on apply. |
| P2 | LSP / editor support | **Deferred** to a follow-up slice. This slice ships CLI diagnostics (file:line:col, structured). The Langium grammar makes the LSP cheap later. |
| P3 | CLI surface | **Both** `engine apply` (one-shot, the core) and `engine sync` (thin watcher wrapper over the same routine). |
| P4 | Rename semantics | **Append-only rename ledger entries**; historical entries never rewritten; witness replay resolves old names through the accumulated mapping. Detection: **heuristic + confirm, only when the old name is ledger-referenced** — unreferenced delete+add applies without ceremony; referenced pairs are refused with the exact `--rename` re-run spelled out. |
| P5 | Comments | **`//` is banned** (parse error suggesting `///`). `///` is the only comment form and round-trips into AST `doc` fields (plan §5.5). The printer emits no `//`; generated English lives only in the prose projection. |
| P6 | Predicate syntax | **Full concrete syntax for all 8 candidate kinds** — forced by P1 (a canonical `.lat` cannot hold invariants as comments). This is the largest work item in the slice, budgeted as such. |
| P7 | Parser technology | **Langium.** One grammar file; generated parser code gitignored; `langium generate` wired into `ensure-ready.sh` and npm scripts. |
| P8 | Naming convention | **Everything camelCase** (fields, invariant names, states, transitions, enum values); type-like names (context, enum, entity, aggregate, event) PascalCase. Enforced as **warning-level** diagnostics (`naming-convention`), not errors. Committed spec migrated (§9). |
| P9 | Implied invariants | **All three structure-implied families are derived, not printed**: `@terminal` states imply stays-terminal; `ref` fields imply refs-resolve; `Money` fields imply non-negative unless tagged `@signed`. Tag edits are invariant edits and go through reconciliation. |
| P10 | Operators | **TS-flavored**: `&& \|\| ! => == != < <= > >=`. Spelling only — the expressible set is still the closed grammar (`validateCandidate`). |
| P11 | Provenance | **No `anchored` clause in `.lat`.** The invariant *name* is the join key to the ledger. Lineage renders in the prose projection (satisfying the gate's "provenance renders in projections") and via a new `engine explain <name>` command. Invariant names are rename-tracked like every other name. |
| P12 | English sentences | Invariants carry human-owned `///` docs (new `doc` field on `CandidateInvariant`). Seeded once at migration from the generated English; human-owned thereafter. Doc ≠ explain ≠ provenance (plan §5.5) — staleness of the English over an edited predicate is possible and accepted (it is doc, not a checked artifact). |

## 3. The language

### 3.1 Reference example (post-slice `specs/subscriptions/spec.lat`, complete)

```
/// Subscriptions API: hybrid license-fee + usage-based billing
context Subscriptions {

  enum BillingPeriod { monthly, annual }
  enum UsagePricing { overage, allUnits }

  /// Pricing definition: per-seat license fee plus usage billing in one of two modes
  entity Plan {
    planId        : Id key
    licenseFee    : Money
    usageRate     : Money
    includedUnits : Int
    pricingMode   : UsagePricing
    period        : BillingPeriod
  }

  /// A customer's subscription to a Plan; usage accrues per billing period and resets at rollover
  aggregate Subscription {
    subId        : Id key
    plan         : ref Plan
    seats        : Int
    periodStart  : Date
    periodEnd    : Date
    accruedUnits : Int

    machine {
      region lifecycle { states { trialing @initial, active @active, pastDue @active, canceled @terminal, expired @terminal } }
      transition activate { region lifecycle; from trialing to active }
      transition expireTrial { region lifecycle; from trialing to expired }
      transition paymentFailed { region lifecycle; from active to pastDue }
      transition recover { region lifecycle; from pastDue to active }
      transition cancelFromTrial { region lifecycle; from trialing to canceled }
      transition cancelFromActive { region lifecycle; from active to canceled }
      transition cancelFromPastDue { region lifecycle; from pastDue to canceled }
      transition dunningExhausted { region lifecycle; from pastDue to canceled }
    }

    /// A billing period is well-ordered and accrued usage never goes negative.
    invariant positivePeriodNonNegativeUsage { periodStart < periodEnd && accruedUnits >= 0 }
  }

  /// Period invoice: license-fee portion plus usage portion; partial payments accrue
  aggregate Invoice {
    invoiceId        : Id key
    subscription     : ref Subscription
    licenseFeeAmount : Money  @total
    usageAmount      : Money  @total
    totalDue         : Money  @total
    amountPaid       : Money  @balance

    machine {
      region settlement { states { draft @initial, open @active, paid @terminal, void @terminal, uncollectible @terminal } }
      transition finalize { region settlement; from draft to open }
      transition settle { region settlement; from open to paid }
      transition voidDraft { region settlement; from draft to void }
      transition voidOpen { region settlement; from open to void }
      transition writeOff { region settlement; from open to uncollectible }
    }

    /// An invoice never bills more than the sum of its parts.
    invariant totalDueAtMostParts { totalDue <= licenseFeeAmount + usageAmount }

    /// An invoice is never overpaid, and a paid invoice is paid exactly.
    invariant neverOverpaidAndPaidExact {
      amountPaid <= totalDue && (state settlement in {paid} => amountPaid == totalDue)
    }

    /// At most one draft invoice exists per subscription at any time.
    invariant oneDraftInvoicePerSubscription { unique while settlement in {draft} by (subscription) }
  }

  /// Overage pricing only makes sense with a real included-units allowance.
  invariant overageImpliesRealAllowance on Plan {
    includedUnits >= 0 && (pricingMode == UsagePricing.overage => includedUnits >= 1)
  }
}
```

Five invariant blocks — exactly the rules a human decided. The other thirteen adopted invariants
from slice 1 are implied by structure (§3.4). *(The two `nonNegative Plan` template invariants are
subsumed by the implied-`Money` rule; `overageImpliesRealAllowance` keeps its `includedUnits >= 0`
conjunct because `Int` fields carry no implied bound.)*

### 3.2 Grammar (surface forms; Langium `lat.langium`)

Top level: `context <PascalId> { <item>* }` where item is `enum | entity | aggregate | event |
invariant | ticksPerDay`.

- `enum <PascalId> { <camelId>, … }`
- `entity <PascalId> { <field>* }` / `aggregate <PascalId> { <field>* <machine>? <invariant>* }`
- `event <PascalId> { <field>* }`
- `ticksPerDay = <int>`
- field: `<camelId> : <type> [key] [@<tag>]*` with type `Int | Text | Date | Duration | Money | Id
  | <EnumName> | ref <OwnerName> | List<type>`. Field tags include the existing semantic tags
  (`@total`, `@balance`, `@monotonic`, …) plus new `@signed` (suppresses the implied non-negative
  rule on a `Money` field).
- machine: `machine { region+ transition+ }`;
  `region <camelId> { states { <camelId> [@initial|@active|@terminal]*, … } }` — exactly one
  `@initial` per region (parse-level validation);
  `transition <camelId> { region <r>; from <s> to <s> [; when <EventName>] }`
- invariant: `[///-doc] invariant <camelId> [on <OwnerName>] [where <predicate>] { <body> }` —
  target implicit inside an aggregate block; required `on` at context level.
- `///` doc comments attach to the following construct (context, entity, aggregate, field-owner
  constructs where the AST has `doc`, and invariants) and round-trip; `//` anywhere is a parse
  error with a diagnostic suggesting `///`.

Invariant **bodies**, one per closed-grammar kind ([`invariant.ts`](../../../lattice/src/ast/invariant.ts)):

| Candidate kind | Body syntax |
|---|---|
| `statePredicate` | `<predicate>` (optional `where <predicate>` guard sits in the header) |
| `unique` | `unique while <region> in {<state>, …} by (<path>, …)` |
| `refsResolve` | `refs resolve` (only needed explicitly for exotic cases; normally implied) |
| `cardinality` | `count [where <predicate>] <= <int>` |
| `terminal` | `terminal <region>.<state>` (normally implied by `@terminal`) |
| `monotonic` | `monotonic <path>` |
| `conservation` | `conserve <path> + <path> [+ …] == <path>` (parts sum equals total, exact) |
| `leadsTo` | `from <predicate> leads to <predicate> under fairness "<text>"` — printable and parseable, but hand-written instances are rejected by `validateCandidate` exactly as LLM-freeform ones are (template-instantiated only, slice-1 §6.1) |

Predicates: comparisons `== != < <= > >=` over terms; connectives `&&`, `||`, `!`, `=>`
(precedence: `!` > `&&` > `||` > `=>`; parentheses); state membership `state <region> in
{<state>, …}` (subject is always the quantified instance). Terms: bare `path.segments` (self
field), `<int>`, `<EnumName>.<value>`, `now`, and `+` (linear arithmetic only — same closure as
the candidate grammar; no other operators exist in the surface syntax).

### 3.3 One identifier rule, two enforcement points

The Langium `ID` terminal must match `/^[A-Za-z_][A-Za-z0-9_]*$/` — the same rule
`validateModel` enforces (`invalid-name` in [`validate.ts`](../../../lattice/src/ast/validate.ts)).
A `.langium` file cannot import a TS constant, so a **unit test extracts the terminal definition
from the grammar file and asserts it equals `IDENT_RE`** — single source enforced by test, never
two live definitions. camelCase/PascalCase conventions (P8) are warning diagnostics in the
validator, not grammar restrictions.

### 3.4 Implied invariants (P9)

Derived from structure at load, never printed as blocks, still first-class everywhere else
(solver emitters, prose projection with an "implied by structure" note, reconciliation):

| Structure | Implied rule | Derived name (deterministic) | Opt-out |
|---|---|---|---|
| state `s` tagged `@terminal` in region `r` of `A` | once in `s`, stays in `s` | `terminal<A><R><S>` (camelCase-joined) | remove the `@terminal` tag |
| owner `A` has ≥ 1 `ref` field | every ref on `A` resolves | `refsResolve<A>` | none — a `ref` must resolve |
| `Money` field `f` on owner `A` | `f >= 0` | `nonNegative<A><F>` | tag the field `@signed` |

Rules:
- The engine's canonical invariant set = explicit blocks ∪ derived. Derivation is a pure function
  of the model, recomputed on every load; derived invariants are not stored in `state.json`'s
  adopted list.
- **Tag edits are invariant edits.** Removing `@terminal`, adding `@signed`, or deleting a `ref`
  field removes a derived invariant; if that invariant has ledger history (all thirteen do, for
  subscriptions), the removal flow (§5, step 6) applies — refused without `--force-remove`.
  Adding `@terminal`/`Money`/`ref` creates a derived invariant with no ledger ceremony (provenance
  is "implied by structure").
- An explicit block whose body duplicates a derived invariant is a warning (`redundant-invariant`)
  and is normalized away by the printer.
- Migration maps the thirteen historical template-adopted ledger names (e.g.
  `Terminal_Invoice_void`) to the derived names via rename entries (§9).

## 4. Storage model (P1)

```
specs/<name>/spec.lat        ← canonical spec (git-facing, hand-editable)
specs/<name>/spec.prose.md   ← projection (regenerated; carries English + provenance lineage)
.lattice-session-<name>/     ← engine working state + canonical judgments
  ledger.jsonl               ← canonical judgment log (append-only; verdicts, adoptions,
                               declines, structure Q&A, and NEW: rename entries)
  model.json, state.json     ← engine working copy, updated by apply (derived from .lat)
```

A parse-broken `spec.lat` never corrupts anything: `apply` refuses, the session keeps its last
good state, git history holds the last good text. The printer's output is the normal form; after
a successful apply the file is rewritten normalized (engineer formatting is not preserved).

New ledger entry kind:

```ts
| { kind: 'rename'; at: string; scope: 'field' | 'state' | 'transition' | 'enumValue'
      | 'enum' | 'entity' | 'aggregate' | 'event' | 'invariant' | 'region';
    path: string;            // e.g. 'Subscription.accruedUnits' (pre-rename, owner-qualified)
    from: string; to: string }
```

Witness replay resolves names through the accumulated mapping (chained renames compose in ledger
order). Historical entries are never rewritten.

## 5. `engine apply` — the reconciliation pipeline

`engine apply --lat <file> --session <dir> [--dry-run] [--rename <path>=<new>]…
[--force-remove <name>]…` — **atomic**: any rejection or refusal means nothing is written.

1. **Parse** (Langium). Never throws; on syntax errors emit structured diagnostics
   (`file:line:col`, code, message — including the `//`-ban diagnostic) and exit 1.
2. **Map + validate.** Langium AST → `DomainModel` + `CandidateInvariant[]` (+ docs);
   `validateModel` + `validateCandidate` per invariant. The parser layer accepts nothing the
   closed grammar rejects — same door Claude's proposals go through.
3. **Diff** against the session's stored model + canonical invariant set (explicit ∪ derived),
   name-keyed per construct kind.
4. **Renames.** For each delete+add pair of like kind: if the old name is referenced by any
   ledger entry (witness field keys, machine-state values, invariant names, provenance text) —
   refuse, print the proposed interpretation and the exact re-run
   (`--rename Subscription.accruedUnits=usedUnits`), exit 1. With the flag: treat as rename,
   rewrite references inside the model, append a `rename` ledger entry. Unreferenced pairs apply
   as plain delete+add, no ceremony. Same-body invariant delete+add pairs are proposed as
   invariant renames.
5. **Invariant adds and edits.** Replay **every** `verdict` ledger entry through
   `evaluateCandidate` (witnesses resolved through the rename mapping). Consistent with all
   verdicts → applied; ledger gains an `adopted` entry with provenance
   `hand-edited <date>, consistent with <w-ids>`. Contradicts any verdict → **rejected**, naming
   the witness, its verdict, and when it was judged: *"this edit permits the state in w3, judged
   forbid on 2026-07-05 — re-judge with the domain expert or revert."* No silent overrules.
6. **Removals.** A deleted explicit block, removed `@terminal`, added `@signed`, or removed
   `ref`/`Money` field that kills a ledger-backed invariant is refused unless
   `--force-remove <name>`, which appends a `declined` entry recording the explicit overrule.
7. **Write.** Update `model.json` + `state.json`, append ledger entries, re-render all
   projections: normalized `spec.lat` and regenerated `spec.prose.md` (English + provenance
   lineage render there — gate binding).
8. **Guards.** Refuse when `state.json` shows a mid-flight elicitation (phase not `converged`
   with a non-null model, or `pendingWitnesses` non-empty): finish or abandon the session first.
   If the session dir does not exist, the spec is treated as newly hand-authored: a fresh session
   is created, every invariant adopts with provenance `hand-edited <date>` (no verdicts exist to
   contradict), and projections render.
   `--dry-run` reports the full diff, rename proposals, and reconciliation verdicts; writes
   nothing. Exit codes: 0 applied (or clean dry-run), 1 refused/diagnostics, 2 internal —
   never-throw discipline, matching the CLI's existing contract.

**`engine sync --lat <file> --session <dir>`** — thin chokidar watcher over the identical apply
routine: debounced (~200 ms), tolerant of editors' atomic-save rename events, keeps watching
through failures, prints each outcome; when confirmation is needed it prints the exact
`apply --rename …` command (a watcher cannot confirm).

**`engine explain <invariantName> --session <dir>`** — answers "where did this rule come from?":
resolves the name through rename history, then prints the lineage — adopted entry + provenance,
each referenced witness with its verdict, salient facts and judgment date (reusing witness-show
rendering); for implied invariants, the deriving structure (e.g. "implied by @terminal on
Invoice.settlement.void"); for template-era history, the original template id.

## 6. Code changes

| Where | What |
|---|---|
| `lattice/src/parse/lat.langium` | New grammar (§3.2). |
| `lattice/src/parse/fromLangium.ts` | Langium AST → `DomainModel` + `CandidateInvariant[]` + docs; positioned diagnostics. |
| `lattice/src/parse/diff.ts` | Name-keyed model diff + rename-candidate detection. |
| `lattice/src/engine/reconcile.ts` | Pipeline steps 3–7; pure logic, unit-testable without I/O. |
| `lattice/src/engine/implied.ts` | Derived-invariant computation (§3.4), used by apply, the printer (omit blocks duplicating a derived rule), and the loader (add derived rules to the canonical set). The elicitation flow and its templates are **untouched** — golden traces A/B/C must not shift. |
| `lattice/src/emit/code.ts` | Printer rewritten to §3.2 syntax (docs, `@initial`, events, `ticksPerDay`, predicate bodies, no comments, no implied blocks). |
| `lattice/src/emit/prose.ts` | Render implied invariants with an "implied by structure" note; provenance lineage unchanged (already rendered). |
| `lattice/src/ast/invariant.ts` | `CandidateInvariant.doc?: string`. |
| `lattice/src/engine/session.ts` | `rename` ledger entry kind; rename-mapping resolver. |
| `lattice/src/cli.ts` | `apply`, `sync`, `explain` subcommands. |
| `lattice/scripts/ensure-ready.sh`, `package.json` | `langium generate` step; generated code gitignored; `chokidar`, `langium`, `fast-check` deps. |

Slice-1 elicitation flow is untouched except `implied.ts` sharing: Claude still proposes
structured JSON; the parser is the engineers' door.

## 7. Testing (round-trip is day one)

1. **Round-trip identity** — `parse(astToCode(m, invs)) ≡ (m, invs)` (deep equality, modulo
   absent-vs-undefined normalization), quantified over the model and the **explicit** invariant
   set — derived invariants are never printed and are recomputed at load (§3.4):
   - property-tested with **fast-check generators** over random models + invariants covering all
     8 candidate kinds, docs, tags, events, `ticksPerDay` (real generated inputs — no
     Wizard-of-Oz corpus);
   - fixed corpus: subscriptions session model + adopted set, the three fixture domains
     (`lattice/fixtures/domains/*.json`), the migrated committed `spec.lat`.
2. **Normalization idempotence** — `astToCode(parse(t))` reaches a fixed point after one
   iteration for all corpus + generated texts.
3. **Negative corpus** — syntax errors, `//` comments, out-of-grammar bodies (freeform `leadsTo`,
   nonlinear arithmetic, unknown functions), unresolved names/states/regions, two `@initial`
   states, duplicate names → structured diagnostics with positions; never a crash.
4. **Reconciliation units** — rename mapping (incl. chained renames), verdict replay
   consistency/contradiction, removal refusal, tag-edit-as-invariant-edit, session-guard refusal,
   atomicity (a rejected edit leaves session + files byte-identical).
5. **Definition-of-done integration test** — on a copy of `specs/subscriptions/` + its session:
   a rename, a new transition, and an invariant edit contradicting a judged case → first two
   applied with provenance, third rejected naming witness + verdict, projections re-rendered,
   round-trip holds on the result.
6. **Existing suite** — golden traces A/B/C untouched and never weakened; printer-shape tests in
   `projections.test.ts` updated to the new syntax (they assert printer output, not trace
   behavior). Full run (real solvers, serialized) green before every commit:
   `cd lattice && npx tsc --noEmit && npx vitest run`.

The apply path needs no solvers (`evaluateCandidate` is pure TS), so all new tests are fast.

## 8. Migration of the committed spec (in-slice, dogfood)

The old-syntax file is not parseable under the new grammar (`//` comments, empty bodies) and
never needs to be: the new printer renders the new-syntax file from the session's stored model,
with camelCase names applied; that file is then **applied against the existing session**, so the
rename detection fires and the renames are confirmed the real way:
1. camelCase renames (states `past_due→pastDue`, transitions, enum value `all_units→allUnits`,
   invariant names) confirmed via `--rename` flags — rename ledger entries appended, witnesses
   replay through the mapping. First real user of the slice.
2. Historical template invariant names map to derived names (§3.4) via `rename` entries;
   implied blocks disappear from the file.
3. `///` docs seeded once from the current generated English (then human-owned).
4. `spec.prose.md` regenerated; ledger diff in the PR shows only appended entries.

## 9. Out of scope

- LSP / editor packaging (P2 — follow-up slice; the grammar makes it cheap).
- Solver re-verification on apply (future `--verify` flag; reconciliation here is ledger replay).
- Anything belonging to the spec→implementation generation slice (independent; do not block).
- Preserving engineer formatting (printer output is the normal form).
- Growing the closed candidate grammar (versioned act, unchanged).

## 10. Constraints inherited (non-negotiable)

Gate binding (ledger canonical; no silent overrules; provenance renders in projections — prose
projection + `explain`). Closed grammar (parser accepts nothing `validateCandidate` rejects).
TypeScript strict; `npx tsc --noEmit` + full `npx vitest run` green before every commit; golden
traces never weakened. Worktree bootstrap via `bash lattice/scripts/ensure-ready.sh`. No
Wizard-of-Oz validation — real parser, real round-trips, generator-based property tests. Never
`git add -A`; conventional commits.

## 11. Risks & budget honesty

- **Predicate syntax is the bulk of the slice** (P6): grammar + printer rewrite + mapping +
  round-trip generators across 8 kinds. Budgeted as roughly half the implementation plan.
- **Langium mapping layer** — Langium's generated AST ≠ our domain AST; the mapping is where
  round-trip equality is won or lost. The property tests exist precisely to catch drift here.
- **Rename mapping correctness** — witnesses store machine states as `region.state` values and
  field keys; the resolver must cover both, and chained renames must compose. Unit-tested
  explicitly (§7.4).
- **Migration touches the real ledger** — append-only by construction; the PR diff proves it.
