// Per-domain tally split (spec §2.0 requires both domains reported separately).
// Usage: npx tsx fidelity/split.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tallyRecords } from './tally.js';
import type { FidelityRecord } from './harness.js';

const dir = join(import.meta.dirname, 'results');
const recs = readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FidelityRecord);
console.log('billing:', tallyRecords(recs.filter(r => r.ruleId.startsWith('b'))));
console.log('revrec :', tallyRecords(recs.filter(r => r.ruleId.startsWith('r'))));
