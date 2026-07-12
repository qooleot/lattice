import { describe, it, expect } from 'vitest';
import { checkMethodGuard } from '../../src/engine/method-guard.js';
import { realDeps } from '../../src/cli.js';
import { subscriptionsModel } from '../fixtures.js';

// Real quint end-to-end (design §5 worked example): SubscriptionService.activate declares NO
// `requires` while the `activate` transition requires `paidInvoiceCount >= 1`. A method weaker
// than its guard advertises calls that will always be rejected → `weaker-than-guard`. The verdict
// comes back from a real `runQuintVerify` at --init indInit --max-steps 0, not asserted structurally.
describe('checkMethodGuard (integration, real quint)', () => {
  it('activate (no requires) vs paidInvoiceCount >= 1 guard ⇒ weaker-than-guard', async () => {
    const r = await checkMethodGuard(subscriptionsModel, 'SubscriptionService', 'activate', realDeps);
    expect(r.verdict).toBe('weaker-than-guard');
  }, 180_000);
});
