// Conformance capture: after each test, dump every DB the test opened as a raw SQLite image.
// Deliberately has ZERO imports from lattice/ — the harness reads these bytes offline.
import { afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbs } from './support.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.conform', 'snapshots');
let seq = 0;

afterEach(ctx => {
  if (openDbs.length === 0) return;
  mkdirSync(outDir, { recursive: true });
  const slug = ctx.task.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  for (const db of openDbs.splice(0)) {
    const base = join(outDir, `${process.pid}-${String(++seq).padStart(4, '0')}-${slug}`);
    writeFileSync(`${base}.sqlite`, db.serialize());
    writeFileSync(`${base}.json`, JSON.stringify({ source: ctx.task.name }));
    db.close();
  }
});
