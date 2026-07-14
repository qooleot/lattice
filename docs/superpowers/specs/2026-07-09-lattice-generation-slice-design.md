# Lattice — Generation Slice Design: Spec → Running Service

- **Date:** 2026-07-09
- **Status:** APPROVED design (brainstormed with the human 2026-07-08–09). Next step: writing-plans.
- **Brief:** [`2026-07-05-lattice-generation-slice-brief.md`](2026-07-05-lattice-generation-slice-brief.md)
- **Parent design:** [`docs/plan.md`](../../plan.md) — §5.3 (services are verified commands; RPC is a
  generated projection), §11.5 (conformance adapter, generated-first), §11.6 (CI wedge), §13
  (outbox = semantic event stream).

## 0. Thesis

Deterministic **codegen** (not an LLM) turns a judged, ledger-anchored spec into a *real* running
TypeScript service — real SQLite persistence, real guard rejections, real outbox writes — with
every generated check citing its spec element and ledger anchors. This completes the founder story
(describe domain → judged spec → RUNNING SERVICE) and manufactures the target the conformance slice
(slice 2) will point at.

**Codegen, decisively — no LLM in the generation path.** The generator joins the existing emitter
family (`lattice/src/emit/{alloy,quint,prose,code}.ts`), all pure AST-walkers. The DoD *forbids* an
LLM: byte-identical regeneration, verifiable ledger-anchored provenance, and a differential test
against the `evaluateCandidate` oracle are all properties an LLM cannot provide. The LLM's role in
Lattice is upstream (elicitation, judging → a *judged spec*); once judged, turning the spec into a
service is a compiler, not a guesser.

## 1. Input & loader seam

Generation consumes the **AST**: `DomainModel` + adopted `CandidateInvariant`s + their ledger
anchors (`lattice/src/ast/domain.ts`, `invariant.ts`; session shapes in `src/engine/session.ts`).

Consume the AST through a **loader seam**, never a file format. Today: the session store / a derived
`spec.json` cache. After slice 3: `parse(spec.lat)` producing the same AST. Design the generator
against the AST type; the seam absorbs the transition. If `spec.json` emission does not yet exist,
adding it to `engine emit` is the authorized small prerequisite (the derived cache slice 3 already
calls for).

**Seam closed (2026-07-14).** `loadGenInputFromLat(specLatPath, ledgerDir?)`
(`lattice/src/generate/load.ts`) is the `parse(spec.lat)` variant this section called for: it parses
`spec.lat` through the slice-3 parser (`parse/parse.ts` + `parse/fromLangium.ts`) for the model and
invariants, and — when a session `ledgerDir` is given — rehydrates each parsed invariant to that
session's stable ledger id by name (`engine/reconcile.ts`'s `rehydrateIds`, the same lookup `apply`
already uses to reattach identity after a hand edit) so `plan.ts`'s existing id-keyed provenance
lookup resolves unchanged. Without a `ledgerDir` there is no ledger to anchor to, so provenance
reads the honest `from .lat (no ledger)` instead of silently reporting `none`. `engine generate`
now accepts either `--session <dir>` (the original path) or `--spec <spec.lat> [--ledger
<sessionDir>]`; a committed-artifacts equivalence test
(`lattice/src/generate/latEquivalence.test.ts`) pins that both paths generate byte-identical output
for `specs/subscriptions/`, i.e. that `emit`/`apply` really do keep the session and `spec.lat` in
sync. `spec.json` was never built — parsing `spec.lat` text directly turned out to need no derived
cache.

## 2. Generator architecture — `lattice/src/generate/`

New sibling directory beside the engine (the engine is **not** forked). A **two-stage pipeline**:

```
AST + ledger  ──►  resolved generation plan  ──►  renderers
                   (anchors attached ONCE,        TS types · repository · commands ·
                    language-neutral view)        invariants · SQLite DDL · tests · provenance
```

- **Stage 1 — the plan.** Resolve each spec element to its ledger anchors *once* and attach them to
  plan nodes; normalize the AST into a ready-to-render view. This is CML's model-tree idea minus a
  template engine.
