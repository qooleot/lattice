# Lattice — Plan 3a: `const` Field Modifier (Grammar Growth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `const` field modifier (suffix, like `key`) marking an aggregate/entity field immutable-after-creation, with the full versioned-grammar ceremony (grammar → reserved word → AST → bridge → round-trip printer → mermaid → generation `readonly` → committed-spec migration → docs), so the inference slice's Plan 3 (abstract-evolution) can read `f.const` to keep config fields frozen.

**Architecture:** `const` is a boolean field flag mirroring `key` at every layer. It carries no runtime enforcement in generation (generated code has no field-mutation surface today) beyond a `readonly` TS-type modifier. Committed-spec migration goes through `engine apply` on the real session (not a bare file edit) so `model.json` and the committed `generated/` package regenerate.

**Tech Stack:** TypeScript (strict, ESM), Langium grammar, Vitest.

## Global Constraints

- TypeScript strict; `cd lattice && npx tsc --noEmit && npx vitest run` green before every commit. Run `npx langium generate` after grammar edits (regenerates `src/parse/generated/*`, gitignored) and after any fresh checkout; `npm install` too.
- **Grammar ceremony (slice-4 §4/§9 discipline):** grammar + reserved-word + all projections (printer, mermaid, generation, docs) land **in lockstep**; the grammar-sync test (`test/parse/parse.test.ts:165-178`) enforces grammar↔reserved-word parity.
- **Round-trip fidelity is sacred:** `apply` re-parses `code.ts`'s own output; `const` must print and re-parse identically. The property-based round-trip test (`test/parse/roundtrip.test.ts`) + the idempotency apply test (`test/cli-apply.test.ts:28`) are the anchors.
- Goldens A–D never weakened. `evaluate.ts` untouched. Generation's `differential.test.ts` must stay green (const changes no invariant/candidate semantics).
- **Load note (this session):** the machine is slow from heavy solver use; `golden/trace-b.test.ts`'s median-latency assertion is a known environmental flake — a lone golden-trace-b *latency* failure is not a regression (report, don't block, don't weaken budgets). Most of this plan is parse/emit/codegen (no solver), so it's largely unaffected.
- Never `git add -A`.
- **Decisions locked with the human (2026-07-11):** suffix syntax (`name : T const`); `const` on `Subscription.plan`, `Subscription.maxRetries`, `Invoice.subscription` (NOT `seats` — seats is adjustable); `value-no-const` diagnostic (mirror `value-no-key`); `const`-on-key tolerated (redundant, no diagnostic); generation = `readonly` TS-type only.
- Ceremony reference: `docs/superpowers/specs/2026-07-07-lattice-slice-4-grammar-machine-growth-design.md` §4/§9.

---

## Task 1: Grammar + reserved word + AST + Langium bridge (the parse pipeline)

**Files:** `lattice/src/parse/lat.langium`, `lattice/src/ast/reserved.ts`, `lattice/src/ast/domain.ts`, `lattice/src/parse/fromLangium.ts`; regenerate `lattice/src/parse/generated/*`. Test: `lattice/test/parse/parse.test.ts`, `lattice/test/parse/fromLangium.test.ts`.

- [ ] **Step 1: Failing tests.** Add to `parse.test.ts` a case parsing a field `foo : Int const` (and `bar : Id key const` to lock modifier ordering) and asserting no parse diagnostics; add to `fromLangium.test.ts` an assertion `expect(model.aggregates[0]!.fields.find(f => f.name==='foo')!.const).toBe(true)` off a small spec string. Run — FAIL (grammar rejects `const`; `.const` undefined).

- [ ] **Step 2: Grammar.** In `lattice/src/parse/lat.langium`, `FieldDecl` (`:69-70`) → `name=ID ':' type=LatType (key?='key')? (const?='const')? tags+=Tag*;` (suffix, after `key`, before tags). Regenerate: `cd lattice && npx langium generate` (confirm the exact script; regenerates `src/parse/generated/ast.ts`/`grammar.ts`, giving `G.FieldDecl` a `const: boolean`).

- [ ] **Step 3: Reserved word.** Add `'const'` to `RESERVED_WORDS` in `lattice/src/ast/reserved.ts:13-20`. (The grammar-sync test `parse.test.ts:165-178` now passes grammar↔reserved parity.)

- [ ] **Step 4: AST.** In `lattice/src/ast/domain.ts:12-17`, add `const?: boolean;` to `Field` (after `key?`).

- [ ] **Step 5: Bridge.** In `lattice/src/parse/fromLangium.ts` `mapFields` (`:46-53`), after the `if (f.key) field.key = true;` line, add `if (f.const) field.const = true;`.

