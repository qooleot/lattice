# Lattice Pillar C — CTI-Guided Strengthening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a `violated` invariant's CTI into an inferred, auto-pruned transition **guard** — auto-adopted when one variant survives, surfaced as a distinguish question when several do, or reported as a consistency finding when none do — via a shared engine reachable from both a `strengthen` CLI command and the interactive elicitation loop.

**Architecture:** A first-class `guard` Candidate kind (inferred, session/engine-internal until write-back, dissolving into a transition's `requires` on `apply`); a pure `strengthenInvariant` engine (CTI→transition trace-diff → `{eq,le,ge}` shape lattice → auto-prune with Pillar A's solver queries → resolve); two entry points (the `strengthen` command and an interactive-loop hook) that share the engine. Masking coverage and loop-quieting fall out of reusing the §7.2 reclassify-on-apply pass.

**Tech Stack:** TypeScript (strict, ESM, `.js` specifiers), Vitest, Quint 0.26.0 / Apalache 0.47.2.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run`. **Real solvers, no simulated validation** — each verdict/resolution asserted in an integration test comes from a real `quint verify` via `runQuintVerify`/`deps.quintVerify`.
- After a fresh checkout: `npx langium generate` + `npm install`. (This worktree already has both — do NOT re-run unless a build error says the parser is missing.)
- **Goldens A–D byte-identical.** A `guard` candidate only affects emission when it is *adopted and present in `QuintQuery.adopted`*; goldens carry no adopted guards, so their emission is unchanged. A Task-2 test asserts byte-identical emission with no adopted guards. Do not touch `evaluate.ts` behavior for existing kinds, goldens, or generation `differential.test.ts`.
- Never `git add -A`. Guards are **inferred, never authored** (design §9) — **no** `.langium`, `fromLangium.ts`, `grammar.ts`, or reserved-word change.
- **Load note:** a lone `golden/trace-b.test.ts` *median-latency* failure is a known environmental flake — report it, do not block, never weaken a latency budget. Any OTHER failure is real.
- **Findings are never hard errors** (spurious-CTI discipline, §10): a `no-transition` or `inconsistent` resolution is a finding, never a crash; auto-adoption is always ledger-noted (`pinnedBy`) and reversible.
- Design of record: `docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md` §8 (esp. §8.1 the kind + boundary, §8.5 the engine, §8.6 surface + write-back + hook, §8.7 masking/quieting) and §10 (honest ceiling).

## Landed foundation (verified 2026-07-12)

- **Candidate union** (`src/ast/invariant.ts:23-42`): 9 kinds; `Cmp` op set is `'eq' | 'le' | 'ge'` (`:40`). `Predicate` `cmp` is `{ kind:'cmp'; op:Cmp; left:Term; right:Term }`; `field` term is `{ kind:'field'; owner:string; path:Path }`; `Path = string[]`. `CandidateInvariant { id; name; doc?; prior; source; candidate }` (`:43-50`).
- **Emission** (`src/emit/quint.ts`): `astToQuint(m, q)` builds per-owner `trans_<Owner>_<name>` actions; the transition guard renders at `:345` as `const guard = t.requires ? `, ${predToQuint(m, t.requires, `${v}.get(id)`, o.name)}` : ''`. `q.adopted` (Candidate[]) is conjoined as always-properties via `candidateToQuint` at `:399-400`. `candidateToQuint(m,c,name)` (`:223`) renders always-property `val`s per kind — it has NO `guard` case. `predToQuint` (`:152`) is exported (Pillar B). `varName`/`owners`/`buildOwnerInit` exported.
- **Classifier / CTI** (`src/engine/classify.ts`): `classifyInvariant` runs the reachability probe `deps.quintVerify(rEm, { init:'init', invariant:'q_peersImpliesI', maxSteps:reachSteps })` where `rEm = astToQuintClassify(m, { invariant, peers, probe:'entailment', maxSteps:reachSteps })`; a `violated` result's `witness` is a `CaseState`.
- **Witness carries the trace** (`src/solvers/quint-adapter.ts:130-135`): `parseITF` → `CaseState { now?; entities: CaseEntity[]; trace?: CaseEntity[][] }` where `entities` is the LAST (violating) state and `trace` is the preceding states. `CaseEntity` carries the instance's fields including `<region>_state`.
- **Evaluation** (`src/engine/evaluate.ts:63`): `evaluateCandidate(c, s): Verdict` switches on `c.kind`; `evalPred(pred, entity, state)` evaluates a `Predicate` against a `CaseEntity`. `subjects()` = `s.entities.filter(e => e.type === c.aggregate)`.
- **Structural gate** (`src/engine/tier.ts`): `conjunctTier(m, c)` switches on `c.kind` (no default); `conjunctsOf`. **Salient** (`src/engine/salient.ts`): `collectCmps`/`collectInStateRegions` walk predicates.
- **Adoption** (`src/cli.ts`): a candidate is adopted by `s.candidates.push({ inv, status:'adopted' })` + `appendLedger(dir, { kind:'adopted', at:now(), invariant:inv, provenance })`. Adopted candidates reach emission via `adoptedConstraints(s)` / `expressibleAdopted` → `QuintQuery.adopted`.
- **Write-back** (`src/emit/code.ts:78-79`): `astToCode(m, adopted)` renders each transition as `transition <name> { from … to … [; requires <predToText(t.requires)>] … }`.
- **Reclassify-on-apply** (`src/cli.ts` `classifyOnApply`, design §7.2): recomputes `classified` labels for a dependency set on apply — the masking/quieting mechanism §8.7 reuses.
- **Reachability bound:** `reachSteps` default `6` (Pillar A/B).

---

## Task 1: `guard` Candidate kind — AST, evaluation, and loud invariant-only exclusions

**Files:**
- Modify: `lattice/src/ast/invariant.ts` (union member), `lattice/src/engine/evaluate.ts` (`guard` eval case), `lattice/src/emit/quint.ts` (`candidateToQuint` rejects guard), `lattice/src/engine/tier.ts` (`conjunctTier` rejects guard)
- Test: `lattice/test/engine/guard-candidate.test.ts`

**Interfaces:**
- Produces: `Candidate` gains `| { kind: 'guard'; aggregate: string; region: string; transition: string; predicate: Predicate }`. `evaluateCandidate` handles `guard` (predicate satisfied on every subject → `permit`). `candidateToQuint` and `conjunctTier` THROW on `guard` (a guard is never an always-property — the loud boundary of §8.1).

- [ ] **Step 1: Write the failing tests** (`test/engine/guard-candidate.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { evaluateCandidate } from '../../src/engine/evaluate.js';
import { candidateToQuint } from '../../src/emit/quint.js';
import { conjunctTier } from '../../src/engine/tier.js';
import { subscriptionsModel } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const settleGuard: Candidate = { kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
  predicate: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } };

