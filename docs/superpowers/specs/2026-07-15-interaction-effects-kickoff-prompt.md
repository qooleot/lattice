# Kickoff prompt — Slice C: invariant interaction effects

You are picking up **Slice C — interaction effects**. It is independent of Slice B1 (optional
fields, `docs/superpowers/plans/2026-07-15-optional-fields.md`), which may be in flight; the two do
not touch the same code. Slice A (template-layer conformance) is merged.

## The problem, in one sentence

**A conjunction of invariants forbids things no single invariant mentions, and nothing surfaces
that — so a spec can rule out a legal domain state that no human ever judged.**

Per-rule review cannot catch it: each rule is individually correct and individually reasonable. The
consequence lives in the *pair*.

## Two real cases from the BillPayments elicitation — same shape, opposite value

Both arise from the identical structural coincidence: a **conservation** rule plus a
**non-negativity** rule on one of its parts. Both are auto-adopted by `matchTemplates`
(`lattice/src/engine/templates.ts`) with no question asked, because each fires on shape alone.

**Case 1 — a consequence you must decide, and nobody did.**

```
conservationBill          : amountPaid + amountDue == total
nonNegativeBillAmountDue  : amountDue >= 0
```

Together these entail `amountPaid <= total` — **the model forbids overpayment.** Neither rule says
the word. Nobody chose it. Payers overpay in the real world (duplicate submissions, rounding up,
stale amounts), so this may be plain wrong for the domain — and the human was asked twice during
the elicitation and dismissed the question both times, which means a spec shipped this way would
carry a rule its author never saw, let alone judged.

**Case 2 — the same mechanism, and here it is a free correctness win.**

```
conservationPayment           : amountRefunded + amountReturned + amountRemaining == amount
nonNegativePaymentAmountRemaining : amountRemaining >= 0
```

Together these entail `amountRefunded + amountReturned <= amount` — **you cannot claw back more than
was paid.** That is exactly right, nobody had to think of it, and it came for free.

**This is the whole difficulty.** The two are structurally identical. The mechanism cannot tell them
apart. Only a domain expert can, and only if something shows them the consequence — which today
nothing does.

## Why it is invisible today

- Template matches are **auto-adopted** at `init` (`lattice/src/cli.ts`, the `init` case) with an
  `adopted` ledger entry and no review gate.
- Adopted candidates become constraints on **every** witness the solver subsequently draws —
  `adoptedConstraints` (`lattice/src/engine/planner.ts:93`) feeds them into every `solve`. They never
  re-enter the elicitation loop.
- So the interaction narrows the witness space *before* the first question, and every question the
  human is later asked is already drawn from the narrowed space. The forbidden state is not judged
  and not shown — it is simply unreachable.
- `astToProse` prints each invariant. It never prints what a pair of them implies.

## What already exists that you should build on, not rebuild

- **`decline --id --reason`** (`cli.ts`, landed in Slice A) — the auditable way to reject an adopted
  rule, legal before the first verdict. If your design surfaces a bad interaction, `decline` is
  probably what the user *does* about it. Read `docs/plan.md` §10.2's application-model paragraph.
- **The distinguishing-witness machinery** — `nextQuestion` (`planner.ts`) already asks the solver
  for an instance separating two candidates, renders it as a table (`renderWitnessTable`,
  `engine/salient.ts`), and records the verdict with its witness in `ledger.jsonl`. An interaction
  question is plausibly the same shape pointed at a different query. Do not invent a second
  question mechanism without a reason.
