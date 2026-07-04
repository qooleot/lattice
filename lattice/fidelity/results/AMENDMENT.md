# Protocol Amendment 1 — retry lane for format failures (2026-07-04)

**Decision (human):** the gate's purpose is measuring *semantic* fidelity of agent-authored
formalizations; first-shot format conformance is reported separately, not allowed to shrink the
semantic sample. Production gives format failures structured diagnostics + retries; the gate gives
exactly ONE re-dispatch.

**Procedure:** the 7 first-shot failures (b02, b03, b08, b10, r03, r04, r05) were re-dispatched once
each — same prompt template, fresh contexts, no reference to the failed attempts. Originals archived
verbatim in `first-shot/` (tally reads top-level only). A second failure is final (not-formalizable).

**Report obligations:** (1) first-shot conformance = 13/20, always reported alongside the verdict;
(2) re-run model: claude-sonnet (first-shot model not recorded — run by external orchestrator); noted
as a minor confound.

## Amendment 1 addenda (during re-run round)

- **Delivery normalization:** replies wrapped in markdown code fences whose content parses as a single
  JSON object are accepted (fences stripped, content saved verbatim). Rationale: transport formatting,
  not formalization content.
- **JSON-null normalization:** explicit `null` for optional predicate fields (statePredicate.where)
  is treated as absent — JSON has no undefined, and cardinality.where already blesses null. Validator
  fixed accordingly; affects r05's classification (grammar-clean).
- **Second strikes are final (per Amendment 1):** b02 (unknown-path — sum over a list field is
  inexpressible), b03 (unresolved-enum — cross-entity counting strained the grammar), r04
  (unknown-region — cross-entity machine-state reference; note this is precisely the ref-hop state
  extension already planned for Task 19). All three → not-formalizable, final.
- **Mechanical verdicts from re-run:** b08, r03 → failed-obvious (each grammar-clean but failed its
  own obvious case — the harness working as designed; r03's formalizer even self-flagged its
  approximation in notes).