- **Stage 2 — renderers.** Each renderer consumes the plan and cites its anchors; no renderer
  re-derives provenance.

**Multi-language seam (deferred, not gold-plated).** The plan is the seam a second target language
would fork at (a second set of renderers over the same plan). We do **not** design a
backend-agnostic IR now — the right IR shape is learned from a second consumer, so guessing it is
premature. Any future backend inherits its own **differential-conformance obligation** (its
generated checks differential-tested against `evaluateCandidate`, per-language): unlike CML's
unverified Freemarker templates, a Lattice backend must emit code that *provably* agrees with the
semantics oracle. Record the seam; build TS-only.

## 3. Generated artifacts

Emitted into committed **`generated/subscriptions/`** (repo-root, sibling to `specs/` and
`lattice/`), with its **own `package.json`** and its **own tsc+vitest gates**. Regen is
**clean-dir**: wipe and re-emit the whole directory (no stale-file merge — reinforces never-hand-edit).

1. **Entity + value types** from the domain model (identifier hygiene already enforced upstream).
2. **Repositories** over **better-sqlite3**. The generated `CREATE TABLE` DDL *is* the
   reverse-readable persistence mapping seam (plan §11.5.4) — no ORM ceremony.
3. **Command handlers** from transitions: `requires` → structured precondition rejection; state
   change; `emits` → domain event appended to the **outbox**.
4. **Invariant checks** — readable standalone functions (§5), checked at commit.
5. **Generated test suite** — guards reject bad commands, invariants hold / reject, events land in
   the outbox — plus the determinism and differential tests.
6. **Provenance** — every check/handler carries its spec element + ledger anchors (§6).

## 4. Persistence & the commit transaction

**better-sqlite3** (synchronous SQLite). Each command runs in one real SQL transaction, making
"rejected at commit" *literal*:

```
BEGIN
  → check guard (requires)                     → fail: structured rejection + ROLLBACK
  → apply state change
  → re-check invariants (incl. newly           → fail: structured rejection + ROLLBACK
     state-activated `where`-scoped ones)
  → append event to outbox (emits)
COMMIT
```

Synchronous execution keeps tests deterministic (no async/event-loop ordering). The repository
interface stays clean so a MikroORM backend could slot later if conformance ever demands
parent-product comparability — noted, not built (same "second backend" discipline as the language
seam).

## 5. Invariant compilation + the differential test

**Approach (settled): generate readable standalone checks, differential-tested against the
evaluator.** Linking `evaluateCandidate` as the shipped enforcement was rejected — it would make the
generated file a black box (go read the engine + a serialized AST blob to learn the rule) and pull
the engine into the generated runtime. The evaluator is the *oracle*, not the shipped code.

Compile `statePredicate` (incl. `where`-state scoping and ref-reaching paths) and `unique`
(cross-row query) to readable checks — **every invariant the Subscriptions spec has**.

