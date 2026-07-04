# Fidelity Gate — Agent Runbook

You are an agent executing the Lattice autoformalization fidelity experiment (spec §2.0). Your output
decides whether the project proceeds, pivots, or stops. **The value of this experiment is its
measurement integrity — a "helpful" deviation that improves the scores destroys the experiment.**

## What this measures

Whether an LLM, formalizing real business rules into a closed invariant grammar, produces
formalizations that are *subtly wrong* — they pass obvious test cases but disagree with intent on an
adversarial case. You orchestrate; fresh single-rule contexts formalize; a human judges.

## Protocol integrity rules (violating any of these invalidates the run)

1. **One fresh context per rule.** Each rule is formalized by a NEW subagent that has never seen any
   other rule, any other formalization, or this runbook. Dispatch 20 separate subagents (they may run
   in parallel — they share nothing).
2. **One shot, no repairs.** If a formalization fails grammar validation or its own obvious cases,
   RECORD that outcome. Never fix, retry, re-prompt, or "clarify" — a failure is data, not a bug.
3. **The formalizer's context is exactly the prompt template.** It must not read `docs/` (plan/specs),
   `lattice/fidelity/` (harness, rules, other results), or `lattice/src/engine/evaluate.ts`. The
   template embeds everything it needs.
4. **You never author adversarial cases or verdicts.** Those are the human's (steps 5–6). You convert
   and tabulate only.
5. **Report the tally verbatim**, whatever it says. Do not soften a STOP verdict.

## Prerequisites

```bash
cd lattice
npm install          # if node_modules missing
npx vitest run       # sanity: all tests pass (35+)
```

## Step 1 — Formalization fan-out

For each of the 20 rules in `fidelity/rules.json` (ids b01–b10, r01–r10):

1. Build the prompt: take `fidelity/formalizer-prompt.md`, replace `{{RULE_ID}}` and `{{RULE_TEXT}}`,
   and replace `{{GRAMMAR}}` with the full contents of `src/ast/invariant.ts`.
2. Dispatch it to a fresh subagent. It returns ONE JSON object (a FidelityRecord).
3. Save verbatim to `fidelity/results/<RULE_ID>.json`. If the reply isn't valid JSON, save what was
   returned to `fidelity/results/<RULE_ID>.raw.txt` and write a minimal record
   `{"ruleId":"<id>","status":"not-formalizable","model":{"context":"none","enums":[],"entities":[],"aggregates":[],"events":[]},"formalization":null,"cases":[],"adversarial":null,"humanVerdict":null,"notes":"unparseable reply"}` — do not re-ask.

## Step 2 — Mechanical check

For each saved record run:

```bash
npm run fidelity -- fidelity/results/<RULE_ID>.json
```

Interpret (do not edit formalizations):
- `grammarErrors` non-empty → leave the file as-is; the tally counts it not-formalizable.
- `obviousPass: false` → set `"humanVerdict": "failed-obvious"` in the file (the only edit you make).
- `grammarErrors: []` and `obviousPass: true` → survivor; goes to the human.

## Step 3 — Build the judging worksheet

Write `fidelity/results/JUDGING.md`. For each survivor, in rule-id order:

```markdown
## <RULE_ID> — "<rule text>"

**Formalization (raw):**
```json
<the formalization object, pretty-printed>
```

**Its 3 obvious cases:** (render each case's entities as a table: Entity | Id | Fields, plus `now` if
present, with the case's `desc` and `expected` verdict)

**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick,
  an off-by-one-period — where you suspect this formalization disagrees with the rule's intent.
  Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.
```

Do NOT add your own English gloss of what the formalization means — the human judges the raw
formalization against the rule text; your paraphrase would bias exactly what is being measured.

## Step 4 — STOP. Hand the worksheet to the human.

Tell them: "Fill in the adversarial case + expected verdict for each rule in
`fidelity/results/JUDGING.md`, then tell me to continue." Wait.

## Step 5 — Apply human judgments

For each survivor, convert the human's plain-English adversarial case into a `CaseState` JSON
(conventions: machine state as field key `"<Region>.state"`; ref fields hold entity ids; data fields
are numbers or enum strings — any other string value is treated as a dangling ref; `now` in ticks,
24 ticks = 1 day). **Show the human each converted case as an entity table and get their confirmation
before recording it** — a mistranslated case corrupts the verdict. Write it into the record's
`adversarial` field with the human's `expected` verdict, then re-run:

```bash
npm run fidelity -- fidelity/results/<RULE_ID>.json
```

Set `humanVerdict` mechanically from the output: `adversarialAgrees: true` → `"faithful"`;
`adversarialAgrees: false` → `"subtle-wrong"`. Human override (step 3) beats the mechanical result —
record the override and note it in `notes`.

## Step 6 — Tally and report

```bash
npm run tally
```

Also compute the per-domain split (the spec requires both rates reported separately):

```bash
npx tsx -e "
import { readdirSync, readFileSync } from 'fs';
import { tallyRecords } from './fidelity/tally.js';
const recs = readdirSync('fidelity/results').filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync('fidelity/results/' + f, 'utf8')));
console.log('billing:', tallyRecords(recs.filter(r => r.ruleId.startsWith('b'))));
console.log('revrec :', tallyRecords(recs.filter(r => r.ruleId.startsWith('r'))));
"
```

Commit the results:

```bash
git add lattice/fidelity/results
git commit -m "chore(lattice): fidelity gate results — <verdict one-liner>"
```

Report to the human: the overall verdict line verbatim, both per-domain rates, the count breakdown
(faithful / subtle-wrong / failed-obvious / not-formalizable), and one line per subtle-wrong rule
naming what the adversarial case exposed. **The thresholds:** < 10% subtle-wrong → proceed as
designed; 10–30% → STOP, example-set-as-spec pivot required; > 30% → STOP, do not build further.