- **`classify`** (`engine/classify.ts`, `cli.ts`'s `classify` case) — already answers "is this
  invariant entailed by the others?" using real Quint/Apalache, and writes `classified` ledger
  entries with `verdict: 'entailed' | 'independent' | …`. **Read this first.** Entailment of a rule
  by the rest of the set is very close to the question you are asking, and it may be most of your
  machinery already. If it is, say so and scope accordingly rather than building a parallel path.
- **`strengthen`** (`engine/strengthen.ts`) — CTI-guided guard inference. Also solver-backed; also
  worth reading before you design a new solver interaction.

## The hard part (do not skip this in brainstorming)

**The space of consequences is infinite.** "What does this conjunction forbid?" has no enumerable
answer — you cannot list every entailed proposition. So the design question is not *how to detect a
consequence* (the solver can: ask for a witness of the negation; UNSAT means the conjunction forbids
it). The design question is **which consequences to surface, and when**, without drowning the user.

Some directions, none endorsed — the fork is yours to explore:

- **Incremental narrowing.** When rule B is adopted, some witnesses that were legal become illegal.
  Show the user one. This makes "what did adopting B cost?" concrete and bounded, and it maps onto
  the existing witness machinery.
- **Domain-prior probes.** Like Phase 0b's skip probes (`.claude/skills/elicit-spec/SKILL.md`): do
  not enumerate, pick the handful a domain expert would find tempting. "Can a bill be overpaid?" is
  a question a payments person answers instantly.
- **Tag-driven.** The conservation+non-negativity pair is a *known* interacting shape. Enumerate the
  template pairs that interact and probe only those. Narrow, cheap, and it covers both real cases
  above — but it only ever finds interactions someone anticipated.

## Evidence trail

- The overpayment case was found by hand during the BillPayments Phase 0b dry-run, by multiplying
  two adopted rules together on paper. Nothing in the tool surfaced it, and nothing would have.
- The elicitation was **parked** on exactly this question — see the session's structure ledger
  discussion; the human declined to answer twice, which is itself data about how much a consequence
  needs to be *shown* rather than asked about in the abstract.
- Slice A's design (`docs/superpowers/specs/2026-07-14-template-layer-conformance-design.md`) names
  this as its explicitly-deferred Slice C and states the case in §"Not in this slice".

## Process (non-negotiable)

1. **Brainstorm first** (`superpowers:brainstorming`) — this is genuine design work with no spec to
   conform to; `docs/plan.md` is silent on it. Explore the fork above *before* writing a design.
   Read `classify.ts` before your first question: if entailment already answers most of this, the
   slice is much smaller than it looks, and finding that out early is the highest-value thing you
   can do.
2. Design spec → human approval → `superpowers:writing-plans` → `superpowers:subagent-driven-development`
   with per-task review.
3. Every factual claim in a design, plan, comment, doc or test title must survive a grep. Slice A
   produced **five** false doc claims, each an unqualified universal ("the *only* route", "*every*
   consumer") that a grep refutes — three of them written *while fixing* false claims. Prefer a
   narrower claim you can cite.

## Environment (learned the hard way — treat as constraints, not advice)

- Work in a git worktree. Run `bash lattice/scripts/ensure-ready.sh` before the first engine call,
  and **again after any rebase** — it reinstalls when `package-lock.json` moves, and a stale
  `node_modules` makes `npx tsc`/`npx quint` vanish in ways that look exactly like real failures.
- **`npx tsc --noEmit -p .` (from `lattice/`) must exit 0.** Slice A shipped a branch that passed
  every test and failed compilation for five tasks because no plan step ran it. Make it a named gate
  in every task.
- **The full suite has no known-green baseline on this machine.** The failure set shifts run to run;
  every failure passes in isolation. Gate **per-file** after `bash scripts/cleanup-solvers.sh`. Argue
  a failure by whether your change can *reach* the test, never by the suite's verdict.
- **Never pipe `vitest`/`tsc` through `tail`/`head` when reading an exit code** — you get the pipe's
  status, not the command's. Redirect to a file and grep it.
- **Never cap a survey grep** (`| head -N`). A capped grep silently reads as "covered everything";
  it cost Slice A a missed file and a wrong plan.
- `main` moves under you — it moved three times during Slice A, twice mid-session. Re-check it
  immediately before merging, and re-run the gates on the rebased result. A clean rebase is not
  evidence the code still works.
- Never `git add -A`. Never edit `/Users/taras/projects/spec-core/lattice/...` from a worktree — that
  is the main checkout, and other sessions have work in flight there.

## Definition of done (settled in brainstorming; this is the floor)

The overpayment interaction is **surfaced to a human as a concrete case they judge**, on the real
BillPayments shape, before it silently constrains the elicitation — and the judgement lands in the
ledger with the witness that produced it. Whatever mechanism you choose must also leave Case 2
alone, or surface it just as cheaply: a design that floods the user with every free win is as
useless as one that hides the costly ones.
