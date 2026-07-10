# Inference Slice — Plan 1: Solver-Induction Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Quint adapter a real Apalache 1-step induction capability, empirically pin the entailed/independent/violated query protocol, and add the append-only `classified` ledger kind — the foundation every later inference pillar builds on.

**Architecture:** The Task-1 spike pinned the mechanism: `quint verify --inductive-invariant` is unusable on the emitted machine, so induction is delivered via a havoc `--init` action + ordinary `verify --init <name> --invariant I --max-steps 1` (Quint 0.26.0, Apalache 0.47.2 auto-managed). Task 2 extends `src/solvers/quint-adapter.ts` with a `runQuintVerify` sibling to `runQuint` that passes a custom `--init`/`--invariant`; a consecution CTI writes an ITF, so violation detection reuses `runQuint`'s path. The `classified` ledger entry is an additive union member — generation and the existing engine ignore kinds they don't handle.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), Vitest, Quint/Apalache via `npx quint verify`.

## Global Constraints

- TypeScript strict; verify with `cd lattice && npx tsc --noEmit && npx vitest run` before every commit — real solvers, no simulated validation.
- Run `npx langium generate` after any fresh checkout before diagnosing tsc errors (`src/parse/generated/` is gitignored).
- Never `git add -A`; stage explicit paths.
- Goldens A–D are never weakened. `evaluate.ts` (the model-free oracle) is NOT touched by this plan — the generation `differential.test.ts` must stay green.
- Ledger is canonical and append-only; classifications are ledger facts, never silent state mutations. An *entailed* invariant is never auto-deleted.
- Solver invocations honor the existing per-call ephemeral-port isolation (orphan-JVM / golden-trace-B load-sensitive latency quirks) — reuse the adapter's spawn path, do not fork a second one.
- This plan is the first of five (design §13); it must produce working, tested software on its own.

---

## Roadmap (this plan = Plan 1 of 5)

| Plan | Scope | Deliverable | Depends on |
|---|---|---|---|
| **1 (this)** | Induction spike + adapter induction mode + `classified` ledger kind | Solver can run induction; protocol pinned; ledger can record labels | — |
| 2 | Pillar A entailment classifier + `classify` CLI + `status`/`explain` rendering + method⊨transition | Adopted invariants get entailed/independent/violated labels | Plan 1's pinned protocol |
| 3 | Abstract-evolution emission (§6) + structural gate (§6.4) | Data-touching invariants classified under sound over-approximation | Plan 2 |
| 4 | Pillar B guard analysis (stuck-state, reachability) | Annotation-gated stuck-state questions; reachability warnings | Plans 1–2 |
| 5 | Pillar C + first-class guard candidates + solver-first auto-pruning | CTI → guard proposals through the elicitation loop | Plans 1–4 |

Plans 2–5 get full task breakdowns when reached, written against the code Plan 1–(N−1) actually leaves behind. Rationale: their emission/query details depend on Plan 1's spike outcome.

---

## Task 1: Induction spike — pin CLI behavior and the classification protocol

**Files:**
- Create: `docs/superpowers/specs/2026-07-09-inference-spike-notes.md` (the decision artifact Plan 2 consumes)
- Scratch (not committed): hand-written `.qnt` files under the session scratchpad

**Interfaces:**
- Produces: a recorded decision — (a) whether a consecution counterexample writes an ITF trace under `--out-itf` (this decides how Task 2 detects `violated`), and (b) the exact flag protocol that yields the correct **entailed / independent / violated** verdict on the three known examples from the committed spec.

This task is exploratory but ends in a committed artifact. Every command is concrete; the deliverable is the filled-in notes doc.

- [ ] **Step 1: Confirm the induction flags exist**

Run: `cd lattice && npx quint verify --help | grep -E "inductive-invariant|init|invariant"`
Expected: lines for `--inductive-invariant`, `--init`, `--invariant` (already confirmed in the design §2 spike; re-confirm the local toolchain).

- [ ] **Step 2: Determine whether a consecution counterexample emits an ITF**

Write `q_noninductive.qnt` to the scratchpad:

```
module m {
  var c: int
  action init = { c' = 0 }
  action step = { c' = c - 1 }
  val inv = c >= 0
}
```