- [ ] **Step 6: Run — PASS** (parse + fromLangium + grammar-sync). **Step 7: tsc + commit** (`lat.langium`, generated is gitignored, `reserved.ts`, `domain.ts`, `fromLangium.ts`, the two test files); message `feat(grammar): const field modifier — parse pipeline (grammar, reserved word, AST, bridge)`.

---

## Task 2: Validation — `value-no-const`; tolerate const-on-key

**Files:** `lattice/src/ast/validate.ts`; Test: `lattice/test/ast/validate-values.test.ts` (mirror `value-no-key`).

- [ ] **Step 1: Failing test.** In `validate-values.test.ts`, a value type with a `const` sub-field → expect a diagnostic `code: 'value-no-const'` (mirroring the existing `value-no-key` at `validate.ts:167`). Run — FAIL.

- [ ] **Step 2: Implement.** In `validate.ts`'s value-field checks (`:163-173`, beside `value-no-key`), push `{ code:'value-no-const', message:\`value ${v.name}.${f.name} cannot be const — value types are immutable by structure\`, at:... }` when a value sub-field has `const`. Do NOT add a diagnostic for `const`-on-key (a key is immutable by nature; redundant `const` is tolerated silently — add a one-line comment noting the deliberate tolerance).

- [ ] **Step 3: Run — PASS. Step 4: tsc + commit** (`validate.ts`, test); message `feat(validate): value-no-const diagnostic; const-on-key tolerated`.

---

## Task 3: Emitters — round-trip printer + mermaid + property arbitraries

**Files:** `lattice/src/emit/code.ts`, `lattice/src/emit/mermaid/domainDiagram.ts`, `lattice/test/parse/arbitraries.ts`; Test: `lattice/test/emit/code-print.test.ts`, `lattice/test/parse/roundtrip.test.ts`, `lattice/test/emit/mermaid.test.ts` (or `mermaid-gate.test.ts`).

- [ ] **Step 1: Failing tests.**
  - `code-print.test.ts`: add a `const:true` field to the printer fixture; assert the printed line contains `... const` positioned after the type/`key` and before `@tags` (matching the grammar order).
  - `arbitraries.ts` `fieldArb` (`:26-40`): extend its `fc.record({...})` to sometimes set `const:true` (and `entityFieldArb` `:46-58`), so the property-based round-trip (`roundtrip.test.ts:57-70`, `parse∘print=id`) exercises `const`. This is the highest-value test — it fuzzes printer/parser agreement.
  - `mermaid.test.ts`: add a `const:true` field; assert `«readonly»` renders in the class member line.
  Run — FAIL (printer drops `const`; mermaid has no stereotype).

- [ ] **Step 2: Implement.**
  - `code.ts` `fieldLines` (`:64-68`): insert `${f.const ? ' const' : ''}` between the `key` and `@tags` segments (exact grammar order).
  - `domainDiagram.ts` `classLines` (`:17-24`): append `${f.const ? ' «readonly»' : ''}` after the `«key»` segment.

- [ ] **Step 3: Run — PASS** (incl. property round-trip). **Step 4: tsc + commit** (`code.ts`, `domainDiagram.ts`, `arbitraries.ts`, the three test files); message `feat(emit): round-trip const in .lat printer + «readonly» in mermaid + property arb`.

> Prose (`emit/prose.ts`) renders no field lists → no change. Quint (`emit/quint.ts` `fieldQType`) is informational for `const` → no change (Plan 3 abstract-evolution is where `const` gains solver meaning). Confirm both as explicit non-changes in the commit body.

---

## Task 4: Generation — `readonly` TS types + regenerate committed package

