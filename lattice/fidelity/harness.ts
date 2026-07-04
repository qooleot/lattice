import { readFileSync } from 'node:fs';
import { validateCandidate } from '../src/ast/grammar.js';
import { validateModel } from '../src/ast/validate.js';
import { evaluateCandidate, type CaseState, type Verdict } from '../src/engine/evaluate.js';
import type { Candidate, Diagnostic } from '../src/ast/invariant.js';
import type { DomainModel } from '../src/ast/domain.js';

export interface FidelityCase { desc: string; state: CaseState; expected: Verdict }
export interface FidelityRecord {
  ruleId: string;
  status: 'formalized' | 'not-formalizable';    // not-formalizable = grammar can't express it (honest coverage signal)
  model: DomainModel;
  formalization: Candidate | null;
  cases: FidelityCase[];                         // exactly 3 "obvious" cases
  adversarial: FidelityCase | null;              // the 4th, expert-flagged case
  humanVerdict: 'faithful' | 'subtle-wrong' | 'failed-obvious' | null;   // filled by the human after review
}
export interface CheckResult { grammarErrors: Diagnostic[]; obviousPass: boolean; adversarialAgrees: boolean | null; perCase: { desc: string; got: Verdict; expected: Verdict }[] }

export function checkRecord(r: FidelityRecord): CheckResult {
  if (r.status === 'not-formalizable' || !r.formalization)
    return { grammarErrors: [], obviousPass: false, adversarialAgrees: null, perCase: [] };
  let grammarErrors: Diagnostic[];
  try {
    grammarErrors = [...validateModel(r.model), ...validateCandidate(r.formalization, r.model)];
  } catch (err) {
    grammarErrors = [{ code: 'validator-crash', message: String(err) }];
  }
  if (grammarErrors.length) return { grammarErrors, obviousPass: false, adversarialAgrees: null, perCase: [] };
  const perCase = r.cases.map(c => ({ desc: c.desc, got: evaluateCandidate(r.formalization!, c.state), expected: c.expected }));
  const obviousPass = perCase.every(c => c.got === c.expected);
  const adversarialAgrees = r.adversarial
    ? evaluateCandidate(r.formalization, r.adversarial.state) === r.adversarial.expected
    : null;
  return { grammarErrors, obviousPass, adversarialAgrees, perCase };
}

// CLI: npm run fidelity -- results/r01.json
if (process.argv[2]) {
  const rec: FidelityRecord = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(checkRecord(rec), null, 2));
}