describe('guard Candidate kind', () => {
  it('evaluateCandidate: permit iff the guard predicate holds on every subject', () => {
    // CaseEntity is { type, id, fields: Record<name, value> } — fields are NESTED, not flat.
    const permit = { entities: [{ type: 'Invoice', id: 'i1', fields: { amountPaid: 5, totalDue: 5 } }] };
    const forbid = { entities: [{ type: 'Invoice', id: 'i1', fields: { amountPaid: 3, totalDue: 5 } }] };
    expect(evaluateCandidate(settleGuard, permit)).toBe('permit');
    expect(evaluateCandidate(settleGuard, forbid)).toBe('forbid');
  });
  it('candidateToQuint THROWS on a guard (never an always-property)', () => {
    expect(() => candidateToQuint(subscriptionsModel, settleGuard, 'q')).toThrow(/guard/i);
  });
  it('conjunctTier THROWS on a guard (guards are not classified)', () => {
    expect(() => conjunctTier(subscriptionsModel, settleGuard)).toThrow(/guard/i);
  });
});
```

- [ ] **Step 2: Run — FAIL** (`guard` not in the union; no cases). `cd lattice && npx vitest run test/engine/guard-candidate.test.ts`

- [ ] **Step 3: Implement.**
  - `src/ast/invariant.ts` — add to the `Candidate` union (after `sumOverCollection`):
    ```ts
      | { kind: 'guard'; aggregate: string; region: string; transition: string; predicate: Predicate };
    ```
  - `src/engine/evaluate.ts` `evaluateCandidate` — add a case (mirrors `statePredicate`'s subject loop):
    ```ts
    case 'guard':
      return subjects().every(e => evalPred(c.predicate, e, s)) ? 'permit' : 'forbid';
    ```
  - `src/emit/quint.ts` `candidateToQuint` — at the top (before the kind checks), add:
    ```ts
    if (c.kind === 'guard') throw new Error('candidateToQuint: a guard candidate is a transition enablement, not an always-property — conjoin it into its trans_ action, do not render it as a val');
    ```
  - `src/engine/tier.ts` `conjunctTier` — add a `guard` case to the `switch` that throws:
    ```ts
    case 'guard': throw new Error('conjunctTier: guards are transition enablements, never classified as invariants');
    ```

- [ ] **Step 4: Run — PASS.** Also `cd lattice && npx tsc --noEmit` (the new union member may surface non-exhaustive switches elsewhere — if `tsc` flags a switch that must handle `guard`, add a throwing `guard` case there too, per the §8.1 "loud exclusion" rule; do NOT add silent fall-through). Then full `npx vitest run` to confirm no existing behavior changed.

- [ ] **Step 5: Commit** `src/ast/invariant.ts`, `src/engine/evaluate.ts`, `src/emit/quint.ts`, `src/engine/tier.ts`, `test/engine/guard-candidate.test.ts`; message `feat(ast): guard Candidate kind — eval on pre-state, loud exclusion from always-property sites`.

---

## Task 2: Emit adopted guards as transition-guard assumptions

**Files:**
- Modify: `lattice/src/emit/quint.ts` (filter guards out of the adopted always-property conjunction; conjoin adopted guards into their `trans_` actions)
- Test: `lattice/test/emit/quint-guard-assumption.test.ts`

**Interfaces:**
- Consumes: `Candidate` `guard` kind (Task 1). `QuintQuery.adopted` (existing).
- Produces: when a `guard` candidate is present in `q.adopted`, `astToQuint` conjoins its `predicate` into the enablement of its `trans_<aggregate>_<transition>` action (alongside `t.requires`), and EXCLUDES it from the `adopted<i>` always-property conjunction. No adopted guards → byte-identical emission.

- [ ] **Step 1: Write the failing test** (`test/emit/quint-guard-assumption.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { astToQuint } from '../../src/emit/quint.js';
import { subscriptionsModel, paidImpliesExactConjunct } from '../fixtures.js';
import type { Candidate } from '../../src/ast/invariant.js';

