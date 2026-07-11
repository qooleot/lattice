# Inference Slice — Plan 2b: Classifier Wiring (Pillar A, part 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the landed emitter foundation (Plan 2 Tasks 1–3) into a working entailment classifier: a two-probe classifier module, on-demand reachability escalation, the `classify`/`status`/`explain` CLI surface, reclassify-on-apply, and method⊨transition entailment.

**Architecture:** `src/engine/classify.ts` orchestrates `astToQuintClassify` + a new `SolverDeps.quintVerify` (wrapping `runQuintVerify`). Consecution runs `--init indInit --invariant q_I --max-steps 1`; entailment `--init indInit --invariant q_peersImpliesI --max-steps 0`; escalation reuses the *same emission* from the real `--init init --invariant q_peersImpliesI --max-steps N`. Method⊨transition adds a param-aware predicate renderer (params → nondet draws) so `∀params: methodReq ⇒ guard` runs as a `--max-steps 0` implication check without touching the throwing transition-guard path.

**Tech Stack:** TypeScript (strict, ESM, `.js` specifiers), Vitest, Quint 0.26.0 / Apalache 0.47.2.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run` before every commit. **Real solvers, no simulated validation**: fake `SolverDeps` may test orchestration branch-logic in unit tests, but every distinct verdict must also have a real `quint verify` integration test.
- After a fresh checkout run `npx langium generate` **and** `npm install` (Plan 1 lesson).
- Never `git add -A`; stage explicit paths. Goldens A–D never weakened. `evaluate.ts` not touched. Generation's `differential.test.ts` stays green.
- Peers = `expressibleAdopted('quint', adoptedConstraints(s))` (planner.ts:72/87), **minus the invariant-under-test** (circular). `expressibleAdopted('quint', …)` keeps only `statePredicate/conservation/cardinality/unique/sumOverCollection`.
- `classified` ledger entries (session.ts:29-32) are append-only; latest per `(invariant, conjunct)` wins. An *entailed* invariant is never auto-deleted.
- `param` terms stay a hard error on the ordinary path (`termToQuint`, quint.ts:80); only the new method⊨transition renderer resolves them.

## Landed foundation this plan builds on (verified 2026-07-10)

- `astToQuintClassify(m, cq: ClassifyQuery): QuintEmission` — `cq = { invariant: Candidate; peers: Candidate[]; probe: 'consecution'|'entailment'; maxSteps: number }`. Emits the full machine (real `init`, all transitions, `step`), a havoc `indInit`, and vals `q_I`, `peer0..`, `peersAnd`, `q_peersImpliesI`. `invariantName` = `q_I` (consecution) / `q_peersImpliesI` (entailment). (`src/emit/quint-classify.ts`)
- `runQuintVerify(em, { init?, invariant?, maxSteps }): Promise<{violated, witness?, ms}>` (`src/solvers/quint-adapter.ts`).
- `SolverDeps` (`src/engine/planner.ts:11`) — has `alloy`, `quint`; **this plan adds `quintVerify`**. `realDeps` is wired in `src/cli.ts`.
- `readClassifications(dir)` and the `classified` `LedgerEntry` variant (`src/engine/session.ts:29-32,62`).
- `adoptedConstraints(s)`, `expressibleAdopted(engine, adopted)` (`src/engine/planner.ts:72-88`).

## FIDELITY CAVEAT (honest ceiling — Task 1 folds it into design §10 + labels)

`astToQuintClassify`'s `indInit` uses `IDS.mapBy(id => {…})`, binding **every instance of an aggregate to an identical drawn record**. So the induction probes explore only the "all-instances-of-an-aggregate-equal" slice of the state space, not the full reachable set. Verdicts (`entailed`/`independent`/`not-inductive`) are **sound over that slice**. Every emitted label and the design must say so; do not claim full-reachable-set soundness.

---

## Task 1: Classifier module + `SolverDeps.quintVerify` + honesty edits

**Files:**
- Modify: `lattice/src/engine/planner.ts` (add `quintVerify` to `SolverDeps`)
- Modify: `lattice/src/cli.ts` (wire `quintVerify` into `realDeps`)
- Create: `lattice/src/engine/classify.ts`
- Modify: `lattice/src/emit/quint-classify.ts` (harden the regex Minor)
- Modify: `docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md` (§10 caveat)
- Test: `lattice/test/engine/classify.test.ts` (unit, fake deps), `lattice/test/engine/classify.integration.test.ts` (real quint), `lattice/test/emit/quint-classify.test.ts` (multi-owner hardening)

**Interfaces:**
- Produces:
  ```ts
  // planner.ts SolverDeps — add:
  quintVerify(em: QuintEmission, opts: { init?: string; invariant?: string; maxSteps: number }):
    Promise<{ violated: boolean; witness?: CaseState; ms: number }>;

  // classify.ts:
  export interface Classification {
    invariant: string; conjunct?: string;
    verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';
    tier: 'sound';               // 'abstract' arrives in Plan 3
    witness?: CaseState;         // CTI, for not-inductive
    reachable?: boolean;         // set by escalate() (Task 2)
    pinnedBy?: string[];         // peer names, when entailed (guard-level attribution is future work)
  }
  export async function classifyInvariant(
    m: DomainModel, inv: CandidateInvariant, peers: Candidate[], peerNames: string[], deps: SolverDeps,
  ): Promise<Classification>;
  ```

- [ ] **Step 1: Fold the fidelity caveat into design §10**

In `docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md` §10 (Honest ceiling), add a bullet:
> - **Equal-records slice.** The classifier's havoc-init (`astToQuintClassify`, `mapBy`) binds every instance of an aggregate to an identical drawn record, so induction is checked over the "all-instances-equal" slice of the state space, not the full reachable set. `entailed`/`independent`/`not-inductive` are sound **over that slice**; a per-verdict note records this.

Commit is folded into this task's final commit.

- [ ] **Step 2: Write failing unit tests (fake deps, branch logic)**

`lattice/test/engine/classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyInvariant } from '../../src/engine/classify.js';
import type { SolverDeps } from '../../src/engine/planner.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

