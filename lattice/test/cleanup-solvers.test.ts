import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cleanup-solvers.sh');

/** Ask the script's own parser what a `ps` etime string is in seconds. */
const secs = (etime: string): string =>
  execFileSync('bash', ['-c', `source "${SCRIPT}" --source-only; etime_to_secs "${etime}"`], { encoding: 'utf8' }).trim();

// cleanup-solvers.sh kills a solver JVM only if it is orphaned AND older than MIN_AGE_SECS — the
// age test is what separates a real stray from a JVM re-parenting to PID 1 during a NORMAL
// shutdown (measured: ppid=1 at ~t=12s, gone by t=24s, unaided). If this parser silently returns
// 0, every process looks young, nothing is ever swept, and the failure is invisible: the script
// still exits 0 and still prints a reassuring summary. Hence a test.
describe('cleanup-solvers etime_to_secs — ps reports [[dd-]hh:]mm:ss', () => {
  it('parses ss', () => expect(secs('05')).toBe('5'));
  it('parses mm:ss', () => expect(secs('26:55')).toBe('1615'));
  it('parses hh:mm:ss', () => expect(secs('01:45:28')).toBe('6328'));
  it('parses dd-hh:mm:ss (launchd is days old)', () => expect(secs('09-01:23:06')).toBe('782586'));
  // Arithmetic runs in awk, not bash, so a zero-padded field is decimal — `$((08))` would throw.
  it('treats zero-padded fields as decimal, not octal', () => {
    expect(secs('00:08')).toBe('8');
    expect(secs('08:00')).toBe('480');
  });
  it('a JVM shutting down normally reads younger than the 60s default', () =>
    expect(Number(secs('00:12'))).toBeLessThan(60));
});
