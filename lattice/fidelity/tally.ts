import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRecord, type FidelityRecord } from './harness.js';

const dir = join(import.meta.dirname, 'results');
const recs = readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FidelityRecord);

let faithful = 0, subtle = 0, failedObvious = 0, notFormalizable = 0, unjudged = 0;
for (const r of recs) {
  if (r.status === 'not-formalizable') { notFormalizable++; continue; }
  const c = checkRecord(r);
  if (c.grammarErrors.length) { notFormalizable++; continue; }
  if (!c.obviousPass) { failedObvious++; continue; }
  if (r.humanVerdict === 'faithful') faithful++;
  else if (r.humanVerdict === 'subtle-wrong') subtle++;
  else unjudged++;
}
const passing = faithful + subtle;
const rate = passing ? subtle / passing : 0;
console.log({ total: recs.length, faithful, subtleWrong: subtle, failedObvious, notFormalizable, unjudged,
  subtleWrongRate: `${(rate * 100).toFixed(0)}%` });
console.log(rate < 0.10 ? 'VERDICT: proceed as designed (<10%)'
  : rate <= 0.30 ? 'VERDICT: STOP — example-set-as-spec pivot required (10–30%)'
  : 'VERDICT: STOP — do not build further (>30%)');
if (unjudged) console.log(`WARNING: ${unjudged} records lack humanVerdict — tally incomplete`);