Run: `npx quint verify --inductive-invariant inv --out-itf /tmp/cti.itf.json <path>/q_noninductive.qnt; echo "exit=$?"; test -f /tmp/cti.itf.json && echo "ITF WRITTEN" || echo "NO ITF"`
Expected: non-zero exit (inv is not inductive — from `c=0`, `step` reaches `c=-1`). **Record** whether `ITF WRITTEN` or `NO ITF`. This decides Task 2's violation-detection branch: ITF-present (key `violated` on the ITF, like `runQuint`) vs stderr-pattern (key on an exit-code + message match).

- [ ] **Step 3: Confirm an inductive invariant passes**

Write `q_inductive.qnt` (same module but `action step = { c' = c + 1 }`).
Run: `npx quint verify --inductive-invariant inv --out-itf /tmp/ok.itf.json <path>/q_inductive.qnt; echo "exit=$?"`
Expected: exit 0 (inv holds at init and is preserved by every step).

- [ ] **Step 4: Pin the classification protocol on the real spec**

Emit the committed Subscriptions machine to Quint using the current emitter, so the module contains the real guards. In a scratch script:

```ts
import { astToQuint } from './lattice/src/emit/quint.js';
// load the committed model however the session store exposes it, e.g. loadState('.lattice-session-subscriptions').model
// then hand-append candidate predicates for the invariant-under-test and its peers, and print em.source
```

Then hand-run three protocol variants and record which produces the correct verdict for each known case:

- `neverOverpaidAndPaidExact` paid-conjunct (`settlement in {paid} => amountPaid == totalDue`) → expect **entailed** (the only step into `paid` is `settle`, guarded `amountPaid == totalDue`).
- `retryCapWhilePastDue` / `activePaidInFull` (coupling invariants, no guard establishes them) → expect **independent**.
- Seeded: mutate `settle` to `requires amountPaid >= totalDue`, re-emit → the overpayment invariant → expect **violated** with a CTI.

Candidate protocol to validate (the hypothesis; adjust to what the tool actually does):
- **Consecution / violated probe:** `--inductive-invariant "(peersAnd and I)"`. Holds ⇒ `I` maintained given peers (entailed-or-independent). Fails ⇒ **violated**, ITF/stderr carries the CTI.
- **Redundancy / entailed probe:** `--inductive-invariant "peersAnd" --invariant "(peersAnd implies I)"`. If `peersAnd` is inductive AND every peers-state satisfies `I` ⇒ **entailed**; else **independent**.

- [ ] **Step 5: Write the decision artifact**

Fill in `docs/superpowers/specs/2026-07-09-inference-spike-notes.md` with: the ITF-on-CTI answer (Step 2), the confirmed protocol (Step 4) as exact flag strings, and the three verdicts observed. This is the spec Plan 2 implements against.

- [ ] **Step 6: Commit**

```bash
cd /Users/taras/projects/spec-core/.claude/worktrees/ecstatic-swirles-d47547
git add docs/superpowers/specs/2026-07-09-inference-spike-notes.md
git commit -m "docs: inference induction spike — pinned CLI behavior + classification protocol

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Adapter custom-`--init` verify (`runQuintVerify`)

**Spike outcome that shaped this task** ([`2026-07-09-inference-spike-notes.md`](../specs/2026-07-09-inference-spike-notes.md)): `--inductive-invariant` is **unusable** on the emitted machine (its Phase 1 rejects our permissive `init`; its Phase 2 can't bind map/record state). The validated mechanism is a **havoc `--init` action** (emitted in Plan 2/3) plus `quint verify --init <name> --invariant I --max-steps 1`. A consecution CTI **writes an ITF and exits non-zero** — so violation detection reuses `runQuint`'s exact path, no new branch. This task adds only the adapter capability to pass a custom `--init`/`--invariant`; building the havoc `indInit` action is Plan 2/3 emitter work.

**Files:**
- Modify: `lattice/src/solvers/quint-adapter.ts` (extract shared spawn core; add `runQuintVerify`)
- Test: `lattice/test/solvers/quint-adapter.test.ts` (unit, mock `execImpl`)
- Test: `lattice/test/solvers/quint-adapter.integration.test.ts` (real quint)

**Interfaces:**
- Consumes: `QuintEmission { source; invariantName; varTypes }` (unchanged).
- Produces:
  ```ts
  export interface VerifyOpts {
    maxSteps: number;
    init?: string;        // custom --init action name (default: the module's 'init')
    invariant?: string;   // --invariant def name (default: em.invariantName)
  }
  export async function runQuintVerify(em: QuintEmission, opts: VerifyOpts, execImpl?: ExecLike): Promise<QuintResult>
  ```
  `QuintResult { violated: boolean; witness?: CaseState; ms: number }` is reused unchanged; for a consecution failure `witness` is the CTI (a two-state ITF trace: pre-state satisfies the hypothesis, post-state violates the invariant). `runQuint(em, maxSteps)` keeps its exact signature and becomes a thin wrapper (the reachability primitive).

- [ ] **Step 1: Write the failing unit tests**

Append to `lattice/test/solvers/quint-adapter.test.ts` (reuses the file's existing `em` and `failWith` helpers):

```ts
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';

