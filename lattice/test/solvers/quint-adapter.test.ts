import { describe, it, expect, vi } from 'vitest';
import { runQuint } from '../../src/solvers/quint-adapter.js';
import type { QuintEmission } from '../../src/emit/quint.js';

const em: QuintEmission = { source: 'module m {}', invariantName: 'q_inv', varTypes: {} };

const failWith = (stderr: string) =>
  Object.assign(new Error(`Command failed: npx quint verify\n${stderr}`), { code: 1, stderr });

// Each quint verify spawns its own Apalache JVM and SIGTERMs it at exit. On quint's default
// fixed port 8822, a back-to-back call raced the dying JVM for the port and lost (observed live:
// quint connects to the dying server, which drops the call), exiting 1 WITHOUT an ITF file — the
// same surface as a deterministic failure. The adapter now isolates every invocation on its own
// ephemeral port and retries exactly once on the transient gRPC classes, never on anything else.
describe('quint adapter retry-once on transient gRPC startup contention', () => {
  it('retries once when quint dies with a transient gRPC error, then succeeds', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 14 UNAVAILABLE: Connection dropped\n    at callErrorFromStatus (...)'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    const r = await runQuint(em, 5, exec);
    expect(r.violated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('retries once on RST_STREAM (dying server closes the HTTP/2 stream mid-call)', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 13 INTERNAL: Received RST_STREAM with code 0 (Call ended without gRPC status)'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    const r = await runQuint(em, 5, exec);
    expect(r.violated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry deterministic failures (parse/typecheck errors)', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('error: parsing failed\nsyntax error near token'));
    await expect(runQuint(em, 5, exec)).rejects.toThrow(/quint verify failed without a counterexample/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('gives up after the single retry if the transient error persists', async () => {
    const exec = vi.fn().mockRejectedValue(failWith('Error: 14 UNAVAILABLE: Connection dropped'));
    await expect(runQuint(em, 5, exec)).rejects.toThrow(/UNAVAILABLE/);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  // The root fix for the port-8822 contention: every invocation runs its Apalache server on its
  // own ephemeral port, so back-to-back calls (and concurrent checkouts) never share a server.
  // The retry attempt must pick a FRESH port — retrying the contended one defeats the purpose.
  it('passes a unique ephemeral --server-endpoint per attempt', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(failWith('Error: 14 UNAVAILABLE: Connection dropped'))
      .mockResolvedValueOnce({ stdout: '[ok] No violation found', stderr: '' });
    await runQuint(em, 5, exec);
    const endpoints = exec.mock.calls.map((c: any[]) => {
      const args = c[1] as string[];
      return args[args.indexOf('--server-endpoint') + 1]!;
    });
    for (const ep of endpoints) {
      const port = Number(ep.match(/^localhost:(\d+)$/)![1]);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(60000);
    }
    expect(endpoints[0]).not.toBe(endpoints[1]);
  });
});
