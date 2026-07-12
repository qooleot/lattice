# Inference induction spike — pinned CLI behavior + classification protocol

Spike for Task 1 of the inference slice. Establishes empirically, against the local
toolchain (Quint 0.26.0, Apalache 0.47.2, auto-managed by quint), the two facts the
downstream `runQuintInductive` adapter and entailment classifier depend on:

1. whether a consecution counterexample (CTI) writes an ITF trace, and
2. the exact `quint verify` flag protocol that yields the correct
   **entailed / independent / violated** verdict on the committed Subscriptions spec.

All results below are the raw behavior observed, not the pre-spike hypothesis. Where the
hypothesized protocol did **not** work, that is recorded plainly along with the working
alternative that was found.

---

## Step 1 — induction flags exist (confirmed)

`cd lattice && npx quint verify --help | grep -E "inductive-invariant|init|invariant"`:

```
  --init                 name of the initializer action           [default: "init"]
  --invariant            the invariants to check, separated by commas
  --inductive-invariant  inductive invariant to check. Can be used together with
                         ordinary invariants.
```

All three flags are present in the local toolchain.

### How `--inductive-invariant NAME` actually runs (from quint `cliCommands.js`)

`--inductive-invariant I` expands to **three sequential Apalache runs** (each spawns a JVM):

1. **Phase 1 — base:** `init = <module init>`, invariant `I`, `--max-steps 0`.
   "Does `I` hold in the initial state(s) defined by `init`?"
2. **Phase 2 — consecution:** `init = I`, transition `step`, invariant `I`, `--max-steps 1`.
   "Starting from *any* state satisfying `I`, does one `step` preserve `I`?"
3. **Phase 3 — implication (only if an ordinary `--invariant J` is also given):**
   `init = I`, invariant `J`, `--max-steps 0`. "Does every `I`-state satisfy `J`?"

Phases run in order; if an earlier phase fails, the later phases do not run.

---

## Step 2 — does a consecution CTI emit an ITF?  **YES.**

The brief's minimal example uses `val inv = c >= 0` on `var c: int`. **That form does not
work**: an unbounded integer cannot serve as Apalache's init predicate in Phase 2, so the
run aborts with an assignment error rather than a clean non-inductive result:

```
> [2/2] Checking whether 'step' preserves the inductive invariant 'inv'...
error: c is used before it is assigned. You need to have either `c == <expr>` or
`c.in(<set>)` before doing anything else with `c` in your predicate.
exit=1
NO ITF
```

The invariant used as the Phase-2 init predicate **must bind every state variable** by
assignment or set membership. Rewriting the invariant so `c` is bound over a bounded set
(`val inv = c.in(0.to(5))`) makes the run behave as intended.

**File** `q_ni_bounded.qnt` (`init { c'=0 }`, `step { c'=c-1 }`, `val inv = c.in(0.to(5))`):

```
npx quint verify --inductive-invariant inv --out-itf /tmp/cti.itf.json q_ni_bounded.qnt
```

Observed:

```
> [1/2] ... inductive invariant 'inv' holds in the initial state(s) ...   NoError
> [2/2] ... 'step' preserves the inductive invariant 'inv' ...
State 1: state invariant 0 violated.
The outcome is: Error
[State 0] { c: 0 }
[State 1] { c: -1 }
error: found a counterexample
step2_exit=1
==> ITF WRITTEN
```

ITF contents (`/tmp/cti.itf.json`):

```json
{"#meta":{"format":"ITF",...},"vars":["c"],
 "states":[{"#meta":{"index":0},"c":{"#bigint":"0"}},
           {"#meta":{"index":1},"c":{"#bigint":"-1"}}]}
```

### Answer for Task 2's violation-detection branch

A consecution CTI **writes an ITF** and returns a **non-zero exit code**, exactly like an
ordinary `quint verify` counterexample. The ITF is a **two-state trace**: state 0 is the
pre-state satisfying the invariant, state 1 is the post-state violating it (the CTI).

Task 2's `runQuintInductive` therefore uses the **same detection as the existing
`runQuint`** (`src/solvers/quint-adapter.ts`): `exit != 0 && existsSync(itf)` ⇒ violated,
then parse the ITF as the witness/CTI. There is **no** need for a stderr-pattern branch and
**no** `violated` key inside the ITF — the ITF carries only `#meta`/`vars`/`states`; the
verdict is the exit-code + file-presence pair.

---

## Step 3 — an inductive invariant passes.  **Confirmed.**

**File** `q_ind_bounded.qnt` (`step { c' = if (c < 5) c+1 else c }`, `val inv = c.in(0.to(5))`):