describe('runQuintVerify flag construction', () => {
  it('passes a custom --init and --invariant when given', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('error: parsing failed\nsyntax error'));
    await expect(runQuintVerify(em, { init: 'indInit', invariant: 'PaidConjunct', maxSteps: 1 }, exec))
      .rejects.toThrow(/quint verify failed without a counterexample/);
    const args = exec.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--init') + 1]).toBe('indInit');
    expect(args[args.indexOf('--invariant') + 1]).toBe('PaidConjunct');
    expect(args[args.indexOf('--max-steps') + 1]).toBe('1');
  });

  it('defaults --invariant to em.invariantName and omits --init when not given', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('error: parsing failed'));
    await expect(runQuintVerify(em, { maxSteps: 3 }, exec)).rejects.toThrow();
    const args = exec.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--invariant') + 1]).toBe('q_inv'); // em.invariantName
    expect(args).not.toContain('--init');
  });

  it('retries once on a transient gRPC error, like runQuint', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 14 UNAVAILABLE: Connection dropped'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    const r = await runQuintVerify(em, { init: 'indInit', maxSteps: 1 }, exec);
    expect(r.violated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd lattice && npx vitest run test/solvers/quint-adapter.test.ts`
Expected: FAIL — `runQuintVerify` is not exported.

- [ ] **Step 3: Refactor the shared core and add `runQuintVerify`**

In `lattice/src/solvers/quint-adapter.ts`, replace the body of `runQuint` with a shared `verifyWithArgs` helper and add the new function. (Keeps `runQuint`'s external behavior identical — existing tests stay green: `runQuint` still passes `--max-steps`, `--invariant`, `--server-endpoint`, `--out-itf`, and the existing tests locate flags by `indexOf`, so argument order does not matter to them.)

```ts
async function verifyWithArgs(em: QuintEmission, extraArgs: string[], execImpl: ExecLike): Promise<QuintResult> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), 'quint-'));
    const qnt = join(dir, 'q.qnt');
    const itf = join(dir, 'out.itf.json');
    writeFileSync(qnt, em.source);
    const env = { ...process.env, JAVA_HOME: dirname(dirname(findJava())) };
    try {
      await execImpl('npx', ['quint', 'verify',
        '--server-endpoint', `localhost:${randomPort()}`, '--out-itf', itf, ...extraArgs, qnt],
        { env, timeout: 90_000 });
      return { violated: false, ms: Date.now() - t0 };
    } catch (e: any) {
      if (existsSync(itf)) {
        const witness = parseITF(JSON.parse(readFileSync(itf, 'utf8')), em.varTypes);
        return { violated: true, witness, ms: Date.now() - t0 };
      }
      if (attempt === 0 && TRANSIENT_QUINT.test(`${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`)) {
        await sleep(1000);
        continue;
      }
      throw new Error(`quint verify failed without a counterexample: ${e.stderr ?? e.message}`);
    }
  }
}

export async function runQuint(em: QuintEmission, maxSteps: number, execImpl: ExecLike = exec): Promise<QuintResult> {
  return verifyWithArgs(em, ['--max-steps', String(maxSteps), '--invariant', em.invariantName], execImpl);
}

export interface VerifyOpts {
  maxSteps: number;
  init?: string;        // custom --init action name (default: the module's 'init')
  invariant?: string;   // --invariant def name (default: em.invariantName)
}

