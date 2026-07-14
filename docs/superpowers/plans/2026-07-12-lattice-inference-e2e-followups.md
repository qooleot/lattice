# Lattice Inference Slice — E2E Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the product gaps the end-to-end verification surfaced and the follow-up backlog identified: make strengthening work on real multi-conjunct invariants, refresh all invariants a guard affects, surface staleness, improve visibility, harden guard tests, and wire the ≥2-survivor distinguish case into an interactive choice.

**Architecture:** Six independent tasks over the already-merged inference slice (Pillars A/B/C). Each reuses the existing per-conjunct classify, `strengthenInvariant` engine, `classifyOnApply` reclassify, and ledger machinery — no new subsystems except a `method-guard` ledger entry and a guard-choice answer path.

**Tech Stack:** TypeScript (strict, ESM, `.js` specifiers), Vitest, Quint 0.26.0 / Apalache 0.47.2.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run`. **Real solvers, no simulated validation** — every verdict/resolution asserted from quint comes from a real `quint verify` (`realDeps`); wiring-only tests may use scripted `deps` mirroring `cli-classify.test.ts`.
- After a fresh checkout: `npx langium generate` + `npm install`. (This worktree already has both.)
- Never `git add -A` — add only the files each task names. Do NOT touch goldens, `evaluate.ts` behavior for existing kinds, or generation `differential.test.ts`.
- **Load note:** a lone `golden/trace-b.test.ts` median-latency failure is a known environmental flake — report, do not block, never weaken the budget. Any OTHER failure is real.
- **EXECUTION DISCIPLINE:** run every test to completion in the FOREGROUND — do NOT background vitest and return before it finishes. Commit yourself.
- Design of record: `docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md` §7.2 (incremental recompute), §8.2 (distinguish resolution), §8.5–8.7 (strengthening engine/surface/masking), §10 (honest ceiling).

## Landed foundation (verified 2026-07-12)

- **Strengthening call sites** (`src/cli.ts`): the classify **hook** (`:590-606`) iterates unique violated invariant *names* and calls `strengthenInvariant(model(), target.inv, adoptedConstraints(s), deps, reachSteps ?? 6)` — passing the WHOLE `CandidateInvariant`. The `strengthen` **command** (`:637`) does the same. `adoptGuard(s, dir, g, provTag)` (`:212`) mints + adopts a guard `CandidateInvariant` idempotently; `guardCandidateInvariant(g)` (`:202`) is the shared minter. `conjunctsOf` is imported (`:14`).
- **The engine** (`src/engine/strengthen.ts`): `strengthenInvariant(m, violated: CandidateInvariant, adopted, deps, reachSteps=6): Promise<Resolution>`; `invariantCmp(inv)` extracts the own-field `cmp` from a `statePredicate` body that is a `cmp` or an `implies` consequent — it returns **null for an `and` body** (the E2E bug: a multi-conjunct invariant yields no cmp). `Resolution = auto-adopt | inconsistent | distinguish{survivors} | no-transition`. `separates(m, a, b, adopted, deps)` (both-directions) already exists for equivalence pruning.
- **Per-conjunct classify** (`src/cli.ts` `classifyAdopted` `:133`): `for (const conj of conjunctsOf(inv.candidate))` → one `Classification` per conjunct, each with `.invariant` (name) + `.conjunct` (index string) + `.verdict`. `conjunctsOf(c)` (`src/engine/tier.ts`) returns `{candidate, conjunct?}[]`.
- **Reclassify** (`src/cli.ts` `classifyOnApply` `:180`): reclassifies `targets = adopted.filter(a => changedSet.has(a.name) && classifiable…)` — NAME-scoped only; the aggregate-scope broadening is explicitly deferred (`:170-179` doc comment).
- **Guard findings / status** (`src/cli.ts` status `:~370`): `readGuardFindings(dir)` deduped by `owner::region::state::finding`; `readClassifications(dir)` deduped latest-per-key; status returns `{ …, classifications, guardFindings }`.
- **Method guards** (`src/cli.ts` `:567`): `checkAllMethodGuards(m, deps)` → `{ service; method; verdict; reachable? }[]`, surfaced in `classify` output but NOT persisted/in `status`.
- **explain** (`src/cli.ts` `:645`): invariant-keyed; returns `{ name, english, provenance, witnesses, classification/classifications }`.
- **apply** (`src/cli.ts` `:438`): calls `reconcile({ parsed, storedModel, … })`; `classifyOnApply` at `:492`; `r.ledgerAppends` (kind `adopted`) name the changed invariants.
- **verdict / pendingWitnesses** (`src/cli.ts` `:355`): `verdict --witness <id> --judge permit|forbid` reads `s.pendingWitnesses[id]`. The strengthen distinguish answer path (Task 6) uses a dedicated `--choose` instead (a guard choice is not a permit/forbid).
- **Ledger** (`src/engine/session.ts`): `LedgerEntry` union; `appendLedger`, `readLedger`, `readClassifications`, `readGuardFindings`. `classified` + `guard-finding` entry kinds exist.

---

## Task 1: Per-conjunct strengthening (E2E finding #2)

**Files:** Modify `lattice/src/cli.ts` (hook + `strengthen` command); Test `lattice/test/cli-strengthen.test.ts`, `lattice/test/engine/strengthen.integration.test.ts`

**Interfaces:**
- Consumes: `strengthenInvariant(m, violated: CandidateInvariant, …)`, `conjunctsOf` (both imported).
- Produces: both the hook and the command strengthen the violated **conjunct** (a single-conjunct `CandidateInvariant` built from `conjunctsOf`), so multi-conjunct invariants (whose body is an `and`) become strengthenable.

- [ ] **Step 1: Failing integration test.** In `test/engine/strengthen.integration.test.ts`, add a real-quint test on the settle-guard-stripped `subscriptionsModel` variant using the REAL multi-conjunct `neverOverpaidAndPaidExact` (an `and` of `amountPaid<=totalDue` and `inState(paid) ⇒ amountPaid==totalDue`). Assert that strengthening its **second conjunct** (the `paid ⇒ ==` one, built via `conjunctsOf(inv.candidate)[1].candidate` wrapped in a `CandidateInvariant`) yields `auto-adopt` with `guard.transition==='settle'`, `guard.predicate.op==='eq'`. (Confirm first via a scratch check that passing the WHOLE `and`-bodied invariant returns `no-transition "no own-field cmp"` — the bug — then that the conjunct path fixes it.) Timeout 120_000.

- [ ] **Step 2: Run — the whole-invariant path returns no-transition (bug reproduced), the conjunct path is what we implement.**

- [ ] **Step 3: Implement.** Add a helper near `adoptGuard` in `src/cli.ts`:
```ts
/** The single-conjunct CandidateInvariant for a violated per-conjunct classify result, so
 *  strengthenInvariant sees a cmp/implies body (not an `and`) — E2E finding #2. `conjunct` is the
 *  index string from the Classification; undefined ⇒ the invariant is single-conjunct (pass as-is). */
