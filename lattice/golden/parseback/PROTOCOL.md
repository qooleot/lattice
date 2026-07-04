# Decorrelated parse-back (spec §5.1) — golden-run instrumentation, not a per-turn cost

For each question asked during a golden/interactive run:
1. Copy ONLY Claude's prose narration (not the table) into a FRESH Claude conversation with the
   domain model JSON, asking it to reconstruct the concrete case as CaseState JSON.
2. Run: npx tsx golden/parseback/diff.ts <session-dir> <witnessId> <parsed.json>
3. `match: false` = a rendering-fidelity failure — count it toward kill criterion 3 (§2.4)
   and record it in trace-c-interactive.md.
