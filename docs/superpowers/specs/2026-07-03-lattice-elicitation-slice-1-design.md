# Lattice — Slice #1 Design: The Elicitation Chat, End-to-End, Two Engines

- **Date:** 2026-07-03
- **Status:** Design (approved for planning)
- **Parent design:** [`docs/plan.md`](../../plan.md) — the full Lattice architecture. This document is the first buildable vertical slice of it.
- **Next step:** `writing-plans` → a step-by-step implementation plan.

---

## 0. One-paragraph summary

Build the first vertical slice of Lattice: a domain expert chats with Claude Code, which drives a *recognition-over-recall* elicitation loop backed by **real model finders**. Claude proposes candidate invariants; for each open question a solver manufactures a concrete **distinguishing witness**; the expert judges permit/forbid on that concrete case; the version space prunes; on convergence Claude writes a human-readable **prose** spec and a **code-projection** spec. It is demonstrated on **two golden invariants — one structural (Alloy 6), one temporal/arithmetic (Quint/Apalache)** — routed to the right engine automatically by invariant shape. This slice tests exactly one hypothesis: *the agent-pays-the-tax, human-judges-cases loop produces a correct spec in few questions.* It deliberately does **not** test anti-drift, scale, or arithmetic-at-depth — those are separate hypotheses and later slices.

---

## 1. What this slice validates — and what it does not

Being explicit here is the whole point: a result is only meaningful if the claim is scoped, so that a failure points at a *specific* cause rather than "we didn't finish."

**Validates (Hypothesis H-elicit):**
- Claude can seed candidate invariants from a domain description (autoformalization, forward direction).
- A real model finder can manufacture a **distinguishing, minimal, reachable witness** that separates two candidate invariants.
- Rendering that witness as a domain-language yes/no question, and pruning on the verdict, **converges** on the intended invariant in a small number of judgments.
- The loop works across **two invariant paradigms** (structural and temporal/arithmetic) via **shape-based routing** to two engines.
- On convergence, the same underlying representation emits both a **prose** projection (what the expert reads) and a **code** projection (what an engineer reads).

**Does NOT validate (out of scope — other hypotheses / later slices):**
- **Anti-drift / conformance** (the anti-Rebel keystone, plan §11.5, Risk 6). This is *"does the spec stay synced to code?"* — a different question. **Slice #2.**
- **Scale** (Stripe-sized model, many aggregates, many candidates → the full MaxSAT machinery).
- **Novel-domain elicitation** where templates contribute little and the loop does most of the work at higher question cost (plan §8 intro, §16 "read the ratio honestly").
- **Arithmetic fidelity at depth** (nonlinear proration, rounding, real-time) — plan §15, Risk 2.
- **Oracle targets ③ (runtime monitors) and ④ (DST)**, and the **reverse mining flywheel** (§18).

**A slice-1 result must not be read as a verdict on any of the above.**

---

## 2. Success criteria

**Golden trace A — structural, routed to Alloy 6** (reproduces plan §8.5):
- Domain: `Customer`, `Plan { family }`, `Subscription { customer, plan, active }`.
- Hidden ground truth: `H3 = ≤1 active per (customer, family)`.
- Seed candidates `{H1: per-customer, H2: per-plan, H4: unlimited}` with priors.
- Expected trace: Q1 witness `DPSF` (two active, same customer, different plan, **same** family) → expert forbids → prune H2, H4. Boundary probe Q2 witness `DPDF` (two active, different family) → expert permits → refute H1 → **candidate set empties → regenerate** → LLM synthesizes H3 → converge.
- **Must exercise the hard path:** a regeneration *and* a boundary-probe refutation, not just simple pruning.

**Golden trace B — temporal/arithmetic, routed to Quint/Apalache** (reproduces plan §16 Q1/Q2):
- Domain: `Subscription` (Access × Billing), `Invoice { dueDate, status }`, a `grace` duration.
- Question: "Active subscription, latest invoice unpaid & *N* past due — valid?" Q1: 5 **days** past due → forbid. Q2: 5 **hours** past due → permit.
- Converge on: *Active-while-unpaid only within `grace` of the due date.*
- Exercises time/duration comparison (arithmetic) over a state property (temporal) → confirms routing to the SMT-backed engine, not Alloy.

**Mini-§20 fidelity gate** (see §8): on ~5 real billing rules, the measured *subtle-wrong* rate must land in the plan's viable band (< ~10% → proceed as designed; 10–30% → flag the example-set-as-spec pivot; > 30% → stop and rethink before building further).