const inv: CandidateInvariant = { id: 'i1', name: 'testInv', prior: 1, source: 'template', candidate: paidImpliesExactConjunct };

// Fake deps whose quintVerify returns queued results in call order (consecution first, then entailment).
function fakeDeps(results: { violated: boolean; witness?: any }[]): SolverDeps {
  let i = 0;
  return {
    alloy: async () => ({ sat: false, instances: [], ms: 0 }),
    quint: async () => ({ violated: false, ms: 0 }),
    quintVerify: async () => ({ ...results[i++]!, ms: 0 }),
  };
}

describe('classifyInvariant branch logic', () => {
  it('consecution fails -> not-inductive with the CTI witness', async () => {
    const w = { entities: [{ type: 'Invoice', id: 'invoice1', fields: {} }], trace: [] };
    const c = await classifyInvariant(subscriptionsModel, inv, [], [], fakeDeps([{ violated: true, witness: w }]));
    expect(c.verdict).toBe('not-inductive');
    expect(c.witness).toBe(w);
  });
  it('consecution holds + entailment holds -> entailed (pinnedBy peers)', async () => {
    const c = await classifyInvariant(subscriptionsModel, inv, [], ['peerA'], fakeDeps([{ violated: false }, { violated: false }]));
    expect(c.verdict).toBe('entailed');
    expect(c.pinnedBy).toEqual(['peerA']);
  });
  it('consecution holds + entailment fails -> independent', async () => {
    const c = await classifyInvariant(subscriptionsModel, inv, [], [], fakeDeps([{ violated: false }, { violated: true }]));
    expect(c.verdict).toBe('independent');
  });
});
```

- [ ] **Step 3: Run — FAIL (module missing).** `cd lattice && npx vitest run test/engine/classify.test.ts`

- [ ] **Step 4: Add `quintVerify` to `SolverDeps` + wire `realDeps`**

In `src/engine/planner.ts`, add the `quintVerify` member to the `SolverDeps` interface (import `QuintEmission` type from `../emit/quint.js`). In `src/cli.ts`'s `realDeps`, add `quintVerify: (em, opts) => runQuintVerify(em, opts)` (import `runQuintVerify` from `./solvers/quint-adapter.js`).

- [ ] **Step 5: Implement `classifyInvariant`**

`src/engine/classify.ts`:

```ts
import type { DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant } from '../ast/invariant.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { astToQuintClassify } from '../emit/quint-classify.js';

