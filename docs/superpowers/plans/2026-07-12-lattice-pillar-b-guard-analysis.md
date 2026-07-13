# Lattice Pillar B — Guard Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect two guard-related model smells — reachable **stuck states** (a non-terminal state whose every out-transition is guarded-false) and **unreachable guarded states** (a dead transition / over-strong guard) — as non-blocking findings surfaced by `classify`, counted in `status`, and persisted to the ledger.

**Architecture:** A **hybrid** strategy (design §7.3): a pure structural pre-filter disposes of the easy majority with zero solver calls, and a thin emitter twin `astToQuintGuard` turns each residual state into a reachability probe over the **abstract-evolution** machine (the same one Pillar A's classifier runs on), reusing the existing `runQuintVerify` adapter. Findings persist to a new `guard-finding` ledger entry.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), Vitest, Quint 0.26.0 / Apalache 0.47.2.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run`. **Real solvers, no simulated validation** — each finding asserted in an integration test must come from a real `quint verify` via `runQuintVerify`.
- After a fresh checkout: `npx langium generate` + `npm install`. (This worktree already has both from earlier this session — do NOT re-run unless a build error says the parser is missing.)
- **Goldens A–D are byte-identical.** Pillar B adds a NEW emitter twin (`astToQuintGuard`) and a NEW engine module; it does not change `astToQuint`'s output for any existing caller. Do not touch `evaluate.ts` or generation `differential.test.ts`.
- Never `git add -A` — add only the files each task names.
- **Load note (this session/environment):** `golden/trace-b.test.ts`'s *median-latency* assertion is a known load-induced flake (design honest-ceiling; ledger note). A lone `golden-trace-b` *latency* failure is environmental, not a regression — report it but do not treat it as blocking, and never "fix" it by weakening a latency budget. Any OTHER failure is real.
- **Findings are never hard errors** (design §7.3, fork 6). `@terminal` stuck states are silent. Reachability findings carry the bounded-`N` honest-ceiling caveat (design §10).
- Design of record: `docs/superpowers/specs/2026-07-09-lattice-inference-slice-design.md` §7.3 (guard analysis), §7.3.3 (machine choice), §10 (honest ceiling).

## Landed foundation (verified 2026-07-12)

- **AST** (`src/ast/domain.ts`): `TransitionDef { name; region; from: string[]; to: string; requires?: Predicate }`; `Machine { regions: Region[]; transitions: TransitionDef[] }`; `Region { name; initial; states: StateDef[] }`; `StateDef { name; tags?: string[] }` (terminal via `tags?.includes('terminal')`); `AggregateDef.machine?: Machine`. `owners(m)` (`src/emit/quint.ts:36`) = `[...m.aggregates, ...m.entities]`; only aggregates carry a `machine`.
- **Emitter** (`src/emit/quint.ts`): `varName(n)` (`:27`) = lowercase-first + `'s'`; `owners` (`:36`); `buildOwnerInit` (`:183`); `candidateToQuint` (`:223`, exported); `astToQuint(m, q)` (`:308`) emits `action init = {…}` (real fixed init) and `action step = any {…}` and, when `q.abstractEvolution`, the `evolve_*` actions. The per-transition guard is rendered by `predToQuint(m, t.requires, `${varName(o.name)}.get(id)`, o.name)` (`:152`, currently **not exported** — Task 2 exports it). `isEvolvingField` (`:34`) etc. already gate evolution to non-`const` `Int`/`Money`.
- **Classifier twin pattern** (`src/emit/quint-classify.ts`): `astToQuintClassify` builds its machine by calling `astToQuint(m, {kind:'probe-permit', hi:…, exclusions:[], maxSteps:…, abstractEvolution:true})`, string-slicing the `head` (module through the `\n  action step = any {` line), appending `val` definitions, and returning `{ source, invariantName, varTypes }`. Task 2's `astToQuintGuard` mirrors this exactly.
- **Solver** (`src/solvers/quint-adapter.ts:70`): `runQuintVerify(em: QuintEmission, opts, exec?)`. `SolverDeps.quintVerify(em, { init?: string; invariant?: string; maxSteps: number })` (`src/engine/planner.ts:18`) returns `QuintResult { violated: boolean; witness?: CaseState; … }`. Pillar A calls it as `deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps })` (`src/engine/classify.ts:40`).
- **Ledger** (`src/engine/session.ts`): `LedgerEntry` is an append-only union; `appendLedger(dir, e)` (`:54`); `readLedger(dir)` (`:58`); `readClassifications(dir)` (`:62`) is the per-kind reader pattern. The `classified` entry (`:29-32`) is the template for the new `guard-finding` entry.
- **CLI** (`src/cli.ts`): the `classify` command (case at `:487`) filters `classifiable`, appends `classified` entries, then computes `methodGuards = await checkAllMethodGuards(model(), deps)` and returns `{ classified, skipped, methodGuards }` (`:525-534`); it already parses `--max-steps` into `reachSteps` (`:509-513`, default undefined → `classifyInvariant`'s `reachSteps=6`). The `status` command (case at `:359`) reads `readClassifications(dir)`, dedups latest-per-key, and returns a `classifications` count object (`:365-374`).
- **Reachability bound:** Pillar A uses `reachSteps` default `6`. Pillar B reuses the same default and the same `--max-steps` flag.

## Worked examples this plan must reproduce (design §7.3)

- **Committed `subscriptions` spec → clean.** Every non-terminal state has an unguarded escape (`trialing`: `expireTrial`/`cancel`; `active`: `paymentFailed`/`cancel`; `pastDue`: `recover`/`cancel`/`dunningExhausted`; `draft`: `voidDraft`; `open`: `voidOpen`/`writeOff`), so `stuckCandidates` is **empty** (zero solver calls). Its reachability residual is `{active, pastDue}` (Subscription) + `{open, paid, uncollectible}` (Invoice); under the abstract-evolution machine every one is reachable (`paidInvoiceCount` accrues to ≥1; the `@total`/`@balance` Money fields accrue to satisfy `finalize`/`settle`), so **no findings**. This is the honest "well-formed model" result.
- **A stuck residual** (small fixture): a reachable non-terminal state whose only exit is a guard unsatisfiable even under accrual → a `stuck` finding with the blocking-valuation witness.
- **An unreachable guarded state** (small fixture): a state gated behind an unsatisfiable guard → an `unreachable` finding.

---

## Task 1: Structural pre-filter (pure functions, no solver)

**Files:**
- Create: `lattice/src/engine/guard-structure.ts`
- Test: `lattice/test/engine/guard-structure.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GuardSite { owner: string; region: string; state: string }
  // Non-terminal states whose EVERY out-transition is guarded (has `requires`), including states
  // with zero out-transitions. These are the only states a stuck-probe need run on.
  export function stuckCandidates(m: DomainModel): GuardSite[];
  // States NOT reachable from the region's `initial` via UNGUARDED transitions alone (BFS over
  // transitions with no `requires`). These are the only states a reachability-probe need run on.
  export function reachabilityResidual(m: DomainModel): GuardSite[];
  ```
- Consumes: `DomainModel`, `AggregateDef`, `Machine`, `TransitionDef`, `Region`, `StateDef` from `../ast/domain.js`.

- [ ] **Step 1: Write the failing tests.** Add `lattice/test/engine/guard-structure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stuckCandidates, reachabilityResidual } from '../../src/engine/guard-structure.js';
import { subscriptionsModel } from '../fixtures.js';
import type { DomainModel } from '../../src/ast/domain.js';

// Tiny model: region s, initial=a (non-terminal), only exit `go` is guarded → a is a stuck candidate;
// b is reached only via the guarded `go` → b is in the reachability residual.
const guardedOnlyModel: DomainModel = {
  aggregates: [{
    kind: 'aggregate', name: 'W',
    fields: [{ name: 'wId', type: { kind: 'prim', prim: 'Id' }, key: true },
             { name: 'n', type: { kind: 'prim', prim: 'Int' } }],
    machine: {
      regions: [{ name: 's', initial: 'a', states: [{ name: 'a' }, { name: 'b', tags: ['terminal'] }] }],
      transitions: [{ name: 'go', region: 's', from: ['a'], to: 'b',
        requires: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['n'] }, right: { kind: 'int', value: 1 } } }],
    },
  }],
  entities: [], enums: [], values: [], events: [], services: [], context: 'T',
} as unknown as DomainModel;

describe('stuckCandidates', () => {
  it('committed subscriptions model has NO stuck candidates (every non-terminal state has an unguarded escape)', () => {
    expect(stuckCandidates(subscriptionsModel)).toEqual([]);
  });
  it('flags a non-terminal state whose only out-transition is guarded', () => {
    expect(stuckCandidates(guardedOnlyModel)).toEqual([{ owner: 'W', region: 's', state: 'a' }]);
  });
  it('does NOT flag a terminal state with no out-transitions', () => {
    // `b` is terminal-tagged in guardedOnlyModel — never a stuck candidate.
    expect(stuckCandidates(guardedOnlyModel).some(s => s.state === 'b')).toBe(false);
  });
});

describe('reachabilityResidual', () => {
  it('subscriptions residual is exactly the guard-gated states', () => {
    const res = reachabilityResidual(subscriptionsModel).map(s => `${s.owner}.${s.state}`).sort();
    expect(res).toEqual(['Invoice.open', 'Invoice.paid', 'Invoice.uncollectible', 'Subscription.active', 'Subscription.pastDue'].sort());
  });
  it('a state reached only via a guarded transition is in the residual', () => {
    expect(reachabilityResidual(guardedOnlyModel)).toEqual([{ owner: 'W', region: 's', state: 'b' }]);
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing). `cd lattice && npx vitest run test/engine/guard-structure.test.ts`

- [ ] **Step 3: Implement `src/engine/guard-structure.ts`:**

```ts
import type { AggregateDef, DomainModel, TransitionDef } from '../ast/domain.js';

export interface GuardSite { owner: string; region: string; state: string }

const isTerminal = (states: { name: string; tags?: string[] }[], state: string): boolean =>
  !!states.find(s => s.name === state)?.tags?.includes('terminal');

/** Non-terminal states whose EVERY out-transition (in the same region, with the state among its
 *  `from`) carries a `requires` guard — including states with zero out-transitions. A state with any
 *  UNGUARDED out-transition can always escape, so it is never stuck and is dropped here. */
export function stuckCandidates(m: DomainModel): GuardSite[] {
  const out: GuardSite[] = [];
  for (const a of m.aggregates as AggregateDef[]) {
    const machine = a.machine;
    if (!machine) continue;
    for (const r of machine.regions) {
      const trans = machine.transitions.filter(t => t.region === r.name);
      for (const st of r.states) {
        if (isTerminal(r.states, st.name)) continue;
        const outs = trans.filter(t => t.from.includes(st.name));
        const anyUnguarded = outs.some(t => !t.requires);
        if (!anyUnguarded) out.push({ owner: a.name, region: r.name, state: st.name });
      }
    }
  }
  return out;
}

/** States NOT reachable from the region's `initial` following UNGUARDED transitions only (a sound
 *  under-approximation of reachability: an unguarded transition can always fire). The residual is
 *  what the solver must actually probe. */
export function reachabilityResidual(m: DomainModel): GuardSite[] {
  const out: GuardSite[] = [];
  for (const a of m.aggregates as AggregateDef[]) {
    const machine = a.machine;
    if (!machine) continue;
    for (const r of machine.regions) {
      const unguarded = machine.transitions.filter((t: TransitionDef) => t.region === r.name && !t.requires);
      const reached = new Set<string>([r.initial]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of unguarded) {
          if (t.from.some(f => reached.has(f)) && !reached.has(t.to)) { reached.add(t.to); grew = true; }
        }
      }
      for (const st of r.states) if (!reached.has(st.name)) out.push({ owner: a.name, region: r.name, state: st.name });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — PASS.** `cd lattice && npx vitest run test/engine/guard-structure.test.ts`

- [ ] **Step 5: tsc + commit.** `cd lattice && npx tsc --noEmit`. Commit `src/engine/guard-structure.ts` + `test/engine/guard-structure.test.ts`; message `feat(engine): structural guard pre-filter (stuckCandidates + reachabilityResidual)`.

---

## Task 2: `astToQuintGuard` emitter twin

**Files:**
- Modify: `lattice/src/emit/quint.ts` (export `predToQuint`)
- Create: `lattice/src/emit/quint-guard.ts`
- Test: `lattice/test/emit/quint-guard.test.ts`

**Interfaces:**
- Consumes: `astToQuint`, `predToQuint`, `varName`, `owners`, `QuintEmission` from `./quint.js`; `GuardSite` from `../engine/guard-structure.js`; `DomainModel`, `AggregateDef` from `../ast/domain.js`.
- Produces:
  ```ts
  // kind:'stuck'  → invariant `q_not_stuck = not stuck`; a VIOLATION ⇒ a reachable stuck config
  //                 (the witness is the blocking valuation).
  // kind:'reach'  → invariant `q_not_reach = not reach`; a "holds" (no violation) ⇒ the state is
  //                 UNREACHABLE within maxSteps.
  export function astToQuintGuard(m: DomainModel, site: GuardSite, kind: 'stuck' | 'reach'): QuintEmission;
  ```

- [ ] **Step 1: Export `predToQuint`.** In `src/emit/quint.ts:152`, change `function predToQuint(` to `export function predToQuint(`.

- [ ] **Step 2: Write the failing test.** Add `lattice/test/emit/quint-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { astToQuintGuard } from '../../src/emit/quint-guard.js';
import { subscriptionsModel } from '../fixtures.js';

describe('astToQuintGuard', () => {
  it('stuck probe names q_not_stuck and negates the state predicate over the out-guards', () => {
    const em = astToQuintGuard(subscriptionsModel, { owner: 'Invoice', region: 'settlement', state: 'open' }, 'stuck');
    expect(em.invariantName).toBe('q_not_stuck');
    expect(em.source).toContain('val stuck =');
    expect(em.source).toContain('settlement_state == "open"');
    expect(em.source).toContain('val q_not_stuck = not stuck');
    // out-guard of `open` is settle's `amountPaid == totalDue`, negated inside `stuck`.
    expect(em.source).toMatch(/not\s*\(.*amountPaid.*==.*totalDue/);
    // reuses the base machine (abstract-evolution → evolve_ actions present) and real init.
    expect(em.source).toContain('action init =');
    expect(em.source).toContain('action evolve_Invoice_amountPaid');
  });
  it('reach probe names q_not_reach and asserts the bare state predicate', () => {
    const em = astToQuintGuard(subscriptionsModel, { owner: 'Subscription', region: 'status', state: 'active' }, 'reach');
    expect(em.invariantName).toBe('q_not_reach');
    expect(em.source).toContain('val reach =');
    expect(em.source).toContain('status_state == "active"');
    expect(em.source).toContain('val q_not_reach = not reach');
  });
});
```

- [ ] **Step 3: Run — FAIL** (module missing). `cd lattice && npx vitest run test/emit/quint-guard.test.ts`

- [ ] **Step 4: Implement `src/emit/quint-guard.ts`:**

```ts
import type { AggregateDef, DomainModel } from '../ast/domain.js';
import type { GuardSite } from '../engine/guard-structure.js';
import { astToQuint, owners, predToQuint, varName, type QuintEmission } from './quint.js';

/** A guard-analysis probe over the abstract-evolution machine (design §7.3.4). Mirrors
 *  astToQuintClassify: slice the base machine's head (module through the `step` line), append the
 *  stuck/reach `val`s, and name the negated predicate as the invariant. */
export function astToQuintGuard(m: DomainModel, site: GuardSite, kind: 'stuck' | 'reach'): QuintEmission {
  // Any candidate works as `hi` — we only reuse the machine, not q_inv. Use the first adopted-free
  // structural fact by picking a trivial always-true probe target: reuse the base with abstract
  // evolution on so numeric guards can be satisfied/blocked by accrual.
  const base = astToQuint(m, { kind: 'probe-permit', hi: TRUE_PROBE, exclusions: [], maxSteps: 1, abstractEvolution: true });
  const stepIdx = base.source.indexOf('\n  action step = any {');
  if (stepIdx < 0) throw new Error('astToQuintGuard: could not locate the `step` action in the base emission');
  const head = base.source.slice(0, base.source.indexOf('\n', stepIdx + 1));

  const o = owners(m).find(x => x.name === site.owner) as AggregateDef | undefined;
  if (!o) throw new Error(`astToQuintGuard: unknown owner ${site.owner}`);
  const v = varName(o.name);
  const IDS = `${o.name.toUpperCase()}_IDS`;
  const inState = `${v}.get(id).exists and ${v}.get(id).${site.region}_state == "${site.state}"`;

  let valLines: string; let invariantName: string;
  if (kind === 'reach') {
    valLines = [`val reach = ${IDS}.exists(id => ${inState})`, `val q_not_reach = not reach`].map(l => '  ' + l).join('\n');
    invariantName = 'q_not_reach';
  } else {
    const outs = (o.machine?.transitions ?? []).filter(t => t.region === site.region && t.from.includes(site.state));
    // every out-transition is guarded (Task 1 guarantees it for a stuck candidate); "stuck" =
    // in-state AND every out-guard false. Zero out-transitions → `true` conjunct (always stuck in S).
    const negGuards = outs.map(t => `not (${predToQuint(m, t.requires!, `${v}.get(id)`, o.name)})`);
    const stuckExpr = [inState, ...negGuards].join(' and ');
    valLines = [`val stuck = ${IDS}.exists(id => ${stuckExpr})`, `val q_not_stuck = not stuck`].map(l => '  ' + l).join('\n');
    invariantName = 'q_not_stuck';
  }
  const source = `${head}\n\n${valLines}\n}\n`;
  return { source, invariantName, varTypes: base.varTypes };
}
```

`TRUE_PROBE` — the base emission requires a `hi` candidate to build `q_inv`, but the guard twin never
references `q_inv`. Add, at the top of the file, a minimal always-expressible candidate to satisfy the
`astToQuint` contract without affecting the machine:

```ts
import type { Candidate } from '../ast/invariant.js';
// A statePredicate whose body is the vacuous `0 == 0` — expressible, never referenced by the guard
// invariant (we slice only the machine head), keeps astToQuint's q_inv construction happy.
const TRUE_PROBE: Candidate = { kind: 'statePredicate', aggregate: '', body:
  { kind: 'cmp', op: 'eq', left: { kind: 'int', value: 0 }, right: { kind: 'int', value: 0 } } } as Candidate;
```

If `astToQuint` rejects an empty `aggregate` on `TRUE_PROBE` (candidateToQuint may look it up), instead
pass the first real aggregate name: `aggregate: m.aggregates[0]?.name ?? ''`. Verify which by running
Step 5; adjust the `aggregate` value until the base emission succeeds. (The probe target is irrelevant
— only the sliced machine head is used.)

- [ ] **Step 5: Run — PASS.** `cd lattice && npx vitest run test/emit/quint-guard.test.ts`. If the base emission throws on `TRUE_PROBE`, apply the `aggregate` fix noted above and re-run.

- [ ] **Step 6: tsc + commit.** `cd lattice && npx tsc --noEmit`. Commit `src/emit/quint.ts`, `src/emit/quint-guard.ts`, `test/emit/quint-guard.test.ts`; message `feat(emit): astToQuintGuard — stuck/reachability probes over the abstract-evolution machine`.

---

## Task 3: `analyzeGuards` engine (orchestrate filter → solver) + real-quint integration

**Files:**
- Create: `lattice/src/engine/guard-analysis.ts`
- Test: `lattice/test/engine/guard-analysis.integration.test.ts`

**Interfaces:**
- Consumes: `stuckCandidates`, `reachabilityResidual`, `GuardSite` (Task 1); `astToQuintGuard` (Task 2); `SolverDeps` from `./planner.js`; `CaseState` from `./evaluate.js`.
- Produces:
  ```ts
  export interface GuardFinding {
    finding: 'stuck' | 'unreachable';
    owner: string; region: string; state: string;
    witness?: CaseState;   // stuck: the blocking-valuation trace; unreachable: none
    boundedN: number;      // reachability depth the result is relative to (honest-ceiling)
  }
  // Structural pre-filter → solver-confirm. For each stuck candidate, a VIOLATION of q_not_stuck ⇒
  // a `stuck` finding. For each reachability-residual state, a NON-violation (holds) of q_not_reach ⇒
  // an `unreachable` finding. Well-formed models return [].
  export function analyzeGuards(m: DomainModel, deps: SolverDeps, reachSteps?: number): Promise<GuardFinding[]>;
  ```

- [ ] **Step 1: Write the failing integration test.** Add `lattice/test/engine/guard-analysis.integration.test.ts` (real quint — small fixtures keep it fast):

```ts
import { describe, it, expect } from 'vitest';
import { analyzeGuards } from '../../src/engine/guard-analysis.js';
import { realDeps } from '../../src/cli.js';   // the real SolverDeps (quintVerify = runQuintVerify)
import type { DomainModel } from '../../src/ast/domain.js';

const mk = (transitions: any[], states: any[]): DomainModel => ({
  aggregates: [{ kind: 'aggregate', name: 'W',
    fields: [{ name: 'wId', type: { kind: 'prim', prim: 'Id' }, key: true },
             { name: 'n', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 's', initial: 'a', states }], transitions } }],
  entities: [], enums: [], values: [], events: [], services: [], context: 'T',
} as unknown as DomainModel);
const cmp = (l: any, op: string, r: any) => ({ kind: 'cmp', op, left: l, right: r });
const fld = (p: string) => ({ kind: 'field', owner: 'self', path: [p] });
const int = (value: number) => ({ kind: 'int', value });
const and = (...args: any[]) => ({ kind: 'and', args });

describe('analyzeGuards (integration, real quint)', () => {
  it('flags a reachable non-terminal state stuck behind an unsatisfiable guard', async () => {
    // `a` (initial, non-terminal) only exits via `go`, guarded by `n==1 and n==2` (unsatisfiable
    // even under accrual). `a` is reachable (initial) and can never escape → stuck.
    const model = mk(
      [{ name: 'go', region: 's', from: ['a'], to: 'b',
         requires: and(cmp(fld('n'), 'eq', int(1)), cmp(fld('n'), 'eq', int(2))) }],
      [{ name: 'a' }, { name: 'b', tags: ['terminal'] }]);
    const findings = await analyzeGuards(model, realDeps, 4);
    expect(findings.some(f => f.finding === 'stuck' && f.state === 'a')).toBe(true);
  }, 60_000);

  it('flags a state unreachable behind an unsatisfiable guard', async () => {
    // `b` is entered only via `go` (guarded by the unsatisfiable `n==1 and n==2`) → unreachable.
    const model = mk(
      [{ name: 'go', region: 's', from: ['a'], to: 'b',
         requires: and(cmp(fld('n'), 'eq', int(1)), cmp(fld('n'), 'eq', int(2))) }],
      [{ name: 'a' }, { name: 'b' }]);
    const findings = await analyzeGuards(model, realDeps, 4);
    expect(findings.some(f => f.finding === 'unreachable' && f.state === 'b')).toBe(true);
  }, 60_000);

  it('a well-formed model with an unguarded escape yields no stuck finding', async () => {
    // `a` has an unguarded exit `esc` → never a stuck candidate → no stuck probe, no finding.
    const model = mk(
      [{ name: 'esc', region: 's', from: ['a'], to: 'b' }],
      [{ name: 'a' }, { name: 'b', tags: ['terminal'] }]);
    const findings = await analyzeGuards(model, realDeps, 4);
    expect(findings.some(f => f.finding === 'stuck')).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 2: Run — FAIL** (module missing). `cd lattice && npx vitest run test/engine/guard-analysis.integration.test.ts`

- [ ] **Step 3: Implement `src/engine/guard-analysis.ts`:**

```ts
import type { DomainModel } from '../ast/domain.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { reachabilityResidual, stuckCandidates } from './guard-structure.js';
import { astToQuintGuard } from '../emit/quint-guard.js';

export interface GuardFinding {
  finding: 'stuck' | 'unreachable';
  owner: string; region: string; state: string;
  witness?: CaseState;
  boundedN: number;
}

export async function analyzeGuards(m: DomainModel, deps: SolverDeps, reachSteps = 6): Promise<GuardFinding[]> {
  const findings: GuardFinding[] = [];
  // Stuck: structural filter → solver-confirm reachability of the stuck config.
  for (const site of stuckCandidates(m)) {
    const em = astToQuintGuard(m, site, 'stuck');
    const r = await deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps });
    if (r.violated) findings.push({ finding: 'stuck', ...site, witness: r.witness, boundedN: reachSteps });
  }
  // Reachability: residual → solver. A NON-violation (q_not_reach holds) ⇒ unreachable within N.
  for (const site of reachabilityResidual(m)) {
    const em = astToQuintGuard(m, site, 'reach');
    const r = await deps.quintVerify(em, { init: 'init', invariant: em.invariantName, maxSteps: reachSteps });
    if (!r.violated) findings.push({ finding: 'unreachable', ...site, boundedN: reachSteps });
  }
  return findings;
}
```

- [ ] **Step 4: Run — PASS** (real quint). `cd lattice && npx vitest run test/engine/guard-analysis.integration.test.ts`. Confirm the stuck and unreachable findings come from real `quint verify` (the test uses `realDeps`). If `realDeps` is not exported from `cli.ts`, export it (`export const realDeps`) as part of this task, or import `runQuintVerify` and build `{ quintVerify: (em, o) => runQuintVerify(em, o) }` inline in the test.

- [ ] **Step 5: tsc + commit.** `cd lattice && npx tsc --noEmit`. Commit `src/engine/guard-analysis.ts`, `test/engine/guard-analysis.integration.test.ts` (+ `src/cli.ts` if you exported `realDeps`); message `feat(engine): analyzeGuards — hybrid stuck/reachability guard analysis (real quint)`.

---

## Task 4: Ledger `guard-finding` entry + `classify`/`status` wiring

**Files:**
- Modify: `lattice/src/engine/session.ts` (new ledger kind + reader), `lattice/src/cli.ts` (classify writes findings; status counts them)
- Test: `lattice/test/cli-classify.test.ts` (classify wiring), `lattice/test/cli.test.ts` (status count — this is where the `status` command is already exercised; there is no dedicated `cli-status.test.ts`)

**Interfaces:**
- Consumes: `analyzeGuards`, `GuardFinding` (Task 3).
- Produces: `LedgerEntry` gains `{ kind: 'guard-finding'; at: string; finding: 'stuck' | 'unreachable'; owner: string; region: string; state: string; witness?: CaseState; boundedN: number; provenance: string }`; `readGuardFindings(dir)` reader; `classify` output gains a `guardFindings` array; `status` output gains a `guardFindings` count object.

- [ ] **Step 1: Write failing tests.**

In `lattice/test/cli-classify.test.ts`, add a test asserting `classify` surfaces `guardFindings` and persists them. Model the setup on the existing classify tests (init a session from a model, run `classify`). Use a model with an unsatisfiable-guard stuck state (as in Task 3's fixture) so a finding is produced; assert the returned object has `guardFindings` containing a `stuck` finding for that state, and that `readGuardFindings(dir)` returns it. (If the existing classify tests use a stub `deps` rather than real quint, use the same stub shape but have its `quintVerify` return `{ violated: true }` for the `q_not_stuck` invariant — assert the WIRING, not the solver, here; the real-solver proof is Task 3.)

In `lattice/test/cli.test.ts` (where `status` is already exercised), add a test: after seeding the ledger with two `guard-finding` entries (one `stuck`, one `unreachable`) via `appendLedger`, `status` returns `guardFindings: { stuck: 1, unreachable: 1 }`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

In `src/engine/session.ts`, add to the `LedgerEntry` union (after the `classified` member):
```ts
  | { kind: 'guard-finding'; at: string; finding: 'stuck' | 'unreachable';
      owner: string; region: string; state: string; witness?: CaseState;
      boundedN: number; provenance: string };
```
and add the reader next to `readClassifications`:
```ts
export function readGuardFindings(dir: string): Extract<LedgerEntry, { kind: 'guard-finding' }>[] {
  return readLedger(dir).filter((e): e is Extract<LedgerEntry, { kind: 'guard-finding' }> => e.kind === 'guard-finding');
}
```

In `src/cli.ts` `classify` command, after `const methodGuards = await checkAllMethodGuards(model(), deps);` and before the returns, add:
```ts
        const guardFindings = await analyzeGuards(model(), deps, reachSteps);
        for (const f of guardFindings)
          appendLedger(dir, { kind: 'guard-finding', at: now(), finding: f.finding, owner: f.owner,
            region: f.region, state: f.state, witness: f.witness, boundedN: f.boundedN, provenance: `classify ${isoDay(now())}` });
```
and include `guardFindings` in BOTH `classify` returns:
```ts
        if (values.name) return { classified: results, methodGuards, guardFindings };
        …
        return { classified: results, skipped, methodGuards, guardFindings };
```
Add the import: `import { analyzeGuards } from './engine/guard-analysis.js';` and `readGuardFindings` to the `session.js` import.

In the `status` command, after the `classifications` count loop, add:
```ts
        const gf = readGuardFindings(dir);
        const guardFindings = { stuck: gf.filter(e => e.finding === 'stuck').length,
                                unreachable: gf.filter(e => e.finding === 'unreachable').length };
```
and add `guardFindings` to the returned object.

- [ ] **Step 4: Run — PASS.** `cd lattice && npx vitest run test/cli-classify.test.ts test/cli.test.ts`

- [ ] **Step 5: Full check + commit.** `cd lattice && npx tsc --noEmit && npx vitest run` (heed the load note — a lone golden-trace-b latency failure is environmental). Commit `src/engine/session.ts`, `src/cli.ts`, the two test files; message `feat(cli): guard-finding ledger entry + classify/status wiring (Pillar B)`.

---

## Final whole-branch review (after Task 4)

Run an integrated review over the Pillar B diff (base = pre-Task-1, head = last Task-4 commit): confirm goldens byte-identical (the new twin doesn't touch existing emission), the structural filter is sound (unguarded-escape ⇒ never stuck; unguarded-BFS ⇒ trivially reachable), the solver direction is correct (stuck: violation⇒finding; reachability: holds⇒finding), findings are non-blocking and `@terminal` stuck is silent, and the bounded-`N`/machine-choice honest-ceiling caveats (§10) are reflected. Carry forward the still-open Plan-2b follow-up tickets (guard-change staleness warning; implied-invariant auto-classify; methodGuards persist-to-ledger + status view; consistent/stronger-than-guard real-quint tests; apply-path latency watch).

## Self-Review

**Spec coverage:** Task 1 = §7.3.1 structural filter (stuck) + §7.3.2 reachability residual; Task 2 = §7.3.4 encoding (`astToQuintGuard` over the abstract-evolution machine, §7.3.3); Task 3 = the hybrid orchestration + the direction-of-verdict rules (§7.3.1/§7.3.2) proven against real quint; Task 4 = §7.3.5 surface (ledger `guard-finding` + `classify` + `status`). Explain-by-state (§7.3.5 mentions it) is deferred — findings are state-keyed, `explain` is invariant-keyed; noted as a follow-up.

**Placeholder scan:** Every code step carries complete code. The one open implementation detail (whether `TRUE_PROBE` needs a real aggregate name) is flagged with the exact fallback and how to decide (run Step 5) — not a "TBD".

**Type consistency:** `GuardSite` (Task 1) flows into `astToQuintGuard` (Task 2) and `analyzeGuards` (Task 3); `GuardFinding` (Task 3) maps field-for-field onto the `guard-finding` ledger entry (Task 4). `deps.quintVerify(em, { init:'init', invariant: em.invariantName, maxSteps })` matches `SolverDeps` (planner.ts:18) and Pillar A's call. `reachSteps` default `6` matches `classifyInvariant`.

**Honest ceiling:** every `GuardFinding` carries `boundedN`; reachability findings are unreachable-within-N (not proven-dead); stuck/reachability run on the abstract-evolution machine (§7.3.3), whose blind spot is documented in §10.
