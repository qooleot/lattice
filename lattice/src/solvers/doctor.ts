import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';

export const VENDOR = join(import.meta.dirname, '..', '..', 'vendor');
export const ALLOY_JAR = join(VENDOR, 'alloy.jar');

/** Major version parsed from a `java -version` banner, e.g. 8, 17, 21. Returns 0 if unparseable. */
function javaMajorVersion(javaPath: string): number {
  const r = spawnSync(javaPath, ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) return 0;
  const text = (r.stderr || r.stdout || '').toString();
  // Matches `java version "1.8.0_131"` (old scheme) or `openjdk version "21.0.11"` (9+ scheme).
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return 0;
  const first = Number(m[1]);
  // Old versioning scheme: 1.8 => major 8.
  return first === 1 ? Number(m[2] ?? 0) : first;
}

/**
 * Absolute path to a >=17 java binary. Resolution order:
 *   1. LATTICE_JAVA env override
 *   2. a local no-admin JDK unpacked by scripts/fetch-solvers.sh into vendor/jdk/
 *      (used when this host has no admin rights to install a system JDK)
 *   3. the system JDK 17+ reported by /usr/libexec/java_home
 *
 * Note: /usr/libexec/java_home's `-v 17+` filter is not trustworthy on every
 * macOS build — on hosts with only a JDK 8 installed it has been observed to
 * return the JDK 8 path anyway (silently ignoring the version filter, even
 * for `-v 99+`). Every candidate is therefore re-verified by actually running
 * `java -version` and parsing the major version before being accepted.
 */
export function findJava(): string {
  if (process.env.LATTICE_JAVA) return process.env.LATTICE_JAVA;

  const vendorMatches = globSync(join(VENDOR, 'jdk', '*', 'Contents', 'Home', 'bin', 'java'));
  for (const candidate of vendorMatches) {
    if (javaMajorVersion(candidate) >= 17) return candidate;
  }

  try {
    const home = execFileSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' }).trim();
    const candidate = join(home, 'bin', 'java');
    if (javaMajorVersion(candidate) >= 17) return candidate;
  } catch { /* java_home found nothing at all */ }

  // Nothing usable was found; return the (possibly too-old) java_home default
  // so callers get a meaningful path/version in error messages rather than ''.
  const fallbackHome = execFileSync('/usr/libexec/java_home', { encoding: 'utf8' }).trim();
  return join(fallbackHome, 'bin', 'java');
}

export interface DoctorReport { java: { ok: boolean; version: string; path: string }; alloyJar: boolean; quint: boolean }

export async function doctor(): Promise<DoctorReport> {
  let java = { ok: false, version: 'none', path: '' };
  try {
    const path = findJava();
    // `java -version` writes its banner to stderr (not stdout) on every known
    // JDK, so both streams must be captured regardless of exit status.
    const r = spawnSync(path, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) {
      const text = (r.stderr || r.stdout || '').toString();
      java = { ok: javaMajorVersion(path) >= 17, version: text.split('\n')[0] ?? '', path };
    }
  } catch { /* stays not-ok */ }
  let quint = false;
  try { execFileSync('npx', ['quint', '--version'], { encoding: 'utf8' }); quint = true; } catch { /* absent */ }
  return { java, alloyJar: existsSync(ALLOY_JAR), quint };
}

if (import.meta.url === `file://${process.argv[1]}`) doctor().then(r => console.log(JSON.stringify(r, null, 2)));
