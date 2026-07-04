# Fidelity Gate — Final Report (2026-07-04)

## Verdict (pre-registered thresholds, spec §2.0 / plan §20)

```
subtle-wrong rate = 2 / (5 + 2) = 29%
VERDICT: STOP — example-set-as-spec pivot required (10–30%)
```

Per-domain: **billing 2/7 = 29%** (fully judged). **Rev-rec: unjudged** — judging was truncated by
human decision after 7 of 15 survivors ("we have enough examples"); all 8 unjudged records are
rev-rec and remain `humanVerdict: null`.

## Counts (20 rules)

| Outcome | n | Rules |
|---|---|---|
| Faithful | 5 | b05, b06, b09, b10 (overrides by inspection), b07 (case-confirmed) |
| **Subtle-wrong** | **2** | **b01** (Trialing counts as "active" — letter-vs-intent), **b04** (only `latestInvoice` consulted; intent = ANY unpaid invoice past grace) |
| Failed-obvious | 2 | b08, r03 (caught by their own cases — harness working) |
| Not-formalizable (final, 2 strikes) | 3 | b02 (sum-over-collection), b03 (cross-entity counting), r04 (cross-entity state ref) |
| Unjudged (truncated) | 8 | r01, r02, r05–r10 |

First-shot format conformance: **13/20** (Amendment 1 gave one retry lane; see AMENDMENT.md).

## Caveats (read before trusting the number)

1. **n = 7 judged, billing only.** Granularity is ~14 points; 29% is one catch away from either band edge.
2. **4 of 5 faithfuls are overrides by inspection** — the channel this experiment exists to distrust.
   Only b01, b04, b07 got real adversarial cases; of those, 2 of 3 were subtle-wrong.
3. **Both catches are prose-ambiguity catches, not encoding bugs**: the formalizations were faithful
   to the rules' *letter* ("active subscription", "latest invoice") and wrong against *intent*. b07 is
   the mirror case (text stronger than intent; the translation landed on the intended weaker reading).
   This measures "one-shot translation of ambiguous prose" — which is the product's premise, not its
   design: the elicitation loop exists to surface exactly these boundary questions ("latest paid but a
   prior unpaid?") as machine-generated witnesses.
4. Re-run model (sonnet) differed from unrecorded first-shot model; delivery normalizations
   (fence-strip, JSON-null-for-optional) documented in AMENDMENT.md.

## Interpretation

The pre-registered meaning of 10–30%: *"viable ONLY with the example-set-as-spec redesign — humans
author examples; formulas are derived and continuously reconciled to the examples."* (plan §20)

The slice-1 design already **is** that architecture, adopted in advance as pivot insurance (design
D13): the verdict ledger is the canonical artifact; invariant formulas are derived, regenerable, and
validated against every judged case; the elicitation loop anchors each surviving candidate to
concrete human verdicts. The gate's result upgrades D13 from insurance to **binding rule**:

- **No LLM-seeded invariant is ever adopted without at least one judged case anchoring it.** The
  loop's distinguish/probe path provides this; the elicit-spec skill must never present an unprobed
  formalization as settled (strengthen wording in Task 20).
- Emitted specs must always render invariants **with their ledger anchors** (already designed).
- Template-instantiated invariants remain auto-adoptable: templates are human-authored, self-tested
  schemas — a different risk channel than the one measured here.

## Grammar backlog (evidence-driven, deferred per §6.1 closed-grammar policy)

1. **Cross-entity machine-state refs** (r04 ×2 failures) — already scheduled: Task 19 ref-hop paths.
2. **Sum-over-collection** (b02 ×2) — real DDD shape (invoice lines → total); slice-2 candidate.
3. **Cross-entity counting** (b03 ×2) — likely NOT an invariant-grammar gap: "Trialing→Active only
   after payment" is a transition guard (machine construct); the gate tested only the invariant
   fragment. Route such rules to the machine in the real flow, don't widen the grammar for them.

## Process notes

- Validator hardened mid-gate (structural shape validation; no record edits; classifications
  unchanged) after ill-typed candidates crashed it — commit 95970bc.
- The human independently articulated the loop thesis mid-judging: "don't one-shot; show the
  translation, the cases, AND ask back 'only the latest invoice is evaluated — what if that is paid
  but a prior invoice is unpaid?'" That sentence is the Question Planner's job description (plan §8).
