# Lattice — Adversarial Command Generation Design (conformance tier-2b)

- **Date:** 2026-07-15
- **Status:** APPROVED design (brainstormed with the human 2026-07-15; all forks below resolved by
  the human). Next step: writing-plans.
- **Parent:** [`2026-07-14-lattice-slice-2-conformance-design.md`](2026-07-14-lattice-slice-2-conformance-design.md)
  (the passive harness this extends), [`docs/plan.md`](../../plan.md) §11.6 tier 2 ("generated
  command sequences… explores the interleavings and orderings hand-written tests never generate"),
  §11.5 layer 1 (command→entry-point — this slice builds its residual form for non-generated impls).
- **Hypothesis:** H-drive — *can conformance catch drift even when no test exercises it?* Slice 2's
  passive harness inherits the target suite's coverage (c13 proved the suite can be structurally
  blind); this slice removes that dependency and closes the declared guard-evaluation gap.

## 0. Thesis

A seeded generator DRIVES the implementation through command sequences nobody wrote. Because the
driver holds the real pre-state at every step, it finally evaluates the spec's `requires` guards
(passive mode's pre-registered honesty gap) — in both directions: legal commands must be accepted,
illegal probes must be rejected. Every reached state flows through the UNCHANGED slice-2 check
path. No solver in the loop; failures replay from a seed and shrink to a minimal command sequence.

## 1. Fork resolutions (all human-approved 2026-07-15)

| # | Fork | Resolution |
|---|------|-----------|
| 1 | Scope | **All three pressures**: legal-sequence driving; illegal-attempt guard probing (accept = violation); superset-op interleaving (spec-unknown ops woven between spec commands; their rejections are not violations, their state corruption is caught downstream). |
| 2 | Generator | **Seeded pure-TS walk + fast-check shrinking** (fast-check ^3 already a lattice dependency). Quint-simulated traces rejected for the driving path (JVM-slow, no shrinking; solver-directed generation recorded as a seam). |
| 3 | Driver map | **Hand-written typed `conform/drive.ts`** in the target (~20 lines for this impl). The map is irreducible semantic judgment — spec-`settle` = "recordPayment with exactly the remaining balance"; `dunningExhausted` = "the nightly job with a failing charge callback until the cap"; `recover` has NO dedicated entry point (side effect of recordPayment). Conventions bind data, not calling contracts: name-matching finds 3 of 11 transitions and zero argument shapes. Typed against the generated contract → compile-breaks on spec regen; line count joins the measured residual surface. Generated stubs recorded as follow-up DX if more targets materialize. |
| 4 | Pre-state oracle | **Scoped observe + tiered check frequency.** Per-step legality reads the REAL database, scoped to the target row + ref hops through the existing projection (no mirror — a maintained mirror is the §11.5 second truth, and desyncs worst exactly where it's tempting: real DBs with background jobs and concurrent writers). Full-tier sweeps at sequence end; per-step during shrinking; `--check-every` between. Cost model holds for remote/real-DB targets (O(1 query) per step). |
| 5 | Criteria | **Approved as drafted** (§5). |

## 2. Architecture

**Engine-side (`lattice/src/conform/drive/`):**
- **Walk** — fast-check-driven: arbitraries for command choice, target-row choice, and value
  synthesis (from spec field types); explicit `--seed`; sequence shrinking on failure.
- **Scoped pre-state reader** — target row + ref hops projected through the existing
  binder/observe machinery (same bindings, same overrides). Real reads only.
- **Oracle** — legality = from-state membership + `requires` via `evaluateCandidate` on the
  observed pre-state. Legal + rejected ⇒ violation (impl stricter than spec). Illegal probe +
  accepted ⇒ **post-accept re-attribution** (human ruling 2026-07-16, discovered by the first real
  campaign: one impl entry point can serve multiple spec transitions, e.g. `voidInvoice` ←
  voidDraft+voidOpen): the acceptance is a violation ONLY if no legal sibling transition explains
  the observed pre→post step (Tier 2's single-step rule reused); a sibling match is recorded as a
  narrative re-attribution. Honest limitation, reported never hidden: drift in one of two
  transitions sharing an entry point can be masked by its legal sibling. Post-state checking = the
  driven DB serialized as a standard snapshot and pushed through the unchanged slice-2 path
  (Tier 1 + Tier 2 + crosschecks) — total reuse, no new checking machinery.

**Target-side (`implementations/subscriptions/conform/drive.ts`):** the typed driver map —
`transitions` (one entry per spec transition: how to induce it here), `superset` (ops the spec
doesn't know), `create` (aggregate factories). All entries receive the scoped observed row and a
seeded value generator; rejections are detected by the driver contract (`{accepted} | {rejected:
reason}`, normalizing this impl's throws).

## 3. The walk, per step

1. Choose: create a new aggregate (bounded population) or target an existing row.
2. Scoped-observe the target row (+ ref hops).
3. Enumerate the machine's transitions for that row's region; evaluate from-state + guard on the
   observed pre-state.
4. With probability `1 − probeRate`: execute a LEGAL command via the driver — expect acceptance.
   With probability `probeRate`: execute an ILLEGAL one (wrong from-state or violated guard,
   chosen from the real candidates) — expect rejection.
5. Superset ops interleave at a configurable rate; either outcome is acceptable for them.
6. Sequence end (or every `--check-every` commands): snapshot → full existing check path.
7. On any violation: fast-check shrinks the sequence with per-step full checks; report the seed,
   the minimal human-readable command sequence, and the standard anchored violation.

## 4. Surface

`lattice conform --target X --drive [--sequences 200] [--length 30] [--seed S] [--check-every K]
[--probe-rate 0.2]`. The report's guards line upgrades in drive mode: `guards probed at event
time: N attempts across M guarded transitions` (the passive line remains for passive runs — the
honesty statement is mode-accurate). The ledger `conformance` entry gains drive metadata: mode
`'drive'`, sequences, probe counts, seeds, and the shrunk repro for any failure.

## 5. Pre-registered success / kill criteria (human-approved)

1. **Drift rediscovery 13/13:** the driver, run against the existing `drift/*` evidence branches
   WITHOUT their test suites (driving only), rediscovers every class. Same zero-tuning verbatim
   protocol as slice 2 plan 4; a rediscovery failure is recorded and escalated, never re-scoped.
2. **Guard probing both directions:** clean impl → 0 false accepts across the campaign;
   `drift/c04-weakened-guard` → the illegal probe's acceptance is caught directly.
3. **Zero false positives:** clean impl, 5 seeds × 200 sequences → 0 violations (pre-registered
   before any drift run).
4. **Determinism + shrinking:** every failure replays exactly from its seed; shrunk lengths
   measured and reported. A failure that does not reproduce from its seed is itself a criterion
   failure.
5. **Runtime:** default campaign (200 sequences × length 30) ≤ 60s on this target.
6. **Kill criteria:** irreducible false positives kill the generator design (not tuned around);
   any class passive mode caught that driving structurally cannot is a stop-and-redesign finding.

## 6. Honest scope boundaries (recorded)

- **Single-threaded sequences only.** Concurrency/interleaved-transaction fuzzing is target-④/DST
  territory; claiming race coverage here would overclaim.
- **Quint-directed generation** (solver hunting rare interleavings to seed the walk): recorded seam.
- **Host-side drivers for polyglot targets** (Ruby/Mongo): recorded seam — at that boundary the
  walk emits a language-neutral command plan executed by a host-side driver; the scoped-read cost
  model (fork 4) is what keeps that future viable.
- **Clock control:** drivers receive a monotonic `clock()` from the walk (deterministic); real
  time never leaks into sequences.

## 7. Constraints (inherited)

Engine discipline (tsc + conform suite green before every commit; full suite once per plan, by the
controller); no solver in the driving/checking path; diagnostics cite spec elements + ledger
anchors; no silent caps (probe coverage reported); never `git add -A`; conventional commits;
doc edits committed immediately.
