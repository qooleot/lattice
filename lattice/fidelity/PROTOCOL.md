# Fidelity Gate Protocol (spec §2.0 / §8) — run BEFORE any adapter work

For each of the 20 rules in `rules.json` (10 billing + 10 rev-rec):
1. In a FRESH Claude conversation, give it: the rule text, the §6.1 grammar (src/ast/invariant.ts),
   and ask it to produce a FidelityRecord JSON: a minimal DomainModel + a formalization (or
   status: "not-formalizable"), + 3 obvious cases with expected verdicts.
   Case-authoring constraint: data fields use numbers/enums; string values are ONLY entity ids (refs).
2. Save as fidelity/results/<ruleId>.json. Run: npm run fidelity -- fidelity/results/<ruleId>.json
   - grammarErrors non-empty → count as not-formalizable (record it, move on).
   - obviousPass false → humanVerdict: "failed-obvious".
3. For survivors, the HUMAN authors 1 adversarial case (a 4th case a domain expert would flag —
   boundary, sign trick, off-by-one-period). Add it, re-run.
4. Human sets humanVerdict: "faithful" (formalization matches intent incl. adversarial) or
   "subtle-wrong" (passed 3 obvious cases but disagrees with intent on the adversarial case).
5. Run: npm run tally  → read the verdict against spec §2.0 thresholds. Report BOTH domains'
   rates separately too (billing b* vs revrec r*) — degradation on revrec informs trace-C trust.

Decision: <10% proceed · 10–30% pivot (examples-as-spec) · >30% stop.