export async function runQuintVerify(em: QuintEmission, opts: VerifyOpts, execImpl: ExecLike = exec): Promise<QuintResult> {
  const args: string[] = [];
  if (opts.init) args.push('--init', opts.init);
  args.push('--max-steps', String(opts.maxSteps), '--invariant', opts.invariant ?? em.invariantName);
  return verifyWithArgs(em, args, execImpl);
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd lattice && npx vitest run test/solvers/quint-adapter.test.ts`
Expected: PASS (new tests + all pre-existing retry/port tests).

- [ ] **Step 5: Write the failing integration test (real quint)**

Append to `lattice/test/solvers/quint-adapter.integration.test.ts`. These modules mirror the spike's validated havoc-init consecution harness (the invariant binds `c` over a bounded set, as the spike found necessary; `indInit` havocs `c` over that set = an arbitrary hypothesis-satisfying state):

```ts
import { runQuintVerify } from '../../src/solvers/quint-adapter.js';

describe('runQuintVerify custom --init (integration, real quint)', () => {
  const consecutionHolds: QuintEmission = { source:
    `module m {\n  var c: int\n  action init = { c' = 0 }\n  action indInit = { nondet x = oneOf(0.to(5)) c' = x }\n  action step = { c' = if (c < 5) c + 1 else c }\n  val inv = c.in(0.to(5))\n}`,
    invariantName: 'inv', varTypes: {} };
  const consecutionFails: QuintEmission = { source:
    `module m {\n  var c: int\n  action init = { c' = 0 }\n  action indInit = { nondet x = oneOf(0.to(5)) c' = x }\n  action step = { c' = c - 1 }\n  val inv = c.in(0.to(5))\n}`,
    invariantName: 'inv', varTypes: {} };

  it('holds (no violation) when the step preserves the invariant from any hypothesis state', async () => {
    const r = await runQuintVerify(consecutionHolds, { init: 'indInit', invariant: 'inv', maxSteps: 1 });
    expect(r.violated).toBe(false);
  }, 180_000);

  it('reports a CTI when a step breaks the invariant from a hypothesis state', async () => {
    const r = await runQuintVerify(consecutionFails, { init: 'indInit', invariant: 'inv', maxSteps: 1 });
    expect(r.violated).toBe(true);
  }, 180_000);
});
```

Note: `QuintEmission` is already imported in this file (via `astToQuint` usage); if not, add `import type { QuintEmission } from '../../src/emit/quint.js';`.

- [ ] **Step 6: Run the integration test**

Run: `cd lattice && npx vitest run test/solvers/quint-adapter.integration.test.ts -t "runQuintVerify"`
Expected: PASS — `consecutionHolds` → `violated:false`; `consecutionFails` → `violated:true` (two-state CTI). This matches the spike's Step-2/Step-3 evidence.

- [ ] **Step 7: Full check + commit**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`
Expected: PASS, goldens A–D green.

```bash
cd /Users/taras/projects/spec-core/.claude/worktrees/ecstatic-swirles-d47547
git add lattice/src/solvers/quint-adapter.ts lattice/test/solvers/quint-adapter.test.ts lattice/test/solvers/quint-adapter.integration.test.ts
git commit -m "feat(solvers): quint adapter custom --init verify (runQuintVerify)

Shares the spawn/retry/port-isolation core with runQuint; passes a custom
--init (+ --invariant/--max-steps) so the classifier's havoc-init
consecution/entailment probes run as ordinary verify calls. The spike
showed --inductive-invariant is unusable on the emitted machine; this is
the validated mechanism. Foundation for the entailment classifier (Plan 2).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: The `classified` ledger entry kind

**Files:**
- Modify: `lattice/src/engine/session.ts` (extend the `LedgerEntry` union; add a `readClassifications` helper)
- Test: `lattice/test/engine/session.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: `CaseState` (from `evaluate.js`), the existing `appendLedger` / `readLedger`.
- Produces:
  ```ts
  // new LedgerEntry member (verdict set per design §5 hybrid protocol; reachable? set by escalation):
  { kind: 'classified'; at: string; invariant: string; conjunct?: string;
    verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';
    tier: 'sound' | 'abstract'; caveat?: string;
    witness?: CaseState; reachable?: boolean; pinnedBy?: string[]; provenance: string }
  // helper:
  export function readClassifications(dir: string): Extract<LedgerEntry, { kind: 'classified' }>[]
  ```

- [ ] **Step 1: Write the failing test**

Create `lattice/test/engine/session.test.ts` (or append if it exists):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedger, readLedger, readClassifications } from '../../src/engine/session.js';

