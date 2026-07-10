// Compiles emitted generator output (repo.ts / commands.ts / types.ts / invariants.ts text) into a
// live module and returns it, so tests can drive generated handlers against a real better-sqlite3 DB
// with no mocks. Writes each file to a fresh temp dir and imports the entry point via tsx's
// programmatic API (tsImport), which transpiles TS on the fly and resolves the emitted modules'
// `./foo.js` import specifiers to their sibling `./foo.ts` source files.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

/**
 * Writes `files` (a map of filename -> source text, e.g. { 'repo.ts': ..., 'commands.ts': ... })
 * into a fresh temp directory and dynamically imports `commands.ts` from it.
 *
 * The temp dir gets a `package.json` with `"type": "module"` so Node's ESM loader (which tsx hooks)
 * treats the written `.ts` files as ES modules — required for tsx's `.js` -> `.ts` specifier
 * resolution to kick in. Callers must include every module the emitted code imports (typically
 * `types.ts`, `invariants.ts`, `repo.ts`, `commands.ts`) or resolution will fail with MODULE_NOT_FOUND.
 */
export async function loadGeneratedModule(files: Record<string, string>): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'lat-gen-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  const entry = pathToFileURL(join(dir, 'commands.ts')).href;
  return tsImport(entry, import.meta.url);
}
