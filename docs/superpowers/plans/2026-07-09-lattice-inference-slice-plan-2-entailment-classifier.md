# Inference Slice — Plan 2: Pillar A Entailment Classifier

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify each adopted invariant as entailed / independent / not-inductive (with on-demand escalation to violated) via real Apalache induction, surface the labels in `classify`/`status`/`explain`, recompute them on every `apply`, and add method⊨transition entailment.

**Architecture:** A new emitter twin `astToQuintClassify` reuses `astToQuint`'s machine-building internals (extracted into shared helpers) and adds a havoc `indInit` action plus named `val` invariants; a new `src/engine/classify.ts` orchestrates the two induction probes (consecution `--max-steps 1`, entailment `--max-steps 0`) through `runQuintVerify`, with reachability escalation through `runQuint`. Method⊨transition gets a param-aware render path (params → nondet draws) so `∀params: methodReq ⇒ transitionGuard` is decidable without touching the transition-guard path.

**Tech Stack:** TypeScript (strict, ESM, `.js` specifiers), Vitest, Quint 0.26.0 / Apalache 0.47.2 via `runQuintVerify`/`runQuint`.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run` before every commit — **real solvers, no simulated validation**: every classification verdict asserted in a test must come from a real `quint verify` round-trip (unit tests may use a fake `SolverDeps` to test orchestration logic, but at least one integration test per verdict must be real).
- After any fresh checkout run `npx langium generate` **and** `npm install` (gitignored parser + generation's `better-sqlite3`), else tsc/tests fail environmentally (Plan 1 lesson).
- Never `git add -A`; stage explicit paths.
- Goldens A–D never weakened. `evaluate.ts` is NOT touched. Generation's `differential.test.ts` stays green.
- Ledger is append-only; classifications are `classified` entries (already in the union, `session.ts:29-32`), never silent state mutations. An *entailed* invariant is never auto-deleted.
- The classifier's peer set is `adoptedConstraints(s)` (`planner.ts:87-88`) filtered through `expressibleAdopted('quint', …)` (`planner.ts:72-86`) — never the invariant-under-test itself (circular).
- `param` terms remain a hard error on the ordinary transition-guard path (`termToQuint`/`predToQuint`, `quint.ts:80`); only the new method⊨transition path may resolve them (to nondet draws).
- Design of record: [`2026-07-09-lattice-inference-slice-design.md`](../specs/2026-07-09-lattice-inference-slice-design.md) §5 (labels/protocol), §7 (ledger/CLI), §4.2 (emission). Spike evidence: [`2026-07-09-inference-spike-notes.md`](../specs/2026-07-09-inference-spike-notes.md) §4b.

---

## Task 1: Entailment-probe integration test + Plan-1 minor cleanup

Carried from Plan 1's final review: pin the `--max-steps 0` entailment-probe behavior in the suite (Probe-2 *failure* must return `violated:true` with an ITF, not throw). Also fold Plan-1 Minor M1 (mid-file import).

**Files:**
- Test: `lattice/test/solvers/quint-adapter.integration.test.ts`
- Modify: `lattice/test/solvers/quint-adapter.test.ts` (M1: move the `runQuintVerify` import to the top import group)

**Interfaces:** Consumes `runQuintVerify(em, { init?, invariant?, maxSteps })` (Plan 1). Produces no new API.

- [ ] **Step 1: Write the failing integration test**

Append to `lattice/test/solvers/quint-adapter.integration.test.ts`:

```ts
describe('runQuintVerify entailment probe (--max-steps 0, integration)', () => {
  // Probe 2 shape: from an arbitrary hypothesis state, does the invariant hold in that
  // very state (0 steps)? A hypothesis state that violates `inv` must yield violated:true
  // with an ITF (not a thrown error) — the classifier's `independent` vs `entailed` split
  // relies on this.
  const peersStateViolatesInv: QuintEmission = { source:
    `module m {\n  var c: int\n  action init = { c' = 0 }\n  action indInit = { nondet x = oneOf(0.to(5)) c' = x }\n  action step = { c' = c }\n  val peersImpliesInv = c.in(0.to(5)) implies (c == 0)\n}`,
    invariantName: 'peersImpliesInv', varTypes: {} };
  const peersStateSatisfiesInv: QuintEmission = { source:
    `module m {\n  var c: int\n  action init = { c' = 0 }\n  action indInit = { nondet x = oneOf(0.to(5)) c' = x }\n  action step = { c' = c }\n  val peersImpliesInv = c.in(0.to(5)) implies (c.in(0.to(5))) }`.replace('} }','}\n}'),
    invariantName: 'peersImpliesInv', varTypes: {} };

  it('returns violated:true (ITF) when a hypothesis state fails the implication at max-steps 0', async () => {
    const r = await runQuintVerify(peersStateViolatesInv, { init: 'indInit', invariant: 'peersImpliesInv', maxSteps: 0 });
    expect(r.violated).toBe(true);
  }, 180_000);

  it('returns violated:false when every hypothesis state satisfies the implication', async () => {
    const r = await runQuintVerify(peersStateSatisfiesInv, { init: 'indInit', invariant: 'peersImpliesInv', maxSteps: 0 });
    expect(r.violated).toBe(false);
  }, 180_000);
});
```

- [ ] **Step 2: Run it and confirm behavior**

Run: `cd lattice && npx vitest run test/solvers/quint-adapter.integration.test.ts -t "entailment probe"`
Expected: PASS — the violating-hypothesis case returns `violated:true` (ITF), the satisfying case `violated:false`. This confirms `runQuintVerify` handles the `--max-steps 0` probe exactly as the classifier will use it. (If `violated:true` does not appear for the violating case, STOP — the classifier's `entailed`/`independent` split is unsound and needs the design revisited; report it.)

- [ ] **Step 3: Apply M1**

In `lattice/test/solvers/quint-adapter.test.ts`, move the `import { runQuintVerify } from '../../src/solvers/quint-adapter.js';` line up into the top import group beside the existing `runQuint`/`parseITF` import.

- [ ] **Step 4: Full check + commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run test/solvers/`
Expected: PASS.