export interface Classification {
  invariant: string; conjunct?: string;
  verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';
  tier: 'sound';
  witness?: CaseState;
  reachable?: boolean;
  pinnedBy?: string[];
}

// Design §5 two-probe base label. Sound over the equal-records slice (see plan §fidelity caveat).
export async function classifyInvariant(
  m: DomainModel, inv: CandidateInvariant, peers: Candidate[], peerNames: string[], deps: SolverDeps,
): Promise<Classification> {
  // Probe 1 — consecution: from any (peers ∧ I) state, does one step preserve I?
  const cEm = astToQuintClassify(m, { invariant: inv.candidate, peers, probe: 'consecution', maxSteps: 1 });
  const consec = await deps.quintVerify(cEm, { init: 'indInit', invariant: cEm.invariantName, maxSteps: 1 });
  if (consec.violated) return { invariant: inv.name, verdict: 'not-inductive', tier: 'sound', witness: consec.witness };
  // Probe 2 — entailment: does every (peers) state already satisfy I?  (peers ⇒ I at 0 steps)
  const eEm = astToQuintClassify(m, { invariant: inv.candidate, peers, probe: 'entailment', maxSteps: 0 });
  const entail = await deps.quintVerify(eEm, { init: 'indInit', invariant: eEm.invariantName, maxSteps: 0 });
  return entail.violated
    ? { invariant: inv.name, verdict: 'independent', tier: 'sound' }
    : { invariant: inv.name, verdict: 'entailed', tier: 'sound', pinnedBy: peerNames };
}
```

- [ ] **Step 6: Run unit — PASS.**

- [ ] **Step 7: Harden the regex Minor (multi-owner emission test)**

Add to `lattice/test/emit/quint-classify.test.ts` a test that emits with a **multi-owner-referencing** hypothesis (peers over both `Subscription` and `Invoice`, using `subscriptionsModel`) and asserts the emitted `indInit` substitutes each owner var with its inline map without corrupting either (both `(subscriptions ... mapBy ...)` and `(invoices ... mapBy ...)` appear in the hypothesis conjunct, and no bare `subscriptions`/`invoices` token survives outside a `.mapBy` expr). If this exposes the `\bvar\b` global-replace footgun (quint-classify.ts:55), fix it token-safely (e.g. replace longest-var-name-first, or match `\bvar\b` not already inside an emitted map) and add a comment pinning the assumption. If the test passes as-is, leave a comment documenting the safe-for-current-models assumption.

- [ ] **Step 8: Integration — worked classification (real quint)**

`lattice/test/engine/classify.integration.test.ts`: with `realDeps`' `quintVerify` (real quint), on `subscriptionsModel`:
- `paidImpliesExactConjunct` (peers `[]`) → `entailed` (consecution holds, entailment holds — the settle guard forces it).
- `activePaidInFull` (a coupling invariant, add fixture) → `not-inductive` (design §5 correction).

```ts
it('paid-conjunct classifies entailed on the committed model', async () => {
  const c = await classifyInvariant(subscriptionsModel, paidInvFixture, [], [], realDeps);
  expect(c.verdict).toBe('entailed');
}, 240_000);
```

- [ ] **Step 9: Full check + commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`
Expected: PASS; goldens green.

