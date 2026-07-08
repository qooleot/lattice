# A Verifiable, Domain-Driven Specification Language for the AI-Agent Era

*Working name: **Lattice** (placeholder — rename freely).*
*Status: design plan, synthesized from an extended design conversation. Not yet built.*

---

## 0. One-paragraph thesis

Markdown spec-driven development (Kiro, Spec Kit, OpenSpec) fails because prose has no semantics: an AI agent fills the gaps by plausibility and drifts. Classical formal methods (TLA+, Alloy, Dafny) don't fail on rigor — they fail on the **adoption cliff**: humans pay a huge up-front formalization tax for a delayed, binary payoff, so they quit. **The agent changes that economics.** If the agent pays the formalization tax and the human only ever *judges concrete cases* at the altitude they think in (domain concepts, examples, forbidden states), you can have a specification that is simultaneously (a) readable by domain experts, (b) precise enough for an agent to implement with confidence, and (c) mechanically checkable. Lattice is that specification: **one language (an AST with prose/code/diagram projections), one elicitation loop (recognition over recall), and one oracle (the same invariants compiled to four verification targets).**

---

## Table of contents

1. Motivation & what's wrong with today's options
2. Prior art and what we take from each
3. Core thesis: one language, one loop, one oracle
4. Concept ledger: keep / merge / drop
5. The language
6. The three projections (and the honest round-trip decision)
7. Architecture
8. The elicitation loop in detail
9. Candidate sources (where invariants come from)
10. The invariant-template catalog & how templates are authored
11. The Oracle Compiler and its four targets — in full
12. The Decision Ledger
13. Domain events vs. transitions
14. Concurrency: races and sagas (why the behavioral checker exists)
15. Model-checking scope & decidability — the honest ceiling
16. The question-minimizing LLM conversation (worked)
17. The human-readable spec (worked)
18. Improvement flows — the flywheel
19. Risks & open research questions
20. The first experiment to run (autoformalization fidelity)
21. Recommended build sequence
22. Glossary & references

---

## 1. Motivation & what's wrong with today's options

Two failure modes bracket the design space:

- **Prose SDD (Kiro / GitHub Spec Kit / OpenSpec).** The spec is natural language, so it cannot *judge* an implementation. "Moves to active when the trial ends, unless payment fails" is not a function — it's a vibe. The agent invents the unstated cases; two agents invent different ones. The spec can never be an oracle, so "confidence" is unfounded.

- **Classical formal methods (TLA+, Alloy, Dafny, P).** Rigorous, but the value curve is a step function: you get the checking payoff only after formalizing *enough*, in a solver-friendly encoding, in notation domain experts can't read. Humans pay all the cost before any payoff and abandon. (The "Rebel lesson," §2.)

Lattice sits between them: the rigor of formal methods, the readability of prose, and — the new ingredient — an **agent that pays the formalization tax** so the human never faces the cliff.

---

## 2. Prior art and what we take from each

| Source | What it is | What we take | What we reject |
|---|---|---|---|
| **Quint** (Informal Systems) | TLA+ reimagined with programming-like syntax; SMT model checking via **Apalache** | declarative invariants, temporal properties, actions-as-transitions, the fold-only decidability discipline, Apalache as the SMT-backed checker | it targets distributed-systems engineers, not domain experts; no DDD; weak at structural/relational invariants |
| **Fizzbee** | Python-like (Starlark) formal-methods language; Go BFS model checker; roles/actors, `atomic`, fairness, liveness | proof that *imperative, familiar* syntax lowers the barrier; `atomic`; readable action bodies | no domain modeling; still an engineer tool |
| **P** (Microsoft/AWS) | State-machine programming language; explicit-state checking at S3/DynamoDB scale; **spec monitors** | *everything is a communicating state machine* (sagas included); spec-monitors that double as runtime monitors; "feels like code" drove adoption | explicit-state doesn't scale to large data domains as well as symbolic |
| **Alloy 6 / Pardinus** | Relational modeling + bounded model *finding* (Kodkod→SAT); Alloy 6 adds first-order **LTL** (merged Electrum) | first-class **relations**, multiplicity, transitive closure (`^`,`*`) for structural invariants; fast small-scope instance enumeration for elicitation | SAT is bad at arithmetic (see Portus/cvc5) |
| **Dafny / SPARK / Verus** | Deductive program verification (contracts + SMT-discharged VCs) | Design-by-Contract (`requires`/`ensures`/invariant) as the invariant backbone — *not* BDD | fusing spec+code and proving whole programs doesn't fit "agent writes idiomatic TS/Rust" |
| **Context Mapper (CML)** | DDD DSL: bounded contexts, context maps, aggregates, entities, VOs, events | the DDD *vocabulary* (strategic + tactical) | its Eclipse/Xtext tooling; and it checks *nothing* |
| **Rebel** (ING/CWI) | Financial-product DSL: fields + events (pre/post) + invariants + lifecycle → Z3 | typed domain primitives (Money, IBAN); the exact "state machine + invariants + domain modeling" shape; **and the cautionary tale** | it stayed research-grade — the adoption cliff (§19) |
| **Antithesis / FoundationDB / TigerBeetle** | Deterministic simulation testing (DST): deterministic hypervisor, whole-system fault injection, RL-guided multiverse, perfect repro | DST as a verification *target* (§11.4); the "you define properties, we find the seed" model | it's a substrate we rent, not a thing we build |
| **Jepsen + Elle** | Consistency checking from observed histories | runtime conformance as anomaly-inference from real traces (§11.3) | domain-specific to databases |
| **mypyvy / IC3-PDR / DistAI / DuoAI** | Automated inductive-invariant inference | invariant *inference* as a candidate source (§9); CTI-guided strengthening; inductiveness = the entailment classifier | not deployed tools — algorithms we implement |

**The Rebel lesson (why formalization efforts die):** Rebel was explicitly designed *with* domain experts to model real financial products, and still never became ING's system of record. The cliff: to get Z3 to say anything useful, a product had to be expressed in decidable predicate logic + linear integer arithmetic — but proration, rounding, calendar math, and external state are undecidable, nonlinear, or tedious. So the "communicate with domain experts" promise collided with "only for the fragment the solver handles"; engineers became the bottleneck again; the model and the code diverged; the model was abandoned. **Every design decision in Lattice is aimed at not re-digging this grave: the agent pays the tax, partial specs still deliver value (no cliff, a ramp), and the model cannot silently drift from code (the conformance loop is a hard gate).**

---

## 3. Core thesis: one language, one loop, one oracle

Everything reduces to three things. Every other concept is a plugin into one of them.

1. **One *object* language** — the spec (context/aggregate/machine), an AST with formal semantics, rendered/edited through three projections (prose, code, diagram). *Honest scoping:* "one language" means one object language **for the people modeling domains** — it is **not** a claim that the whole system is one grammar. Two smaller authored languages sit beside it, plus a compile target (see §3.2). Naming them honestly matters because they are the real surface area a user confronts.
2. **One elicitation loop** — *recognition over recall*: propose a candidate invariant → ask the single cheapest, most-informative question → the human judges a concrete case → prune/refine → verify. Fed by many **candidate sources**. *Honest scoping:* in a well-covered domain this loop is **not** the workhorse — templates + LLM seeding + inference are (see §8 intro and §16). Its value scales with domain novelty.
3. **One oracle** — the same invariants compiled to four **targets**: design-time model check, conformance/property tests, runtime monitors, deterministic simulation testing. *The anti-drift guarantee rests on the conformance adapter — designed in §11.5, not hand-waved.*

### 3.1 Cast of roles — who is "the human"

The doc uses "the human" for very different people; they have very different tolerances. Explicitly:

| Role | Authors | Judges / reads | Tolerance for loops |
|---|---|---|---|
| **Domain expert / founder** | nothing in code; edits *structured* fields | judges concrete cases (recognition), reads prose, resolves policy forks (open decisions) | **low** — the question-minimization (§8) exists for them |
| **Engineer** | the object language (code projection); **owns the residual conformance adapter** (§11.5) | code, diagrams | high |
| **Platform team** | rules/templates in the **meta-language** (§10.3) — rare, specialist | the catalog | high |
| **The agent (LLM)** | drafts formalizations, candidate invariants, and first-draft adapters | — | n/a (pays the formalization tax) |

### 3.2 The three authored languages (surface area, honestly)

- **Object language** — the spec DSL (`context`/`aggregate`/`machine`/`service`). What most users touch. One AST, three projections (§6).
- **Meta-language** — the rule/template language (§10.3): a real programming language with quantifiers and `emit` that pattern-matches over the object language's *reflected meta-model*. A **separate** language with its own AST that emits object-level invariants. Touched only by the platform team, rarely.
- **Compiled substrate** — the temporal-logic / relational form the two above compile to (§10.3 bottom). A compile target; **nobody authors it**.

Prose and diagram are **projections/views**, not separate authored languages (see §6 for the authoring boundary).

---

## 4. Concept ledger: keep / merge / drop

We generated ~25 loose concepts. They collapse to **7 components + candidate sources + oracle targets.**

### KEEP as first-class

