# Lattice — Slice #1 Design: The Elicitation Chat, End-to-End, Two Engines

- **Date:** 2026-07-03 (rev 2 — same day; incorporates design review)
- **Status:** Design (approved for planning)
- **Parent design:** [`docs/plan.md`](../../plan.md) — the full Lattice architecture. This document is the first buildable vertical slice of it.
- **Next step:** `writing-plans` → a step-by-step implementation plan.

---

## 0. One-paragraph summary

Build the first vertical slice of Lattice: a domain expert chats with Claude Code, which first elicits the **domain structure** (phase 0 — Claude-only), then drives a *recognition-over-recall* **invariant elicitation loop** backed by **real model finders**. Claude proposes candidate invariants; for each open question a solver manufactures a concrete **distinguishing witness**; the expert judges permit/forbid on that concrete case; the version space prunes; on convergence Claude writes a human-readable **prose** spec and a **code-projection** spec. It is demonstrated on **three golden traces**: A (structural, Alloy 6) and B (temporal/arithmetic, Quint/Apalache) in the *covered* billing domain, and **C — an AI-native revenue-recognition domain (Rillet-style), run end-to-end interactively as the novel-domain test**, exercising both engines, phase 0, and the open-decision path. The **full §20 fidelity experiment (20 rules) gates all adapter work.** This slice tests one primary hypothesis: *the agent-pays-the-tax, human-judges-cases loop produces a correct spec in few questions* — plus a first (not final) measurement of that loop on a novel domain. It deliberately does **not** test anti-drift or scale — those are separate hypotheses and later slices.

**A deliberate reordering, named.** The parent plan's build sequence (§21) puts templates+seeding before the loop and recommends starting single-engine. This slice inverts both **on purpose**: the product question being tested is the *elicitation chat experience*, so the loop comes first; and both engines are built together because the golden traces span both invariant paradigms and we refuse to validate the loop on a simulated or partial engine (D3, D9 — a faked loop can produce false confidence). The parent plan's orderings remain right for the *platform*; this slice's ordering is right for the *experience test*.

---

## 1. What this slice validates — and what it does not

Being explicit here is the whole point: a result is only meaningful if the claim is scoped, so that a failure points at a *specific* cause rather than "we didn't finish."

**Validates (Hypothesis H-elicit):**
- **Phase 0:** Claude can elicit a well-formed domain *structure* (aggregates, entities, machines, events, tags) from a fuzzy founder description, via recognition-style questions, within a small question budget.
- Claude can seed candidate invariants from a domain description (autoformalization, forward direction) — gated *first* by the full §20 fidelity experiment.
- A real model finder can manufacture a **distinguishing, minimal, reachable witness** that separates two candidate invariants.
- Rendering that witness as a domain-language yes/no question, and pruning on the verdict, **converges** on the intended invariant in a small number of judgments.
- The loop works across **two invariant paradigms** (structural and temporal/arithmetic) via **shape-based routing** to two engines.
- On convergence, the same underlying representation emits both a **prose** projection (what the expert reads) and a **code** projection (what an engineer reads).
- **The loop is usable as a chat**: witness generation fits a pre-registered latency budget (§2).
- **First novel-domain measurement (trace C):** on a domain with only partial template coverage (revenue recognition), the loop carries the residual at a measured, bounded question cost, and genuine policy forks are **parked as open decisions**, not guessed.

**Does NOT validate (out of scope — other hypotheses / later slices):**
- **Anti-drift / conformance** (the anti-Rebel keystone, plan §11.5, Risk 6). This is *"does the spec stay synced to code?"* — a different question. **Slice #2.**
- **Scale** (Stripe-sized model, many aggregates, many candidates → the full MaxSAT machinery).
- **Novel-domain elicitation at large** — trace C is *one* novel domain, semi-scripted; it yields a data point, not a verdict on the loop's economics across novel domains generally (plan §8 intro, §16 "read the ratio honestly").
- **Arithmetic fidelity at depth** (nonlinear proration, rounding, real-time) — plan §15, Risk 2. (Rev-rec allocation math in trace C is deliberately kept linear: conservation and monotonicity, not SSP-allocation rounding.)
- **Oracle targets ③ (runtime monitors) and ④ (DST)**, and the **reverse mining flywheel** (§18).

**A slice-1 result must not be read as a verdict on any of the above.**

---

## 2. Success criteria

### 2.0 Gate — the §20 fidelity experiment, at full size, strictly first

