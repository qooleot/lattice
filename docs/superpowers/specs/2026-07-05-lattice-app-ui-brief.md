# Lattice — App/UI Track Brief: Productizing the Elicitation Experience

- **Date:** 2026-07-05
- **Status:** Pre-design brief — NOT an approved design, and deliberately more open-ended than the
  engine-slice briefs: the assignment is to *think*, brainstorm with the human, and converge on a
  v1 app design. Write the design spec, get approval, then writing-plans. Do not build first.
- **Origin:** the project's founding goal (2026-07-03): "build an app around this idea… start
  first with the experience of using an AI chat to build the human readable and code spec."
  Slice 1 built that experience as a Claude Code skill + CLI — a deliberate scaffold. Domain
  experts (founders) will not live in a terminal; this track builds where they will live.
- **Parent design:** [`docs/plan.md`](../../plan.md) §3.1 (cast of roles), §6 (projections and the
  authoring boundary), §16–17 (the worked conversation and the founder-facing spec).

---

## 1. What exists (the app is a client, not a rebuild)

- **The engine** (`lattice/src/cli.ts`): deterministic, session-backed, JSON-in/JSON-out. Commands:
  `structure`, `init`, `propose`, `next-question`, `verdict`, `regenerate`, `status`,
  `witness-show`, `emit`. This boundary was designed from day one as the seam an app cuts along.
  Sessions persist in `state.json` + append-only `ledger.jsonl` (the canonical artifact).
- **The NL translator**: currently the `elicit-spec` Claude Code skill
  (`.claude/skills/elicit-spec/SKILL.md`). Read that file as the *behavioral spec* of the app's
  agent: phase-0 structure protocol, dual-render rule (deterministic witness table shown verbatim,
  prose is additive), probe-pick rule, regeneration/alternatives protocol, and the gate-binding
  rules (never present an unprobed formalization as settled; every adopted invariant cites its
  ledger anchors; ambiguity becomes a boundary question). In the app, this role moves to a
  **Claude Agent SDK** agent with the same protocol.
- **Real usage evidence**: one full live session (billing warm-up) is committed — read
  `.lattice-session-subscriptions/ledger.jsonl` (45 entries) and `specs/subscriptions/` to see the
  actual interaction shapes the UI must serve, and `lattice/golden/trace-c-interactive.md` for the
  measured-run protocol the app should eventually make effortless.

## 2. The interactions the UI must make first-class (from real usage, not speculation)

1. **Structure Q&A (phase 0)** — propose-and-correct, mostly multiple-choice with free-text
   correction. ~10 questions. Chat-shaped, but each answer mutates a visible, growing model —
   the UI should show the domain taking shape (entities/lifecycles appearing) as answers land.
2. **The "comes free" moment** — 13 template invariants auto-adopted in the live run. This is the
   product's first wow; it deserves presentation weight (a reviewable list, not a chat paragraph).
3. **Judging witnesses — THE core interaction.** A concrete state (entity table; sometimes a
   snapshot *sequence* for temporal witnesses) + three buttons: permit / forbid / we-haven't-
   decided. The dual-render rule is binding: the deterministic table is ground truth and must be
   shown verbatim; the agent's one-sentence framing is sugar. Temporal witnesses (trace-B/C style)
   want a small timeline rendering, not a wall of tables.
4. **Open decisions** — parked forks are a first-class queue ("3 decisions await you"), not chat
   scrollback.
5. **Provenance / anchors** — every adopted rule links to the judged cases behind it. In chat this
   is a citation string; in a UI it's click-through: rule → its witnesses → the human's verdicts
   with timestamps. This is the trust story rendered literally, and no chat can do it as well.
6. **The deliverables** — founder-facing prose spec and engineer-facing `.lat`, both re-rendering
   live as the session progresses (projections of one AST — let the user SEE that).
7. **Latency honesty** — Alloy answers in ~1s, Apalache in ~5s (worst budget 45s). The UI needs a
   truthful "solver is searching for a counterexample…" state, never a fake spinner over nothing
   (user's durable rule: no simulation theater; the engine is real, show its real work).

## 3. Architecture questions to brainstorm (the real forks)

1. **Hosting/runtime model.** The solver toolchain is heavy (vendored JDK ~336MB, Alloy jar,
   Apalache): (a) hosted service wrapping the engine (sessions server-side; browser app;
   toolchain is a server concern — likely v1 answer), (b) local-first desktop wrapping the
   existing CLI (zero infra, heavy install), (c) hybrid. Cost/latency/multi-user implications.
2. **Agent runtime.** Claude Agent SDK service that owns the conversation and calls the engine
   (engine as library import vs. subprocess CLI — the engine is plain TS, importable server-side;
   the CLI exists for process isolation). The SKILL.md protocol becomes the agent's system prompt;
   gate-binding rules carry over verbatim.
3. **v1 audience.** Founder-only (judging + prose spec) with `.lat` as a download? Or split-pane
   founder/engineer views from day one? (Plan §3.1's role table is the guide; YAGNI pressure says
   founder-first.)
4. **Chat-first with structured cards, or canvas-first with a chat rail?** The evidence says the
   session is chat-*paced* but card-*shaped*: witness cards, decision queues, a growing model
   panel. Where does the center of gravity sit?
5. **Session/workspace model.** Multiple domains per user; resume; sharing a spec read-only
   (the prose projection as a shareable artifact is a natural first collaboration feature);
   multi-expert votes (plan §12) later — don't preclude, don't build.
6. **What happens at the end of a session** — where do emitted specs live, how do re-elicitation
   rounds work on an existing spec (the ledger supports it; the UX story doesn't exist yet).

## 4. Explicitly out of scope for v1 thinking (note, don't design)

- Generation-slice output surfacing ("here's your running service") — a future tab, coming from
  the generation slice; leave a seam, not a design.
- `.lat` in-browser editing — that's slice 3's parser + an editor story; the app renders `.lat`
  read-only until that lands.
- Multi-expert simultaneous judging, mining/flywheel views, runtime-monitor dashboards.

## 5. Constraints binding this track

- **The engine is the only source of truth and it is real.** The app never simulates engine
  behavior, never fakes a witness, never renders an invariant as adopted without its ledger
  anchors. (Fidelity-gate binding + the user's durable no-simulation rule.)
- The dual-render rule is UI law: deterministic witness tables verbatim; prose is additive.
- Engine changes belong to engine slices — if the app needs protocol additions (e.g. a
  `next-question` streaming/progress event, structured phase-0 model-delta events), spec them as
  a short protocol-change proposal for the human to route, don't fork the engine.
- Process: brainstorm forks one at a time → design spec at
  `docs/superpowers/specs/2026-07-05-lattice-app-ui-design.md` → human approval → writing-plans.
  For eventual implementation, the frontend-design skill applies.

## 6. Pointers

- Engine protocol: `lattice/src/cli.ts` (commands + JSON shapes), session store
  `lattice/src/engine/session.ts` (`SessionState`, `LedgerEntry`).
- Agent behavioral spec: `.claude/skills/elicit-spec/SKILL.md`.
- Real session to design against: `.lattice-session-subscriptions/ledger.jsonl` +
  `specs/subscriptions/{spec.prose.md,spec.lat}`.
- Worked UX narratives: `docs/plan.md` §16 (the question-minimizing conversation) and §17 (the
  founder-facing spec) — the app is these two sections made tangible.