```
npx quint verify --inductive-invariant inv --out-itf /tmp/ok.itf.json q_ind_bounded.qnt
```

Observed:

```
> [1/2] ... NoError
> [2/2] ... The outcome is: NoError
[ok] No violation found.
step3_exit=0
==> NO ITF (expected for pass)
```

Exit 0, no ITF written.

---

## Step 4 — classification protocol on the committed Subscriptions spec

The machine was emitted from the committed model via the real emitter
(`astToQuint`, `loadState('.lattice-session-subscriptions').model`); the emitted `init`,
per-transition `trans_*` blocks (with their real `requires` guards), and `step` were kept
verbatim. The invariant-under-test predicates were emitted faithfully by the same emitter
(passed as the query's `hi`). The catalog reference `oneOf(CATALOG.PLAN_IDS)` in the emitted
`init` was replaced by a local `Set("plan1","plan2")` so the throwaway probe compiles
standalone (the `plan` field is opaque `str` and is read by none of the invariants under test).

### 4a. The hypothesized `--inductive-invariant` protocol does NOT run on this machine

Two independent, empirically demonstrated blockers:

**Blocker 1 — Phase 1 uses the emitter's permissive `init`.** The emitted `init` draws every
field nondeterministically (`oneOf(Set(0,24,72,100))`, `oneOf(<enum>)`); it is a *state
generator*, not a true initial state. So Phase 1 ("does `I` hold at `init`?") fails for any
non-vacuous invariant. `Never_Overpaid_And_Paid_Exact` as `--inductive-invariant`:

```
> [1/2] Checking whether the inductive invariant 'NeverOverpaid' holds in the initial state(s) ...
The outcome is: Error
error: found a counterexample
exit=1
```

(init can produce `amountPaid > totalDue`, violating the invariant at "step 0".)

**Blocker 2 — Phase 2 cannot bind the map-shaped state.** Using an invariant that *is*
vacuously true at `init` (`retryCapWhilePastDue` — every subscription starts `trialing`, so
its `pastDue ⇒ …` body is vacuous) gets past Phase 1, and then Phase 2 aborts:

```
> [1/2] ... The outcome is: NoError
> [2/2] Checking whether 'step' preserves the inductive invariant 'RetryCap'...
error: subscriptions is used before it is assigned. You need to have either
`subscriptions == <expr>` or `subscriptions.in(<set>)` before doing anything else with
`subscriptions` in your predicate.
exit=1
```

Phase 2 uses the invariant as the init predicate; a `keys().forall(...)` invariant assigns
none of `now` / `subscriptions` / `invoices`, so Apalache cannot construct an arbitrary
`I`-state. (Same root cause as the `c >= 0` failure in Step 2, now on record/map state.)
Binding all vars symbolically would require a TypeOK ranging over the full typed value
domain of each map; that is not expressible through the current emitter output nor through
plain Quint surface syntax in a form Apalache handles without set expansion.

**Conclusion:** `--inductive-invariant` (and therefore the brief's two-probe protocol
phrased in terms of it) is **not usable directly** on the emitted machine.

### 4b. Working alternative — havoc-init consecution harness (this is the protocol to build)

Consecution can be checked with an **ordinary** `quint verify` by supplying a custom
`--init` action that (i) binds every state variable by *assignment* (`v' = …` — so no
"used before assigned"), (ii) havocs every field including the machine-state fields over
their enum domains, and (iii) asserts the induction hypothesis (`I`, and any peer
invariants) on the drawn state. Then check `I` for one step:

```
npx quint verify --init indInit --invariant I --max-steps 1 --out-itf <path> <file>
```

- **Holds** ⇒ exit 0, no ITF ⇒ `I` is maintained under the current guards+hypothesis.
- **Fails** ⇒ exit 1, ITF written with a **two-state CTI** (state 0 satisfies the
  hypothesis, state 1 violates `I`) — detected exactly as in Step 2 / `runQuint`.

`indInit` skeleton (both ids share a record via `mapBy`, so a forall-over-map hypothesis
reduces to the scalar constraint on the drawn record — see scratch `build_conseq.py`):

```
action indInit = {
  nondet nd_isettle = oneOf(Set("draft","open","paid","void","uncollectible"))
  nondet nd_ipaid = oneOf(Set(0,24,72,100))
  nondet nd_itotal = oneOf(Set(0,24,72,100))
  ... (one nondet per field of every owner, incl. status_state / settlement_state) ...
  all {
    now' = 0,
    subscriptions' = SUBSCRIPTION_IDS.mapBy(id => { ...fields..., status_state: nd_nstatus }),
    invoices'      = INVOICE_IDS.mapBy(id => { ...fields..., settlement_state: nd_isettle }),
    ((nd_isettle == "paid") implies (nd_ipaid == nd_itotal))   // the induction hypothesis I (∧ peers)
  }
}
```

Note: Quint forbids reading a primed variable with a method chain (`invoices'.keys()`), so
the hypothesis is asserted on the drawn nondet values (equivalently, on the constructed
record), not on `invoices'`.

### 4c. Observed verdicts (invariant-under-test = the `paid ⇒ amountPaid == totalDue` conjunct)

The relevant transition is `settle`, the only step into `paid`:
`requires (amountPaid == totalDue)`. `amountPaid`/`totalDue` are set only at init (no action
mutates them), so classification turns entirely on the `settle` guard.

| Case | Machine | Command | Exit | ITF | Verdict |
|------|---------|---------|------|-----|---------|
| **entailed** | `settle` guard `amountPaid == totalDue` (as committed) | `verify --init indInit --invariant PaidConjunct --max-steps 1` | **0** | none | consecution **holds** |
| **violated** | `settle` guard seeded to `amountPaid >= totalDue` | same | **1** | written | **CTI** |
| **independent** | committed guards, invariant `activePaidInFull`, **no peers** in hypothesis | same shape | **1** | written | **CTI** (same signature as violated) |

Raw evidence:

- **entailed:** `The outcome is: NoError` / `[ok] No violation found.` / `entailed_exit=0`, no ITF.
- **violated:** `State 1: state invariant 0 violated.` / `error: found a counterexample` /
  `violated_exit=1`, ITF written. CTI: state 0 = invoice `open`, `amountPaid=100`,
  `totalDue=72` (hypothesis holds vacuously — not `paid`); state 1 = seeded `>=` `settle`
  fired (`100 >= 72`), invoice now `paid` with `100 ≠ 72` ⇒ invariant violated.
- **independent:** `State 1: state invariant 0 violated.` / `independent_bareconseq_exit=1`,
  ITF written. CTI: state 0 = subscription `trialing` (hypothesis vacuous); state 1 =
  `activate` fired ⇒ subscription `active` while its `latestInvoice` is unpaid
  (`amountPaid ≠ totalDue`) ⇒ invariant violated.

### 4d. Key protocol finding: consecution alone conflates *violated* and *independent*

Both the seeded-`violated` case and the genuinely-`independent` coupling invariant fail bare
consecution with an identical signature (exit 1 + ITF + 2-state CTI). Bare consecution
answers only "is `I` self-inductive under the current guards?"; a `no` does **not** mean the
domain is buggy — a coupling invariant is simply not *entailed* by the guards, yet is a
legitimate constraint one could adopt.

Separating the three verdicts therefore needs the **second axis** the brief anticipated,
realized through the havoc-init harness (not `--inductive-invariant`):

1. **Consecution probe** — hypothesis `= (peersAnd and I)`, invariant `= I`.
   - Fails ⇒ **violated** (the CTI is a real counterexample even with the full peer set assumed).
   - Holds ⇒ entailed-or-independent; continue.
2. **Entailment probe** — hypothesis `= peersAnd` (peers assumed inductive), invariant
   `= (peersAnd implies I)`, `--max-steps 0`.
   - Holds (every peers-state already satisfies `I`) ⇒ **entailed**.
   - Fails ⇒ **independent** (`I` is consistent with, but not implied by, the peers+guards).

The peer set (`peersAnd`) is the conjunction of the already-adopted invariants, emitted the
same way and asserted at `indInit`. Pinning the full three-way protocol end-to-end (with the
real peer conjunction) was left for Task 2's implementation; Steps 1–3 and the entailed +
violated + independent(-bare) behaviors above are pinned definitively with raw output.

---

## Bottom line for Task 2

1. **Violation detection = exit-code + ITF presence**, reusing `runQuint`'s mechanism
   (`exit != 0 && existsSync(itf)` ⇒ violated; parse ITF as the CTI). No stderr pattern,
   no in-ITF verdict key. The CTI ITF is a two-state trace (pre-state = hypothesis, post =
   violation).
2. **Do not use `--inductive-invariant` on the emitted machine.** Its Phase 1 rejects the
   emitter's permissive `init`, and its Phase 2 cannot bind the map/record state. Instead
   emit a **havoc `indInit`** that assigns every var and asserts the hypothesis, and run
   `quint verify --init indInit --invariant I --max-steps 1 --out-itf <path>`.
3. **Classification needs two probes** (consecution, then entailment), because bare
   consecution cannot distinguish `violated` from `independent`.