```bash
git add lattice/src/engine/classify.ts lattice/src/engine/planner.ts lattice/src/cli.ts lattice/src/emit/quint-classify.ts lattice/test/engine/classify.test.ts lattice/test/engine/classify.integration.test.ts lattice/test/emit/quint-classify.test.ts lattice/test/fixtures.ts docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md
git commit -m "feat(engine): entailment classifier (two-probe base label)

classifyInvariant runs consecution then entailment via a new
SolverDeps.quintVerify; entailed/independent/not-inductive per design §5.
Hardens the multi-owner hypothesis substitution; folds the equal-records
fidelity caveat into design §10.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: On-demand reachability escalation (not-inductive → violated)

**Files:** Modify `lattice/src/engine/classify.ts`; Test `classify.test.ts` + `classify.integration.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // Reachability from the REAL init. Reuses the classify emission (which contains both `init` and
  // q_peersImpliesI): a violation of (peers ⇒ I) within maxSteps of the real init = a reachable
  // peer-consistent counterexample. reachable ⇒ 'violated' + reachable witness; else stays 'not-inductive'.
  export async function escalate(
    m: DomainModel, inv: CandidateInvariant, peers: Candidate[], deps: SolverDeps, maxSteps: number,
  ): Promise<Classification>;
  ```

- [ ] **Step 1: Failing unit tests (fake deps)** — reachable (`violated:true`) → `{ verdict:'violated', reachable:true, witness }`; unreachable (`violated:false`) → `{ verdict:'not-inductive' }`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `escalate`**

```ts
export async function escalate(
  m: DomainModel, inv: CandidateInvariant, peers: Candidate[], deps: SolverDeps, maxSteps: number,
): Promise<Classification> {
  const em = astToQuintClassify(m, { invariant: inv.candidate, peers, probe: 'entailment', maxSteps });
  // Real init (permissive draw), bounded run; q_peersImpliesI violated ⇒ reachable peer-consistent ¬I.
  const r = await deps.quintVerify(em, { init: 'init', invariant: 'q_peersImpliesI', maxSteps });
  return r.violated
    ? { invariant: inv.name, verdict: 'violated', tier: 'sound', witness: r.witness, reachable: true }
    : { invariant: inv.name, verdict: 'not-inductive', tier: 'sound' };
}
```

- [ ] **Step 4: Run unit — PASS.**

- [ ] **Step 5: Integration (real quint)** — two fixtures in `test/fixtures.ts`:
  - Seeded overpayment: `subscriptionsModel` with `settle` guard mutated to `amountPaid >= totalDue`, invariant `neverOverpaid` → `escalate(...)` → `violated`, `reachable:true`, with a witness.
  - Unreachable-CTI control: an `active ⇒ paidInvoiceCount >= 1`-shaped invariant whose CTI is blocked by `activate`'s guard on the frozen counter → `escalate(...)` stays `not-inductive`.
  Assert each with real `realDeps`, generous timeout.

- [ ] **Step 6: Full check + commit** (`classify.ts`, both test files, `test/fixtures.ts`).

---

## Task 3: `classify` CLI command + `status`/`explain` rendering

**Files:** Modify `lattice/src/cli.ts`; Test `lattice/test/cli-classify.test.ts` (new), `lattice/test/cli-explain.test.ts`.

**Interfaces:**
- `classify --session DIR [--name INV] [--escalate INV] [--max-steps N]`: classifies all adopted invariants (or the one `--name`); `--escalate INV` runs Task 2 on a prior `not-inductive`. Appends a `classified` ledger entry per result; returns `{ classified: Classification[] }`.
- `status`: add `classifications: { entailed, independent, notInductive, violated }` — counts of the **latest** `classified` entry per `(invariant, conjunct)` from `readClassifications(dir)`.
- `explain <name>`: merge `{ verdict, tier, caveat, witness, pinnedBy, reachable }` from the latest matching `classified` entry into the returned object.

- [ ] **Step 1: Failing tests.** `cli-classify.test.ts` drives `runCommand(['classify','--session',dir], fakeDeps)` (fake `quintVerify`) and asserts (a) a `classified` ledger entry per adopted invariant, (b) `status` returns the counts, (c) `explain` surfaces the verdict. Extend `cli-explain.test.ts` for the verdict/tier fields.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add `classify` to both switches in `runCommand` (validation block ~cli.ts:149-168; body after ~cli.ts:189). Build peers via `expressibleAdopted('quint', adoptedConstraints(s))` minus the target; call `classifyInvariant`/`escalate`; `appendLedger(dir, { kind:'classified', at:<iso>, invariant, conjunct, verdict, tier, witness, reachable, pinnedBy, provenance:'classify <date>' })` per result. Extend `status` (~cli.ts:277-281) with the counts (latest-per-key reduce over `readClassifications(dir)`). Extend `explain` (~cli.ts:379-405) to merge the latest matching `classified`. Thread `deps` (first classify-from-CLI use of `deps.quintVerify`). Use a fixed timestamp source consistent with the rest of cli.ts (it already stamps `at` via `new Date().toISOString()` — mirror that).

- [ ] **Step 4: Run — PASS. Step 5: Full check + commit** (`cli.ts`, both test files).

---

## Task 4: Reclassify-on-apply (incremental) + `--no-classify`

**Files:** Modify `lattice/src/cli.ts` (both `apply` branches); Test `lattice/test/cli-apply.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // Recompute classifications only for invariants in the dependency set of `changed` (the touched
  // invariant/guard/field + any adopted invariant whose body/scope references it); carry the rest
  // forward. Returns the classified entries to append. Skipped when apply --no-classify.
  async function classifyOnApply(
    dir: string, m: DomainModel, adopted: CandidateInvariant[], changed: string[], deps: SolverDeps,
  ): Promise<Extract<LedgerEntry, { kind: 'classified' }>[]>;
  ```

- [ ] **Step 1: Failing test** in `cli-apply.test.ts`: apply a model with `fakeDeps`, assert `classified` entries appear for affected invariants (via `readClassifications`), and `apply --no-classify` produces none.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add the `--no-classify` flag. Compute the dependency set from the apply's change (the reconcile result `r` already names changed invariants/structure; for a fresh session, all adopted are "changed"). Call `classifyOnApply` after `writeProjections`, before `done(...)`, in **both** branches (fresh ~cli.ts:352-353 and reconcile ~cli.ts:375-377); append its entries via `appendLedger`; fold a `classification` summary into the returned object (analogous to `workspace`). Keep it scoped to the change so the hot path doesn't re-run the whole set (design §7.2).

- [ ] **Step 4: Run apply tests + goldens. Step 5: Full check + commit** (`cli.ts`, `cli-apply.test.ts`).

---

## Task 5: method⊨transition entailment (param-aware encoding)

**Files:** Create `lattice/src/emit/method-guard.ts` (param-aware renderer + harness emission); Create `lattice/src/engine/method-guard.ts` (the check); Modify `lattice/src/cli.ts` (surface in `classify`/`status`); Test `lattice/test/engine/method-guard.test.ts` + `.integration.test.ts`, `lattice/test/emit/method-guard.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // emit/method-guard.ts — a param-aware predicate renderer; params resolve to drawn nondet vars,
  // never routed through termToQuint's throwing 'param' case (quint.ts:80 stays intact).
  export function predToQuintParam(
    m: DomainModel, p: Predicate, self: string, ownerName: string, paramVars: Record<string, string>,
  ): string;
  export function astToMethodGuardQuery(
    m: DomainModel, aggregate: string, transition: string, methodReq: Predicate | undefined,
    params: { name: string; type: TypeRef }[], direction: 'method-implies-guard' | 'guard-implies-method',
  ): QuintEmission;

  // engine/method-guard.ts — the entailment check.
  export type MethodGuardVerdict = 'consistent' | 'weaker-than-guard' | 'stronger-than-guard';
  export async function checkMethodGuard(
    m: DomainModel, service: string, method: string, deps: SolverDeps,
  ): Promise<{ verdict: MethodGuardVerdict; witness?: CaseState }>;
  ```

- [ ] **Step 1: Param-renderer unit test + impl.** `predToQuintParam` mirrors `predToQuint` (quint.ts:141-162) but takes `paramVars` and, for a `param` term, returns `paramVars[t.name]` instead of throwing. TDD: a `requires` containing a `param` renders to the drawn var name (not a throw). Leave the ordinary `termToQuint`/`predToQuint` `param` throw untouched (constraint).

- [ ] **Step 2: Harness emission + test.** `astToMethodGuardQuery` builds a havoc harness over the transition's aggregate (reuse `buildOwnerInit(...,'havoc')` + `owners`), plus one `nondet nd_param_<name> = oneOf(<pool for its TypeRef>)` per param (pool selection mirrors `initValue`, quint.ts:46-71: enum → `oneOf(Set(...))`, ref → `oneOf(<TARGET>_IDS)`, int-prim → `oneOf(INT_POOL)`), asserts `methodReq` (rendered via `predToQuintParam`) at `indInit`, and checks the guard implication at `--max-steps 0`. `direction` picks which implication is the invariant (`methodReq ⇒ guard` for weaker-detection; `guard ⇒ methodReq` for stronger-detection). Test the emitted `.source` shape.

- [ ] **Step 3: `checkMethodGuard` unit test (fake deps) + impl.** Resolve `MethodDef.kind.performs → { aggregate, transition }` and the `TransitionDef.requires` (inline pattern from validate.ts:229-234). Run direction `method-implies-guard`: `violated` ⇒ a (params,state) with methodReq true but guard false ⇒ **weaker-than-guard** (advertises rejected calls). Then `guard-implies-method`: `violated` ⇒ **stronger-than-guard** (silently narrows the API). Neither ⇒ `consistent`. A method with no `requires` = weakest ⇒ `weaker-than-guard` iff the guard is non-trivial.

- [ ] **Step 4: Integration (real quint).** `SubscriptionService.activate` (no `requires`) vs `activate`'s `paidInvoiceCount >= 1` guard → `weaker-than-guard`.

- [ ] **Step 5: Surface** the verdict in `classify`/`status` output (a `methodGuards: [...]` section). **Step 6: Full check + commit.**

> **If Task 5 grows past one PR** (the param renderer + harness may be sizable), split it into Plan 2c — the classifier (Tasks 1–4) is independently shippable and method⊨transition is a distinct sub-system.

---

## Final whole-branch review (after Task 5)

Run the deferred integrated review over Plan 2 + 2b together — base = the commit before Plan 2 Task 1 (`7e92e9e`), head = the last 2b commit — so the reviewer sees the wired classifier end-to-end (emitter foundation → classifier → CLI → method⊨transition), not an un-consumed foundation. Carry the accumulated Minors (regex footgun if not already fixed, `pinnedBy` guard-attribution as future work, `candidateToQuint` recomputation) into that review for triage.

## Self-Review

**Spec coverage:** Task 1 = design §5 base labels + the honesty caveat (§10); Task 2 = §5 escalation (Option 3); Task 3 = §7.1/§7.4 CLI; Task 4 = §7.2 reclassify-on-apply; Task 5 = method⊨transition. Abstract-evolution (§6) remains Plan 3 (`tier` hardcoded `'sound'`).

**Placeholder scan:** Tasks 1–2 carry full verbatim code (grounded in the landed `astToQuintClassify`/`SolverDeps`); Tasks 3–5 carry interfaces + concrete seams (cli.ts line anchors, the param-renderer recipe, the pool-selection reference) + step-by-step TDD outlines rather than every line, because CLI wiring is mechanical against known anchors and the method-guard harness is best finalized against Task 1's landed `quintVerify`. No "TBD"/"handle errors"; every task ends in a named test + commit.

**Type consistency:** `Classification`, `SolverDeps.quintVerify`, `classifyInvariant`, `escalate`, `checkMethodGuard`, `predToQuintParam` names are consistent across producers/consumers. `Classification.verdict` and the `classified` ledger enum both carry `entailed|independent|not-inductive|violated` + `reachable?`. Escalation reuses `astToQuintClassify`'s existing `q_peersImpliesI` val from the real `init` — no new emission. `quintVerify` signature matches `runQuintVerify`.