const settleGuard: Candidate = { kind: 'guard', aggregate: 'Invoice', region: 'settlement', transition: 'settle',
  predicate: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } };
const q = (adopted: Candidate[]) => ({ kind: 'probe-permit' as const, hi: paidImpliesExactConjunct, exclusions: [], maxSteps: 1, adopted });

describe('adopted guard emission', () => {
  it('conjoins an adopted guard into its trans_ action, NOT the adopted always-property list', () => {
    const em = astToQuint(subscriptionsModel, q([settleGuard]));
    // the settle transition action carries the guard predicate as an extra enablement conjunct
    expect(em.source).toMatch(/action trans_Invoice_settle = \{[^}]*amountPaid[^}]*>=[^}]*totalDue/);
    // and the guard is NOT rendered as an `adopted<i>` always-property val
    expect(em.source).not.toMatch(/val adopted\d+ = .*amountPaid.*>=.*totalDue/);
  });
  it('no adopted guards → byte-identical to today', () => {
    const withArg = astToQuint(subscriptionsModel, q([]));
    const noArg = astToQuint(subscriptionsModel, { kind: 'probe-permit', hi: paidImpliesExactConjunct, exclusions: [], maxSteps: 1 });
    expect(withArg.source).toBe(noArg.source);
  });
});
```

- [ ] **Step 2: Run — FAIL** (guard is currently passed to `candidateToQuint` at `:400`, which now throws — so the first test errors, and the guard never reaches `trans_`). `cd lattice && npx vitest run test/emit/quint-guard-assumption.test.ts`

- [ ] **Step 3: Implement** in `src/emit/quint.ts`:
  - Split adopted into guards vs always-properties near the top of `astToQuint` (before the per-owner loop):
    ```ts
    const adoptedAll = q.adopted ?? [];
    const adoptedGuards = adoptedAll.filter((c): c is Extract<Candidate, { kind: 'guard' }> => c.kind === 'guard');
    const adoptedInvs = adoptedAll.filter(c => c.kind !== 'guard');
    ```
  - In the transition-rendering line (`:345`), append matching adopted guards to the enablement. Replace:
    ```ts
    const guard = t.requires ? `, ${predToQuint(m, t.requires, `${v}.get(id)`, o.name)}` : '';
    ```
    with:
    ```ts
    const gConds = [
      ...(t.requires ? [predToQuint(m, t.requires, `${v}.get(id)`, o.name)] : []),
      ...adoptedGuards.filter(g => g.aggregate === o.name && g.region === r.name && g.transition === t.name)
        .map(g => predToQuint(m, g.predicate, `${v}.get(id)`, o.name)),
    ];
    const guard = gConds.length ? `, ${gConds.join(', ')}` : '';
    ```
  - In the adopted always-property block (`:399-400`), use `adoptedInvs` instead of `q.adopted ?? []`:
    ```ts
    const adopted = adoptedInvs;
    adopted.forEach((c, i) => preds.push(candidateToQuint(m, c, `adopted${i}`)));
    ```
  (`predToQuint`, `varName` `v`, `o`, `r`, `t` are all in scope in the transition loop.)

- [ ] **Step 4: Run — PASS.** Then `cd lattice && npx tsc --noEmit && npx vitest run` (heed the load note; the byte-identical test is the golden-safety guard).

- [ ] **Step 5: Commit** `src/emit/quint.ts`, `test/emit/quint-guard-assumption.test.ts`; message `feat(emit): conjoin adopted guards into their trans_ actions (assumption); exclude from always-property list`.

---

## Task 3: Strengthening engine, part 1 — CTI→transition trace-diff + shape-lattice generation (pure)

**Files:**
- Create: `lattice/src/engine/strengthen.ts`
- Test: `lattice/test/engine/strengthen.test.ts`

**Interfaces:**
- Consumes: `DomainModel`, `AggregateDef`; `Candidate`/`CandidateInvariant`/`Predicate`/`Cmp` (`invariant.ts`); `CaseState`/`CaseEntity` (`evaluate.ts`).
- Produces:
  ```ts
  export interface GuardSiteRef { owner: string; region: string; transition: string }
  // Diff the CTI's last trace step against the violating state; the region-state change identifies the
  // transition to guard. Returns null when no region moved (accrual-only step → no-transition).
  export function ctiTransition(m: DomainModel, violated: CandidateInvariant, w: CaseState): GuardSiteRef | null;
  // The {eq,le,ge} shape lattice over the violated invariant's own-field cmp operand pair, each a
  // `guard` candidate scoped to `site`. Empty if the invariant body has no extractable own-field cmp.
  export function guardVariants(site: GuardSiteRef, violated: CandidateInvariant): Extract<Candidate, { kind: 'guard' }>[];
  ```

- [ ] **Step 1: Write the failing tests** (`test/engine/strengthen.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { ctiTransition, guardVariants } from '../../src/engine/strengthen.js';
import { subscriptionsModel } from '../fixtures.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