**The differential test (the slice's most Lattice-flavored test).** Ledger `verdict` entries carry
a concrete replayable `witness: CaseState` and the human's `judge: permit|forbid`. For each adopted
invariant × each judged witness, assert **three-way agreement**:

```
generated readable check   ≡   evaluateCandidate(c, witness)   ≡   human verdict (ledger)
```

The spec's own judged evidence follows it into the implementation, re-used as the generator's test
oracle. Witnesses materialize directly into the generated SQLite rows.

### Coverage boundary (stated honestly — no overclaiming)

Invariant checking has three tiers; the generated service owns the first two, and only where a spec
declares them:

| Tier | Kinds | v1 policy |
|---|---|---|
| **Commit-snapshot** | statePredicate, unique (also cardinality, refsResolve, conservation, sumOverCollection) | Compiled to readable checks. Subscriptions uses statePredicate + unique. |
| **Trace / temporal** | terminal, monotonic | **Incremental commit-time enforcement** (`monotonic`: reject if new value < prior committed value; `terminal`: reject leaving a terminal state — largely enforced by construction) — emitted **only if a spec declares one**. Subscriptions declares none → v1 ships snapshot enforcement. No journal/replay (that is slice 2 — see §9). |
| **Liveness** | leadsTo | Not runtime-checkable (the evaluator itself returns `permit` on finite cases). Provenance comment: verified by quint at spec-time. |

The generator **errors loudly** if a spec uses an invariant kind it does not compile — no silent
gaps.

## 6. Provenance / gate binding

Every generated check, handler, and test carries a comment naming its spec element (`spec.lat:NN`)
and ledger anchors. Nothing is presented as verified beyond what the ledger supports. This is plan
§11.6's "passive assertions" born generated instead of retrofitted.

## 7. Demo — real, no mocks (grounded in the committed spec)

A demo script drives real commands against the real generated service and real persistence:

1. **Guard reject.** Seed a subscription with `paidInvoiceCount = 0`; call `activate` → rejected,
   diagnostic citing `requires paidInvoiceCount >= 1` + anchor. Nothing written.
2. **Transition + outbox event.** Pay the invoice so `paidInvoiceCount ≥ 1`; call `activate` →
   succeeds, `SubscriptionActivated` appended to the outbox; state is `active`.
3. **Invariant reject at commit.** Seed a subscription with `paidInvoiceCount = 1` **but**
   `latestInvoice.amountPaid < totalDue`; call `activate` → guard *passes*, state moves to `active`,
   then the state-scoped invariant `activePaidInFull` (`where state status in {active}`) fails →
   **transaction rolls back**, diagnostic citing the invariant + anchor. Clean guard-vs-invariant
   separation, straight from the real spec.

## 8. Definition of Done

- **One command** generates the full package from `specs/subscriptions/`.
- The **generated package's own** `tsc --noEmit` + `vitest run` pass.
- **Determinism test:** regenerate → `git diff` empty (byte-identical).
- **Differential test:** generated checks agree with `evaluateCandidate` on every ledger witness.
- **Demo:** the three scenarios in §7 execute for real.
- **Engine gates unchanged:** `cd lattice && npx tsc --noEmit && npx vitest run` green, golden traces
  A/B/C never weakened.
- **Every check cites its anchors.**

## 9. Non-Goals (explicit — prevent re-litigation)

- **Enforce *in*, don't replay.** The generated service *enforces its own* invariants at commit and
  *writes* the outbox / produces states. It does **NOT** build a replay/trace-checker, an
  `observe()` projection, a state-journal-for-audit, or a drift catalog — those are **slice 2**
  (whose brief §2 Tier 2 *is* the trace checker; whose Tier 1 wedge is `observe()` + the evaluator).
  The outbox schema and the states the generated tests produce are **documented stable seams** for
  slice 2, not machinery we build here. Snapshot enforcement inside the service is complementary to
  slice 2's external observation, not overlapping (same oracle, opposite direction).
- **No 2nd-language backend / plugin system.** The plan is the seam; only TS renderers in v1.
- **No extension seam for imperative logic.** v1 generates and drives only *declared* transitions
  (`activate`, `cancel`, `finalize`, `settle`); custom business logic (how fields accrue/derive) is
  out. Extension will arrive later as separate non-generated files importing the generated module.
- **No HTTP/OpenAPI surface** (plan §5.3 calls it a projection — in-process invocation proves the
  thesis), no sagas/`external` calls, no migrations beyond create-schema, no ORM.

## 10. Constraints (inherited, non-negotiable)

- Generator lives beside the emitters (`lattice/src/generate/`), consuming the same AST; engine not
  forked.
- TypeScript strict; before every commit `cd lattice && npx tsc --noEmit && npx vitest run` (real
  solvers, serialized); goldens green, never weakened. The generated package has its OWN gates.
- Worktree bootstrap: `bash lattice/scripts/ensure-ready.sh` before first use.
- Never `git add -A`; conventional commits; commit doc edits immediately.
- Coordination: shares AST types with slice 4 (schema producer — now merged to main) and the loader
  seam with slice 3 (`.lat` canonical). Highest-collision file: `src/ast/domain.ts`. Rebase often.