**Files:** `lattice/src/generate/render/types.ts`; Test: `lattice/src/generate/render/types.test.ts`. Then regenerate `generated/subscriptions/*` (after Task 5's migration lands the `const`s — see ordering note).

- [ ] **Step 1: Failing test.** In `types.test.ts`, a `const` field → assert the rendered interface line is `readonly <name>: <type>;`. Run — FAIL.

- [ ] **Step 2: Implement.** `types.ts` `fieldLine` (`:14`): `` return `  ${f.const ? 'readonly ' : ''}${f.name}: ${tsType(f.type)};`; ``. Leave `sql.ts`/`commands.ts`/`repo.ts` unchanged (no field-mutation surface exists to protect — confirmed; note this explicitly in the commit body so a reviewer doesn't expect enforcement there).

- [ ] **Step 3: Run — PASS.** **Step 4: tsc + commit** (`types.ts`, `types.test.ts`); message `feat(generate): emit readonly for const fields (TS types)`. (The committed `generated/subscriptions/*` regen happens in Task 5, after the spec carries the `const`s.)

---

## Task 5: Committed-spec migration (via `apply`) + regenerate package + docs

**Files:** `specs/subscriptions/spec.lat`, `.lattice-session-subscriptions/*` (via `apply`), `generated/subscriptions/*` (via `generate`), `docs/language/*` (a `const` note), and `lattice/test/fixtures.ts` only if a `toEqual`-style test breaks. Test: `lattice/test/cli-apply.test.ts` idempotency anchor.

- [ ] **Step 1: Edit the spec.** Add `const` to `Subscription.plan` (`spec.lat:22`), `Subscription.maxRetries` (`:29`), and `Invoice.subscription` (`:54`) — suffix form (`plan : ref Catalog.Plan const`, etc.). Leave `seats` mutable.

- [ ] **Step 2: Migrate through the real session (NOT a bare edit).** Run the engine `apply` against `.lattice-session-subscriptions` with the edited `spec.lat` (mirror how `cli-apply.test.ts`/prior migrations invoke it), so `reconcile()` writes `model.json` and `writeProjections` re-emits `spec.lat`/prose/diagrams. Then **assert the migration took**: `JSON.parse(readFileSync('.lattice-session-subscriptions/model.json'))` — `Subscription.plan.const === true`, `Subscription.maxRetries.const === true`, `Invoice.subscription.const === true` (diff.ts ignores field modifiers, so reconcile is silent — this assertion is the only confirmation).

- [ ] **Step 3: Idempotency + goldens.** Re-`apply` the emitted `spec.lat` and confirm byte-stable (the `cli-apply.test.ts:28` idempotency anchor); run the golden suite — A–D green (heed the load note re: golden-trace-b latency).

- [ ] **Step 4: Regenerate the committed package.** Run `generate --session .lattice-session-subscriptions --out generated/subscriptions`; confirm `generated/subscriptions/types.ts` now shows `readonly plan`, `readonly maxRetries` (Subscription) and `readonly subscription` (Invoice); `commands.ts`/`repo.ts`/`schema.sql` byte-identical (determinism test). Commit the regenerated `generated/subscriptions/*`.

- [ ] **Step 5: Docs.** Add a `const` note to `docs/language/` (a field-modifier note near the `key`/tags docs — mirror slice-4's §4.3 doc migration): syntax, meaning (immutable after creation), that it renders `readonly` in generated TS, and that abstract-evolution (Plan 3) treats const fields as frozen.

- [ ] **Step 6: Full check + commit.** `cd lattice && npx tsc --noEmit && npx vitest run` green (goldens A–D; `differential.test.ts` + `determinism.test.ts` green; lone golden-trace-b latency flake OK). Stage `specs/subscriptions/spec.lat`, `.lattice-session-subscriptions/*`, `generated/subscriptions/*`, `docs/language/*`, and `lattice/test/fixtures.ts` if touched; message `feat: migrate committed spec to const (plan, maxRetries, Invoice.subscription) + regenerate package + docs`.

> **fixtures.ts note:** `subscriptionsModel` is a hand-approximation (already drops `plan`). Only add `const:true` to its `maxRetries`/`Invoice.subscription` fields if a `toEqual`-style test (e.g. `fromLangium.test.ts` full-entity equality) breaks — otherwise leave it (name-based `.find` tests won't care). Check `fromLangium.test.ts` for full-entity `toEqual` before deciding.

---

## Final whole-branch review (after Task 5)

Integrated review over Plan 3a's diff: grammar↔reserved parity, round-trip fidelity (the property test is the proof), generation `readonly` + committed-package regen correctness (determinism/differential green), migration confirmed in `model.json`, goldens byte-identical. Then Plan 3 (abstract-evolution) revises to consume `f.const` (default-evolving: non-`const` numeric fields → monotone-up).

## Self-Review

**Spec coverage:** the ripple map's 12 seeds map to 5 tasks — parse pipeline (T1), validation (T2), round-trip emitters (T3), generation readonly (T4), migration+regen+docs (T5). Grammar-sync + round-trip property test are the enforced tripwires. Human-locked decisions (suffix, the three const fields not incl. seats, value-no-const, readonly-only generation) are recorded in Global Constraints.

**Placeholder scan:** T1–T4 carry the exact grammar/AST/printer/renderer one-liners; T5's migration steps are concrete commands + the model.json assertion (the only reconcile-silent confirmation). No "TBD".

**Type consistency:** `Field.const?: boolean` mirrors `key?` at every layer (grammar `const?='const'`, bridge `if (f.const)`, printer `f.const ? ' const'`, mermaid `«readonly»`, generation `readonly`). Round-trip: grammar order (key, const, tags) == printer order == property-arb coverage.
