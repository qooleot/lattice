// Usage: npx tsx golden/parseback/diff.ts <session-dir> <witnessId> <parsedBack.json>
// parsedBack.json = a CaseState reconstructed by a FRESH model from Claude's prose question alone.
import { readFileSync } from 'node:fs';
import { loadState } from '../../src/engine/session.js';
import { extractSalient, salientKey } from '../../src/engine/salient.js';
import type { CaseState } from '../../src/engine/evaluate.js';

const [dir, wid, parsedFile] = process.argv.slice(2);
const s = loadState(dir!);
const pending = s.pendingWitnesses[wid!];
if (!pending) { console.error('unknown witness'); process.exit(2); }
const parsed: CaseState = JSON.parse(readFileSync(parsedFile!, 'utf8'));
const cands = s.candidates.filter(c => c.status === 'active').map(c => c.inv.candidate);
const a = salientKey(pending.salient);
const b = salientKey(extractSalient(cands, parsed));
console.log(JSON.stringify({ match: a === b, original: a, parsedBack: b }, null, 2));
process.exit(a === b ? 0 : 1);