// Invoice invariant conditioning on `paid`: paid ⇒ amountPaid == totalDue (body is the cmp for lattice extraction).
const paidExact: CandidateInvariant = { id: 'x', name: 'paidExact', prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Invoice',
    where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
    body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } } };

// CaseEntity = { type, id, fields: {...} }; region state is keyed '<region>.state' (evaluate.ts:52).
const inv = (settlement: string, paid: number, due: number) => ({ type: 'Invoice', id: 'i1', fields: { 'settlement.state': settlement, amountPaid: paid, totalDue: due } });
describe('ctiTransition', () => {
  it('maps a region-state change in the last step to the entering transition', () => {
    const w = { entities: [inv('paid', 3, 5)], trace: [[inv('open', 3, 5)]] };
    // open → paid in region settlement ⇒ the `settle` transition.
    expect(ctiTransition(subscriptionsModel, paidExact, w)).toEqual({ owner: 'Invoice', region: 'settlement', transition: 'settle' });
  });
  it('returns null when only fields changed (accrual step, no region moved)', () => {
    const w = { entities: [inv('open', 9, 5)], trace: [[inv('open', 3, 5)]] };
    expect(ctiTransition(subscriptionsModel, paidExact, w)).toBeNull();
  });
  it('returns null when the trace is empty (violation at init)', () => {
    expect(ctiTransition(subscriptionsModel, paidExact, { entities: [inv('open', 9, 5)] })).toBeNull();
  });
});

