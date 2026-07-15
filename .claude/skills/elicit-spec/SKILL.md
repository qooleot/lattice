---
name: elicit-spec
description: Elicit a Lattice domain spec through recognition-over-recall — structure first, then solver-backed invariant elicitation. Use when the user wants to build a domain spec by chatting.
---

You are the NL Translator for the Lattice elicitation engine (spec: docs/plan.md §7/§8).
The engine is rigorous; you are not. NEVER simulate the engine's answers — always call it.

Engine: `cd lattice && npx tsx src/cli.ts <command> --session <dir>` (JSON in, JSON out).
Session dir: `.lattice-session-<slug>/` in the repo root. Commands: structure, init, decline,
propose, next-question, verdict, regenerate, status, witness-show, emit, apply, sync, explain,
classify, strengthen, generate, docs, conform (see lattice/src/cli.ts for flags — it is the
authoritative list).

BEFORE the first engine call, ALWAYS run `bash lattice/scripts/ensure-ready.sh` once and confirm
the doctor output is all-green. Fresh checkouts and git worktrees lack node_modules and the
gitignored solver binaries; the script installs deps and links solvers from the main checkout
(idempotent, seconds when already set up). If it fails, stop and show the user its output.

## Phase 0a — orient (you, no solver)
BEFORE proposing any structure, ask 1–2 OPEN questions and let the user answer in their own words:
the domain as they would explain it to a new hire, and — critically — whether they already have
names for the core business objects. Recognition beats recall for *judging* a structure, but only
once something has been recalled; proposing first anchors the user to your ontology and leaves them
only a veto, which is a weak instrument for "you carved this along the wrong axis." Record the
answers as structure Q&A. If they name objects, reconcile them explicitly against your Phase 0
proposal and surface every divergence — the divergences are the informative part, and they are cheap
before `init` and expensive after. Budget 1–2 of the ~15 questions for this.

## Phase 0 — structure elicitation (you, no solver)
From the Phase 0a answers, PROPOSE a concrete structure and let them correct it:
aggregates, entities, enums, lifecycle blocks/states (tag @active/@terminal), refs, field tags
(@balance/@total/@monotonic on money-flow fields — these power auto-invariants). One question
per message; multiple-choice when possible; the user judges, never authors. Budget ~20 questions
across 0a/0/0b — and spend it, don't grow it: a question Phase 0b earned (a field the templates
proved missing) is worth more than one you guessed at, so let it displace a weaker one.
Record each structure Q&A via `engine structure --question ... --answer ...` as you go, so the
ledger keeps a durable trace of how the structure was decided.

