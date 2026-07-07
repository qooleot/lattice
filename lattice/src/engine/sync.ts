import { watch } from 'chokidar';
import { statSync } from 'node:fs';
import type { SolverDeps } from './planner.js';

export interface SyncHandle { close(): Promise<void> }

/** Thin watcher over the identical apply routine (spec §5). Never confirms renames itself —
 *  a watcher cannot pass flags; it prints the exact command instead.
 *
 *  `mapPath` (the workspace's `context-map.lat`, when the spec lives in a workspace) is watched
 *  alongside `lat`: a map edit re-runs the SAME apply on the unchanged spec, which reconciles as
 *  a no-op and re-renders projections — including the apply hook that recompiles the workspace
 *  docs. That reconcile-and-recompile IS the map recompile; there is no separate code path. */
export function startSync(opts: { lat: string; mapPath?: string; session: string;
  onOutcome: (o: object) => void; deps: SolverDeps }): SyncHandle {
  let running = false, queued = false;
  const runApply = async () => {
    if (running) { queued = true; return; }
    running = true;
    try {
      const { runCommand } = await import('../cli.js');   // lazy: avoids a cli↔sync import cycle
      const out: any = await runCommand(['apply', '--session', opts.session, '--lat', opts.lat], opts.deps);
      if (out.error === 'refused' && out.refusals?.some((r: any) => r.code === 'needs-rename-confirmation')) {
        const flags = out.refusals.filter((r: any) => r.rename)
          .map((r: any) => `--rename ${r.rename.path}=${r.rename.to}`).join(' ');
        out.hint = `run once: engine apply --session ${opts.session} --lat ${opts.lat} ${flags}`;
      }
      opts.onOutcome(out);
    } catch (err) {
      opts.onOutcome({ error: 'internal', message: String(err) });
    } finally {
      running = false;
      if (queued) { queued = false; void runApply(); }
    }
  };
  // Native watchers (FSEvents/inotify) take a moment to arm after `watch()` returns; a write that
  // lands in that gap is silently missed rather than queued (no error, no event — confirmed by
  // direct probing). Snapshot mtime now and re-check once chokidar reports `ready`, so an edit
  // racing the watcher's startup still triggers exactly one apply instead of vanishing.
  const statAt = () => { try { return statSync(opts.lat).mtimeMs; } catch { return null; } };
  const mtimeAtStart = statAt();
  const watchPaths = opts.mapPath ? [opts.lat, opts.mapPath] : [opts.lat];
  const watcher = watch(watchPaths, { ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
  watcher.on('change', () => void runApply());
  watcher.on('add', () => void runApply());
  watcher.on('ready', () => { if (statAt() !== mtimeAtStart) void runApply(); });
  return { close: () => watcher.close() };
}
