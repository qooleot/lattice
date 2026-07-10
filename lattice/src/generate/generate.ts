import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenInput } from './types.js';
import { buildPlan } from './plan.js';
import { renderTypes } from './render/types.js';
import { renderDdl } from './render/sql.js';
import { renderRepo } from './render/repo.js';
import { renderCommands } from './render/commands.js';
import { renderInvariants } from './render/invariants.js';
import { renderTests } from './render/tests.js';      // Task 9 provides this; stub returns '' until then
import { renderPackageFiles } from './render/pkg.js';

export function generateService(input: GenInput, outDir: string): string[] {
  const plan = buildPlan(input);
  rmSync(outDir, { recursive: true, force: true });   // clean-dir
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {
    'types.ts': renderTypes(plan),
    'schema.sql': renderDdl(plan),
    'repo.ts': renderRepo(plan),
    'invariants.ts': renderInvariants(plan),
    'commands.ts': renderCommands(plan),
    'service.test.ts': renderTests(plan),
    ...renderPackageFiles(plan),
  };
  const written: string[] = [];
  for (const [name, src] of Object.entries(files)) {
    const p = join(outDir, name); writeFileSync(p, src); written.push(p);
  }
  return written.sort();
}