Runs **before any adapter or engine code is written** (it needs no engine — it's Claude plus human judgment):
- **20 real rules: 10 billing** (proration, dunning, trial expiry, refund, plan change, …) **+ 10 revenue-recognition** (ratable recognition, deferred-revenue rollforward, period close, usage catch-up, contract modification, …). The two-domain split measures whether autoformalization fidelity **degrades on the novel domain** — a correlated-risk signal the single-domain version can't see.
- Claude formalizes each into the candidate-invariant grammar (§6.1); the harness generates 3 "obvious" cases per rule; keep formalizations passing all 3; then 1 adversarial case per survivor.
- **Read against plan §20 thresholds** (< ~10% subtle-wrong → proceed as designed; 10–30% → flag the example-set-as-spec pivot; > 30% → stop and rethink before building further). With 20 rules the bands are meaningful (granularity 5%).

### 2.1 Golden trace A — structural, routed to Alloy 6 (reproduces plan §8.5)

- Domain: `Customer`, `Plan { family }`, `Subscription { customer, plan, active }`.
- Hidden ground truth: `H3 = ≤1 active per (customer, family)`.
- Seed candidates `{H1: per-customer, H2: per-plan, H4: unlimited}` with priors.
- Expected trace: Q1 witness `DPSF` (two active, same customer, different plan, **same** family) → expert forbids → prune H2, H4. Boundary probe Q2 witness `DPDF` (two active, different family) → expert permits → refute H1 → **candidate set empties → regenerate** → LLM synthesizes H3 → converge.
- **Must exercise the hard path:** a regeneration *and* a boundary-probe refutation, not just simple pruning.

### 2.2 Golden trace B — temporal/arithmetic, routed to Quint/Apalache (reproduces plan §16 Q1/Q2)

- Domain: `Subscription` (Access × Billing), `Invoice { dueDate, status }`, a `grace` duration.
- Question: "Active subscription, latest invoice unpaid & *N* past due — valid?" Q1: 5 **days** past due → forbid. Q2: 5 **hours** past due → permit.
- Converge on: *Active-while-unpaid only within `grace` of the due date.*
- Exercises time/duration comparison (arithmetic) over a state property (temporal) → confirms routing to the SMT-backed engine, not Alloy.
- **Units rendering:** time is modeled as discrete ticks (plan §15); the emitter must carry a tick-granularity so witnesses render as "5 days" / "5 hours", not raw tick counts.

### 2.3 Golden trace C — the novel domain: AI-native revenue recognition (end-to-end, interactive, both engines)

The full experience, run live with a human (the founder role), on a domain the template catalog only partially covers. Semi-scripted: the ground truths and a verdict policy are **pre-registered below** so convergence is judged objectively, but the session itself is a real chat.

**Input (pre-registered founder description, typed into the chat):**
> "We're building an AI-native revenue recognition product (like Rillet). Customers sign contracts with multiple line items — subscriptions recognized ratably over the term, one-time services recognized on delivery, usage-based lines recognized as usage is reported. Contract value is allocated across the lines; unrecognized value sits as deferred revenue. We close accounting periods monthly. Once a period is closed its numbers can't change; late adjustments post as corrections in the current open period."

**Pre-registered structure (what phase 0 should converge to, ≤ 10 structure questions):**
- `aggregate Contract { customer; lines: List<Obligation>; tcv: Money }` with `entity Obligation { allocated: Money; method: enum { Ratable, OnDelivery, UsageBased } }` and `entity RevenueEntry { obligation: ref; period: ref AccountingPeriod; amount: Money; kind: enum { Recognition, Correction } }`.
- `aggregate AccountingPeriod { machine { states { Open @active, Closed @terminal } } }`.
- Events: `PeriodClosed`, `UsageReported`, `RevenueRecognized`.

**Pre-registered "comes free" invariants (templates fire; no questions):**
- Conservation (template #1, Quint): `recognized(o) + deferred(o) == allocated(o)` per obligation.
- Monotonic (template #8, Quint): cumulative recognized per obligation only increases.
- Terminal (template #3, Quint): `Closed` stays `Closed`.
- No orphan (template #9, Alloy): every `RevenueEntry` resolves to an existing obligation and period.
- Single-active (template #7, Alloy): at most one `Open` accounting period.

**Pre-registered residual invariant (the loop's real work; hidden ground truth H\*):**
*No entry ever posts to a Closed period — including corrections. Adjustments touching a closed period post as `kind=Correction` entries in an Open period, referencing the original obligation.* Seed candidates the LLM should plausibly produce:
- H1: entries (any kind) post only to Open periods. **(= H\*)**
- H2: Recognitions only to Open; Corrections may post to Closed (retroactive restatement).
- H3: entries may post to any period not yet past a lock-window after close.

Expected witnesses: a Correction dated inside a Closed period (H2 permits, H1 forbids → expert **forbids**); an entry in a Closed period shortly after close (H3 permits, H1 forbids → expert **forbids**); a Correction in an Open period adjusting a closed-period obligation (all permit → confirms the convention). Convergence expected in **2–4 judgments**; this invariant is *mixed* (entry–period relations + close-event ordering) and is routed per-invariant, exercising **both** engines within one domain.

**Pre-registered open decision (must be parked, not guessed):**
Usage reported *after* its usage-period closed — recognize as catch-up in the current open period, or restate? The expert (per the verdict policy) answers "we haven't decided." **Success = the loop records this in the ledger as a blocking open decision and moves on.** Traces A/B never exercise this path; C must.

**Trace C passes if:** phase 0 converges on the pre-registered structure within budget; the five template invariants auto-adopt; the residual converges to H\* within the question budget; the open decision is parked; and the emitted prose + code specs match the pre-registered ground truths.

### 2.4 Cross-cutting budgets and kill criteria (pre-registered)

**Latency budget (chat viability):** on the golden models' scopes, witness generation (`next-question`, end-to-end including solver) — **p50 ≤ 10s, worst-case ≤ 45s**. A loop that converges in 2 questions but takes 2 minutes per question fails as a chat product.

**Kill criteria.** The loop is judged *not delivering* if any of these hold on the golden traces:
1. Distinguishing witnesses are routinely **unreachable or unintelligible** as domain questions (a human can't judge them without analysis).
2. Convergence needs **> 4 judgments per residual invariant** on traces A/B, or **> 8 judgments total for the residual** on trace C (2× the pre-registered expectations).
3. The solver frequently returns witnesses that **typecheck but are semantically wrong** (autoformalization failure surfacing in the loop rather than in the §2.0 gate).
4. The latency budget is missed by > 2× and no engineering fix (scope tuning, solver warm-start) closes it.

---

## 3. Architecture

Minimal realizations of the components in plan §7. Everything rigorous is deterministic code; the only non-deterministic part is Claude (the NL Translator), and its every formalization is re-checked by a solver ("LLM proposes, Model Finder disposes").

```
 ┌─ INTERFACE ─────────────────────────────────────────────────────────────┐
 │  Claude Code  =  NL Translator                                          │
 │    · PHASE 0: founder description → structure questions → domain AST    │
 │    · domain description → seed candidate invariants (+priors)           │
 │    · solver witness → domain-language question (over the engine's       │
 │      deterministic witness TABLE — prose is additive, never a substitute)│
 │    · parse verdict; on "regenerate", synthesize a ledger-consistent H   │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  structured calls (CLI via Bash) — NOT free text
                 │  every call carries --session <dir>
 ┌─ ELICITATION ENGINE  (deterministic, TypeScript) ────────────────────────┐
 │  Session Store        state.json (AST, version space) + ledger.jsonl    │
 │  Hypothesis Manager   version space · prune · convergence test          │
 │  Question Planner      distinguishing-pair selection · boundary probe    │
 │  Engine Router         invariant shape → Alloy | Quint                  │
 │  Grammar Validator     candidate must parse into the closed grammar §6.1 │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  "find a witness where Hi, Hj disagree (reachable, minimal)"
 ┌─ MODEL FINDERS  (two, routed) ───────────────────────────────────────────┐
 │  Alloy adapter    AST→.als · run distinguish · parse+enumerate instances │
 │  Quint adapter    AST→.qnt · verify iff(Hi,Hj) · parse ITF counterexample│
 └───────────────┬──────────────────────────────────────────────────────────┘
 ┌─ MEMORY / OUTPUT ────────────────────────────────────────────────────────┐
 │  Decision Ledger (append-only JSONL — THE CANONICAL ARTIFACT)            │
 │  Projections writer (prose + code, both cite ledger anchors)             │
 └──────────────────────────────────────────────────────────────────────────┘
```

**Component responsibilities:**
- **NL Translator (Claude Code)** — chat front-end + example intake, and phase-0 structure elicitation. The only LLM-driven part. Guardrails: every candidate it proposes and every regeneration it synthesizes is validated by a solver before it is trusted; every witness it narrates is presented alongside the engine's deterministic table (§5.1).
- **Session Store** *(build)* — all engine state persists under `--session <dir>`: `state.json` (domain AST, version space, convergence state) + `ledger.jsonl`. The CLI is invoked per-call from Bash; nothing lives only in process memory.
- **Hypothesis Manager** *(build)* — holds the version space (candidate invariants + LLM priors); prunes on each verdict; on empty set signals "regenerate" and hands Claude the ledger; runs the convergence test (survivors equivalent over scope + no new distinguishing candidate). **Regeneration is capped at 3 attempts**; at the cap, the invariant is parked in the ledger as an open decision rather than looping forever.
- **Question Planner** *(build, thin)* — selects the next question. Slice-1 scope: distinguishing-XOR generation + boundary probing. **Deferred:** the full MaxSAT balanced split — replaced by "distinguish the highest-combined-prior still-separable pair" (adequate at ≤ ~5 candidates; MaxSAT only earns its keep at scale).
- **Engine Router** *(build)* — routes each candidate/query by shape: relational / cardinality / closure → Alloy; temporal / arithmetic → Quint/Apalache. No composition (see §7, deferred bridge).
- **Grammar Validator** *(build)* — every candidate (seeded or regenerated) must parse into the closed grammar of §6.1; out-of-grammar proposals are rejected with a structured error so Claude can retry.
- **Model Finder adapters** *(build the glue, reuse the solvers)* — see §7.
- **Decision Ledger** *(build)* — append-only JSONL; **the canonical spec artifact** (§3.1): verdicts (witness, judgment, timestamp), structure verdicts from phase 0, open decisions, provenance. Feeds "don't re-ask" and the prose "open decisions" section.
- **Projections writer** *(build)* — AST → `spec.prose.md` (plan §17 shape) and `spec.code` (plan §5.2 shape), each invariant citing its ledger anchors. Only `code←AST` / `solver←AST` directions exist in this slice; prose is a **read-only rendered** view (no prose→AST autoformalization — honoring plan §6).

### 3.1 The ledger is the canonical artifact (pivot insurance, free)

Plan §19's bottom line: if autoformalization proves untrustworthy, the product pivots to "**humans author examples; examples are the ground truth; formulas are derived.**" Slice 1 builds that stance in from day one at zero extra cost: the **verdict ledger is the source of truth**; invariant formulas are *compiled, regenerable artifacts* that must remain consistent with every ledger entry (the engine already re-validates regenerated candidates against the full ledger — the same check applies to all of them). Two consequences: a bad §2.0 result is a pivot, not a rewrite; and the emitted prose spec anchors each invariant to the concrete judged cases behind it — a better trust story for a founder than a formula.

---

## 4. The chat, end to end

### 4.0 Phase 0 — structure elicitation (Claude-only, no solver)

The part of the "20 questions" experience a real user hits *first*, and the prerequisite for everything else: from a fuzzy founder description to a well-formed domain AST.

- **Method:** EventStorming-style intake, recognition over recall applied to *structure*. Claude proposes a concrete structure (aggregates, lifecycles as concrete state lists, events) and asks the founder to correct it — one question per message, multiple-choice where possible ("Is a Contract's line item its own thing with an identity, or just data on the contract?"). The founder never authors structure; they judge proposed structure.
- **Validation:** `engine init` checks well-formedness deterministically — refs resolve, machines are connected, every `@active`/`@terminal` tag is on a real state, key fields exist. Errors return structured diagnostics Claude must resolve by asking, not guessing.
- **Output:** the domain AST registered in the session; structure verdicts appended to the ledger.
- **Budget (trace C):** ≤ 10 structure questions to reach the pre-registered structure.

### 4.1 The invariant elicitation loop (one turn)

```
domain AST (from phase 0)
   │  Claude: templates fire + LLM seeding
   ▼
seed {H1..Hn} + priors ──▶ Hypothesis Manager (holds version space)
                              │
                              ▼
                          Question Planner picks a pair (Hi, Hj)
                              │
                              ▼
                          Engine Router → {Alloy | Quint}
                              │
             ┌────────────────┴─────────────────┐
             ▼                                  ▼
   witness found (instance)              UNSAT over scope
             │                                  │
   engine renders canonical TABLE         Hi ≡ Hj → merge (never ask)
   Claude adds domain-language prose
             │
   expert judges permit/forbid ──▶ Ledger (append) ──▶ prune version space
             │                          (or "we haven't decided" → park
     ┌───────┴────────┐                  as OPEN DECISION, move on)
     ▼                ▼
  not converged    set empty → Claude regenerates a
  → next turn      ledger-consistent H (grammar-validated,
             │     solver-validated; ≤ 3 attempts, then park)
             ▼
     converged → Projections writer emits prose + code (ledger-anchored)
```

---

## 5. The Claude Code interface

This answers the original question — *"is it just an agent skill / markdown?"* Because we chose the faithful engine, the answer is: **a skill front-end *plus* a companion deterministic engine the skill calls.** Markdown alone would only let Claude *simulate* the loop; here the rigorous parts are real code (D9: no simulation — false confidence).

- **The skill** (`elicit-spec`) loads context: the Lattice AST/semantics summary, the templates included in this slice (§9), the elicitation methodology (plan §8/§16), the phase-0 structure-intake protocol (§4.0), and the two projection shapes. It instructs Claude to drive the loop by calling the engine and to do only the NL work (elicit structure, seed, render, regenerate).
- **The engine CLI** (invoked by Claude via Bash; an MCP wrapper is an optional later convenience, not built in this slice) exposes a small, structured surface. Claude passes **structured data (JSON), not free text** — so the engine builds the AST directly and there is no concrete-syntax parser in this slice (see §6). **Every command takes `--session <dir>`.**

| Command | Who calls | Does |
|---|---|---|
| `engine init --model <json>` | Claude | Build + validate the domain AST (entities, aggregates, machine, tags) from structured data; structured diagnostics on ill-formedness |
| `engine propose --candidates <json>` | Claude | Register seed candidate invariants + priors; **each must parse into the §6.1 grammar** |
| `engine next-question` | Claude | Run Question Planner → route → return a distinguishing witness (or `merged`, or `converged`) as structured data **plus the canonical witness table (markdown)** |
| `engine witness show <id>` | Claude | Re-render the canonical table for a prior witness |
| `engine verdict --witness <id> --judge permit\|forbid\|undecided` | Claude | Append to Ledger; prune (`undecided` parks an open decision); may return `regenerate` (set empty) with the ledger |
| `engine regenerate --candidate <json>` | Claude | Submit a synthesized candidate; engine validates **grammar + consistency with every prior verdict** (solver check) before admitting it; attempt 4+ is rejected → park |
| `engine status` | Claude | Current candidate set, convergence state, ledger |
| `engine emit --prose --code <path>` | Claude | Write the projections on convergence, ledger anchors included |

Division of labor is exactly plan §7: **Claude = fuzzy NL; engine + solvers = rigorous bookkeeping and witness generation.**

### 5.1 Witness rendering — guarding the reverse direction of Risk 1

The §2.0 gate tests autoformalization *forward* (rule → formula). The loop also depends on the *reverse* direction: solver witness → domain question. If Claude narrates a witness incorrectly, the expert answers a different question than the solver asked, and the ledger silently records a corrupted verdict. Two guards:

1. **Dual render, table is ground truth.** The engine deterministically renders every witness as a canonical entity/field table (no LLM involved). The skill **must display this table verbatim**; Claude's prose narration is additive sugar on top, never a substitute. The expert always sees the mechanical truth.
2. **Decorrelated parse-back (golden-run harness only).** In the golden scripts, Claude's prose question is handed to a *fresh context* (no access to the original witness) to parse back into a structured instance; the harness diffs it against the actual witness. Divergence = a rendering-fidelity failure, counted toward kill criterion 3. This is harness instrumentation, not a per-turn cost.

---

## 6. The DSL, the AST, and why there is no parser yet

Two distinct languages doing two jobs — do not conflate them:

- **Lattice** is the new DSL. Its *code projection* (the `context Billing { aggregate Subscription { … } }` syntax of plan §5.2) is a **new grammar** in `.lat` files. This is the language being invented.
- **TypeScript** is the *implementation language of the tooling* — the AST types, the compilers, the loop engine are written in TS. TS is **not** the DSL. (Chosen because Quint is a native TS/npm library and TS has the strongest DSL tooling.)

Pipeline:

```
billing.lat            ← Lattice source (the NEW grammar; NOT built in slice #1)
   │  parser (DEFERRED)
   ▼
AST                    ← plain TypeScript data types, e.g.
                         type Aggregate = { kind:'aggregate'; name:string;
                           fields:Field[]; machine?:Machine; invariants:Invariant[] }
   │  emitters (TS tree-walks → strings)
   ├──▶ astToAlloy(ast) → ".als"    (feed Alloy)
   ├──▶ astToQuint(ast) → ".qnt"    (feed Quint/Apalache)
   ├──▶ astToProse(ast) → markdown  (plan §17 read view)
   └──▶ astToCode(ast)  → ".lat"    (pretty-print the code projection)
```

**Why no concrete-syntax parser in slice #1:** in the elicitation loop the domain expert never types Lattice (plan §6 — they judge cases; the engine writes the code). Claude submits candidates as **structured data** through the engine CLI, so the engine **constructs AST nodes directly**. The code projection is **output-only** (pretty-printed from the AST). So *"what creates the AST"* in this slice is the **engine's AST constructors from Claude's structured proposals — not a text parser.** Building the AST types + all four emitters *is* the substance of the language (semantics + compilation + projections); the front-door parser is orthogonal.

**When the parser lands (later slice):** when an engineer hand-edits the `.lat` code projection and reloads it. Recommended tool at that point: **Langium** (TS-native; one grammar yields AST + validation + LSP + editor highlighting — exactly what "code projection: diff-able, PR-able, engineers read/write it" wants).

### 6.1 The closed candidate-invariant grammar — the real contract between Claude and the engine

Both emitters must be **total** over candidates, and regeneration must be **validatable** — which is only possible if candidates live inside a fixed grammar. This grammar (a TypeScript discriminated union) is essentially the slice's eight template schemas plus a small set of combinators; every form carries its engine-routing tag:

| Form | Shape | Routes to |
|---|---|---|
| State predicate | comparisons (`= ≠ < ≤`) over Int/Money/Date/Duration/enum/machine-state fields; boolean connectives; `implies` | by operands |
| Quantified structural | `forall`/`exists` over an aggregate's instances; ref-resolution (`every ref resolves`) | Alloy |
| Uniqueness | `unique while <state> by (<key paths>)`; cardinality `count(…) ≤ n` | Alloy |
| Aggregation | `sum` over a collection field, compared linearly (fold-safe, per plan's fold-only discipline) | Quint |
| Temporal safety | `always P`; `once S: stays S` (terminal); `only increases` (monotonic) | Quint |
| Temporal liveness | `P leads-to Q under fairness(…)` — **template-instantiated only** in this slice (never LLM-freeform) | Quint |
| Guarded scope | any of the above under a `where <state predicate>` guard | unchanged |

`engine propose` / `engine regenerate` reject anything outside this grammar with a structured error naming the offending node, so Claude can reformulate. Growing the grammar is a deliberate, versioned act in later slices — not something the LLM does implicitly.

---

## 7. Engines & routing

**Language:** the engine is **TypeScript / Node.**

**Alloy 6 adapter** (structural). `astToAlloy` emits signatures for the domain and predicates for each candidate. Distinguishing query:
```alloy
run distinguish { (Hi and not Hj) or (not Hi and Hj) } for <scope>
```
An instance ⇒ the witness (parse Alloy's instance output). **Enumerate successive distinct instances** ("next") for boundary probes — native to Alloy. UNSAT over scope ⇒ `Hi ≡ Hj` ⇒ merge. Reachability for the structural golden invariant is trivial (two active in a family is directly constructible), so no machine-run composition is needed. Integration: **JVM subprocess** (Alloy is a Java jar). **Spike task (first adapter task, half-day):** Alloy's CLI/XML instance output is a known annoyance — validate stdout/XML parsing on a toy model first, and fall back to a thin Java shim over the Alloy API if parsing is brittle. The spike also measures cold/warm JVM latency against the §2.4 budget.

**Quint / Apalache adapter** (temporal/arithmetic). `astToQuint` emits the state machine + candidate predicates. A distinguishing witness is obtained by checking the **equivalence itself** as an invariant — a counterexample to `iff(Hi, Hj)` is precisely a reachable state where the candidates disagree:
```
quint verify spec.qnt --invariant="iff(Hi, Hj)"   # Apalache (SMT/Z3), exhaustive to bound
#   counterexample (ITF JSON)  ⇒ the distinguishing witness
#   no counterexample to bound ⇒ Hi ≡ Hj over scope ⇒ merge
# quint run … for fast randomized feedback during development
```
*(Rev-1 of this doc had the query inverted as `not(iff(Hi,Hj))` — that would return a state where the candidates **agree**. Model checkers falsify invariants; to find disagreement, the invariant to falsify is the agreement.)* For a *different* witness (boundary probe), add an exclusion constraint and re-verify. Reachability is native (Quint checks a transition system). Integration: **native TS** (`@informalsystems/quint`) + **Apalache** (JVM) for exhaustive `verify`. The adapter spike also measures Apalache verify latency on the trace-B/C models against the §2.4 budget (warm-start the JVM if needed — Apalache has a server mode).

**Honest asymmetry (budgeted):** boundary probing is *native enumeration* in Alloy and *hand-rolled via exclusion constraints* in Quint. Doing both engines means implementing witness-generation two ways. This is the accepted cost of covering both invariant paradigms in slice #1 (D3, reaffirmed after review — D9).

**Deferred — the two-engine Reachability-Bridge** (plan §19 Risk 5): composing Alloy's structural finding with Apalache's temporal run inside a *single* query. Routing (one engine per invariant) covers all three golden traces — including trace C's mixed residual, whose relational hop is simple enough for Quint records/filters and whose structural invariants route whole to Alloy; the bridge is added only when a witness must be structural-*and*-temporally-reachable at once. Deferring it does **not** cost reachability filtering — each engine filters on its own side.

---

## 8. The fidelity gate (full plan-§20, not a mini)

Isolates the existential, correlated risk (autoformalization, plan §19 Risk 1) so a loop failure is diagnosable rather than ambiguous. **Runs strictly before adapter/engine work** — it requires no engine, only Claude, the §6.1 grammar types, and human judgment. Full protocol and thresholds in §2.0.

If fidelity is clean, a loop underperformance is a *loop-design* problem; if not, the culprit is autoformalization, and the redesign (humans author examples, formulas are derived — already structurally accommodated by §3.1) is indicated **before** two solver adapters have been built on top of it. The billing-vs-revrec split additionally tells us whether fidelity degrades with domain novelty — which directly informs how much to trust trace-C seeding.

---

## 9. Templates included in this slice

Enough of the plan §10.2 catalog to (a) power the three golden traces and (b) reproduce the §16 "invariants come free" moment so the *felt* value is present — in trace C as well as billing:

| # | Template | Engine | Why included |
|---|---|---|---|
| 7 | Single-active (uniqueness) | Alloy | Golden trace A; trace C (one Open period) |
| 11 | Deadline / grace bound | Quint | Golden trace B |
| 6 | Cross-aggregate coupling | Quint\* | Golden trace B (active sub ↔ unpaid invoice) |
| 3 | Terminal state | Quint | Auto-adopted, "comes free"; trace C (Closed stays Closed) |
| 9 | No orphan (referential integrity) | Alloy | Auto-adopted, "comes free"; trace C (entries resolve) |
| 2 | Non-negative balance | Quint | Auto-adopted, "comes free" |
| 1 | Money conservation | Quint | **Trace C** (recognized + deferred == allocated) |
| 8 | No period reuse / monotonic | Quint | **Trace C** (cumulative recognized only increases) |

The remaining four templates (idempotency, reservation-release, ordered lifecycle, saga net-zero) are **deferred** to later slices.

**\* On template #6:** it is genuinely *mixed* — plan §10.2 lists its engine as "relational + temporal" (navigate the sub→invoice `ref`, *and* check the grace-window date arithmetic). Without the Reachability-Bridge, slice #1 routes it to the engine handling its **dominant/interesting** check — here the temporal/arithmetic side, so **Quint**; the relational hop (a sub to its latest invoice) is a simple functional lookup Quint expresses acceptably via records/filter. **This is the concrete future motivation for the bridge** (§7, deferred): when a mixed invariant's *relational* side is complex enough to want Alloy *and* its temporal side wants Apalache in the same witness, routing no longer suffices. Trace C's residual (entry–period posting rules) is mixed the same way and is handled the same way.

---

## 10. Scope of work

Ordered; item 1 gates everything after it.

1. **Fidelity gate (§2.0/§8)** — §6.1 grammar types + the 20-rule harness + human judgment pass. **No adapter work until read against thresholds.**
2. **Minimal Lattice AST** (TypeScript types) — enough for the three domains: `entity` / `aggregate` / `enum` / `machine` (states, `@active`/`@terminal` tags) / `invariant` / the §6.1 candidate grammar. No concrete-syntax parser.
3. **Session Store** — `--session <dir>`: `state.json` + `ledger.jsonl`; every CLI command loads/persists.
4. **`astToAlloy`** compiler (+ **Alloy output-parsing spike**, first).
5. **`astToQuint`** compiler (+ Apalache latency spike).
6. **`astToProse`** + **`astToCode`** projections writer (ledger anchors included).
7. **Engine Router** (shape → engine, per §6.1 routing tags) + **Grammar Validator**.
8. **Hypothesis Manager** (version space, prune, convergence test, regeneration cap 3 → park) + **Question Planner** (distinguishing-pair selection, boundary probe).
9. **Alloy adapter** (subprocess, run, parse + enumerate instances) + **canonical witness-table renderer** (deterministic, engine-side).
10. **Quint adapter** (npm Quint + Apalache `verify iff(Hi,Hj)`, parse ITF, exclusion-constraint probes, tick-granularity units rendering).
11. **Decision Ledger** (JSONL append + provenance + open decisions + structure verdicts).
12. **Claude Code skill** (`elicit-spec`) — phase-0 structure protocol + loop protocol + dual-render rule — and **engine CLI** wiring (Bash-invokable; MCP wrapper optional, later).
13. **Three golden scripts** asserting convergence + expected witnesses (A: §8.5/Alloy; B: §16 Q1-Q2/Quint; C: rev-rec end-to-end incl. phase 0, the parked open decision, and both engines), each exercising its hard path, with the decorrelated parse-back check (§5.1) and latency measurement (§2.4) wired into the harness.

---

## 11. Explicitly deferred (and the hypothesis each belongs to)

| Deferred | Belongs to | Why safe to defer for slice #1 |
|---|---|---|
| Reachability-Bridge (composed two-engine query) | Robustness / scale | Routing covers all three golden traces; reachability handled per-engine (Risk 5) |
| Full MaxSAT balanced split | Scale | Trivial at ≤ ~5 candidates; greedy heuristic reproduces the golden traces |
| Concrete-syntax parser (`.lat` → AST) | Engineer authoring | Expert never types Lattice; Claude feeds AST as data; code is output-only |
| Conformance adapter (spec ↔ impl) | **H-conformance (slice #2)** | Different hypothesis — anti-drift, not elicitation |
| Runtime monitors ③, DST ④, mining flywheel, multi-expert votes | Oracle / flywheel | Orthogonal to whether elicitation works |
| Remaining 4 templates (idempotency, reservation-release, ordered lifecycle, saga net-zero) | Coverage | Not needed by the three golden traces |
| Novel-domain economics at large (many domains, no pre-registration) | Later measurement | Trace C is one semi-scripted data point, deliberately not a verdict |
| Grammar growth (LLM-proposed new invariant *forms*) | Language evolution | §6.1 is versioned and closed; widening it is a deliberate later act |

---

## 12. Risks specific to this slice

1. **Two-engine integration surface roughly doubles** — the named, accepted cost of "do both" (D3/D9). Two adapters, two witness-generation strategies, two output parsers. Mitigated by the two spikes (Alloy parsing, Apalache latency) running first within their build items.
2. **Autoformalization fidelity (Risk 1) bites in two places** — Claude *seeding* candidates and Claude *rendering* witnesses back to prose. Mitigations: the §2.0 gate (forward direction, full size, strictly first); dual-render with the deterministic table as ground truth + decorrelated parse-back in the harness (reverse direction, §5.1).
3. **Solver latency vs. chat viability** — JVM boot + SMT per question could make the chat feel dead regardless of question quality. Pre-registered budget (§2.4), measured in the golden harness; warm-start/server-mode as the engineering lever; kill criterion 4 if unfixable.
4. **Quint boundary-probe ergonomics** — no native enumeration; boundary probes on the temporal invariant require exclusion-constraint re-queries. Budgeted in §7.
5. **JVM dependency** for Alloy (and Apalache) — a heavier runtime than a pure-TS engine. Accepted for the capability.
6. **Trace C interactive variance** — a live human session is less reproducible than a scripted trace. Mitigated by pre-registering the founder description, the target structure, the ground truths, the verdict policy, and the budgets (§2.3), so pass/fail is objective even though the session is real.

---

## 13. Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | Build the **end-to-end thesis** (real solvers), not a UX-only simulation | User goal: test the actual loop, not a faked one |
| D2 | **Faithful engine first** (deterministic engine + minimal AST + compilers), Claude confined to NL Translator | Matches plan §7; keeps the rigorous parts out of the LLM |
| D3 | **Both engines, routed by shape** (Alloy structural + Quint/Apalache temporal-arith) | User choice; covers both invariant paradigms in one slice |
| D4 | **Reachability-Bridge deferred** | Risk 5 (least prior art); routing suffices; reachability handled per-engine |
| D5 | **Engine in TypeScript** | Quint is native TS; best DSL tooling |
| D6 | **Concrete-syntax parser deferred**; AST fed as structured data; code output-only | Expert never types Lattice; trims a hard build item without weakening the demo |
| D7 | **Fidelity gate + "free" templates folded in** | Makes a slice-1 result diagnosable; reproduces the felt "invariants come free" value |
| D8 | Engine selection: **Alloy 6** for structural, verified against Quint | Alloy natively enumerates distinguishing instances + relational/multiplicity/closure primitives; Quint/TLA+/Apalache is weak at structural and non-enumerating (negation→one counterexample). Evidence: Quint docs (builtin ops, checking-properties), Alloy 6 docs. Alloy actively maintained (6.2.0, 2025-01-09) |
| D9 | **No Wizard-of-Oz / simulated loop, in any phase** (user decision, design review) | A simulated loop can feel good while the real mechanism fails — false confidence is worse than the time saved. Reaffirms D1/D3: both real engines, together |
| D10 | **Fidelity gate at full §20 size (20 rules: 10 billing + 10 rev-rec), strictly before adapter work** | 5 rules made the thresholds statistically meaningless; "alongside" defeated the gate; the split measures fidelity degradation on the novel domain |
| D11 | **Phase 0 structure elicitation included** (Claude-only, engine-validated) | The first thing a real user experiences; prerequisite for the loop; needs no solver, so nearly free |
| D12 | **Golden trace C: AI-native revenue recognition (Rillet-style) as the novel domain** — end-to-end, interactive, semi-scripted, both engines; pulls templates #1 and #8 into the slice | A/B are both billing — the domain where the loop matters least by the plan's own framing (§8, §16); C tests the loop where it earns its keep, and exercises the open-decision path A/B never touch |
| D13 | **The verdict ledger is the canonical artifact; formulas are derived/regenerable** | Plan §19's pivot ("examples are the ground truth") becomes free instead of a rewrite; also a better founder trust story |
| D14 | **Witness dual-render (deterministic engine table + Claude prose) + decorrelated parse-back in the golden harness** | Guards the *reverse* direction of Risk 1, which the fidelity gate (forward) cannot see |
| D15 | **Quint distinguishing query is `verify --invariant="iff(Hi,Hj)"`** (rev-1 had it inverted) | Checkers falsify invariants; a counterexample to the *agreement* is the disagreement witness |
| D16 | **Pre-registered latency budget (p50 ≤ 10s, max ≤ 45s) and concrete kill numbers (> 4 judgments/invariant A/B; > 8 total residual C)** | "Reasonable question count" and "usable as chat" were unmeasurable as written |