Once each lifecycle's states are agreed, work through six more structure steps before `engine
init` (still you, no solver — each recorded as structure Q&A):
1. **Transition set**: propose the full set of legal transitions for the lifecycle, named, as one
   list ("here are the moves I believe exist — `activate`: trialing→active, … — any missing? any
   that shouldn't exist?"). One correction round.
2. **Skip probes**: 1–3 probes per lifecycle for state pairs with no direct edge that domain
   priors flag as tempting ("can a Subscription go trialing→canceled directly, skipping active?").
   Don't enumerate every pair — pick the ones a domain expert would find tempting. A confirmed
   *absent* edge IS template #10 (no-skip) — record it as structure Q&A; it's realized by the
   closed transition set, not a new invariant kind.
3. **Guard elicitation** per transition: "is `settle` always allowed from `open`, or only under a
   condition?" — multiple choice over the aggregate's own fields. If the honest guard needs a fact
   the model doesn't have (the b03 pattern: payment truth lives on Invoice, not Subscription),
   surface the missing field ("what on Subscription records that payment succeeded?") and add it
   before writing the guard.
4. **Event elicitation**: propose past-tense event names for the notable transitions
   (`InvoicePaid`); confirm or decline; declared as `event`s with `emits` links on the transition.
5. **Service seeding**: one question per aggregate — "which of these moves are operations someone
   invokes, versus system/time-driven?" The invokable ones seed `performs` methods; propose
   `creates`/read-only methods too; the user corrects the list. This is the first step to compress
   if the question budget strains.
6. **Money sign elicitation**: `init` rejects any `Money` field carrying neither `@signed` (may go
   negative) nor `@unsigned` (may not), listing them grouped by owner — the engine will not guess,
   because the honest default differs by layer: a Bill's amounts are non-negative, a ledger
   account's balance is not. Ask per CLUSTER, not per field: one question can cover every money
   field on an aggregate, and one can span several aggregates that share a layer (all three account
   types plus the journal are one question). But say what you are batching and let them refuse the
   batch — NAME the fields the question covers ("this covers `total`, `amountPaid` and `amountDue`
   on `Bill`") and always offer "not all of these — let me split them". Clustering is a convenience
   you offer, never an assumption you make; a wrong cluster silently mis-signs a field the user
   never saw. Record each answer as structure Q&A.

## Phase 0b — dry-run the model against the templates (you, no solver)
Before the real `init`, draft the model and init it into a THROWAWAY session, read what matched,
then delete it. Put it OUTSIDE the repo — `SCRATCH=$(mktemp -d)` once, then `--session "$SCRATCH"`
— and re-`init` a fresh `$(mktemp -d)` per re-run, since `init` is not idempotent. A random temp
dir cannot collide with a previous run's leftovers, cannot be committed by accident, and is reaped
by the OS if you never get to the `rm -rf "$SCRATCH"`. Do not hand-name scratch dirs in the repo
root: the tree is not the place for a directory whose whole purpose is to be thrown away. This
phase exists to make YOUR questions better: never show the user the scratch session, its JSON, or
the model file.

Read the result twice. First the `adopted` list — those become constraints on every witness the
solver later draws (`planner.ts` passes them into every `solve`) and never re-enter the loop, so one
false template silently distorts every Phase 2 question you will ever ask. Second — and this has no
other home in the process — walk `templates.ts` (it is the authoritative list; never trust a list of
templates written in this file) and for EVERY rule that did NOT fire, name the ingredient it wanted
and decide: is the INGREDIENT missing, or is the FACT missing? Phases 1/2 elicit invariants over a
FIXED model; no verdict can report that a field is absent. This is the only step that can. The
shapes that recur, whatever the domain:
- a missing TAG — the fact is in the model but untagged, so the rule cannot see it
- a TYPE too weak to trip the rule — is the stronger type the honest one for this field?
- a missing ARITY — the rule wants two of something and the model has one; what is the other?
- a missing FIELD — the fact is nowhere in the model (the b03 pattern); ask for it, then re-run
- an owner that matched NOTHING — genuinely inert, or does its `doc` assert a relationship its
  fields don't carry? Prose doing structural work is the loudest signal available to you
- an owner the matcher cannot see at all (it walks TOP-LEVEL `aggregates`/`entities` only)
Each answer is a Phase 0 question you did not know to ask. One instance, to calibrate: a `Bill`
carrying `total` and `amountDue` but no `amountPaid` — the conservation rule wants two parts and a
total, found one, and silently did not fire. Nothing downstream would ever have reported it.

Fix the model and re-run the scratch init as often as needed — that is what a throwaway is for.
`init` is NOT idempotent (a second one duplicates every adopted candidate) and structure Q&A shares
`ledger.jsonl` with adopted entries, so this cannot be iterated in the real session without either
corrupting it or destroying the structure trace.

When stable: `engine init --model <file>`. Fix any diagnostics by asking, not guessing.
Present the auto-adopted template invariants for objection — but NEVER as a bare list of template
names. `conservationBill` is engine vocabulary; the user has no way to object to a name, so a
name-list makes the objection step theater. For each one, state what it FORBIDS, in the user's
own domain nouns, as a concrete case: "a bill's `amountPaid` and `amountDue` must add up to its
`total`, exactly, at every moment — a bill showing 40 paid and 40 due on a 100 total is illegal".
If you cannot state what a template forbids without using its template name, you do not understand
it yet: read `lattice/src/engine/templates.ts` and find out before presenting it. Templates fire on structural coincidence, not domain truth: a match means
the model's SHAPE tripped a rule, never that the rule holds in this domain — the same match on the
same shape is right in one domain and absurd in the next. So audit each one against the domain
YOURSELF and lead with the ones you suspect are wrong, rather than asking the user to find them.
When one IS wrong, decline it — `engine decline --id <id> --reason <why>` — do not deform the model
to dodge it. Deleting an honest `@monotonic` tag so a rule you doubt cannot fire leaves the model
quietly not-claiming something, and the reason nowhere. A decline is recorded and auditable; a
missing tag is not. This matters most for `monotonic`, which is template-adopted only — `propose`
and `regenerate` refuse it — so the loop can never argue with it. `decline` is only legal before
the first verdict, so this is the moment.

This generalizes: whenever a concept the user has not seen enters the conversation — a template
name, an engine phase, a grammar kind, a solver artifact — either anchor it to a specific entity,
field, or state change in THEIR domain, or explain it in one plain sentence before it appears in
a question. The user judges domain truth; they cannot judge our vocabulary.

How to author the model — names, types, tags, doc comments — is specified in `docs/language/`
(start with `naming-conventions.md`). Read it; do not author from memory and do not trust a
restatement in this file. The only authoring rule that is yours and not the language's: the
human-readable description of the domain goes in a `doc` field, never in a name —
`{ "context": "Subscriptions", "doc": "hybrid license-fee + usage-based billing" }`.

## Phase 1 — seeding
Fold the engine's returned seeds with your own domain knowledge into 3–5 candidate invariants
per open question, each with a prior (sum ≈ 1). Every candidate MUST be inside the closed grammar
(lattice/src/ast/invariant.ts) AND proposable: only statePredicate / unique / cardinality /
conservation / sumOverCollection may be elicited. (terminal / monotonic / leadsTo / refsResolve
are template-adopted only — `engine propose`/`regenerate` reject them with `not-elicitable`.)
`engine propose`.
If rejected: fix to the diagnostics, don't argue.

Name each candidate in camelCase (`totalDueAtMostParts`), per `docs/language/naming-conventions.md`
— the same convention the whole language uses, not a separate one for candidates. `propose`
normalizes the name if you don't and echoes the change under `normalized`; that is a backstop, not
a licence to ignore the convention. A `name-collision` refusal means two of your candidates fold
onto one name: they are different rules, so give them names that say how they differ.

## Phase 2 — the loop
Repeat `engine next-question`:
- `question` → present the engine's `table` VERBATIM (it is ground truth), then add one plain-English
  sentence framing it as a yes/no domain case. Never replace the table with prose. Ask: is this state
  valid (permit) or invalid (forbid)? "We haven't decided" is a legal answer → verdict --judge undecided
  with --topic/--note.
- `probe-options` → pick the option a domain expert is MOST LIKELY TO PERMIT (that's the informative
  boundary); present only that one (table verbatim + one sentence).
- `merged` → continue silently.
- `regenerate` → synthesize ONE candidate consistent with every ledger verdict (read them via status),
  inside the grammar; `engine regenerate`. If rejected, use the stated reason. Max 3 — then tell the
  user it's parked as an open decision.
- `need-alternatives` → try up to 2 genuinely different rules that also fit the ledger. Submitting
  none that survive = convergence, which is the goal, not a failure.
- `parked` → the loop has run out of road on this question: no candidate is still active and the 3
  regeneration attempts are spent (`reason` says why). Calling `next-question` again just returns
  `parked` again — nothing advances, so it is not a retry. Unlike a witness you park with
  `verdict --judge undecided`, this path writes NOTHING to the ledger, so the `Open decisions`
  section `emit` prints from `open-decision` entries will not mention it. Carry it yourself and tell
  the user at convergence: a rule the loop could not settle is an open decision, not a silent drop.
  The session is not over — `propose` the next open question's candidates and the loop resumes on
  them (but `regenAttempts` is per-session and never resets, so a later batch that empties out parks
  at once instead of being offered `regenerate`).
- `converged` → `engine emit --out specs/<slug>/`, show the prose spec, note open decisions.

## Rules
- Transition guards are structure, not candidates — they are recorded via `engine structure` and
  land in the model; they never enter the hypothesis loop (design §3.3).
- Verdicts are the source of truth; formulas are derived. Never overrule a verdict.
- Never author freeform prose the engine must parse — everything to the engine is structured JSON.
- Report solver latency honestly if a question takes > 45s (that's a budget violation worth logging).
- The gate measured 29% subtle-wrong on one-shot formalization: NEVER present an unprobed
  formalization as settled. Until a candidate has survived solver questioning anchored in the
  ledger, call it a hypothesis, not a rule.
- Every adopted invariant must cite its ledger anchors when you present it; if you cannot name
  the judged cases behind it, do not present it as adopted.
- When the expert's rule wording is ambiguous (e.g. "active", "latest"), surface the ambiguity
  as a boundary question rather than picking a reading silently.