**Kill criterion (pre-registered).** The loop is judged *not delivering* if any of these hold on the golden traces:
1. Distinguishing witnesses are routinely **unreachable or unintelligible** as domain questions (a human can't judge them without analysis).
2. Convergence needs **> 2×** the questions a domain expert would consider reasonable for the same invariant.
3. The solver frequently returns witnesses that **typecheck but are semantically wrong** (autoformalization failure surfacing in the loop rather than in the mini-§20 gate).

---

## 3. Architecture

Minimal realizations of the components in plan §7. Everything rigorous is deterministic code; the only non-deterministic part is Claude (the NL Translator), and its every formalization is re-checked by a solver ("LLM proposes, Model Finder disposes").

```
 ┌─ INTERFACE ─────────────────────────────────────────────────────────────┐
 │  Claude Code  =  NL Translator                                          │
 │    · domain description → seed candidate invariants (+priors)           │
 │    · solver witness → domain-language yes/no question                   │
 │    · parse verdict; on "regenerate", synthesize a ledger-consistent H   │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  structured calls (CLI via Bash) — NOT free text
 ┌─ ELICITATION ENGINE  (deterministic, TypeScript) ────────────────────────┐
 │  Hypothesis Manager   version space · prune · convergence test          │
 │  Question Planner      distinguishing-pair selection · boundary probe    │
 │  Engine Router         invariant shape → Alloy | Quint                  │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  "find a witness where Hi, Hj disagree (reachable, minimal)"
 ┌─ MODEL FINDERS  (two, routed) ───────────────────────────────────────────┐
 │  Alloy adapter    AST→.als · run distinguish · parse+enumerate instances │
 │  Quint adapter    AST→.qnt · verify not(iff) · parse ITF counterexample  │
 └───────────────┬──────────────────────────────────────────────────────────┘
 ┌─ MEMORY / OUTPUT ────────────────────────────────────────────────────────┐
 │  Decision Ledger (append-only JSONL)  ·  Projections writer (prose+code) │
 └──────────────────────────────────────────────────────────────────────────┘
```

**Component responsibilities:**
- **NL Translator (Claude Code)** — chat front-end + example intake. The only LLM-driven part. Guardrail: every candidate it proposes and every regeneration it synthesizes is validated by a solver before it is trusted.
- **Hypothesis Manager** *(build)* — holds the version space (candidate invariants + LLM priors); prunes on each verdict; on empty set signals "regenerate" and hands Claude the ledger; runs the convergence test (survivors equivalent over scope + no new distinguishing candidate).
- **Question Planner** *(build, thin)* — selects the next question. Slice-1 scope: distinguishing-XOR generation + boundary probing. **Deferred:** the full MaxSAT balanced split — replaced by "distinguish the highest-combined-prior still-separable pair" (adequate at ≤ ~5 candidates; MaxSAT only earns its keep at scale).
- **Engine Router** *(build)* — routes each candidate/query by shape: relational / cardinality / closure → Alloy; temporal / arithmetic → Quint/Apalache. No composition (see §7, deferred bridge).
- **Model Finder adapters** *(build the glue, reuse the solvers)* — see §7.
- **Decision Ledger** *(build)* — append-only JSONL: verdicts (witness, judgment, timestamp), open decisions, provenance. Feeds "don't re-ask" and the prose "open decisions" section.
- **Projections writer** *(build)* — AST → `spec.prose.md` (plan §17 shape) and `spec.code` (plan §5.2 shape). Only `code←AST` / `solver←AST` directions exist in this slice; prose is a **read-only rendered** view (no prose→AST autoformalization — honoring plan §6).

---

## 4. The elicitation loop (one turn)

```
domain description
   │  Claude
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
   Claude renders as domain Q            Hi ≡ Hj → merge (never ask)
             │
   expert judges permit/forbid ──▶ Ledger (append) ──▶ prune version space
             │
     ┌───────┴────────┐
     ▼                ▼
  not converged    set empty → Claude regenerates a
  → next turn      ledger-consistent H (solver-validated) → next turn
             │
             ▼
     converged → Projections writer emits prose + code
```

---

## 5. The Claude Code interface

This answers the original question — *"is it just an agent skill / markdown?"* Because we chose the faithful engine, the answer is: **a skill front-end *plus* a companion deterministic engine the skill calls.** Markdown alone would only let Claude *simulate* the loop; here the rigorous parts are real code.

- **The skill** (`elicit-spec`) loads context: the Lattice AST/semantics summary, the templates included in this slice (§9), the elicitation methodology (plan §8/§16), and the two projection shapes. It instructs Claude to drive the loop by calling the engine and to do only the NL work (seed, render, regenerate).
- **The engine CLI** (invoked by Claude via Bash; an MCP wrapper is an optional later convenience, not built in this slice) exposes a small, structured surface. Claude passes **structured data (JSON), not free text** — so the engine builds the AST directly and there is no concrete-syntax parser in this slice (see §6):

| Command | Who calls | Does |
|---|---|---|
| `engine init --model <json>` | Claude | Build the domain AST (entities, aggregates, machine, tags) from structured data |
| `engine propose --candidates <json>` | Claude | Register seed candidate invariants + priors into the version space |
| `engine next-question` | Claude | Run Question Planner → route → return a distinguishing witness (or `merged`, or `converged`) as structured data |
| `engine verdict --witness <id> --judge permit\|forbid` | Claude | Append to Ledger; prune; may return `regenerate` (set empty) with the ledger |
| `engine regenerate --candidate <json>` | Claude | Submit a synthesized candidate; engine **validates it against every prior verdict** (solver check) before admitting it |
| `engine status` | Claude | Current candidate set, convergence state, ledger |
| `engine emit --prose --code <path>` | Claude | Write the projections on convergence |

Division of labor is exactly plan §7: **Claude = fuzzy NL; engine + solvers = rigorous bookkeeping and witness generation.**

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

---

## 7. Engines & routing

**Language:** the engine is **TypeScript / Node.**

**Alloy 6 adapter** (structural). `astToAlloy` emits signatures for the domain and predicates for each candidate. Distinguishing query:
```alloy
run distinguish { (Hi and not Hj) or (not Hi and Hj) } for <scope>
```
An instance ⇒ the witness (parse Alloy's instance output). **Enumerate successive distinct instances** ("next") for boundary probes — native to Alloy. UNSAT over scope ⇒ `Hi ≡ Hj` ⇒ merge. Reachability for the structural golden invariant is trivial (two active in a family is directly constructible), so no machine-run composition is needed. Integration: **JVM subprocess** (Alloy is a Java jar); parse instances from its output.

**Quint / Apalache adapter** (temporal/arithmetic). `astToQuint` emits the state machine + candidate predicates. A distinguishing witness is obtained by checking the **negated equivalence** as an invariant:
```
quint verify spec.qnt --invariant="not(iff(Hi, Hj))"   # Apalache (SMT/Z3), exhaustive to bound
# quint run … for fast randomized feedback during development
```
The counterexample (ITF JSON) is the witness. For a *different* witness (boundary probe), add an exclusion constraint and re-verify. Reachability is native (Quint checks a transition system). Integration: **native TS** (`@informalsystems/quint`) + **Apalache** (JVM) for exhaustive `verify`.

**Honest asymmetry (budgeted):** boundary probing is *native enumeration* in Alloy and *hand-rolled via exclusion constraints* in Quint. Doing both engines means implementing witness-generation two ways. This is the accepted cost of covering both invariant paradigms in slice #1.

**Deferred — the two-engine Reachability-Bridge** (plan §19 Risk 5): composing Alloy's structural finding with Apalache's temporal run inside a *single* query. Routing (one engine per invariant) covers slice #1; the bridge is added only when a witness must be structural-*and*-temporally-reachable at once. Deferring it does **not** cost reachability filtering — each engine filters on its own side.

---

## 8. The mini-§20 fidelity harness

Isolates the existential, correlated risk (autoformalization, plan §19 Risk 1) so a loop failure is diagnosable rather than ambiguous.

- Collect **~5 real billing rules** (e.g. proration, dunning, trial expiry, refund, plan change).
- Claude formalizes each into a candidate invariant AST.
- The engine generates **3 "obvious" cases** per rule; keep formalizations that pass all 3.
- Solicit **1 adversarial case** per surviving formalization (a 4th case a domain expert would flag) and check whether the formalization agrees with intent.
- **Measure the subtle-wrong rate** and read it against plan §20 thresholds (< ~10% viable as designed; 10–30% → example-set-as-spec pivot; > 30% → stop).

Run this **before/alongside** the golden traces. If fidelity is clean, a loop underperformance is a *loop-design* problem; if not, the culprit is autoformalization, and the redesign (humans author examples, formulas are derived) is indicated.

---

## 9. Templates included in this slice

Enough of the plan §10.2 catalog to (a) power the two golden invariants and (b) reproduce the §16 "invariants come free" moment so the *felt* value is present:

| # | Template | Engine | Why included |
|---|---|---|---|
| 7 | Single-active (uniqueness) | Alloy | Golden trace A |
| 11 | Deadline / grace bound | Quint | Golden trace B |
| 6 | Cross-aggregate coupling | Quint\* | Golden trace B (active sub ↔ unpaid invoice) |
| 3 | Terminal state | Quint | Auto-adopted, "comes free" |
| 9 | No orphan (referential integrity) | Alloy | Auto-adopted, "comes free" |
| 2 | Non-negative balance | Quint | Auto-adopted, "comes free" |

The remaining six templates (money conservation, idempotency, reservation-release, monotonic period, ordered lifecycle, saga net-zero) are **deferred** to later slices.

**\* On template #6:** it is genuinely *mixed* — plan §10.2 lists its engine as "relational + temporal" (navigate the sub→invoice `ref`, *and* check the grace-window date arithmetic). Without the Reachability-Bridge, slice #1 routes it to the engine handling its **dominant/interesting** check — here the temporal/arithmetic side, so **Quint**; the relational hop (a sub to its latest invoice) is a simple functional lookup Quint expresses acceptably via records/filter. **This is the concrete future motivation for the bridge** (§7, deferred): when a mixed invariant's *relational* side is complex enough to want Alloy *and* its temporal side wants Apalache in the same witness, routing no longer suffices.

---

## 10. Scope of work

1. **Minimal Lattice AST** (TypeScript types) — just enough for the two domains: `entity` / `aggregate` / `enum` / `machine` (states, `@active`/`@terminal` tags) / `invariant` / candidate-invariant forms. No concrete-syntax parser.
2. **`astToAlloy`** compiler.
3. **`astToQuint`** compiler.
4. **`astToProse`** + **`astToCode`** projections writer.
5. **Engine Router** (shape → engine).
6. **Hypothesis Manager** (version space, prune, convergence test) + **Question Planner** (distinguishing-pair selection, boundary probe).
7. **Alloy adapter** (subprocess, run, parse + enumerate instances).
8. **Quint adapter** (npm Quint + Apalache verify, parse ITF).
9. **Decision Ledger** (JSONL append + provenance).
10. **Claude Code skill** (`elicit-spec`) + **engine CLI** wiring (Bash-invokable; MCP wrapper optional, later).
11. **Mini-§20 fidelity harness.**
12. **Two golden scripts** asserting convergence + expected witnesses (A: §8.5 / Alloy; B: §16 Q1/Q2 / Quint), each exercising the hard path.

---

## 11. Explicitly deferred (and the hypothesis each belongs to)

| Deferred | Belongs to | Why safe to defer for slice #1 |
|---|---|---|
| Reachability-Bridge (composed two-engine query) | Robustness / scale | Routing covers both golden invariants; reachability handled per-engine (Risk 5) |
| Full MaxSAT balanced split | Scale | Trivial at ≤ ~5 candidates; greedy heuristic reproduces the golden traces |
| Concrete-syntax parser (`.lat` → AST) | Engineer authoring | Expert never types Lattice; Claude feeds AST as data; code is output-only |
| Conformance adapter (spec ↔ impl) | **H-conformance (slice #2)** | Different hypothesis — anti-drift, not elicitation |
| Runtime monitors ③, DST ④, mining flywheel, multi-expert votes | Oracle / flywheel | Orthogonal to whether elicitation works |
| Remaining 6 templates | Coverage | Not needed by the two golden invariants |

---

## 12. Risks specific to this slice

1. **Two-engine integration surface roughly doubles** — the named, accepted cost of "do both." Two adapters, two witness-generation strategies, two output parsers.
2. **Autoformalization fidelity (Risk 1) bites in two places** — Claude *seeding* candidates and Claude *rendering* witnesses back to prose. Rendering an Apalache ITF counterexample as a legible domain question is harder than rendering an Alloy instance. Mitigation: the mini-§20 gate (§8); judge concrete cases, never confirm prose.
3. **Quint boundary-probe ergonomics** — no native enumeration; boundary probes on the temporal invariant require exclusion-constraint re-queries. Budgeted in §7.
4. **JVM dependency** for Alloy (and Apalache) — a heavier runtime than a pure-TS engine. Accepted for the capability.

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
| D7 | **Mini-§20 fidelity check + extra "free" templates folded in** | Makes a slice-1 result diagnosable; reproduces the felt "invariants come free" value |
| D8 | Engine selection: **Alloy 6** for structural, verified against Quint | Alloy natively enumerates distinguishing instances + relational/multiplicity/closure primitives; Quint/TLA+/Apalache is weak at structural and non-enumerating (negation→one counterexample). Evidence: Quint docs (builtin ops, checking-properties), Alloy 6 docs. Alloy actively maintained (6.2.0, 2025-01-09) |
```
