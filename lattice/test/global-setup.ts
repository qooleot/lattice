// Vitest globalSetup: sweep orphaned solver JVMs before every suite run, so an interrupted prior
// run can't slow this one (golden trace B's latency assertion is load-sensitive). Kills only
// PID-1-reparented apalache/AlloyRunner processes — live solvers from concurrent sessions have
// living parents and are untouched. Failures are non-fatal: a missing bash or ps oddity must
// never block the suite itself.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cleanup-solvers.sh');
  try {
    const out = execFileSync('bash', [script], { encoding: 'utf8', timeout: 10_000 });
    const summary = out.trim().split('\n').pop();
    if (summary && !summary.endsWith('0 orphaned solver process(es) killed')) console.log(summary);
  } catch {
    // non-fatal by design
  }
}
