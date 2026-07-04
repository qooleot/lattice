// Apply a human adversarial case to a fidelity record and set the verdict mechanically.
// Usage: npx tsx fidelity/apply.ts <ruleId> <adversarial.json> [--note "<text>"] [--override faithful|subtle-wrong]
// adversarial.json = { desc, expected: 'permit'|'forbid', state: CaseState }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRecord, type FidelityRecord } from './harness.js';

const [ruleId, advFile, ...rest] = process.argv.slice(2);
if (!ruleId || !advFile) { console.error('usage: apply.ts <ruleId> <adversarial.json> [--note t] [--override v]'); process.exit(2); }
const note = rest.includes('--note') ? rest[rest.indexOf('--note') + 1] : undefined;
const override = rest.includes('--override') ? rest[rest.indexOf('--override') + 1] as 'faithful' | 'subtle-wrong' : undefined;

const path = join(import.meta.dirname, 'results', `${ruleId}.json`);
const rec: FidelityRecord = JSON.parse(readFileSync(path, 'utf8'));
rec.adversarial = JSON.parse(readFileSync(advFile, 'utf8'));
const result = checkRecord(rec);
const mechanical = result.adversarialAgrees ? 'faithful' : 'subtle-wrong';
rec.humanVerdict = override ?? mechanical;
if (note) (rec as any).notes = note;
if (override && override !== mechanical) (rec as any).notes = ((rec as any).notes ?? '') + ` [human override: ${override}; mechanical said ${mechanical}]`;
writeFileSync(path, JSON.stringify(rec, null, 2));
console.log(JSON.stringify({ ruleId, adversarialAgrees: result.adversarialAgrees, humanVerdict: rec.humanVerdict }, null, 2));
