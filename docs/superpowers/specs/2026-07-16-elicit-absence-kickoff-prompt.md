# Kickoff prompt — elicit what absence means (Slice B1's deferred Task 7)

You are picking up the **elicitation half** of optional fields. The other half is merged: read
`docs/superpowers/specs/2026-07-15-optional-fields-design.md` (its §2 is your requirement) and
`docs/superpowers/plans/2026-07-15-optional-fields.md` Task 7 (a first sketch — treat it as a
starting point, not a spec; the same plan's other tasks were wrong about this codebase repeatedly).

## What exists

A field can be optional (`field : Type?`). A `present(f)` predicate reads absence as a **fact** — it
has to, because a comparison treats a missing operand as unknown and **permits** (`evaluate.ts:45`,
"unknown facts don't convict"). An `absence-undecided` diagnostic rejects an invariant whose path
**ends at** an optional field with no dominating `present()`. Derived rules take the guard form.
Both solvers encode it.

So today a hand-author gets told exactly what to write, and writes `present()` themselves.

## What you are building, and why it is not "just add a question"

**The engine must not guess what absence means, and the user must not have to type `present()`.**

The two readings need **opposite** insertions, and only a domain expert knows which:

```lat
approvedAmount : Money?                                       // absent until approved

invariant approvalWithinPayment { approvedAmount <= amount }
invariant succeededWasApproved  { state progress in {succeeded} => approvedAmount > 0 }
```

- **Guard form** — `where present(approvedAmount)`. Absence means *the rule does not apply*. Right
  for the first: it is about approved refunds and should not fire on an unapproved one.
- **Assertion form** — `present(approvedAmount) && …`. Absence means *the rule fails*. Right for the
  second: it exists precisely to forbid a succeeded-but-unapproved refund.

Auto-inserting either one is wrong half the time, **and the two are indistinguishable in the spec
text**. That is why the gate refuses and why this is elicitation rather than a default.

Your job: `next-question` draws a witness with the field **absent** and asks permit/forbid. **Permit
⇒ the engine writes the guard form. Forbid ⇒ the engine writes the assertion form.** The user judges
a concrete case; the engine writes the syntax; the verdict lands in the ledger with its witness.

## Read these before designing

- **`planner.ts`'s `PlannerOutput`** — a seven-variant union. `cli.ts`'s `next-question` passes each
  through, and `.claude/skills/elicit-spec/SKILL.md`'s Phase 2 has a bullet per variant. **An eighth
  variant with no skill bullet fails silently at runtime**, in front of a user — that exact gap
  (`parked`) was found and fixed in a prior slice. Record the variant's shape, its `cli.ts` case, and
  its SKILL.md bullet *before* you write any of them.
- **`grammar.ts`'s `checkAbsence`/`presentsIn`** — the dominance rule your rewrite must satisfy. It is
  syntactic and conservative on purpose: a `where` guard covers the body; `&&` is symmetric; an
  antecedent covers its consequent; an `or`/`not` node never **exports** coverage outward (but is
  transparent inward — `!(present(f) && f > 0)` does not fire). **Both rewrite forms must
  round-trip `validateCandidate` cleanly.** A rewrite that reintroduces `absence-undecided` is the
  bug this task exists to prevent — assert that in a test, do not assume it.
- **`test/cli-decline.test.ts`** — the harness pattern. `cli.ts` has **no `main` export**; it is
  `runCommand(argv, deps)`. (An earlier plan's test called an API that does not exist and the
  implementer correctly stopped rather than guess.)

## Known gaps you will land in the middle of

- **The skill is silent on all of this.** `.claude/skills/elicit-spec/` greps **zero** hits for
  `absence`, `present(`, or `optional`. So `absence-undecided` can already reject a `propose` inside
  the loop with no guidance, leaving the model to improvise. **The elicitation path never emits
  `Type?` at all today**, so optionality is hand-author-only in practice. Your slice is what makes it
  reachable — the skill work is not a footnote, it is half the deliverable.
- **`cardinality.where` and `leadsTo.from`/`to` are not absence-gated at all.** `invariant.md` states
  this gap and deliberately refuses to imply it away. If your elicitation covers them, that is a
  decision to surface, not to make quietly.
- **`arbitraries.ts`'s pools are gated per-kind** so the property test stops generating specs its own
  validator rejects. If you widen what is legal, re-read `git show 7c1a986` and `6d06a15` first.

## Process (non-negotiable)

1. **Brainstorm first** (`superpowers:brainstorming`). This is genuine design work; `docs/plan.md` is
   silent on it. The design's §2 fixes the *what*; the *how* (the variant's shape, where the rewrite
   lives, what the witness table shows) is yours.
2. Design spec → human approval → `superpowers:writing-plans` → `superpowers:subagent-driven-development`
   with per-task review.
3. **Every factual claim — in a design, plan, comment, doc, or test title — must survive a grep or a
   run.** This is not boilerplate. The slice that built the other half produced, and had to fix: an
   invented API; a "headline guard" that never touched the path it claimed to test and passed
   identically at its own parent commit; four false doc claims, one created by *narrowing a true
   claim into a false one*; and a Critical that traced to a survey of two of three engines.
   **Run the claim. Do not reason about it.**

## Environment (learned the hard way — constraints, not advice)

- **`npx tsc --noEmit -p .` (from `lattice/`) must exit 0, in every task.** A prior slice shipped a
  branch that passed every test and failed compilation for five tasks because no plan step ran it.
  It is also your completeness check: adding a `Predicate` arm broke **13** source files' exhaustive
  switches, and only the compiler found them. Never add a `default:` to silence it.
- **The full suite has no known-green baseline on this machine.** Gate **per-file** after
  `bash scripts/cleanup-solvers.sh`. Argue a failure by whether your change can *reach* the test.
- **Never pipe `vitest`/`tsc` through `tail`/`head` when reading an exit code** — you get the pipe's
  status. Redirect to a file and grep it.
- **Never cap a survey grep** (`| head -N`). A capped grep reads as "covered everything."
- **Run gates in the foreground.** Backgrounding a test run and returning without a status stalled
  five tasks in the previous slice.
- `roundtrip.test.ts` runs **200 unseeded** fast-check draws, so one green run settles nothing — and
  a **known pre-existing flake** lives there: a `value` named `Id` shadows the `Id` primitive, so
  `aa : Id` goes in value-typed and comes back prim-typed. Two agents found it independently and both
  confirmed it on base. If roundtrip fails, check for that shape before assuming it is yours.
- `main` moves under you. Re-check immediately before merging and re-run the gates on the rebased
  result; a clean rebase is not evidence the code still works. Re-run `ensure-ready.sh` after any
  rebase — stale `node_modules` makes `npx tsc`/`npx quint` vanish in ways that look like real
  failures.

## Definition of done (settled in brainstorming; this is the floor)

On a model with an optional field, `next-question` offers a witness with that field **absent**, the
table renders it legibly, and a `permit`/`forbid` verdict rewrites the candidate into the guard or
assertion form respectively — with the rewritten candidate passing `validateCandidate` and the
verdict recorded in `ledger.jsonl` with the witness that produced it. The skill's Phase 2 handles the
new variant explicitly, and the model is told never to write `present()` itself.