```bash
cd /Users/taras/projects/spec-core/.claude/worktrees/ecstatic-swirles-d47547
git add lattice/test/solvers/quint-adapter.integration.test.ts lattice/test/solvers/quint-adapter.test.ts
git commit -m "test(solvers): pin --max-steps 0 entailment-probe behavior + tidy import

Locks in the suite the Probe-2 behavior the whole-branch review verified by
hand: a hypothesis state failing (peers => I) at max-steps 0 returns
violated:true with an ITF. Foundation for the classifier's entailed/
independent split. Also folds Plan-1 minor M1 (import placement).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Extract emitter init-building into a reusable helper

Behavior-preserving refactor so `astToQuintClassify` (Task 3) can reuse the exact per-owner record construction with a havoc region-state draw instead of the fixed `initial` literal.

**Files:**
- Modify: `lattice/src/emit/quint.ts` (extract `buildOwnerInit`; export it + `candidateToQuint`, `owners`, `varName` for the sibling emitter)
- Test: `lattice/test/emit/quint.test.ts` (assert existing emission unchanged)

**Interfaces:**
- Produces:
  ```ts
  // stateDraw: 'fixed' → region field = the region's `initial` literal (current init behavior)
  //            'havoc' → region field = a nondet oneOf(Set(...all region states...))
  export function buildOwnerInit(
    m: DomainModel, o: AggregateDef | EntityDef, tag: string, stateDraw: 'fixed' | 'havoc',
  ): { inits: string[]; nondets: string[] };
  export { candidateToQuint, owners, varName }; // now exported for astToQuintClassify
  ```

- [ ] **Step 1: Characterization test (lock current output)**

Add to `lattice/test/emit/quint.test.ts` a test asserting the real `init` for an existing fixture still contains the fixed initial-state literal (e.g. for `invoicingModel`, `settlement_state: "draft"`) and the per-field nondet draws — pick the exact strings from the current emitter output by running `astToQuint` on the fixture once and copying the `init` line. This guards the refactor.

```ts
it('real init still uses the fixed initial region-state literal (refactor guard)', () => {
  const em = astToQuint(invoicingModel, { kind: 'probe-forbid', hi: someStatePredicateOnInvoice, exclusions: [], maxSteps: 5 });
  expect(em.source).toContain('settlement_state: "draft"'); // fixed initial, not a nondet draw
});
```

- [ ] **Step 2: Run — should PASS now (pre-refactor)**

Run: `cd lattice && npx vitest run test/emit/quint.test.ts`
Expected: PASS (characterizing current behavior before touching it).

- [ ] **Step 3: Extract `buildOwnerInit` and export helpers**

In `lattice/src/emit/quint.ts`, pull the per-owner `inits`/`initNondets` construction (currently inline at ~`quint.ts:277-300`) into `buildOwnerInit(m, o, tag, stateDraw)`. It returns the `inits`/`nondets` arrays for one owner. The only branch on `stateDraw`: for each region `r`,
- `'fixed'` → `inits.push(\`${r.name}_state: "${r.initial}"\`)` (current behavior),
- `'havoc'` → push a nondet `nd_${tag}_${r.name}_state = oneOf(Set(${r.states.map(s => \`"${s.name}"\`).join(', ')}))` and `inits.push(\`${r.name}_state: <that nd>\`)`.
Owned-collection init (the `Map(...)` + `Count` draws) is identical in both modes — keep it in the helper unchanged. Have `astToQuint`'s owner loop call `buildOwnerInit(m, o, o.name.toLowerCase(), 'fixed')` and splice the results into its existing `initNondets`/`initSets`. Add `export` to `buildOwnerInit`, `candidateToQuint`, `owners`, `varName`.

- [ ] **Step 4: Run — existing emit tests + goldens must stay green**

Run: `cd lattice && npx vitest run test/emit/ test/golden-trace-d.test.ts`
Expected: PASS — the characterization test and all existing emit/golden tests unchanged (refactor is behavior-preserving for `'fixed'`).

- [ ] **Step 5: Full check + commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`
Expected: PASS.

```bash
cd /Users/taras/projects/spec-core/.claude/worktrees/ecstatic-swirles-d47547
git add lattice/src/emit/quint.ts lattice/test/emit/quint.test.ts
git commit -m "refactor(emit): extract buildOwnerInit (fixed|havoc), export classifier helpers

Behavior-preserving: astToQuint still emits the fixed initial-state literal.
The 'havoc' mode + exported candidateToQuint/owners/varName are consumed by
astToQuintClassify (next task).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `astToQuintClassify` — the classifier emitter twin

Emits the same machine plus a havoc `indInit` action asserting a hypothesis, and named `val` invariants, so the two induction probes can run via `runQuintVerify`.

**Files:**
- Create: `lattice/src/emit/quint-classify.ts`
- Test: `lattice/test/emit/quint-classify.test.ts`
- Test (integration): `lattice/test/emit/quint-classify.integration.test.ts`

**Interfaces:**
- Consumes: `buildOwnerInit`, `candidateToQuint`, `owners`, `varName` (Task 2); `astToQuint`'s public `QuintEmission`.
- Produces:
  ```ts
  export interface ClassifyQuery {
    invariant: Candidate;    // I (the invariant-under-test, or one conjunct)
    peers: Candidate[];      // expressibleAdopted peers (never I)
    probe: 'consecution' | 'entailment';
    maxSteps: number;        // 1 for consecution, 0 for entailment
  }
  // For 'consecution': indInit havocs all vars and asserts (peersAnd and I); invariantName = 'q_I'.
  // For 'entailment':  indInit havocs all vars and asserts  peersAnd;         invariantName = 'q_peersImpliesI'.
  export function astToQuintClassify(m: DomainModel, cq: ClassifyQuery): QuintEmission;
  ```
  The emitted module contains: all `var` decls + pools + `action init` (unused by the probe but harmless) + all transition/`step` actions (reused from `astToQuint`'s builders) + `action indInit` (havoc, hypothesis asserted on the drawn nondets) + the named `val`s. `invariantName` is the `val` the probe checks.

- [ ] **Step 1: Write failing emission-shape unit tests**

`lattice/test/emit/quint-classify.test.ts` — assert `.source` structure (mirroring `test/emit/quint.test.ts` `.toContain` style):

```ts
import { describe, it, expect } from 'vitest';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { invoicingModel, someStatePredicateOnInvoice, draftInvoiceUnique } from '../fixtures.js';

describe('astToQuintClassify', () => {
  it('consecution: emits indInit havocing region state and asserting the hypothesis, checks q_I over one step', () => {
    const em = astToQuintClassify(invoicingModel, { invariant: someStatePredicateOnInvoice, peers: [draftInvoiceUnique], probe: 'consecution', maxSteps: 1 });
    expect(em.source).toContain('action indInit');
    expect(em.source).toMatch(/settlement_state: nd_/);   // region state havoced, not fixed "draft"
    expect(em.source).toContain('val q_I =');
    expect(em.invariantName).toBe('q_I');
    expect(em.source).toContain('action step =');          // step reused verbatim
  });

  it('entailment: checks q_peersImpliesI and asserts only peers at indInit', () => {
    const em = astToQuintClassify(invoicingModel, { invariant: someStatePredicateOnInvoice, peers: [draftInvoiceUnique], probe: 'entailment', maxSteps: 0 });
    expect(em.source).toContain('val q_peersImpliesI =');
    expect(em.invariantName).toBe('q_peersImpliesI');
  });

  it('emits varTypes for every owner (witness parsing needs them)', () => {
    const em = astToQuintClassify(invoicingModel, { invariant: someStatePredicateOnInvoice, peers: [], probe: 'consecution', maxSteps: 1 });
    expect(Object.keys(em.varTypes).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — FAIL (module missing)**

Run: `cd lattice && npx vitest run test/emit/quint-classify.test.ts`
Expected: FAIL — `quint-classify.ts` does not exist.

- [ ] **Step 3: Implement `astToQuintClassify`**

Create `lattice/src/emit/quint-classify.ts`. Reuse the exported helpers; build the module by the same recipe as `astToQuint` (decls, pools, per-owner via `buildOwnerInit(..., 'havoc')`, transition/`step` actions, `frame`), but:
- Emit `action indInit = { <all owners' havoc nondets> all { now' = 0, <owners' mapBy record sets>, <hypothesisConjunct> } }` where `hypothesisConjunct` is `candidateToQuint`-rendered `I` (and each peer) asserted **on the drawn record** (per spike §4b: assert on the nondet-built values, since a forall-over-map hypothesis reduces to the scalar constraint on the single drawn record; do NOT read the primed `var`).
- Append `val q_I = <candidateToQuint(m, I, ...)>`, one `val peerK = <candidateToQuint(peer_k)>` per peer, `val peersAnd = (peer0 and peer1 and …)` (or `true` if no peers), and `val q_peersImpliesI = (peersAnd implies q_I)`.
- Set `invariantName` to `'q_I'` for `consecution`, `'q_peersImpliesI'` for `entailment`.
- Populate `varTypes` identically to `astToQuint` (copy that loop / factor it too if cleaner).

Keep this file focused on emission only — no solver calls.

- [ ] **Step 4: Run unit tests — PASS**

Run: `cd lattice && npx vitest run test/emit/quint-classify.test.ts`
Expected: PASS.

- [ ] **Step 5: Real-quint integration test — the worked entailment**

`lattice/test/emit/quint-classify.integration.test.ts` — emit the committed Subscriptions `paid`-conjunct and run it through `runQuintVerify` for real, asserting the *consecution* probe holds (`violated:false`) because `settle`'s guard forces it:

```ts
import { describe, it, expect } from 'vitest';
import { astToQuintClassify } from '../../src/emit/quint-classify.js';
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js'; // add these fixtures (see note)

describe('astToQuintClassify (integration, real quint)', () => {
  it('paid-conjunct consecution holds (settle guard forces it)', async () => {
    const em = astToQuintClassify(subscriptionsModel, { invariant: paidImpliesExactConjunct, peers: [], probe: 'consecution', maxSteps: 1 });
    const r = await runQuintVerify(em, { init: 'indInit', invariant: em.invariantName, maxSteps: 1 });
    expect(r.violated).toBe(false);
  }, 180_000);
});
```

Fixtures note: add `subscriptionsModel` (load/transcribe the committed model) and `paidImpliesExactConjunct` (the `settlement in {paid} => amountPaid == totalDue` `statePredicate`) to `lattice/test/fixtures.ts`, transcribing from `specs/subscriptions/spec.lat` + the ledger's adopted entry. If loading the live session model in a test is cleaner, use `loadState('.lattice-session-subscriptions').model` guarded by existence.

- [ ] **Step 6: Run integration + full check + commit**

Run: `cd lattice && npx vitest run test/emit/quint-classify.integration.test.ts` then `npx tsc --noEmit && npx vitest run`
Expected: PASS; goldens green.

```bash
cd /Users/taras/projects/spec-core/.claude/worktrees/ecstatic-swirles-d47547
git add lattice/src/emit/quint-classify.ts lattice/test/emit/quint-classify.test.ts lattice/test/emit/quint-classify.integration.test.ts lattice/test/fixtures.ts
git commit -m "feat(emit): astToQuintClassify — havoc-init consecution/entailment emitter

Emits the machine + a havoc indInit asserting the induction hypothesis on
the drawn record + named vals (q_I, peersAnd, q_peersImpliesI). Real-quint
test: the committed paid-conjunct's consecution holds (settle guard).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: The classifier module (`src/engine/classify.ts`) — two-probe base label

**Files:**
- Create: `lattice/src/engine/classify.ts`
- Test: `lattice/test/engine/classify.test.ts` (unit, fake deps)
- Test (integration): `lattice/test/engine/classify.integration.test.ts` (real quint, committed spec)

**Interfaces:**
- Consumes: `astToQuintClassify` (Task 3); `runQuintVerify` (Plan 1); `SolverDeps` (`planner.ts:11`); `adoptedConstraints`/`expressibleAdopted` (`planner.ts`).
- Produces:
  ```ts
  export interface Classification {
    invariant: string; conjunct?: string;
    verdict: 'entailed' | 'independent' | 'not-inductive';   // base labels; 'violated' only via escalation (Task 5)
    tier: 'sound';                                            // 'abstract' arrives in Plan 3
    witness?: CaseState;                                      // CTI, for not-inductive
    pinnedBy?: string[];                                      // peers, when entailed
  }
  // Runs consecution then (only if it holds) entailment, per design §5.
  export async function classifyInvariant(
    m: DomainModel, inv: CandidateInvariant, peers: Candidate[], deps: SolverDeps,
  ): Promise<Classification>;
  ```
  Logic: consecution probe (`astToQuintClassify(..., 'consecution', 1)` → `runQuintVerify(init:'indInit', maxSteps:1)`). If `violated` → `not-inductive` (witness = CTI). Else entailment probe (`'entailment', 0`, `maxSteps:0`): `violated:false` → `entailed` (pinnedBy = peer names); `violated:true` → `independent`.

- [ ] **Step 1: Write failing unit tests (fake deps)**

`lattice/test/engine/classify.test.ts` — drive with a fake `SolverDeps.quintVerify` returning canned `{violated, witness}` to assert the branch logic (this tests orchestration, not solver behavior — the real behavior is the integration test):

```ts
// consecution fails -> not-inductive (with witness); consecution holds + entailment holds -> entailed;
// consecution holds + entailment fails -> independent. Assert each branch with a fake deps.quintVerify
// that returns the scripted result per call order.
```
Write the three cases concretely with a fake `deps` whose `quintVerify` returns queued results.

- [ ] **Step 2: Run — FAIL (module missing).** `cd lattice && npx vitest run test/engine/classify.test.ts`

- [ ] **Step 3: Implement `classifyInvariant`.** Add a `quintVerify` member to `SolverDeps` (in `planner.ts` or wherever `SolverDeps` is defined) wrapping `runQuintVerify`, so the classifier depends on `deps` (testable) rather than importing the adapter directly — mirror how `deps.quint` wraps `runQuint`. Implement the two-probe branch logic above.

- [ ] **Step 4: Run unit — PASS.**

- [ ] **Step 5: Integration test — the worked classification.** `lattice/test/engine/classify.integration.test.ts`: on the committed Subscriptions model with real deps, assert `paidImpliesExactConjunct` → `entailed`, and a coupling invariant (`activePaidInFull`) → `not-inductive` (design §5 correction). Real quint.

- [ ] **Step 6: Full check + commit** (`src/engine/classify.ts`, both test files, and the `SolverDeps`/`planner.ts` edit).

---

## Task 5: On-demand reachability escalation (not-inductive → violated)

**Files:** Modify `lattice/src/engine/classify.ts`; Test `lattice/test/engine/classify.test.ts` + `.integration.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // Runs a bounded reachability probe from the REAL init (runQuint, not indInit).
  // reachable ⇒ verdict 'violated' + reachable witness; else unchanged 'not-inductive'.
  export async function escalate(
    m: DomainModel, inv: CandidateInvariant, peers: Candidate[], deps: SolverDeps, maxSteps: number,
  ): Promise<Classification>;
  ```
  Emits the invariant as an ordinary bounded reachability check (reuse `astToQuint`'s probe-forbid shape with `adopted = peers`, or a small dedicated emission) and calls `deps.quint`/`runQuint` from the real `init`. `violated:true` → `{ verdict:'violated', witness, reachable:true }`; else keep `not-inductive`.

- [ ] Steps: failing unit test (fake deps: reachable→violated, unreachable→stays not-inductive) → implement → integration test (seeded `settle requires amountPaid >= totalDue` → overpayment invariant escalates to `violated` with a reachable witness; and the unreachable-CTI control stays `not-inductive`) → full check → commit. Write the seeded-mutation fixture in `test/fixtures.ts`.

---

## Task 6: `classify` CLI command + `status`/`explain` rendering

**Files:** Modify `lattice/src/cli.ts`; Test `lattice/test/cli-classify.test.ts` (new), `lattice/test/cli-explain.test.ts`.

**Interfaces:**
- `classify --session DIR [--name INV] [--escalate INV]`: classifies all adopted invariants (or one `--name`), appends a `classified` ledger entry per result, returns `{ classified: [...] }`. `--escalate INV` runs Task 5's escalation on a prior `not-inductive` finding.
- `status`: add `classifications: { entailed, independent, notInductive, violated }` counts from `readClassifications(dir)` (latest per `invariant`+`conjunct`).
- `explain <name>`: merge `{ verdict, tier, caveat, witness, pinnedBy }` from the latest matching `classified` entry into the existing `out`.

- [ ] Steps: add the `classify` case to both switches (validation `cli.ts:149-168`, body after `cli.ts:189`), threading `deps` (first `apply`-adjacent use of `deps.quintVerify`); append entries via `appendLedger`; extend `status` (`cli.ts:277-281`) and `explain` (`cli.ts:379-405`). TDD: `cli-classify.test.ts` drives `runCommand(['classify','--session',dir], fakeDeps)` with a fake `quintVerify`, asserts ledger entries + status counts; extend `cli-explain.test.ts` to assert verdict/tier surface. Real-quint end-to-end can piggyback the Task 4 integration. Commit.

---

## Task 7: Reclassify-on-apply (incremental)

**Files:** Modify `lattice/src/cli.ts` (both `apply` branches); Test `lattice/test/cli-apply.test.ts`.

**Interfaces:**
- `classifyOnApply(dir, model, adopted, deps, changed): Promise<LedgerEntry[]>` — recomputes classifications only for invariants in the dependency set of `changed` (the touched invariant/guard/field + any invariant/guard referencing it), carrying forward the rest; returns the `classified` appends. Called after `writeProjections`, before `done(...)`, in both branches (`cli.ts:352-353`, `:375-377`). `apply --no-classify` skips it.

- [ ] Steps: failing test in `cli-apply.test.ts` (apply a model, assert `classified` entries appear for affected invariants and `--no-classify` suppresses them) → implement the hook + dependency set + `--no-classify` flag → run apply tests + goldens → full check → commit. Keep the reclassification off the fresh-session hot path if it would run the whole set — scope to the change (design §7.2).

---

## Task 8: method⊨transition entailment (param-aware encoding)

**Files:** Modify `lattice/src/emit/quint-classify.ts` (param-aware render path); Create `lattice/src/engine/method-guard.ts`; Test `lattice/test/engine/method-guard.test.ts` + integration.

**Interfaces:**
- Produces:
  ```ts
  // ∀ params: methodReq(params, state) ⇒ transitionGuard(state).  Params become nondet draws;
  // never routed through termToQuint's throwing 'param' case.
  export type MethodGuardVerdict = 'consistent' | 'weaker-than-guard' | 'stronger-than-guard';
  export async function checkMethodGuard(
    m: DomainModel, svc: string, method: string, deps: SolverDeps,
  ): Promise<{ verdict: MethodGuardVerdict; witness?: CaseState }>;
  ```
  Resolve `MethodDef.kind.performs → { aggregate, transition }` (inline pattern from `validate.ts:229-234`), read `TransitionDef.requires` as the guard. Emit a havoc harness (reuse `astToQuintClassify` internals) that (a) draws a `nondet nd_param_<name>` per `ParamDef` from a type-matched pool, (b) renders `methodReq` via a **param-aware** term renderer (`param` → `nd_param_<name>`), and checks `methodReq implies transitionGuard` at `--max-steps 0`. Also run the converse for `stronger-than-guard`. A method with no `requires` is trivially weakest → `weaker-than-guard` iff the guard is non-trivial.

- [ ] Steps: (a) add a param-aware path in `quint-classify.ts` — thread an optional `paramVars: Record<string,string>` through a sibling `predToQuintParam`/`termToQuintParam` (or a guarded extension) that resolves `param` to the drawn var; leave the ordinary `termToQuint` `param` throw intact (constraint). Unit-test the renderer (a `requires` with a `param` renders to the nondet var, not a throw). (b) Implement `checkMethodGuard`. (c) Unit test with fake deps for the three verdicts. (d) Integration: `SubscriptionService.activate` (no `requires`) vs `activate`'s `paidInvoiceCount >= 1` guard → `weaker-than-guard`, real quint. (e) Surface in `classify`/`status` output. Full check + commit.

> **If Task 8 grows** (param encoding proves larger than one task), split it into its own Plan 2b rather than bloating this task — method⊨transition is a distinct sub-system and the entailment classifier (Tasks 1–7) is independently shippable.

---

## Self-Review

**Spec coverage:** Tasks 1–5 deliver design §5's two-probe base + escalation (Option 3); Task 6 delivers §7.1/§7.4 (`classify`, `status`, `explain`); Task 7 delivers §7.2 (reclassify-on-apply, incremental); Task 8 delivers the method⊨transition row. Abstract-evolution (§6) is explicitly Plan 3 — not covered here (`tier` is hardcoded `'sound'` until then).

**Placeholder scan:** Tasks 4–8 give interfaces + branch logic + step outlines with concrete file:line seams rather than full code, because their code depends on Tasks 2–3's landed helpers; the two hardest emissions (Task 3 `astToQuintClassify`, Task 8 param path) carry explicit construction recipes. No "TBD"/"handle errors" placeholders; every task ends in a real committed deliverable with a named test.

**Type consistency:** `Classification`, `ClassifyQuery`, `SolverDeps.quintVerify`, `astToQuintClassify`, `classifyInvariant`, `escalate`, `checkMethodGuard`, `buildOwnerInit` names are used consistently across "Produces"/consumers. The `classified` ledger shape matches `session.ts:29-32` (verdict enum incl. `not-inductive`; `reachable?` set by Task 5). Peers built via `adoptedConstraints` + `expressibleAdopted('quint')`, never the invariant-under-test.

**Note for execution:** Tasks 4–8 are deliberately lighter on verbatim code than a fully-specified plan because they build directly on Task 2/3's extracted helpers and are best written against that landed code. If executing subagent-driven, expand each into its full failing-test/implement/pass/commit code at dispatch time from the interfaces + seams given here; if any interface proves wrong against the real Task-2/3 code, that's a plan-fix escalation, not an improvisation.