- One AST + three projections (prose / code / diagram).
- DDD/CML structure + statecharts + domain-events-≠-transitions + typed prelude/profile.
- Two-engine checking: **Apalache** (behavioral/temporal/arithmetic) + **Alloy 6/Pardinus** (structural), with **cvc5 via Portus** as the optional arithmetic backend.
- The one elicitation loop (recognition over recall).
- Decision Ledger (verdicts, open decisions/hotspots, multi-expert votes, provenance/lineage).
- Oracle Compiler → four targets.
- Entailment classifier (is an invariant entailed by the machine, or independent?).
- Rules/templates + tags (three projections + `fixtures` self-test).
- Improvement flows: forward (templates), reverse (mining), coverage, bug-detection.

### MERGE (were described separately; are actually one thing)

| These… | …collapse into |
|---|---|
| Split-Selector, Reachability filter, Minimality/one-dimension-different, Boundary probing, UNSAT-convergence | **the Question Planner** (info-gain question selection *is* those tactics) |
| The "six mechanisms to uplevel writers" | **Candidate Sources** feeding the Hypothesis Manager |
| mypyvy inference **and** adversary/chaos exploration | two **candidate sources**, both powered by the Model Finder producing witnesses (a CTI is a counterexample) |
| Conformance testing, runtime monitoring, property/model-based testing, Antithesis | **targets of the Oracle Compiler** (Antithesis = the DST execution substrate for the runtime target) |
| EventStorming, Example Mapping, forbidden-states, metamorphic, decision tables | **example-intake modalities** used by the NL Translator (keep EventStorming as the workshop front-end and decision tables as guard-completeness intake; the rest are prompting styles) |

### DROP as distinct concepts (redundant naming)

- "Model finder as elicitation instrument," "active learning," "query-by-committee" — these *are* the loop, not separate ideas.
- cvc5 / nuXmv / mypyvy / DuoAI as *deployed tools* — they're backends (inside Apalache) or algorithms (inside the Inference source).
- "Forbidden states" as a distinct method — one prompting style.

---

## 5. The language

### 5.1 Constructs

> Implementation note (2026-07-08): the `machine`/`region`/`transition` vocabulary below is the
> long-run vision; the shipped slice-4 surface implements it as named `lifecycle` blocks (no
> `machine`/`region` keywords) — see
> [`2026-07-07-lattice-slice-4-grammar-machine-growth-design.md`](superpowers/specs/2026-07-07-lattice-slice-4-grammar-machine-growth-design.md)
> §3.1.