function conjunctTarget(inv: CandidateInvariant, conjunct?: string): CandidateInvariant {
  if (conjunct === undefined) return inv;
  const parts = conjunctsOf(inv.candidate);
  const part = parts.find(p => p.conjunct === conjunct) ?? parts[Number(conjunct)];
  return part ? { ...inv, candidate: part.candidate } : inv;
}
```
In the **hook** (`:590-606`), iterate the violated per-conjunct RESULTS (not unique names): for each `r` in `results.filter(x => x.verdict === 'violated')`, find `target = targets.find(c => c.inv.name === r.invariant)`; `const vInv = conjunctTarget(target.inv, r.conjunct)`; call `strengthenInvariant(model(), vInv, adoptedConstraints(s), deps, reachSteps ?? 6)`. Keep the auto-adopt + reclassify + `autoStrengthened.push` logic, tagging the entry with `conjunct: r.conjunct`. (Dedupe: skip a `(name, conjunct)` already handled this run.)
In the **command** (`:637`): the `strengthen --name X` case has no conjunct arg — resolve the *first violated conjunct* of the named invariant: run the per-conjunct classify for it, or (simpler) accept an optional `--conjunct <idx>` and default to strengthening `conjunctTarget(target.inv, values.conjunct)`. If `--conjunct` omitted and the invariant is multi-conjunct, strengthen conjunct `'0'` and note it in the output. (Document the choice in the returned object: `{ strengthened: res, conjunct: <idx> }`.)

- [ ] **Step 4: Run the integration test — PASS (auto-adopt eq via the conjunct path).**

- [ ] **Step 5: Update the hook wiring test** in `test/cli-strengthen.test.ts` so a scripted multi-conjunct violated result drives strengthening of the conjunct (assert `autoStrengthened[].conjunct` present + the guard adopted). **Step 6: full `tsc` + `vitest run` + commit** (`src/cli.ts`, the two test files); message `fix(cli): strengthen the violated conjunct, not the whole invariant (E2E #2 — multi-conjunct)`.

---

## Task 2: Broader reclassify scope after guard adoption (item 1)

**Files:** Modify `lattice/src/cli.ts` (the hook's reclassify call); Test `lattice/test/cli-strengthen.test.ts`

**Interfaces:**
- Consumes: `classifyOnApply(dir, m, adopted, changed, deps)`.
- Produces: after a guard is auto-adopted for transition `<agg>.<region>.<transition>`, the reclassify covers **every adopted invariant scoped to that aggregate** (not just the strengthened one), so a guard that masks a *sibling* invariant reclassifies too.

- [ ] **Step 1: Failing test.** In `test/cli-strengthen.test.ts`, a scripted-`deps` test: two adopted invariants over `Invoice` (the strengthened one + a sibling the guard also forces). After the hook auto-adopts the guard, assert the reclassify (`autoStrengthened[].reclassified`) includes BOTH the strengthened invariant AND the sibling (scripted to return `entailed` for the sibling once the guard is present). Currently only the strengthened one is reclassified.

- [ ] **Step 2: Run — FAIL (only the strengthened invariant reclassified).**

- [ ] **Step 3: Implement.** Replace the narrow `[name]` reclassify (`:602`) with an aggregate-scoped set. Add a helper:
```ts
/** Every adopted invariant name scoped to the guard's aggregate — the reclassify dependency set
 *  after adopting a guard on that aggregate (design §7.2 aggregate-scope, for the guard case). */
function aggregateScopedNames(s: SessionState, aggregate: string): string[] {
  return s.candidates.filter(c => c.status === 'adopted'
    && (c.inv.candidate as any).aggregate === aggregate
    && c.inv.candidate.kind !== 'guard')
    .map(c => c.inv.name);
}
```
In the hook, after `adoptGuard`, compute `const scope = aggregateScopedNames(s, res.guard.aggregate)` and pass `scope` (deduped, including the strengthened `name`) to `classifyOnApply(dir, model(), …, scope, deps)`. (Guards ride into every classify machine via the I-1 channel, so the sibling reclassify genuinely sees the new guard.)

- [ ] **Step 4: Run — PASS. Step 5: full check + commit** (`src/cli.ts`, test); message `feat(cli): reclassify the guard's whole aggregate scope after adoption (item 1)`.

---

## Task 3: Guard-change staleness warning + guard-finding clearing (item 3)

**Files:** Modify `lattice/src/cli.ts` (apply warning; status guard-finding clearing); Test `lattice/test/cli-apply.test.ts`, `lattice/test/cli.test.ts`

**Interfaces:**
- Produces: (a) `apply` emits a `warnings` entry `"classifications may be stale: guard changed on <transition> — run classify"` when a transition's `requires` differs from the stored model but no invariant body changed; (b) `status` treats a `guard-finding` as CLEARED when a later `classify` over the same aggregate produced no such finding — so stale findings stop being counted after the model changes.

- [ ] **Step 1: Failing tests.**
  - `test/cli-apply.test.ts`: apply a model whose transition `requires` changed (guard edit) with no invariant-body change → assert the apply result's `warnings` contains a "guard changed … may be stale" message.
  - `test/cli.test.ts`: seed a `guard-finding` for `(Invoice, settlement, open, stuck)`, then a later `classify`-provenance ledger marker indicating that aggregate was re-analyzed with no such finding; assert `status.guardFindings.stuck` no longer counts the cleared one. (Concretely, implement clearing by a per-`classify`-run generation stamp — see Step 3.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - **(a) Guard-change warning (apply):** in the `apply` case, compare `storedModel` vs the loaded model's transitions: for each `(agg, transition)`, if `requires` differs (compare `JSON.stringify(t.requires ?? null)`), and that transition's aggregate has no invariant in `r.ledgerAppends` (kind `adopted`), push `"classifications may be stale: guard changed on ${agg}.${transition} — run classify"` into the returned `warnings` array. (`storedModel` is available where `reconcile` is called.)
  - **(b) Guard-finding clearing (status):** the append-only `guard-finding` entries never clear. Stamp each `classify` run's guard-analysis with a monotonic run id (e.g. append a `guard-finding` "sweep marker" per aggregate per run, or reuse `provenance: classify <isoDay>`), and in `status` keep only findings from the LATEST sweep per aggregate. Minimal implementation: when `classify` writes guard-findings, also append (per aggregate analyzed) a marker of the run; `status`'s guard-finding dedup then drops findings from superseded runs. If a full sweep-marker is heavier than warranted, the acceptable-scoped alternative is: `status` counts a `guard-finding` only if it is the latest entry for its key AND its `provenance` run is the latest `classify` run in the ledger — document whichever you implement.

- [ ] **Step 4: Run — PASS. Step 5: full check + commit** (`src/cli.ts`, both tests); message `feat(cli): guard-change staleness warning on apply + guard-finding clearing in status (item 3)`.

---

## Task 4: methodGuards persist-to-ledger + status + explain-by-state (item 4)

**Files:** Modify `lattice/src/engine/session.ts` (new `method-guard` ledger kind + reader), `lattice/src/cli.ts` (classify persists; status counts; explain surfaces state findings); Test `lattice/test/cli.test.ts`, `lattice/test/cli-classify.test.ts`

**Interfaces:**
- Produces: a `method-guard` `LedgerEntry` (`{ kind:'method-guard'; at; service; method; verdict; reachable?; provenance }`) + `readMethodGuards(dir)`; `classify` appends them; `status` returns `methodGuards` counts (by verdict); `explain <name>` includes, for the invariant's aggregate, any `guard-finding` entries on that aggregate's states (state-keyed findings surfaced through the invariant that references the aggregate).

- [ ] **Step 1: Failing tests.**
  - `test/cli.test.ts`: seed two `method-guard` entries (differing verdicts), assert `status.methodGuards` = `{ '<verdict>': n, … }` counts.
  - `test/cli-classify.test.ts`: after `classify`, assert `method-guard` entries were appended (`readMethodGuards(dir).length > 0`).
  - `test/cli.test.ts` (explain): seed a `guard-finding` on `Invoice.settlement.open`, then `explain <an Invoice invariant>` includes those findings under a `guardFindings` key (filtered to the invariant's aggregate).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - `session.ts`: add `| { kind:'method-guard'; at: string; service: string; method: string; verdict: string; reachable?: boolean; provenance: string }` to `LedgerEntry`; add `readMethodGuards(dir)` mirroring `readClassifications`.
  - `cli.ts` classify: after `const methodGuards = await checkAllMethodGuards(...)`, append one `method-guard` entry per result (provenance `classify ${isoDay(now())}`), deduped latest-per-`service::method` at read time.
  - `cli.ts` status: add `methodGuards` counts from `readMethodGuards(dir)` (latest-per-`service::method`, count by verdict) to the returned object.
  - `cli.ts` explain: after computing `inv`, add `out.guardFindings = readGuardFindings(dir).filter(f => f.owner === (inv.candidate as any).aggregate)` (the state-keyed findings for the aggregate this invariant is about).

- [ ] **Step 4: Run — PASS. Step 5: full check + commit** (`session.ts`, `cli.ts`, tests); message `feat(cli): persist methodGuards to ledger + status counts + explain surfaces aggregate guard-findings (item 4)`.

---

## Task 5: Consistent / stronger-than-guard real-quint test (hardening)

**Files:** Test `lattice/test/engine/method-guard.integration.test.ts`

**Interfaces:** Consumes `checkMethodGuard(m, service, method, deps)` (existing). No source change — this closes the coverage gap noted in Plan 2b Task 5 (only `weaker-than-guard` had a committed real-quint test).

- [ ] **Step 1: Add real-quint tests.** In `test/engine/method-guard.integration.test.ts`, add two cases on a `subscriptionsModel` variant using `realDeps`: (a) a method whose `requires` is **consistent** with (equal to) its transition guard → `checkMethodGuard` verdict `consistent`; (b) a method whose `requires` is **stronger-than** its transition guard (implies it, strictly) → verdict `stronger-than-guard`. Construct the method `requires` to produce each verdict; VERIFY the actual verdict from real quint and assert it (do NOT assert-to-match — if the constructed guard doesn't produce the intended verdict, fix the fixture). Timeout 120_000 each.

- [ ] **Step 2: Run — PASS (real quint). Step 3: commit** (the test file); message `test(engine): real-quint consistent + stronger-than-guard method-guard cases (Plan 2b hardening)`.

---

## Task 6: ≥2-survivor distinguish — separating witnesses + interactive choice (item 2)

**Files:** Modify `lattice/src/engine/strengthen.ts` (carry separating witnesses on `distinguish`), `lattice/src/cli.ts` (`strengthen` surfaces the choice + a `--choose` answer path); Test `lattice/test/engine/strengthen.test.ts`, `lattice/test/cli-strengthen.test.ts`

**Interfaces:**
- Produces: `Resolution` `distinguish` variant gains `witnesses` — for each pair of survivors, the separating `CaseState` (from the existing `separates` probe) rendered for the author. `strengthen --name X` with ≥2 survivors returns `{ strengthened: { kind:'distinguish', survivors, witnesses } }` (each survivor named `guard_<transition>_<op>`); a follow-up `strengthen --name X --choose <op>` adopts the chosen survivor.

Note (scope): this is the *interactive choice* for guard strengthening, reusing the engine's own `separates` witness — it does NOT route guards through the planner's `nextQuestion`/version-space loop (guards are not always-property candidates; `routeCandidate` throws on them by design). The author picks a variant via `--choose`; the auto-adopt/inconsistent/no-transition paths are unchanged.

- [ ] **Step 1: Engine — carry the separating witness.** In `src/engine/strengthen.ts`, change the `distinguish` resolution to `{ kind:'distinguish'; survivors; witnesses: CaseState[] }`: when resolving ≥2 survivors, for each adjacent survivor pair compute the separating witness by re-running the `separates` probe but returning its `witness` (add a `separatingWitness(m, a, b, adopted, deps): Promise<CaseState | null>` alongside `separates`, or have `separates` return the witness). Collect the non-null witnesses. Unit-test (`strengthen.test.ts`, scripted `deps`) that a 2-survivor case returns both survivors + a witness.

- [ ] **Step 2: Run — FAIL. Step 3: implement the engine change (above).** Keep `separates` (boolean) for equivalence pruning; add `separatingWitness` (returns the witness) for the resolution. `deps.quint(probe-permit, hi: <a∧¬b statePredicate>, adopted)` → `{violated, witness}`; `violated` ⇒ return `witness`.

- [ ] **Step 4: CLI — surface + choose.** In `src/cli.ts` `strengthen`:
  - When `res.kind === 'distinguish'` and no `--choose`: return `{ strengthened: { kind:'distinguish', survivors: res.survivors.map(g => ({ name: `guard_${g.transition}_${g.predicate.op}`, op: g.predicate.op, transition: g.transition })), witnesses: res.witnesses.map(w => ({ table: renderWitnessTable(w, model().ticksPerDay) })) } }` (import `renderWitnessTable` from `./engine/salient.js`).
  - When `--choose <op>` is present: re-run the engine to get the survivors (or recompute), find the survivor whose `predicate.op === values.choose`, `adoptGuard(s, dir, chosen, 'strengthen-chose')`, and reclassify (aggregate scope, Task 2's helper); return `{ strengthened: { kind:'auto-adopt', guard: chosen }, chose: values.choose }`. If no survivor matches, return `{ error:'invalid-arg', arg:'choose', hint:'…' }`.
  - Register `choose` (and `conjunct` from Task 1) in the `parseArgs` options.

- [ ] **Step 5: CLI wiring test** (`cli-strengthen.test.ts`, scripted `deps`): a ≥2-survivor `strengthen` returns the survivors + witness tables; a follow-up `--choose eq` adopts `guard_settle_eq`. **Step 6: full `tsc` + `vitest run` + commit** (`strengthen.ts`, `cli.ts`, both tests); message `feat(cli): interactive ≥2-survivor guard choice — separating witnesses + --choose (item 2)`.

---

## Final whole-branch review + E2E re-verification (after Task 6)

Integrated review over the branch diff (base `134ff82`, head = last commit). Then **re-run the E2E** (the two scratch sessions from the verification pass): the stripped-settle `classify` must now (Task 1) auto-adopt the `settle == guard` for `neverOverpaidAndPaidExact`'s conjunct, write it back on `apply`, and reclassify that conjunct (and its aggregate siblings, Task 2) to `entailed` — the full loop, on the real spec, from the real CLI. Confirm the qualified-ref fix (`0fd3fae`) holds and goldens are byte-identical. Carry forward any still-open tickets (guard-finding staleness depth, apply-path latency watch, implied-invariant auto-classify).

## Self-Review

**Spec coverage:** Task 1 = E2E #2 (per-conjunct strengthening); Task 2 = item 1 (aggregate-scope reclassify, §7.2); Task 3 = item 3 (staleness warning + guard-finding clearing); Task 4 = item 4 (methodGuards persist/status + explain-by-state); Task 5 = consistent/stronger-than-guard hardening; Task 6 = item 2 (≥2 distinguish interactive choice, §8.2). E2E #1 (qualified ref) already fixed (`0fd3fae`).

**Placeholder scan:** Tasks 1–2, 4–6 carry concrete code/seams. Task 3(b) (guard-finding clearing) offers two concrete implementations with a "document whichever you implement" instruction — a genuine implementer choice between a sweep-marker and a latest-run filter, not a TBD; both are specified. Task 5 + Task 1's integration + Task 6's separating-witness carry "verify the real-quint verdict, don't assert-to-match" checkpoints where the constructed fixture meets the live solver.

**Type consistency:** `conjunctTarget`/`aggregateScopedNames` (cli.ts helpers) consume `CandidateInvariant`/`SessionState`; `strengthenInvariant` unchanged signature (Task 1 passes a conjunct-wrapping `CandidateInvariant`); `Resolution.distinguish` gains `witnesses: CaseState[]` (Task 6) consumed by the CLI via `renderWitnessTable`; new `method-guard` ledger entry (Task 4) matches `checkAllMethodGuards`'s result shape.
