import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { loadContextMapText, loadLatText } from '../parse/fromLangium.js';
import { validateWorkspace, type WorkspaceMemberModel } from '../ast/workspace.js';
import type { ContextMapModel } from '../ast/contextmap.js';
import type { DomainModel } from '../ast/domain.js';
import type { CandidateInvariant } from '../ast/invariant.js';
import { specDiagramFiles, workspaceDiagramFiles } from '../emit/mermaid/docs.js';

export interface WorkspaceMember {
  name: string;
  path: string;
  dir: string;   // absolute member dir
  model: DomainModel;
  invariants: CandidateInvariant[];
}

export type WorkspaceResult =
  | { ok: true; map: ContextMapModel; members: WorkspaceMember[]; warnings: string[] }
  | { ok: false; diagnostics: object[] };

/** Loads a workspace: parses `<wsDir>/context-map.lat`, then each `contains` entry's
 *  `<wsDir>/<path>/spec.lat`, then runs `validateWorkspace` for cross-spec checks.
 *  Never throws — I/O and parse failures are reported as diagnostics. */
export function loadWorkspace(wsDir: string): WorkspaceResult {
  const mapPath = join(wsDir, 'context-map.lat');
  let mapText: string;
  try { mapText = readFileSync(mapPath, 'utf8'); }
  catch {
    return { ok: false, diagnostics: [{ code: 'missing-member',
      message: `missing workspace context map: ${mapPath}` }] };
  }

  const mapLoaded = loadContextMapText(mapText);
  if (!mapLoaded.ok) return { ok: false, diagnostics: mapLoaded.diagnostics };
  const { map } = mapLoaded;

  const warnings: string[] = mapLoaded.warnings.map(w => w.message);
  const members: WorkspaceMember[] = [];
  const diagnostics: object[] = [];

  for (const ctx of map.contexts) {
    const memberDir = resolve(wsDir, ctx.path);
    // compileWorkspace writes generated files under memberDir, so a path escaping
    // wsDir would let a cloned context map read/write outside the workspace
    const rel = relative(resolve(wsDir), memberDir);
    if (isAbsolute(ctx.path) || rel.startsWith('..') || isAbsolute(rel)) {
      diagnostics.push({ code: 'invalid-member-path',
        message: `member '${ctx.name}' path '${ctx.path}' resolves outside the workspace directory — member paths must be relative and stay within the workspace` });
      continue;
    }
    const memberPath = join(memberDir, 'spec.lat');
    let text: string;
    try { text = readFileSync(memberPath, 'utf8'); }
    catch {
      diagnostics.push({ code: 'missing-member', message: `missing member spec: ${memberPath}` });
      continue;
    }

    const loaded = loadLatText(text);
    if (!loaded.ok) {
      diagnostics.push({ code: 'parse-failed', message: `failed to parse ${memberPath}`,
        diagnostics: loaded.diagnostics });
      continue;
    }

    if (loaded.model.context !== ctx.name) {
      diagnostics.push({ code: 'context-name-mismatch',
        message: `member '${ctx.name}' (${memberPath}) declares context '${loaded.model.context}' — names must match` });
      continue;
    }

    warnings.push(...loaded.warnings.map(w => w.message));
    members.push({ name: ctx.name, path: ctx.path, dir: memberDir, model: loaded.model, invariants: loaded.invariants });
  }

  if (diagnostics.length) return { ok: false, diagnostics };

  const memberModels: WorkspaceMemberModel[] = members.map(m => ({ name: m.name, model: m.model }));
  const workspaceDiags = validateWorkspace(map, memberModels);
  if (workspaceDiags.length) return { ok: false, diagnostics: workspaceDiags };

  return { ok: true, map, members, warnings };
}

/** Compiles diagram projections for an entire workspace: loads it, then writes
 *  `workspaceDiagramFiles(map)` under `wsDir` and `specDiagramFiles(member.model)` under each
 *  member's own dir. Never throws — a load failure is reported as diagnostics, matching
 *  `loadWorkspace`'s contract. */
export function compileWorkspace(wsDir: string): { ok: true; written: string[] } | { ok: false; diagnostics: object[] } {
  const loaded = loadWorkspace(wsDir);
  if (!loaded.ok) return loaded;

  const written: string[] = [];
  const write = (baseDir: string, files: ReturnType<typeof workspaceDiagramFiles>) => {
    for (const f of files) {
      const p = resolve(baseDir, f.relPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
      written.push(p);
    }
  };

  write(wsDir, workspaceDiagramFiles(loaded.map));
  for (const member of loaded.members) write(member.dir, specDiagramFiles(member.model));

  return { ok: true, written };
}