describe('guardVariants', () => {
  it('generates the {eq,le,ge} lattice over the invariant cmp operand pair', () => {
    const site = { owner: 'Invoice', region: 'settlement', transition: 'settle' };
    const vs = guardVariants(site, paidExact);
    expect(vs.map(v => v.predicate.op).sort()).toEqual(['eq', 'ge', 'le']);
    expect(vs.every(v => v.kind === 'guard' && v.transition === 'settle' && v.aggregate === 'Invoice')).toBe(true);
    // operands preserved (amountPaid vs totalDue)
    expect(vs[0].predicate).toMatchObject({ left: { path: ['amountPaid'] }, right: { path: ['totalDue'] } });
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing). `cd lattice && npx vitest run test/engine/strengthen.test.ts`

- [ ] **Step 3: Implement `src/engine/strengthen.ts`:**

```ts
import type { AggregateDef, DomainModel } from '../ast/domain.js';
import type { Candidate, CandidateInvariant, Cmp, Predicate } from '../ast/invariant.js';
import type { CaseEntity, CaseState } from './evaluate.js';
import { evaluateCandidate } from './evaluate.js';

export interface GuardSiteRef { owner: string; region: string; transition: string }

// Pull the single own-field cmp the invariant is "about": a bare statePredicate body that is a cmp,
// or the consequent of an `implies`/the body when `where` gates it. Returns null if there's no clean
// own-field cmp (both operands must be `field` terms on `self`).
function invariantCmp(inv: CandidateInvariant): (Predicate & { kind: 'cmp' }) | null {
  const c = inv.candidate;
  if (c.kind !== 'statePredicate') return null;
  const pick = (p: Predicate): (Predicate & { kind: 'cmp' }) | null =>
    p.kind === 'cmp' ? p : p.kind === 'implies' ? pick(p.right) : null;
  const cm = pick(c.body);
  if (!cm) return null;
  const ownField = (t: any) => t?.kind === 'field' && t.owner === 'self';
  return ownField(cm.left) && ownField(cm.right) ? cm : null;
}

export function ctiTransition(m: DomainModel, violated: CandidateInvariant, w: CaseState): GuardSiteRef | null {
  const agg = (violated.candidate as any).aggregate as string;
  if (!w.trace || w.trace.length === 0) return null;                 // violation at init → no transition
  const prev = w.trace[w.trace.length - 1];                          // state just before the violating one
  // the violating instance: the aggregate subject where the invariant is forbidden in the final state
  const bad = w.entities.find(e => e.type === agg &&
    evaluateCandidate(violated.candidate, { entities: [e] }) === 'forbid');
  if (!bad) return null;
  const before = prev.find(e => e.type === agg && e.id === bad.id);
  if (!before) return null;
  const machine = (m.aggregates as AggregateDef[]).find(a => a.name === agg)?.machine;
  if (!machine) return null;
  for (const r of machine.regions) {
    const key = `${r.name}.state`;                                    // CaseEntity fields key (evaluate.ts:52)
    const from = before.fields[key], to = bad.fields[key];
    if (from !== undefined && to !== undefined && from !== to) {      // a region moved this step
      const t = machine.transitions.find(tr => tr.region === r.name && tr.from.includes(String(from)) && tr.to === String(to));
      if (t) return { owner: agg, region: r.name, transition: t.name };
    }
  }
  return null;                                                        // only fields changed → accrual step
}

export function guardVariants(site: GuardSiteRef, violated: CandidateInvariant): Extract<Candidate, { kind: 'guard' }>[] {
  const cm = invariantCmp(violated);
  if (!cm) return [];
  const ops: Cmp[] = ['eq', 'le', 'ge'];
  return ops.map(op => ({ kind: 'guard', aggregate: site.owner, region: site.region, transition: site.transition,
    predicate: { kind: 'cmp', op, left: cm.left, right: cm.right } }));
}
```

- [ ] **Step 4: Run — PASS. Step 5: tsc + commit** (`src/engine/strengthen.ts`, `test/engine/strengthen.test.ts`); message `feat(engine): strengthen part 1 — CTI→transition trace-diff + shape-lattice generation`.

---

## Task 4: Strengthening engine, part 2 — auto-prune + resolve (real quint)

**Files:**
- Modify: `lattice/src/engine/strengthen.ts` (add `strengthenInvariant` + `Resolution`)
- Test: `lattice/test/engine/strengthen.integration.test.ts`

**Interfaces:**
- Consumes: `ctiTransition`/`guardVariants` (Task 3); `astToQuintClassify` (`src/emit/quint-classify.js`); `astToQuint` (`src/emit/quint.js`); `SolverDeps` (`./planner.js`); adopted-guard emission (Task 2).
- Produces:
  ```ts
  export type Resolution =
    | { kind: 'auto-adopt'; guard: Extract<Candidate, { kind: 'guard' }> }
    | { kind: 'inconsistent'; note: string }
    | { kind: 'distinguish'; survivors: Extract<Candidate, { kind: 'guard' }>[] }
    | { kind: 'no-transition'; note: string };
  export function strengthenInvariant(
    m: DomainModel, violated: CandidateInvariant, adopted: Candidate[], deps: SolverDeps, reachSteps?: number,
  ): Promise<Resolution>;
  ```

- [ ] **Step 1: Write the failing integration test** (`test/engine/strengthen.integration.test.ts` — real quint, small fixtures):

```ts
import { describe, it, expect } from 'vitest';
import { strengthenInvariant } from '../../src/engine/strengthen.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel } from '../fixtures.js';
import type { CandidateInvariant, Candidate } from '../../src/ast/invariant.js';

// The §8.2 payoff, on the committed model. `paidExact` (paid ⇒ amountPaid==totalDue) is violated under
// abstract accrual (settle reached with amountPaid≠totalDue if settle were unguarded). With the adopted
// `neverOverpaid` (amountPaid<=totalDue) as a peer, only `==` survives → auto-adopt.
const paidExact: CandidateInvariant = { id: 'pe', name: 'paidExact', prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Invoice',
    where: { kind: 'inState', owner: 'self', region: 'settlement', states: ['paid'] },
    body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } } };

describe('strengthenInvariant (integration, real quint)', () => {
  it('overpayment boundary → one surviving guard → auto-adopt (==)', async () => {
    const neverOverpaid: Candidate = { kind: 'statePredicate', aggregate: 'Invoice',
      body: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['amountPaid'] }, right: { kind: 'field', owner: 'self', path: ['totalDue'] } } };
    const res = await strengthenInvariant(subscriptionsModel, paidExact, [neverOverpaid], realDeps, 6);
    expect(res.kind).toBe('auto-adopt');
    if (res.kind === 'auto-adopt') {
      expect(res.guard.transition).toBe('settle');
      expect(res.guard.predicate.op).toBe('eq');
    }
  }, 120_000);
});
```

Note to implementer: if `paidExact` is NOT `violated` on the *committed* `subscriptionsModel` (because the authored `settle` guard already forces it), construct the probe against a model variant with `settle`'s `requires` removed — the strengthening RE-DERIVES that guard. The engine itself must take the model as given; the test sets up a genuinely-violated invariant. Verify the actual verdict with a scratch `classifyInvariant` call and adjust the fixture (remove `settle.requires`) so the invariant is really violated before strengthening runs. Do NOT assert-to-match a wrong result; make the setup produce a real CTI.

- [ ] **Step 2: Run — FAIL** (`strengthenInvariant` missing).

- [ ] **Step 3: Implement** in `src/engine/strengthen.ts` (append):

```ts
import { astToQuintClassify } from '../emit/quint-classify.js';
import { astToQuint } from '../emit/quint.js';
import type { SolverDeps } from './planner.js';

export type Resolution =
  | { kind: 'auto-adopt'; guard: Extract<Candidate, { kind: 'guard' }> }
  | { kind: 'inconsistent'; note: string }
  | { kind: 'distinguish'; survivors: Extract<Candidate, { kind: 'guard' }>[] }
  | { kind: 'no-transition'; note: string };

export async function strengthenInvariant(
  m: DomainModel, violated: CandidateInvariant, adopted: Candidate[], deps: SolverDeps, reachSteps = 6,
): Promise<Resolution> {
  const peers = adopted.filter(c => c.kind !== 'guard');
  // 1. Obtain the CTI (reachability from real init) with its trace.
  const rEm = astToQuintClassify(m, { invariant: violated.candidate, peers, probe: 'entailment', maxSteps: reachSteps });
  const reach = await deps.quintVerify(rEm, { init: 'init', invariant: 'q_peersImpliesI', maxSteps: reachSteps });
  if (!reach.violated || !reach.witness) return { kind: 'no-transition', note: 'invariant not violated (nothing to strengthen)' };
  const site = ctiTransition(m, violated, reach.witness);
  if (!site) return { kind: 'no-transition', note: 'CTI reached via accrual with no declared transition — confirm intended (design §10)' };

  // 2. Generate the shape lattice for the identified transition.
  let variants = guardVariants(site, violated);
  if (!variants.length) return { kind: 'no-transition', note: 'no own-field cmp to shape a guard from' };

  // 3a. Consistency: drop variants with no model when conjoined with the adopted spec.
  const consistent: typeof variants = [];
  for (const g of variants) {
    // a bare `probe-permit` for any witness of the guarded machine; violated:true ⇒ a state exists.
    const em = astToQuint(m, { kind: 'probe-permit', hi: violated.candidate, exclusions: [], maxSteps: 1, adopted: [...adopted, g] });
    const r = await deps.quintVerify(em, { init: 'init', invariant: 'q_inv', maxSteps: 1 });
    if (r.violated) consistent.push(g);                              // a reachable state exists ⇒ guard is satisfiable with the spec
  }
  if (!consistent.length) return { kind: 'inconsistent', note: `no ${site.transition} guard variant is consistent with the adopted spec` };

  // 3b. Closes the CTI: keep variants under which the invariant is no longer violated.
  const closers: typeof variants = [];
  for (const g of consistent) {
    const em = astToQuintClassify(m, { invariant: violated.candidate, peers: [...peers, g], probe: 'entailment', maxSteps: reachSteps });
    const r = await deps.quintVerify(em, { init: 'init', invariant: 'q_peersImpliesI', maxSteps: reachSteps });
    if (!r.violated) closers.push(g);                                // ¬I no longer reachable ⇒ the guard closes it
  }
  if (!closers.length) return { kind: 'inconsistent', note: `no consistent ${site.transition} guard variant closes the CTI` };

  // 3c. Equivalence: collapse variants that no reachable state separates.
  const survivors: typeof variants = [];
  for (const g of closers) {
    let dup = false;
    for (const s of survivors) if (!(await separates(m, s, g, adopted, deps))) { dup = true; break; }
    if (!dup) survivors.push(g);
  }

  // 4. Resolve.
  if (survivors.length === 1) return { kind: 'auto-adopt', guard: survivors[0] };
  return { kind: 'distinguish', survivors };
}

// Two guards separate if some reachable state satisfies one guard-predicate but not the other.
async function separates(
  m: DomainModel, a: Extract<Candidate, { kind: 'guard' }>, b: Extract<Candidate, { kind: 'guard' }>,
  adopted: Candidate[], deps: SolverDeps,
): Promise<boolean> {
  // probe-permit for a state where a.predicate xor b.predicate holds, conjoined with the adopted spec.
  const xor: CandidateInvariant['candidate'] = { kind: 'statePredicate', aggregate: a.aggregate,
    body: { kind: 'not', arg: { kind: 'implies', left: a.predicate, right: b.predicate } } };  // a and not b
  const em = astToQuint(m, { kind: 'probe-permit', hi: xor, exclusions: [], maxSteps: 6, adopted });
  const r = await deps.quintVerify(em, { init: 'init', invariant: 'q_inv', maxSteps: 6 });
  return r.violated;   // a separating reachable state exists
}
```

Note to implementer: `probe-permit`'s emitted invariant name is `q_inv` (see `astToQuint`, the `preds.push(`val q_inv = …`)` line and how `runQuint`/callers name it). Confirm the exact invariant name the `probe-permit` machine exposes by reading `astToQuint`'s tail and how existing `probe-permit` callers (`planner.ts` `solve`) invoke `deps.quintVerify` — use that name in the three probes above. If `probe-permit` semantics make "a witness exists ⇒ violated:true", the consistency/separation checks read a violation as "state found"; verify this against `planner.ts`'s existing probe usage and adjust the boolean sense if needed. This is the one place to validate against the real prober before trusting the pruning.

- [ ] **Step 4: Run the integration test to completion (real quint).** Confirm the `auto-adopt (==)` resolution. If the probe boolean sense is inverted (consistency/separation), fix the sense per the real prober's semantics (verified in Step 3's note) — never assert-to-match. `cd lattice && npx vitest run test/engine/strengthen.integration.test.ts`

- [ ] **Step 5: Full check + commit.** `cd lattice && npx tsc --noEmit && npx vitest run`. Commit `src/engine/strengthen.ts`, `test/engine/strengthen.integration.test.ts`; message `feat(engine): strengthenInvariant — auto-prune (consistency/closes-CTI/equivalence) + resolve (real quint)`.

---

## Task 5: `strengthen` CLI command + write-back into `requires`

**Files:**
- Modify: `lattice/src/cli.ts` (`strengthen` command), `lattice/src/emit/code.ts` (conjoin adopted guards into transition `requires`)
- Test: `lattice/test/cli-strengthen.test.ts`, `lattice/test/emit/code-guard-writeback.test.ts`

**Interfaces:**
- Consumes: `strengthenInvariant`/`Resolution` (Task 4). `astToCode(m, adopted)` (existing).
- Produces: `engine strengthen --name <invariant>` runs the engine and applies the `Resolution` (auto-adopt → push guard candidate + `adopted` ledger entry with `pinnedBy`; inconsistent/no-transition → a finding in the output; distinguish → return `survivors` + separating witnesses). `astToCode` renders an adopted guard into its transition's `requires`.

- [ ] **Step 1: Write failing tests.**
  - `test/cli-strengthen.test.ts`: init a session on a model whose `--name` invariant is violated (remove the authored `settle.requires` variant, as in Task 4); run `strengthen --name paidExact` with a STUB `deps` whose `quintVerify` returns the scripted results that drive the engine to `auto-adopt` (reachability violated + trace; consistency/closes as needed; single survivor). Assert the command output reports `{ strengthened: { kind: 'auto-adopt', guard: { transition: 'settle', … } } }` and that the guard was adopted (a `guard` candidate now in `s.candidates` with `status:'adopted'` and an `adopted` ledger entry). Model the stub on the existing `cli-classify.test.ts` `scriptedDeps`.
  - `test/emit/code-guard-writeback.test.ts`: `astToCode(subscriptionsModel, [{ id, name, prior, source, candidate: <settle == guard> }])` renders the `settle` transition line containing `requires` with the guard predicate (conjoined with any authored `requires`). Assert the emitted `.lat` text includes `transition settle {` … `requires` … `amountPaid == totalDue`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - `src/cli.ts` — add `case 'strengthen'` (requires `--name`; mirror the `classify --name` not-found guard). Resolve the named adopted/violated invariant, call `strengthenInvariant(model(), inv, adoptedConstraints(s), deps, reachSteps)`, then:
    - `auto-adopt` → build a `CandidateInvariant` wrapping `res.guard` (`{ id: <fresh>, name: <derived e.g. `guard_${transition}_${op}`>, prior: 1, source: 'regen', candidate: res.guard }`), `s.candidates.push({ inv, status: 'adopted' })`, `appendLedger(dir, { kind: 'adopted', at: now(), invariant: inv, provenance: `strengthen ${isoDay(now())}` })`; return `done({ strengthened: res })`.
    - `inconsistent` / `no-transition` → `return { strengthened: res }` (a finding; non-blocking).
    - `distinguish` → `return { strengthened: res }` (survivors surfaced; the planner distinguish integration is Task 6/deferred).
    Add `import { strengthenInvariant } from './engine/strengthen.js'` and register `strengthen` in the command arg-validation switch (`--name` required) and `MODEL_COMMANDS`.
  - `src/emit/code.ts` — change `astToCode(m, adopted)` so the transition rendering (`:78-79`) conjoins adopted guards. Before the region loop, build `const guardsByTransition = new Map<string, Predicate[]>()` from `adopted.filter(i => i.candidate.kind === 'guard')` keyed by `` `${g.aggregate}.${g.region}.${g.transition}` ``. In the transition line, compute the effective requires = authored `t.requires` (if any) AND-joined with the adopted guard predicates for `` `${agg}.${r.name}.${t.name}` ``, and render `; requires <predToText(effective)>` when non-empty. (Use the existing `predToText`; combine multiple predicates with `{ kind:'and', args:[...] }`.)

- [ ] **Step 4: Run — PASS.** `cd lattice && npx vitest run test/cli-strengthen.test.ts test/emit/code-guard-writeback.test.ts`

- [ ] **Step 5: Full check + commit.** `cd lattice && npx tsc --noEmit && npx vitest run`. Commit `src/cli.ts`, `src/emit/code.ts`, the two test files; message `feat(cli): strengthen command + adopted-guard write-back into requires`.

---

## Task 6: Interactive-loop hook + masking/quieting coverage

**Files:**
- Modify: `lattice/src/cli.ts` (invoke strengthening on `violated` verdicts in the classify/apply path; adopting a guard triggers reclassify)
- Test: `lattice/test/cli-strengthen.test.ts` (extend), `lattice/test/engine/strengthen-masking.integration.test.ts`

**Interfaces:**
- Consumes: `strengthenInvariant`/`Resolution` (Task 4); `classifyOnApply`/`classifyAdopted` (existing §7.2).
- Produces: when `classify` (or the apply-time classify) yields a `violated` verdict for an adopted invariant, it auto-invokes `strengthenInvariant`; an `auto-adopt` is applied silently (guard adopted + ledger + `pinnedBy`) and the newly-adopted guard triggers a reclassify pass over affected invariants (masking coverage §8.4). The `strengthen` output/`status` surfaces auto-adopted guards.

- [ ] **Step 1: Write failing tests.**
  - Extend `test/cli-strengthen.test.ts`: run `classify` (bulk) on a session with a violated invariant (stub `deps` scripted to a single-survivor strengthening); assert the classify output includes an `autoStrengthened` section naming the adopted guard, and the guard is now adopted in the session.
  - `test/engine/strengthen-masking.integration.test.ts` (real quint OR scripted): after adopting a guard that forces an invariant, a reclassify of that invariant returns `entailed` with the guard's candidate id in `pinnedBy` — the §8.4 masking coverage. (If real quint is too slow, assert the wiring: the reclassify pass is invoked over the affected invariant after guard adoption, using a scripted `deps` returning `entailed`.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `src/cli.ts`:
  - In the `classify` bulk path, after computing `results`, for each `violated` result auto-invoke `strengthenInvariant(model(), <the invariant>, adoptedConstraints(s), deps, reachSteps)`; collect `auto-adopt` outcomes, apply them (adopt guard + ledger, as Task 5), and after adopting, run `classifyOnApply`/`classifyAdopted` over the affected invariants so a masked invariant reclassifies (`pinnedBy` the guard). Return an `autoStrengthened` array (the adopted guards) alongside `classified`/`guardFindings`. Gate this to bulk classify (`!values.name`), consistent with the guard-analysis gating (Pillar B) — keep `--name` fast.
  - Keep it non-blocking: `inconsistent`/`no-transition`/`distinguish` outcomes are collected into the `autoStrengthened`/a findings array, never thrown.

- [ ] **Step 4: Run — PASS.** `cd lattice && npx vitest run test/cli-strengthen.test.ts test/engine/strengthen-masking.integration.test.ts`

- [ ] **Step 5: Full check + commit.** `cd lattice && npx tsc --noEmit && npx vitest run` (heed the load note). Commit `src/cli.ts`, the two test files; message `feat(cli): interactive strengthening hook on violated verdicts + masking reclassify (Pillar C)`.

---

## Final whole-branch review (after Task 6)

Integrated review over the Pillar C diff (base = pre-Task-1, head = last Task-6 commit): confirm goldens byte-identical (no adopted guards → unchanged emission; the Task-2 byte-identical test); the `guard` kind is excluded loudly from every always-property site (candidateToQuint/tier/salient — no silent fall-through); the trace-diff CTI→transition mapping is sound and the accrual-only case yields `no-transition` (never a fabricated guard); the three pruning queries have the correct boolean sense against the real prober; write-back produces valid round-trippable `.lat`; the interactive hook is gated to bulk classify and is non-blocking; auto-adoption is always ledger-noted (`pinnedBy`) and reversible. Carry forward the still-open follow-up tickets (Plan 2b + Pillar B: guard-change staleness warning, implied-invariant auto-classify, methodGuards persist+status, apply-path latency watch, guard-finding staleness, explain-by-state) and any Pillar C minors.

## Self-Review

**Spec coverage:** Task 1 = §8.1 (guard kind + loud exclusions); Task 2 = §8.3/§8.1 emission-as-assumption; Task 3 = §8.5 steps 1–2 (trace-diff + shape lattice); Task 4 = §8.5 steps 3–4 (prune + resolve); Task 5 = §8.6 (command + write-back); Task 6 = §8.6 interactive hook + §8.7 masking/quieting. §10 honest-ceiling items (own-field-only, bounded-N, accrual → no-transition, ledger-noted) are enforced by the engine's `no-transition` path + `pinnedBy` adoption.

**Placeholder scan:** Every code step carries complete code. Two implementer-verification notes (the `probe-permit` invariant name / boolean sense in Task 4; the violated-fixture setup in Task 4/5) are flagged with the exact procedure to resolve them against the real prober — not "TBD". These are genuine "confirm against the live solver" checkpoints, appropriate for the one place the design meets real Apalache semantics.

**Type consistency:** `GuardSiteRef` (Task 3) → `guardVariants` → `strengthenInvariant` (Task 4); `Resolution` (Task 4) consumed by the `strengthen` command + hook (Tasks 5–6); the `guard` Candidate shape (`{kind:'guard';aggregate;region;transition;predicate}`, Task 1) is used identically in emission (Task 2), generation (Task 3), and write-back (Task 5). `deps.quintVerify(em, { init:'init', invariant, maxSteps })` matches `SolverDeps` and Pillar A/B usage throughout.