- `profile` — one company-wide import bundle (prelude + shared kernel + house conventions). Universal primitives (`Money`, `Date`, `Duration`, `Percent`, `Currency`, `Id`) are **always in scope**; no per-context declarations. A context may *refine* an imported type (e.g. house rounding on `Money`) but never re-declare it. **The import graph is the context map's tactical layer** — a cross-context reference is only legal over published/imported types; an Anti-Corruption Layer is a named, checkable translation.
- `context` — a bounded context (module + invariant scope).
- `aggregate` — the **consistency + transaction boundary**. Owns a `machine`, `ref` relations, nested `invariant`s, and its own `repository`. Invariants on an aggregate must hold at every commit (this is the natural home for a held-transaction boundary).
- `entity` / `value` — identity vs. structural equality. `entity` marks an identity attribute with `key` (CML's `Entity`/`aggregateRoot`); `value` carries structural invariants (`Money { amount >= 0 }`) and has no key. Both hold typed attributes and `ref`erences.
- `enum` — plain enumerations (`Currency`, `CollectionMethod`). CML's `aggregateLifecycle` enum is subsumed by our richer `machine`.
- `machine` — a Harel statechart inside an aggregate: **orthogonal (parallel) `region`s**, hierarchical states, guarded transitions with effects, `emits`, and cross-region rules (`when <RegionA> enters <S>: <RegionB> -> <T>`). Prefer orthogonal regions over a flat enum when a thing has independent concerns (e.g. Access × Billing — see §5.6).
- `transition` — `from … to …`, `when <trigger>`, `requires <pre>`, `atomic do { <effect> }`, `ensures <post>`, `emits <event>`.
- `event` — a domain event (a past-tense **fact**; distinct from a transition — see §13).
- `service` — an application/domain service = a **verified command**, not an RPC endpoint (§5.3). **Atomic by default** — a single transaction on one aggregate, no intermediate states. It grows a `saga { … }` body **only when it crosses the atomicity boundary** — which the tool *derives from your own declarations* (you wrote an `external` call, an out-of-band `wait`, or a mutation spanning aggregates), not from discovering hidden concurrency. RPC/OpenAPI is one generated *projection* of it.
- `acl` — an Anti-Corruption Layer (§5.4): a context-map relationship (`[D,ACL]<-[U,OHS,PL]`) **plus** a first-class, checkable `translate` (a decision table) with totality/unambiguity invariants and `dedup`. Where an external system's flat model is quarantined.
- `repository` — nested in its aggregate (one per root, DDD); the **collection port** (maps to a data-plane port); method signatures carry the "many" side.
- `invariant` / `liveness` — structural or behavioral safety, and temporal liveness (`leads-to`, `under fairness(...)`).
- `unique while <state> by (<key paths>)` — readable inline structural uniqueness (replaces the ill-conceived `@scope` tag).
- `rule` + `@tags` — reusable, auto-applying invariant generators (§10).
- `external` — an at-least-once, side-effecting outside call (e.g. a PSP). Its *responses* enter the domain through an `acl`.
- **Documentation** (§5.5): `///` doc comments attach to any construct as first-class AST metadata (they render into the prose projection, not dropped); `glossary` holds per-context ubiquitous-language definitions. Distinct from auto-generated `explain` and from ledger provenance.
- Concurrency: sagas are **state machines** (not a separate `process` construct). Every suspension/await point is a **named state** (that's where interleavings happen and invariants must hold). `crash`/fault points are nondeterministic failures the checker injects.

### 5.2 Worked example — Billing (subscriptions + invoicing), code projection

```
profile @acme/prelude          // Money, Date, Duration, Plan… always in scope

/// Owns subscription lifecycle, invoicing, and payment health.
context Billing {

  glossary {
    "grace period" = "window after an invoice due date during which access is kept while retries run"
    "dunning"      = "the automated retry sequence after a failed payment"
  }

  // --- value objects & enums (tactical DDD) ---
  value Money         { amount: Int; currency: Currency }  invariant { amount >= 0 }   // structural equality (no key)
  value BillingPeriod { start: Date; end: Date }           invariant { start < end }
  value LineItem      { description: Text; amount: Money; quantity: Int }

  enum Currency         { USD, EUR, GBP }
  enum CollectionMethod { ChargeAutomatically, SendInvoice }

  // --- entities ---
  /// A billable customer; identity is the customer id.
  entity Customer {
    id: Id key                         // `key` = identity (vs. value objects' structural equality)
    name: Text
    defaultCurrency: Currency
  }

  /// A customer's recurring commitment to a plan. Access and billing health evolve independently.
  aggregate Subscription {
    id        : Id key
    customer  : ref Customer            // reference (CML's `- Customer`)
    plan      : ref Catalog.Plan
    mrr       : Money
    grace     : Duration
    collection: CollectionMethod

    // Two ORTHOGONAL concerns (Harel parallel regions) — not one flat enum (§5.6).
    lifecycle Access {
      states { Trialing @initial, Active @active, Suspended, Ended @terminal }
    }
    lifecycle Billing {
      states { AwaitingFirstPayment @initial, Current, Retrying, GaveUp @terminal }

      transition firstPayment {
        from AwaitingFirstPayment to Current
        when PaymentSucceeded
        // vision: atomic do { mrr = plan.price } — effects language deferred (slice-4 design §3.4)
        emits SubscriptionActivated
      }
      transition paymentFailed { from Current to Retrying; when PaymentFailed }
      transition recovered     { from Retrying to Current; when PaymentSucceeded }
      transition giveUp        { from Retrying to GaveUp;  when DunningExhausted }
    }
    // cross-region rules replace the conflated flat states (PastDue = Active × Retrying, etc.) —
    // long-run vision only; the shipped v1 surface has no cross-lifecycle rule construct yet (§5.1).
    // when Billing enters GaveUp:                        Access -> Ended
    // when Billing enters Retrying and elapsed(grace):   Access -> Suspended

    unique while active by (customer, plan.family)       // structural invariant, inline & readable
    /// Revenue only accrues to a subscription the customer can actually use.
    invariant BillingLive     { mrr.amount > 0 implies Access.state in {Active, Trialing} }
    liveness  DunningResolves { Billing.state==Retrying leads-to Billing.state in {Current, GaveUp}
                                under fairness(retries) }

    repository {
      find(id): Subscription?
      page(criteria): Page<Subscription>
      activeFor(c: ref Customer): Set<Subscription>      // the "many" side, explicit
    }
  }

  aggregate Invoice {
    id: Id key
    subscription: ref Subscription
    period: BillingPeriod
    lines: List<LineItem>
    dueDate: Date
    lifecycle status { states { Draft @initial, Open, Paid @terminal, Void @terminal, Uncollectible } }
  }

  event SubscriptionActivated { subscription: ref Subscription; at: Date }
  event PaymentFailed         { invoice: ref Invoice; attempt: Int }

  // --- application service = a VERIFIED COMMAND (atomic by default; not RPC — §5.3) ---
  /// Upgrade a subscription to a higher-tier plan, reserving balance until payment confirms.
  /// This one is a saga ONLY because it makes an external PSP call and waits for it —
  /// i.e. it crosses the atomicity boundary. Most services are plain atomic transactions.
  service UpgradePlan {
    command { subscription: ref Subscription; toPlan: ref Catalog.Plan }
    result  { subscription: ref Subscription }
    requires subscription.Access.state == Active

    saga {                                   // step-states exist ONLY because atomicity is broken
      states { Reserving, AwaitingPayment, Applying, Applied, Compensating }
      step reserve { Reserving -> AwaitingPayment;  do { reserve(delta) } }
      step confirm { AwaitingPayment -> Applying;   when PaymentSucceeded; do { capture(delta) } }
      step apply   { Applying -> Applied;           do { subscription.plan = toPlan } emits UpgradeConfirmed }
      compensate   { on cancel|failure: -> Applied; do { release(delta) } }   // §14 no-leak
    }
    ensures subscription.plan == toPlan or reserved == 0
  }

  external PSP { charge(@idempotencyKey key: Id, amount: Money) }

  // cross-aggregate consistency (elicited, not hand-written — see §16)
  invariant PastDueDiscipline {
    forall s: Subscription |
      s.Access.state == Active implies
        latestFinalized(s).status == Paid
        or now() <= latestFinalized(s).dueDate + s.grace
  }
}

// --- Anti-Corruption Layer (§5.4): quarantine Stripe's flat model ---
/// Stripe is upstream (Open Host Service + Published Language). We translate its model
/// into our domain events so its shape can't corrupt ours. The flat Stripe status enum
/// lives HERE, not in the core domain.
acl StripeGateway {
  Billing [D,ACL] <- [U,OHS,PL] Stripe   { implementationTechnology = "Webhooks/REST" }

  translate PaymentIntentStatus -> DomainEvent {     // a decision table; totality is checked
    succeeded               => PaymentSucceeded
    requires_payment_method => PaymentFailed
    requires_action         => PaymentActionRequired
    processing              => (ignore)              // an EXPLICIT drop, not a silent gap
    canceled                => PaymentCanceled
  }
  dedup by @idempotencyKey(event.id)                 // Stripe redelivers webhooks

  invariant Total       { every PaymentIntentStatus is translated }
  invariant Unambiguous { each status maps to exactly one outcome }
}
```

Money math routes to Apalache/cvc5; `unique while active` routes to Alloy 6/Pardinus. **The modeler never picks an engine** — the invariant's shape does.

### 5.3 Application services are verified commands, not RPC — and atomic by default

**Two kinds of "state," which must not be conflated:**
- **Aggregate lifecycle states** (`Trialing / Active / Ended`, `Current / Retrying / GaveUp`) — the *domain* lifecycle, driven by domain events over time. Always present; this is what the statechart models. Transitions between them are usually **atomic**.
- **Saga step-states** (`Reserving / AwaitingPayment / Applying`) — the internal steps of a *single non-atomic operation*. An **artifact of a broken transaction**, not domain lifecycle. Present only when atomicity is unavailable.

A `service` has three layers; RPC is only the outermost, and it's *generated*:

1. **Interface** (RPC/HTTP/OpenAPI request+response) — a **projection** for transport, like prose/code/diagram. The same command is also invokable in-process, by a workflow trigger, or by an agent's in-guest SDK.
2. **Command contract** — `command`/`result` types, `requires` precondition, `emits` events, `ensures` postcondition, and the invariants preserved at commit. This is what the checker verifies.
3. **Orchestration** — the default is **none**: an atomic single-transaction command on one aggregate.

**The atomicity boundary is the aggregate** (Vernon's rule: one aggregate per transaction). A command that stays inside it is **atomic** — the runtime wraps it in one transaction (the held-tx / P4b boundary), and there are *no* intermediate states:

```
service CancelSubscription {
  command { subscription: ref Subscription }
  requires subscription.Access.state in {Active, Trialing}
  do { subscription.Access = Ended; release(reserved) }   // one transaction — atomic, no saga
  emits SubscriptionCanceled
}
```

A `saga` appears **only when the operation crosses the atomicity boundary** — an `external` side-effect that can't be rolled back, an out-of-band `wait`, or a span across aggregates that don't share a transaction. This is *derivation from your own declarations, not discovery*: you already wrote the `external` call and the `wait`; the tool infers the consequence (you can't be one transaction) and **forces you to handle it** rather than letting you silently assume atomicity. It is derived and flagged, not chosen:

```
service UpgradePlan {
  command { subscription: ref Subscription; toPlan: ref Catalog.Plan }
  do { reserve(delta); PSP.charge(...); capture(delta); subscription.plan = toPlan }
}
// TOOL: "PSP.charge is an external effect you wait on — this can't be one transaction; it
//        crosses the atomicity boundary.  [make saga w/ compensation] [settle async] [move call out]"
```

Only if the modeler accepts "make saga" do the step-states (`Reserving`, `AwaitingPayment`) get generated — because the external call and the wait *are* the boundary points.

**Checker payoff:** an atomic command is provably race-free (one transaction serializes it — the §14 machinery is discharged trivially); the checker's real work, and the whole race/crash analysis, applies **only at the broken-atomicity seams the tool flagged**. The highest-value diagnostic: a command silently mutating two aggregates gets caught — *"not in one transaction boundary; make it one aggregate, or use eventual consistency / a saga."* Transactions stay primary; the tool catches when you've escaped one.

This mirrors spec-core: the spec is the source of truth; the RPC/OpenAPI surface and the data-plane/held-transaction execution are generated from it. **Not an RPC interface — an atomic verified command (with sagas only where atomicity genuinely breaks) whose RPC surface is one projection.**

### 5.4 Anti-corruption layers

CML declares the *relationship* (`[D,ACL]<-[U,OHS,PL]`) but not the *translation*. Lattice makes the translation first-class and **checkable**: a `translate` decision table with `Total` (every upstream state handled — the model finder flags gaps) and `Unambiguous` invariants, plus `dedup` (external systems redeliver). This is where an external system's messy/flat model is quarantined so it can't corrupt the core — and it's the natural home for the Idempotency template.

### 5.5 Documentation & glossary (first-class, not dropped comments)

Three distinct things, kept separate so they round-trip across projections:

- **`///` doc comments** — human *intent*, on any construct; a `doc` field on the AST node, rendered as the descriptive prose in the prose projection.
- **`glossary`** — per-context ubiquitous-language definitions (the one thing legitimately per-context).
- **`explain` / provenance** — auto-generated rule descriptions and ledger lineage (`from Idempotency@acme v3`, `elicited 07-02 #21-23`), *not* hand-written.

`doc` (why, human) ≠ `explain` (what, generated) ≠ provenance (lineage, ledger).

### 5.6 Orthogonal statecharts (avoiding flat, overfit states)

A flat Stripe-style enum (`trialing, active, past_due, unpaid, paused, canceled`) is **overfit to the wire representation** and **conflates independent concerns**: `past_due` is not a lifecycle state, it's "Access = Active *and* Billing = Retrying." Model the two concerns as Harel **orthogonal regions** (`Access` × `Billing`) with cross-region rules. The observable "Stripe status" becomes a *projection* of the product, computed at the ACL (§5.4). Wins: no conflation, no state explosion, cleaner region-local invariants (`DunningResolves` is purely a `Billing` property), and the flat external enum stays quarantined at the boundary — the same insight as the anti-corruption layer.

---

## 6. The three projections (and the honest round-trip decision)

The core is a **typed AST with formal semantics** (a transition system + relational structure + contracts). Nobody edits the AST directly. Three projections render/edit it:

- **Prose** — literate markdown + tables + Mermaid. What domain experts read; where they judge cases.
- **Code** — typed, diff-able, PR-able. What engineers read/write.
- **Diagram** — statechart + context map, generated. *(Built: mermaid-docs slice, 2026-07 — statecharts, per-context class diagrams, and the workspace context map render on every apply/sync/emit/docs; see `docs/language/projections.md`.)*

`code → prose` (pretty-print) and `code → diagram` are easy. **`prose → code` is the hard direction — it is autoformalization** (see §19, Risk 1/4).

**The authoring boundary (one rule, applied everywhere in this doc):**

| Prose usage | Who | Safe? |
|---|---|---|
| **Read** a rendered view | everyone | yes — pure `code → prose` |
| **Judge** concrete cases the tool generates | domain expert | yes — recognition, no parsing |
| **Author via structured fields** (typed slots, dropdowns, decision-table cells) | domain expert | yes — the tool controls the grammar |
| **Author freeform paragraphs the tool parses back to AST** | — | **no — deferred** (autoformalization risk) |

This resolves two apparent contradictions elsewhere in the doc:
- **§17** (the rich prose spec) is a **rendered/read view** — not English a domain expert typed as paragraphs.
- **§10.3** (the "readable rule" prose) is a **rendered/structured view** of a rule whose *canonical authored form is the engineer-code projection*. A platform author writes the typed rule (or fills structured slots); they do not type English the tool parses.

Net: everyone *reads* fluent prose; domain experts *author by judging cases and filling structured fields*; **nobody authors freeform paragraphs the tool must parse.** This avoids recreating the Rebel two-sources-of-truth problem *inside the tool*.

---

## 7. Architecture

```
 ┌─ INTERFACES ────────────────────────────────────────────────────────────┐
 │  NL Translator  (chat · example intake: EventStorming, decision tables)  │
 │  Projections    (prose ⇄ code ⇄ diagram — all over the one AST)          │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ examples / verdicts
 ┌─ ELICITATION CORE ───────────────────────────────────────────────────────┐
 │  Hypothesis Manager ◀── CANDIDATE SOURCES:                               │
 │   · version space      · Template Catalog (+tags)   · Inference (mypyvy) │
 │   · prune/regenerate   · Trace Miner                · Adversary/Chaos    │
 │   · convergence test   · LLM domain seeding         · Type-carried       │
 │            │ surviving hypotheses                                         │
 │  Question Planner  (info-gain/MaxSAT split · reachability filter ·        │
 │                     minimality · boundary probe · UNSAT-convergence)      │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ "find a distinguishing, reachable, minimal witness"
 ┌─ CHECKING SUBSTRATE ─────────────────────────────────────────────────────┐
 │  Reachability-Bridge  (composes the two engines below)                   │
 │  Model Finder:  Apalache (behavioral/temporal/arith) · Alloy 6 (struct)  │
 │                 · cvc5 via Portus (arithmetic) · Z3 (MaxSAT split)       │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ resolved invariants + verdicts
 ┌─ MEMORY ─────────────────────────────────────────────────────────────────┐
 │  Decision Ledger  (verdicts · open decisions/hotspots · votes · lineage) │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │
 ┌─ OUTPUT ─────────────────────────────────────────────────────────────────┐
 │  Oracle Compiler → ① design-time model check  ② conformance/property tests│
 │                    ③ runtime monitors          ④ DST / Antithesis props   │
 └───────────────────────────────────────────────────────────────────────────┘
```

### Component responsibilities & build-vs-reuse

- **NL Translator** — *reuse (LLM) + build guardrails.* Chat front-end; structured example intake (EventStorming stickies → events/policies/hotspots; decision tables → guard completeness). Renders witnesses as domain-language questions; parses verdicts. **Guardrail: the LLM proposes, the Model Finder disposes** — every LLM formalization is re-checked before it is trusted.
- **Hypothesis Manager** — *build.* Holds the version space of candidate invariants + LLM priors; prunes on each verdict; **regenerates** when the candidate set empties (synthesize a rule consistent with the whole ledger); runs the convergence test.
- **Question Planner** — *build (thin).* Selects the single cheapest, most-informative question (§8). Folds in: MaxSAT/info-gain split, reachability filter, minimality/one-dimension-different, boundary probing, UNSAT-convergence.
- **Reachability-Bridge** — *build (the hard glue).* Conjoins a structural query with a **bounded run of the machine** so witnesses are dynamically reachable, not merely well-typed. (Risk: composing two solvers — see §19 Risk 5; escape hatch = go single-engine first.)
- **Model Finder** — *reuse.* Apalache primary; Alloy 6/Pardinus for structural + closure; cvc5 (Portus) for arithmetic; Z3 for the MaxSAT split.
- **Decision Ledger** — *build.* Append-only event log (verdicts, open decisions, multi-expert votes, provenance). Feeds elicitation (don't re-ask), the oracle (regression anchors), and the prose "open decisions" section.
- **Oracle Compiler** — *reuse patterns + build codegen.* Emits the four targets from the invariant AST (§11).

---

## 8. The elicitation loop in detail

The loop is *active learning over a hypothesis space of invariants*, with the model finder manufacturing the questions. It is the same skeleton as CEGIS/CEGAR — but the "counterexample" is a **question for a human**, optimized to be the cheapest possible.

**Honest scoping — this is not the workhorse in covered domains.** In a solved domain like billing, templates + LLM seeding + inference resolve most invariants and this loop is lightly exercised (§16: 2 of 12). Its value is twofold and **scales with domain novelty**: (i) it is the **residual handler** for genuinely novel invariants no template covers and inference can't settle; (ii) it is the shared **question-selection layer** every candidate source flows through when a human must confirm — boundary-probing (§8.3) catches an over-general *template*-proposed invariant just as it catches a de-novo one. Build-order implication (§21): templates + seeding + inference are the MVP; the full version-space / MaxSAT machinery below is a later, novelty-driven investment, not the first thing to build.

### 8.1 The atomic operation — a distinguishing witness is a satisfiability query

Candidate invariants are formal predicates `Hₖ(m)` over an instance `m`, each labeling `m` as permit/forbid. To generate a question separating `Hᵢ` and `Hⱼ`, solve for a model of their XOR:

```alloy
run distinguish {
  wellFormed
  reachableWithin[k]                        // reachability filter (compose with the machine)
  (Hi and not Hj) or (not Hi and Hj)        // the two candidates disagree here
}
```

The returned instance **is the question**. UNSAT ⇒ `Hᵢ`,`Hⱼ` are equivalent over the scope ⇒ merge them (never ask).

### 8.2 Choosing *which* question — the MaxSAT balanced split

With many candidates, pick the witness that **partitions the surviving set most evenly** (max information gain / halving). Encode `bₖ = Hₖ(m)` and **minimize `|Σ wₖ·bₖ − ½Σwₖ|`** (weights = LLM priors), so you maximize *expected* info gain. Whichever way the human answers, ~half the space dies.

### 8.3 The refinements that make questions *good*, not just discriminating

- **Reachability filter** — only ask about states the machine can actually reach (compose structural finder ∧ bounded machine run). Prevents adjudicating impossible states.
- **Minimality / one-dimension-different** — among distinguishing witnesses, prefer the smallest that differs from an already-accepted case in exactly one salient dimension. The answer becomes instant recognition, not analysis.
- **Boundary probing** — separately, generate witnesses the *leading* hypothesis forbids-but-barely (catch over-generalization) and permits near the edge (catch under-generalization).
- **Priors + cost** — weight by LLM plausibility and by cost-of-being-wrong (resolve revenue invariants before cosmetic ones).

### 8.4 Prune + regenerate + converge

Prune candidates inconsistent with each verdict. If the set empties, the LLM **regenerates** a candidate consistent with the whole verdict ledger. Convergence = survivors equivalent over scope (UNSAT to separate) **and** the LLM can't propose a new candidate any reachable witness distinguishes.

### 8.5 Worked micro-trace (single-active subscription)

Ground truth (hidden): "≤1 active per customer **per product family**" (= H3). Initial candidates `{H1: per-customer .35, H2: per-plan .40, H4: unlimited .25}`.

```
Q1  MaxSAT split → witness DPSF (two active, same customer, DIFFERENT plan, SAME family)
    Expert: "forbid — can't hold two active storage tiers."
    Prune: H2 & H4 permit DPSF → eliminated.   candidates = { H1 }   (3→1)

Boundary probe: H1 is sole survivor but may over-forbid.
Q2  witness DPDF (two active, same customer, DIFFERENT family) — H1 forbids it
    Expert: "permit — storage and compute are separate."
    H1 forbade a permitted state → H1 refuted.   candidates = { }  → REGENERATE

Regeneration: LLM synthesizes rule fitting ledger {SP:forbid, DPSF:forbid, DPDF:permit}
              → H3 = "≤1 active per (customer, family)".
Convergence: no reachable witness distinguishes H3 from ledger-consistent neighbors → DONE.

Total: 2 recognition-judgments to pin an invariant over an infinite instance space.
```

---

## 9. Candidate sources (where invariants come from)

The Hypothesis Manager is fed by pluggable sources. The writer never *authors* invariants from a blank page — they *judge* candidates these produce.

1. **Template Catalog (+ tags)** — parameterized invariant schemas that pattern-match the model's structure and tags (§10). Covers the known ~80%.
2. **Inference (mypyvy-style, IC3/PDR)** — CTI-guided invariant strengthening for the long tail (§9.1).
3. **Trace Miner** — Daikon-style mining from execution traces (§18 reverse flow).
4. **Adversary / Chaos** — the checker auto-injects crashes, interleavings, duplicate/reordered messages; every reachable un-governed "weird" state becomes a candidate ("I can reach `charged=80,recorded=40` — forbid it?").
5. **LLM domain seeding** — the model already knows canonical Stripe/billing invariants; it proposes them from prior art and re-renders each in prose for confirmation.
6. **Type-carried** — typed primitives auto-attach latent laws (`Money` ⇒ conservation + non-negativity), so those never need authoring.

### 9.1 What "mypyvy-style inference" means (concretely)

An invariant is **inductive** iff (1) `init ⇒ Inv`, (2) `Inv ∧ transition ⇒ Inv'`, (3) `Inv ⇒ safety`. Your safety property usually is *not* inductive alone; the creative work is finding the strengthening. IC3/PDR does it by loop: find a **counterexample-to-induction (CTI)** — a state satisfying the candidate that *steps to* a violation — generalize it into a clause that excludes it, repeat to fixpoint (inductive) or back to `init` (a real bug).

Example: safety `available >= 0` is not inductive. CTI: `available=10` + `reserve(40)` → `available=-30`. **The CTI tells the writer the missing guard** (`reserve requires available >= delta`). This same inductiveness check *is* the **entailment classifier** (§ below), and the CTI is a first-class elicitation witness ("your rule holds here but one step breaks it — forgot a guard?").

**Entailment classifier.** For each stated invariant, check against the machine and label: **entailed** (redundant — "follows from the machine; keep as regression anchor or drop"), **independent** (load-bearing), or **violated** (counterexample). This tells writers whether an invariant is dead weight or doing real work. Design principle: **prefer encoding safety in the machine** (make illegal states/transitions unrepresentable); use standalone invariants only for cross-aggregate/temporal properties or obligations on external actors/sagas.

---

## 10. The invariant-template catalog & how templates are authored

### 10.1 Two layers, clean division of labor

- **Layer 1 — semantic tags** on the model (cheap, added by the domain modeler): `@active`, `@terminal`, `@balance`, `@reservation`, `@idempotencyKey`, plus the `external` keyword. Tags **classify** ("this state is terminal"); they do **not** carry rule parameters. (Per-model uniqueness is the inline `unique while … by …` statement, *not* a tag.)
- **Layer 2 — templates** (written once by a platform team; consumed by everyone): pattern-match tags + shape → emit invariants.

### 10.2 The catalog (payments/billing starter set)

| # | Template | Auto-proposed when… | Schema (parameterized) | Catches | Engine |
|---|---|---|---|---|---|
| 1 | Money conservation | ≥2 `@balance` fields on one aggregate | `sum(buckets) == initial(sum(buckets))` | reserve debits available w/o crediting reserved → leak | SMT (inductive) |
| 2 | Non-negative balance | a `@balance` field | `bucket.amount >= 0` | reserve when `available < delta` | SMT + guard |
| 3 | Terminal state | a `@terminal` state | `once T: stays T` | any transition leaving `Canceled` | temporal/safety |
| 4 | At-most-once / idempotency | an `external` call with `@idempotencyKey` | `forall k: applied(call,k) <= 1` | crash-retry double charge | temporal + fault |
| 5 | Reservation eventually released | `@reservation` bucket w/ no unconditional release | `reserved>0 leads-to reserved==0 under fairness` | cancel strands a reservation | liveness + fairness |
| 6 | Cross-aggregate coupling | a `ref` with a state dependency | `A.state==Active ⇒ B.status∈{Paid} ∨ within grace` | active sub, long-unpaid invoice | relational + temporal |
| 7 | Single-active (uniqueness) | an `@active` state on a child collection | `unique while active by (parent, key)` | two active per family | structural (Alloy) |
| 8 | No period reuse / monotonic | an incrementing period/version/seq | `period never repeats`, `version only ↑` | double-billing a cycle | temporal |
| 9 | No orphan (referential integrity) | any `ref` field | `every ref resolves` | invoice → deleted subscription | structural |
| 10 | Ordered lifecycle / no-skip | a machine with intended ordering | `can't reach Paid without passing Open` | skipping finalization | reachability |
| 11 | Deadline / grace bound | a `Date` gating a state | `state X only while now <= due + @window` | stuck `PastDue` forever | temporal + arithmetic |
| 12 | Saga net-zero on abort | a saga with compensating transitions | `forward ∘ compensate == identity` | partial refund on abort | temporal + fault |

**Application model:** the tool matches templates → materializes candidates → renders each as a *concrete reachable violation* → the writer accepts / edits / declines. Accept → invariant added with provenance (`// from Idempotency@acme v3`). **Decline → recorded in the ledger with a reason** (a *declined* invariant ≠ an *absent* one; auditable). Templates cover the known 80%; inference (§9.1) reaches the long tail.

### 10.3 How a template is authored — three projections (like everything else)

Prose (a **rendered / structured** view — *not* freeform English the platform author types; the canonical authored form is the engineer-code projection below, per §6):
```
rule Idempotency:
  wherever an external call has an idempotency key
  require it is applied at most once per key
  check by crashing between the call and its record
  because "a retry after a crash must not double-charge"
```

Engineer code projection (typed rule over the reflected meta-model — the diff-able form):
```
import meta { Aggregate, Field, Transition }
import tags { IdempotencyKey }

rule Idempotency {
  applies to (t: Transition)
    where t.effects.some(e => e.isExternal && e.args.tagged(IdempotencyKey).any)

  emit invariant "${t.name}.AtMostOnce" {
    let call = t.effects.first(e => e.isExternal)
    let key  = call.args.tagged(IdempotencyKey).first
    forall k: key.type => applied(call, k) <= 1
  }

  probe     crash.between(call, t.record)      // how the checker falsifies it
  check     temporal + fault
  severity  critical
  explain   "${call} has an external effect; a retry after a crash must not double-apply per ${key}."

  test fires_on  transition collect  { emit PSP.charge(@idempotencyKey inv.id, amt) }  // self-test
  test ignores   transition activate { do { mrr = plan.price } }
}
```

Compiled substrate (machine-only; nobody writes this):
```
∀ t ∈ Transition: (∃ e ∈ t.effects | e.isExternal ∧ e.args.tagged(IdempotencyKey))
   ⇒ assert ∀ k: applied(call(t), k) ≤ 1   [engine=temporal+fault, probe=crash(call,record)]
```

**Nobody hand-writes the pattern-matching metalanguage** — it's a compile target the LLM emits and the engine runs. The `fixtures`/`test` block is the rule's own CI test (fires on the positive fixture, silent on the negative), so a rule can't rot into matching the wrong things.

---

## 11. The Oracle Compiler and its four targets — in full

The same invariant AST compiles to four deployment targets. **One invariant, four places.** This is the anti-drift mechanism: the spec cannot silently diverge from the code because the spec continuously *judges* the code, at design time, in tests, at runtime, and under simulation.

### ① Design-time model check
- **Tools:** Apalache (behavioral/temporal/arithmetic; bounded + inductive-invariant checking), Alloy 6/Pardinus (structural + transitive closure, bounded model finding), cvc5 via Portus (arithmetic-heavy).
- **Runs:** in the editor and in CI, *before code exists.*
- **Catches:** invariant violations, race conditions, saga/compensation bugs, unreachable or vacuous states, over/under-constrained transitions.
- **Cannot:** give unbounded guarantees without an inductive invariant; decide nonlinear arithmetic; reason about real-time precisely (§15).

### ② Conformance & property tests
Generated *from* the spec, run in the normal test suite:
- **Model-based trace replay** (quint-connect / Modelator style): generate traces (with nondeterministic choices) from the spec, replay against the implementation via a driver, diff implementation state vs. spec state step-by-step, report reproducible divergences with seeds.
- **Statechart model-based test generation** (`@xstate/test` style): generate paths that cover every transition/guard.
- **Property-based / stateful testing** (fast-check / Hypothesis): generate valid command sequences and assert invariants after each step.
- **Catches:** the implementation diverging from the spec on generated sequences. **Cannot:** cover cases the generator never produces (bounded by generation).

### ③ Runtime conformance monitors
The same invariants compiled to online checkers, running in staging/prod:
- **Embedded assertion / LTL / STL monitors** over live execution (the runtime-verification field; synthesized from the temporal invariants).
- **History/consistency checkers** (Jepsen/Elle style): infer anomalies from observed read/write histories rather than instrumenting internals.
- **P-style spec monitors**: observer state machines watching the event stream, "hot/cold" states for liveness.
- **Catches:** violations in real executions the tests missed; drift after deploy. **Cannot:** exceed what actual executions exercise; adds overhead.

### ④ Deterministic Simulation Testing (DST / Antithesis)
The invariants become **properties** for a deterministic-simulation substrate:
- **Antithesis:** a deterministic hypervisor runs the *real binaries* (whole system) with all nondeterminism controlled; injects a hostile storm of faults (partitions, clock skew, disk failures, reordering); RL-guided search explores a "multiverse of branching executions"; every failure is perfectly reproducible with a seed + a time-travel debugger. (Lineage: FoundationDB / TigerBeetle VOPR.)
- **Runs:** as a heavy periodic gate.
- **Catches:** deep concurrency/fault bugs (the race/saga class of §14) in the real system, not just the model. **Cannot:** run without the DST substrate; slower/costlier.

**Note on layering:** target ① finds the race/saga bug at *design time* from the invariant; target ④ finds the *same* bug in the *real binary* from the *same* invariant. Design-time and runtime conformance from one source.

### 11.5 The conformance adapter — how anti-drift actually works (and doesn't re-create two truths)

**The whole anti-Rebel thesis hangs here, so it gets a design, not a clause.** Targets ② and ③ need to compare the *implementation* against the *spec*. The naive way is a hand-written "driver" mapping three things: command→entry-point, impl-events→spec-events, and impl-state→spec-state. That last map — the **abstraction function** — is a second source of truth, written by hand, that rots on every refactor. Maintaining it is *exactly where model-based-testing efforts die.* If we don't solve it, the drift we banished from the spec reappears in the adapter.

The design is a **layered, generated-first fallback** that shrinks the hand-written surface toward zero and makes what remains self-checking:

1. **Command → entry-point is generated, not written.** The service's RPC/OpenAPI surface is *already a generated projection of the spec* (§5.3). The driver invokes that same generated interface. The "which function to call" half of the adapter is free and **regenerates with the spec** — it can't drift because it isn't a separate artifact.

2. **Primary conformance is at the event layer — no abstraction function at all.** The model-checker's trace *is* a domain-event stream (§13), and the implementation *already emits those domain events to the outbox* (spec-core A4b). So the default check is: *does the impl's emitted event sequence match an allowed spec trace?* This compares **observable histories** (Jepsen/Elle-style) over the stable, public event interface — there is **no impl-state→spec-state map to maintain.** This is the rot-resistant default, and it covers most conformance.

3. **Runtime monitors (target ③) also need no offline abstraction function.** They are spec-compiled assertions running *inside* the implementation, reading its state directly at the point of execution. A large fraction of invariants are checkable this way with zero adapter.

4. **State-level replay (the expensive path) reuses the generated persistence mapping.** When you *do* need to read "the aggregate's state" (for full trace-conformance), you go through the *same generated repository/ORM mapping the spec already produces* (spec-core's MikroORM-shaped SDK / repository ports). The abstraction function is **the persistence mapping read in reverse — generated, not hand-authored.**

5. **The residual hand-written adapter is scoped, self-checking, and drift-detected.** Only implementation state the generated mapping doesn't cover — custom caches, denormalized read models — needs a hand fragment. Two guardrails keep it from becoming a rotting second truth:
   - **It must pass its own round-trip conformance test:** write via the impl → read via the adapter → must equal the spec's expectation. *An adapter that lies or has rotted fails its own test* rather than silently corrupting every other test.
   - **It is typed against the *generated* interface,** so a spec regeneration that changes that interface makes a stale fragment **fail to compile — loud, not silent.**

**Who writes it:** the **engineer** owns the residual fragment; the **agent** drafts it from the spec + the impl. **Why it doesn't re-create two truths:** most of it is generated from the same spec (not a second truth); the primary check needs no state map (events); the residual hand-written surface is minimized, self-tested, and breaks loudly on drift.

**Honest residual risk (added to §19):** this is the highest-risk *engineering* component, and the residual hand-written surface is **not zero** for implementations that diverge sharply from the generated persistence (heavy caching, event-sourced read models, polyglot storage). The claim is not "no adapter" — it is "the adapter is bounded, generated-first, and self-checking, so it fails loudly instead of drifting silently." De-risk it in the vertical slice (§21) on a *real* impl before trusting the anti-drift story.

### 11.6 The cheapest first slice — CI-first conformance (passive invariant assertions)

Before any model checker, engine, elicitation loop, or DST substrate, target ② has a wedge that delivers value on an **existing** codebase in days. It attacks the most common real failure directly: **not missing tests — missing assertions.** A mature system has thousands of tests that already drive the right states and simply never *check* the cross-aggregate invariant that a bug violated (an `Active` subscription whose latest invoice is silently past grace; a subscription and invoice passing each other data that disagrees). Compile invariants to **passive assertions evaluated over the state the existing suite already produces**, and every one of those tests becomes an invariant check for free.

**Mechanism (framework-agnostic; Jest as illustration).** One global teardown hook snapshots the state each test produced — via the `observe()` projection (§11.5) — and evaluates every registered invariant over it. No model checker, no engine, no re-encoding, no new per-test code. In CI you already hold the domain objects in memory, so this is `observe()` at its cheapest.

- **Observe at the layer where semantic state already exists.** If the app materializes state in a domain object (`sub.accessState()`) or emits it on the outbox event, `observe()` is **near-identity** — no hand-written `mapAccess`-style translation. A non-trivial translation is needed *only* when semantic state is scattered across storage columns and materialized nowhere — and that very absence is a cause of the "two systems disagree" bug class, so writing the single canonical `observe()` **fixes** the class rather than taxing it. Crucially, the map is **elicited by the invariant**, not proactively remembered: a feature author writes an assertion referencing `accessState`, and the tool asks "define how to read `accessState` from storage, once." They never start from the adapter.
- **Report → enforce rollout (shadow mode, in CI).** Never flip enforce on a large suite cold — you get a wall of red mixing real bugs with bad fixtures, and it gets reverted. Run **report** mode first: collect every violation across the whole suite; each line is either a real inconsistency the suite silently tolerated (the bug class you care about) or a fixture that builds an impossible state (also worth knowing). Triage, fix or annotate, **then** enforce and gate CI against regressions.
- **Escape hatches.** The invariant's own state guard (`where Access == Active`) auto-skips mid-construction junk; an explicit `@noInvariants` opt-out (with a **required reason**, so the opt-out list is itself auditable) covers deliberately-invalid error-path tests. Evaluate at quiescence (teardown), not mid-flow.
- **Two tiers, both in CI.** (1) **Passive assertions over *existing* tests** — removes the missing-assertion problem for free, zero new test-writing. (2) **Generated command sequences** (stateful property testing, target ②) — explores the interleavings and orderings hand-written tests never generate, which is exactly where race and cross-aggregate-assumption bugs hide. Tier 1 is days; tier 2 is where the behavioral bugs of §14 start getting caught without a full model checker.

**Why this is the right first target.** No infrastructure (no CDC, replica, or prod feed); the *same* invariants and `observe()` projection later graduate to runtime monitors (③) with no rework and no lock-in; and it **validates the `observe()` half of the §11.5 adapter on a real codebase** before any heavy machinery is built on top of it. It is the ramp-not-cliff principle (§1–2) applied to adoption itself: one hand-written projection and one predicate return value on day one, long before the model checker, the loop, or the second engine exist. Design-time model checking (①) and DST (④) still do what only they can — find the race *class* before code exists, and in the real binary under fault storms — but the cheapest proof that the whole anti-drift thesis pays off on *your* system is this CI wedge.

---

## 12. The Decision Ledger

Append-only (fits event-sourcing). Every entry is evidence and lineage.

- **Verdicts** — each judged case: the witness, the human's permit/forbid, timestamp, who judged.
- **Open decisions / hotspots** — genuine policy forks the system *refuses to guess*; they **block** the affected transition until resolved. (EventStorming red stickies, formalized.)
- **Multi-expert votes** — when two experts judge the *same* generated witness differently, that's a real business ambiguity, recorded as a pending decision (not a spec bug).
- **Provenance / lineage** — every adopted invariant stamped (`mined from e2e set 2026-07-02, support 240/240, verified depth 12`, or `from Idempotency@acme v3`).

Feeds: elicitation (don't re-ask judged cases), the oracle (regression anchors), the prose "open decisions" section, and reviewers (why does this invariant exist? was that omission deliberate?).

---

## 13. Domain events vs. transitions

They are **different concepts**; conflating them is a classic error.

| | Transition | Domain event |
|---|---|---|
| Kind | a *rule* | a *fact* |
| Tense | present ("from S on T → S'") | past ("SubscriptionActivated") |
| Guard/precondition? | yes | no — it already happened |
| Mutable? | a spec definition | immutable record |
| When | design-time behavior spec | runtime occurrence |
| Role | the checker *verifies* it | the trace *observes* it |

Directional relationship:
```
inbound event / command  →  TRANSITION (guard + effect)  →  outbound domain event
   (the trigger)              (the verified rule)             (the recorded fact)
   PaymentSucceeded           activate: PastDue→Active        SubscriptionActivated
```
The guard lives on the transition, never on the event (a fact has no precondition). Two payoffs: (a) the emitted events *are* the semantic events an outbox appends and workflows trigger on; (b) the model-checker's **trace is a domain-event stream**, so conformance (target ②) is observed at the event layer. *Event sourcing is orthogonal* — even if you event-source the aggregate, keep the guarded rule separate from the recorded fact in the spec, or you lose the guards the checker reasons about.

---

## 14. Concurrency: races and sagas (why the behavioral checker exists)

Structural finders (Alloy) see single-state properties. Races and saga-crash bugs are **properties of interleavings and fault-injected executions** — found only by the behavioral checker exploring interleavings + faults. **These bugs can only arise where atomicity is broken (§5.3): an atomic single-transaction command is provably free of them, so the checker focuses this machinery exactly on the boundary seams the tool flagged.** Two canonical bugs the checker finds, and the design principles they force:

### 14.1 Upgrade-checkout vs. cancel (TOCTOU)

A two-phase upgrade reserves balance, then (after a payment round-trip) captures and applies the new plan. A concurrent `cancel` interleaves in the wait:

```
COUNTEREXAMPLE
  s0: sub=Active(Basic), available=100, reserved=0
  beginUpgrade  available=60, reserved=40
  ── interleave ──
  cancel        sub=Canceled                 (guard `from Active` held at that instant)
  confirmUpgrade payment.succeeded → plan=Pro on a CANCELED sub  ✗ violates Terminal
  ALT: if confirm guards state → confirm aborts → reserved=40 stranded forever  ✗ violates NoLeak
```
A dilemma: guard `confirm` and you leak money; don't and you mutate a terminal aggregate. **Fix the checker validates:** make the reservation part of the aggregate state (so `cancel` is *forced* by an invariant to compensate: `once Canceled: pendingUpgrade == none`), **or** serialize both through the same aggregate transaction boundary (a held transaction makes the interleaving unreachable). The model *proves why the reservation must live inside the consistency boundary or be a compensating saga.*

### 14.2 Saga + DB failure → double charge

```
process (as a machine): CollectPayment
  charge:  PSP.charge(inv.id, amount)     // external, at-least-once
  yield   // ← crash window before the DB write
  record:  atomic { db.payments += (inv.id, amount); inv.state = Paid }
policy onCrash { retry from start }

COUNTEREXAMPLE (crash + non-idempotent retry)
  charge   PSP.charged=40  (idemKey=inv_1)
  CRASH
  retry → charge   PSP.charged=80          ← PSP not deduping inv_1
  record   db.recorded=40                  ✗ violates NoDoubleCharge
```
**Fix the checker validates:** idempotency-key dedup at the PSP boundary, **or** the outbox pattern (write intent+record atomically, emit to PSP after, dedupe on the far side). The checker, given a naive saga, produces the counterexample that *motivates the outbox architecture you already have.*

**Concurrency primitives:** sagas are state machines; **every `yield`/await is a named state** (that's where interleavings happen and invariants must hold); `crash` points are nondeterministic faults the checker injects (the in-model version of Antithesis). Do **not** introduce a separate imperative `process` construct that hides the pending state — that's exactly where bugs hide.

---

## 15. Model-checking scope & decidability — the honest ceiling

- Bounded model checking proves "no counterexample **within bound**," not correctness (small-scope hypothesis). Unbounded requires an **inductive invariant**, which §9.1 tries to synthesize but cannot always find.
- **Nonlinear arithmetic is a nuance, not a flat wall.** Over *unbounded* integers, `price × days / period` is undecidable and SMT may not terminate — but real money math is **fixed-width integer cents**, and fixed-width (bitvector) arithmetic — multiply, divide, mod, rounding — is **decidable** (bit-blasted to SAT), just potentially slow. So the real axis is *encoding cost and which artifact you verify*, not decidability. Three-layer discipline:
  - **Default — property-based + differential testing against a reference implementation** (an exact-`Decimal` oracle vs. the production int-cents code), in the impl language, no re-encoding. Catches the overwhelming majority of proration/rounding drift cheaply. *This is not your primary bug source anyway* (races and cross-aggregate assumptions are — §11.6, §14).
  - **Must-never-happen money list — verify the *real code* with a code-level bounded checker** (Kani for Rust, CBMC/JBMC for C/Java, CrossHair for Python), **not** a re-encoded model. Re-encoding the formula into a separate artifact recreates the two-truths problem §11.5 fights; a code-level checker verifies the actual function. Reserve this for properties where a *sampled* miss is unacceptable — rounding bugs often hide at a single residue random sampling under-hits, and only exhaustive (SMT/BMC) coverage nails them.
  - **Model-check the *relationships*, not the formula.** Conservation (`sum(buckets)` constant), non-negativity, the rounding bound (`|Σ rounded − rounded(Σ)| ≤ n·unit`), credit/charge netting on plan changes — these are **linear and decidable** even when the underlying formula isn't, and they are *where money bugs actually surface* (a lost cent shows up as a conservation violation, not as "the multiply is wrong"). Keep these as first-class invariants; leave the raw arithmetic to the two layers above.
- **Real time** (grace windows, "within 23h") wants timed-automata reasoning. **Model time abstractly** (symbolic event ordering / discrete ticks), not real durations.
- **Honest value-prop language:** *lifecycle & consistency are model-checked; monetary arithmetic is property-tested; the unbounded tail is covered by runtime monitors + DST.* Not "proven correct." State this as a differentiator, not a weakness — overclaiming is how tools lose trust.

---

## 16. The question-minimizing LLM conversation (worked)

Human judgment is spent only on residual ambiguity; most invariants arrive pre-made.

```
Founder:  Stripe-style subscriptions with invoicing and dunning.

Agent:    Seeding from the Stripe model + your @acme templates:
          · Structure: Subscription + Invoice aggregates, PSP external call
          · 12 invariants proposed. Breakdown so you see what actually needs you:

            6  auto-adopted from templates (MoneyConservation, Idempotency, Terminal,
               NoOrphan, SingleActive, DeadlineBound) — verified, no question needed
            3  from Stripe domain knowledge, high-confidence — auto-confirmed, flagged for review
            2  genuinely ambiguous → one judgment each
            1  a real policy fork → I won't guess

          [Q1]  Active subscription, latest invoice unpaid & 5 DAYS past due — valid state?
Founder:  No — that should be PastDue.
Agent:    (that verdict eliminated 3 of 4 grace-rule candidates; one boundary check left)
          [Q2]  Same, but 5 HOURS past due — valid?
Founder:  Yes, retries still running.
Agent:    Converged: Active-while-unpaid only within `grace` of the due date. ✔

          ⚠️ Open decision (parked; blocks `dunning_exhausted`): after retries exhausted,
             go Unpaid or Canceled? Alice: Unpaid · You: Canceled. Recorded, not guessed.

          Total human input: 2 judgments + 1 pending decision, for 12 invariants.
```
Two questions, not twenty — the Question Planner asked the maximally-discriminating, reachable, minimal cases; everything else came from sources needing no interrogation. *(The "2 questions" is a best-case illustration, not a guarantee — see §19 Risk 3.)*

**Read this ratio honestly (§8 intro).** 9 of 12 invariants came from templates + LLM seeding *because billing is a well-covered domain*; the active-learning loop did the residual 2. In a **novel** domain with no template coverage the ratio inverts — templates contribute little and the loop (plus inference) does most of the work, at a higher question cost. The loop's value scales with novelty; do not read "2 of 12" as "the loop is unimportant," nor as "elicitation is always cheap."

---

## 17. The human-readable spec (worked, prose projection)

```markdown
# Billing — Subscriptions & Invoicing

A **Subscription** belongs to a Customer and a Plan; it earns monthly revenue (mrr).

## Lifecycle
Incomplete → Trialing → **Active** ⇄ Past due → { Unpaid, Canceled }.
- **Activate** (→ Active) when payment succeeds; *requires* the latest invoice is Paid.
- **Cancel** (→ Canceled, terminal); releases any pending reservation.

## Always true
- Only one **Active** subscription per customer per product family.        (ledger #14)
- If it earns revenue, it's *Active* or *Past due*.                         (BillingLive)
- Active while unpaid only within the **grace period** after the due date.  (elicited 07-02, #21–23)
- Money in a balance only moves between buckets; the total never changes.   (MoneyConservation@v3)
- A charge with an idempotency key is applied at most once.                 (Idempotency@v3)

## Eventually
- **Dunning always resolves** — a Past due subscription ends up Active, Unpaid, or Canceled.

## ⚠️ Open decision — blocking
- Retries exhausted → **Unpaid or Canceled?**  Alice: Unpaid · Founder: Canceled. Undecided;
  the `dunning_exhausted` transition won't generate until resolved.
```
Same AST as §5.2. Domain expert lives here; engineer lives in the code; the solver sees the compiled form.

---

## 18. Improvement flows — the flywheel

All flows write back to the Decision Ledger and Template Catalog, so the spec tightens over time.

```
        write spec ──▶ Oracle Compiler ──▶ ① model check  ② tests  ③ monitors  ④ DST
             ▲                                     │            │         │        │
             │                                     ▼            ▼         ▼        ▼
             │                              ┌───────────── TRACES ─────────────────┐
             │                              │  (multiverse ▸ e2e ▸ production)      │
             │                              └───────────────┬───────────────────────┘
             │                                              ▼
             │                                        Trace Miner
             │        ┌──────────────┬────────────────────┼───────────────────────┐
             │        ▼              ▼                     ▼                        ▼
             │  adopt invariant  flag POTENTIAL BUG   propose TEMPLATE       coverage gap →
             │  (verified,       (near-100% support,  (shape seen in ≥2      unreached state →
             │   novel)          rare violation)      aggregates)           propose e2e scenario
             │        │              │                     │                        │
             └────────┴──────────────┴─────────────────────┴────────────────────────┘
                       every proposal is human-judged + checker-verified
```

### Forward (design-time)
Templates + inference propose invariants → verified → adopted.

### Reverse (after test / prod runs) — mining
Instrument the suite (or prod outbox) to emit traces (same format as target ②). A Daikon-style structural miner + a temporal-pattern miner instantiate a fixed grammar (arithmetic relations, implications, cardinality/idempotency, `once/precedes/leads-to`, cross-aggregate couplings) against observed fields, each with a **support** score. Then **two model-checker gates**: (1) **novelty** (not already entailed — the §9.1 inductiveness check), (2) **truth beyond the traces** (no counterexample at depth k). Three outcomes:
- **Adopt** — strong support + survives checking + novel → propose as invariant.
- **Potential bug** — held 239/240, *violated once* → flag ("bug in that run, or a missing guard?"). Often the most valuable output.
- **Reject** — semantic sniff-test kills fixture artifacts (`amount < 100000`); partial-support temporal candidates reclassified as liveness-needing-fairness.

**Template promotion (mining new templates):** when a mined invariant *shape* recurs across ≥2 aggregates/contexts (e.g. Money-conservation in Billing *and* Ledger), propose promoting it to a reusable `rule` — which then finds a *third* aggregate (`Wallet`) that has the shape but wasn't tagged, and proposes the tag. The library grows itself.

### Coverage
The miner reports **unreached** states ("no trace reached `PastDue` with a pending upgrade"); the checker generates a path to the unreached state → **proposed e2e scenario**. Mining's blind spots become test-writing prompts.

### Substrate ranking
Best mining source = the **DST/model-checker multiverse** (hostile states tests never reach) > e2e (realistic edges) > production (only prod-reachable). The verification gate lets you mine any source without overfitting to it.

---

## 19. Risks & open research questions

**Meta-risk (the sharpest point): one load-bearing dependency, wearing many hats.** Trustworthy NL⇄formal translation (**autoformalization**) recurs in: LLM candidate proposal, prose→code, "explain-back" confirmation, the miner's semantic filter, and the initial chat. This is **correlated** risk — if autoformalization is unreliable, multiple components degrade *together*, and the failures are *plausible* (they typecheck, pass shown examples, read fine). Do not treat the seven components as independent bets.

| # | Risk | Hand-wave | Why hard | Severity | Mitigation | Kind |
|---|---|---|---|---|---|---|
| 1 | **Autoformalization fidelity** | "LLM proposes, finder disposes" | the finder catches internal inconsistency, **not** faithful-looking-but-wrong meaning; the "explain-back" check shares the same model's error (correlated) | **Highest — existential** | judge machine-generated *cases*, never confirm prose; decorrelate explain-back (different model); treat the **example/verdict set as the real spec** | Research |
| 2 | **Billing = arithmetic worst case** | "routes to Apalache/cvc5" | *unbounded* nonlinear is undecidable, but fixed-width money math is decidable-yet-slow; the real cost is encoding + which artifact you verify; real-time wants timed automata | Medium (was overstated as High) | model-check the *relationships* (linear); property-test/differential the formula; code-level-verify (Kani/CBMC/CrossHair) a must-never list — never re-encode; abstract time (§15) | Eng |
| 3 | **Bounded ≠ correct / loop convergence** | "verified to depth 12", "2 questions" | small-scope heuristic; inductive invariant is the thing you seek; true invariant may not be in the hypothesis space; MaxSAT split intractable over infinite spaces | Medium (survivable if not oversold) | state the ceiling; bound the loop; fall back to "pick one of N"; measure real question counts | Research |
| 4 | **Prose↔code round-trip** | "edit any projection" | prose→code is autoformalization; projectional editing is adoption-hostile; lossy projections recreate Rebel's two-truths **inside the tool** | Medium-high (fallback exists) | AST is the only editable thing; prose = read-mostly structured fields; give up freeform prose editing | Eng + research edge |
| 5 | **Two-engine composition** | "Reachability-Bridge conjoins structural XOR + machine run" | Alloy (SAT/relational) and Apalache (SMT/temporal) have different logics/state models; least prior art | Medium (designable-away) | **start single-engine** (Alloy 6 does temporal; Apalache expresses relations); split only if forced | Eng |
| 6 | **Conformance adapter rot** (the anti-drift keystone) | designed in §11.5 — but residual surface is non-zero | for impls that diverge from the generated persistence (heavy caching, event-sourced read models, polyglot storage), the impl-state→spec-state map is hand-written and rots — exactly where MBT dies | **High — the anti-Rebel thesis rests on it** | generate command→entry-point + state-read from the spec; make **event-trace conformance** (no state map) the default; residual fragment is **self-checking + fails-to-compile on drift**; de-risk on a real impl in the slice | Eng |

Secondary: trace-mining signal-to-noise (Daikon is noisy; near-100% bug heuristic false-positives); adoption/meta-effort at Stripe scale even with per-invariant cost reduced.

**Bottom line:** four of five are manageable by scoping + honest positioning. **Risk 1 is existential and correlated.** If autoformalization on real billing rules is untrustworthy with plausible errors, the product must pivot from "LLM authors formal specs, humans review prose" to "**humans author examples, LLM derives specs, examples are the ground truth**." Know which product you're building on day one.

---

## 20. The first experiment to run (autoformalization fidelity)

Before writing any grammar, de-risk Risk 1:

1. Collect **20 real Stripe billing rules** (proration, dunning, trial, tax, refunds, plan changes).
2. Have the LLM formalize each into the candidate invariant language.
3. For each, generate 3 "obvious" examples; keep formalizations that pass all 3.
4. **Measure: of the passing formalizations, how many are subtly wrong** (disagree with intent on a 4th, adversarial case a domain expert flags)?
5. **Decision thresholds:**
   - < ~10% subtly-wrong → the "LLM authors, human reviews" product is viable; proceed to a single-engine vertical slice.
   - 10–30% → viable *only* with the example-set-as-spec redesign (humans author examples; formulas are derived and continuously reconciled to the examples).
   - > ~30% → the freeform-prose / "agent authors the formal layer" pitch is not safe; pivot the product before building.

This one experiment tells you which of two products you're actually building.

---

## 21. Recommended build sequence

1. **Fidelity experiment (§20)** — gates the entire architecture direction.
2. **Single-engine vertical slice** — pick Apalache *or* Alloy 6; model **one** primitive (Subscription) end-to-end: structure → statechart → a handful of invariants → the Oracle Compiler's target ① (design-time check) and ② (conformance tests). No Reachability-Bridge yet (§19 Risk 5). **Wire ② against a *real* implementation to de-risk the conformance adapter (§11.5, Risk 6): prove event-trace conformance works with no state map, and measure how much residual hand-written adapter the impl actually needs.** This validates the anti-drift keystone before anything is built on top of it. And note: this slice leans on templates + LLM seeding, *not* the full elicitation loop (§8 intro) — build the loop later, when a novel domain forces it.
3. **The elicitation loop, minimal** — Hypothesis Manager + Question Planner over that one primitive; measure *real* question counts (§19 Risk 3).
4. **Template catalog + tags** — the 12 starter templates; the three-projection rule authoring; `fixtures` self-tests.
5. **Decision Ledger** — verdicts, open decisions, provenance.
6. **Targets ③ (runtime monitors) and ④ (DST)** — wire the same invariants to a monitor and to Antithesis; confirm the race/saga bug (§14) is caught at both design time and runtime.
7. **Reverse flow (mining)** — only once you have e2e traces to mine; add coverage + bug-flagging.
8. **Second engine + Reachability-Bridge** — only if the single-engine ergonomics genuinely hurt.

Guiding principle throughout: **the agent pays the formalization tax; the human only judges concrete cases; the model can never silently drift from the code.** That is the whole design, and the whole defense against the Rebel cliff.

---

## 22. Glossary & references

**Glossary.** *Aggregate* — consistency/transaction boundary. *CTI* — counterexample-to-induction. *DST* — deterministic simulation testing. *Entailment classifier* — is an invariant implied by the machine? *Inductive invariant* — closed under one transition step. *Projection* — a view (prose/code/diagram) of the one AST. *Recognition over recall* — humans judge concrete cases rather than author universals. *Reachability filter* — only ask about states the machine can reach. *Version space* — the set of candidate invariants still consistent with all verdicts.

**Key references.**
- Quint — https://quint.sh/docs/language-basics ; quint-connect (model-based testing bridge) — https://github.com/quint-co/quint-connect
- Fizzbee — https://fizzbee.io/ (roles, liveness/fairness)
- P — https://github.com/p-org/P/ ; AWS systems-correctness — https://cacm.acm.org/practice/systems-correctness-practices-at-amazon-web-services/
- Alloy 6 / Pardinus; Portus (Alloy↔cvc5 SMT finite model finding) — https://arxiv.org/pdf/2411.15978
- Dafny (deductive verification); Design-by-Contract (Eiffel/JML)
- Context Mapper (CML) — https://contextmapper.org/docs/language-reference/
- Rebel (ING/CWI) — https://www.cwi.nl/en/research/software-analysis-and-transformation/software/rebel-a-domain-specific-language-for-product-development-in-finance/
- Antithesis (DST) — https://antithesis.com/docs/introduction/how_antithesis_works/ ; WarpStream DST — https://www.warpstream.com/blog/deterministic-simulation-testing-for-our-entire-saas
- Jepsen/Elle (consistency from histories)
- mypyvy — https://www.wisdom.weizmann.ac.il/~padon/mypyvy-cav2024.pdf ; DuoAI (OSDI'22) — https://www.usenix.org/system/files/osdi22-yao.pdf ; PDR+ER (CAV'25) — https://arxiv.org/html/2505.18998
- Stripe subscription lifecycle — https://docs.stripe.com/billing/subscriptions/overview
- Runtime Verification (RV 2025) — https://2025.ecoop.org/home/vortex-2025 ; RV+LLM — https://arxiv.org/pdf/2511.14435
- Spec-driven development / EARS — https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices
```