describe('classified ledger entry', () => {
  it('round-trips a classified entry and readClassifications filters to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    appendLedger(dir, { kind: 'structure', at: '2026-07-09T00:00:00Z', question: 'q', answer: 'a' });
    appendLedger(dir, {
      kind: 'classified', at: '2026-07-09T00:00:01Z',
      invariant: 'neverOverpaidAndPaidExact', conjunct: 'paid-implies-exact',
      verdict: 'entailed', tier: 'sound',
      pinnedBy: ['settle.requires'], provenance: 'induction 2026-07-09',
    });
    appendLedger(dir, {
      kind: 'classified', at: '2026-07-09T00:00:02Z',
      invariant: 'activePaidInFull', verdict: 'violated', tier: 'sound',
      reachable: true,
      witness: { entities: [], trace: [] },
      provenance: 'escalated 2026-07-09',
    });
    expect(readLedger(dir).length).toBe(3);
    const cls = readClassifications(dir);
    expect(cls.length).toBe(2);
    expect(cls[0]!.verdict).toBe('entailed');
    expect(cls[0]!.pinnedBy).toEqual(['settle.requires']);
    expect(cls[1]!.verdict).toBe('violated');
    expect(cls[1]!.reachable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd lattice && npx vitest run test/engine/session.test.ts`
Expected: FAIL — `readClassifications` is not exported.

- [ ] **Step 3: Implement the union member and helper**

In `lattice/src/engine/session.ts`, add the new member to the `LedgerEntry` union (after the `rename` member) and export the helper:

```ts
  | { kind: 'rename'; at: string; scope: import('./renames.js').RenameScope; path: string; from: string; to: string }
  | { kind: 'classified'; at: string; invariant: string; conjunct?: string;
      verdict: 'entailed' | 'independent' | 'not-inductive' | 'violated';
      tier: 'sound' | 'abstract'; caveat?: string;
      witness?: CaseState; reachable?: boolean; pinnedBy?: string[]; provenance: string };
```

Add at the end of the file:

```ts
export function readClassifications(dir: string): Extract<LedgerEntry, { kind: 'classified' }>[] {
  return readLedger(dir).filter((e): e is Extract<LedgerEntry, { kind: 'classified' }> => e.kind === 'classified');
}
```

(`CaseState` is already imported at the top of `session.ts`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd lattice && npx vitest run test/engine/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no consumer breaks on the new kind**

Run: `cd lattice && npx tsc --noEmit && npx vitest run`
Expected: PASS. In particular `src/generate/*` (which reads `GenInput.ledger`) and any `switch (e.kind)` must not exhaustively throw on `classified` — the union is additive and consumers read only the kinds they need. If tsc flags a non-exhaustive `switch` that previously covered every kind, add a `case 'classified': break;` (no behavior) at that site and note it in the commit.

- [ ] **Step 6: Commit**

```bash
cd /Users/taras/projects/spec-core/.claude/worktrees/ecstatic-swirles-d47547
git add lattice/src/engine/session.ts lattice/test/engine/session.test.ts
git commit -m "feat(engine): append-only 'classified' ledger kind + readClassifications

Records entailed/independent/violated labels with tier, caveat, CTI
witness, and pinnedBy provenance. Additive union member — existing
consumers (incl. generation's GenInput.ledger) ignore it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (design §2, §7.1, fork 2):** Task 1 pins the induction protocol the design's §2 spike gate requires; Task 2 delivers "Apalache-induction throughout" (fork 2) as an adapter extension (design §4.1); Task 3 delivers the `classified` ledger entry (design §7.1). Pillars A/B/C, abstract-evolution, and the CLI surface are explicitly deferred to Plans 2–5 (roadmap table) — not gaps, sequenced sub-plans per the skill's scope check.

**Placeholder scan:** The one conditional ("NO ITF" fallback in Task 2 Step 3, `classified` in a `switch` in Task 3 Step 5) is gated on a concrete Task-1 observation / tsc output, not a vague "handle edge cases" — the plan says exactly what to write and forbids inventing the pattern. No TBD/TODO.

**Type consistency:** `QuintResult`, `QuintEmission`, `ExecLike`, `CaseState`, `LedgerEntry` are used verbatim as defined in the current source (`quint-adapter.ts`, `emit/quint.ts`, `session.ts`). `runQuintVerify`/`VerifyOpts`/`readClassifications` names match between their "Produces" blocks and their implementations. `runQuint`'s external signature is unchanged, so existing callers (`cli.ts`) and tests are unaffected. The `classified` verdict enum (`entailed`/`independent`/`not-inductive`/`violated`) and `reachable?` field match design §5/§7.1 after the Option-3 decision.
