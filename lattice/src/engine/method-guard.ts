import type { DomainModel } from '../ast/domain.js';
import type { CaseState } from './evaluate.js';
import type { SolverDeps } from './planner.js';
import { astToMethodGuardQuery } from '../emit/method-guard.js';

// Plan 2b Task 5 — method⊨transition entailment (design §5).
//
// A `performs` method's `requires` is checked against its transition's guard as `∀ params, state`
// entailment, via two havoc probes at `--init indInit --max-steps 0` (a pure state predicate):
//   1. method-implies-guard: `methodReq ⇒ guard` violated ⇒ a (params, state) with the method's
//      precondition true but the guard false — the method ADVERTISES calls the guard always rejects
//      ⇒ `weaker-than-guard`.
//   2. guard-implies-method: `guard ⇒ methodReq` violated ⇒ a call the guard permits but the method
//      rejects — the method SILENTLY NARROWS the API ⇒ `stronger-than-guard`.
// Neither violated ⇒ `consistent`. A method with no `requires` is the weakest precondition (`true`):
// probe 1 reduces to `true ⇒ guard` ≡ `guard`, so it is `weaker-than-guard` iff the guard is
// non-trivial (falsifiable); probe 2 reduces to `guard ⇒ true` ≡ `true`, never violated.
export type MethodGuardVerdict = 'consistent' | 'weaker-than-guard' | 'stronger-than-guard';

export async function checkMethodGuard(
  m: DomainModel, service: string, method: string, deps: SolverDeps,
): Promise<{ verdict: MethodGuardVerdict; witness?: CaseState }> {
  const svc = m.services.find(s => s.name === service);
  if (!svc) throw new Error(`checkMethodGuard: unknown service ${service}`);
  const mm = svc.methods.find(x => x.name === method);
  if (!mm) throw new Error(`checkMethodGuard: unknown method ${service}.${method}`);
  if (!('performs' in mm.kind)) throw new Error(`checkMethodGuard: method ${service}.${method} does not perform a transition`);
  const { aggregate, transition } = mm.kind.performs;

  // Probe 1 — method weaker than guard? (advertises rejected calls)
  const mgEm = astToMethodGuardQuery(m, aggregate, transition, mm.requires, mm.params, 'method-implies-guard');
  const r1 = await deps.quintVerify(mgEm, { init: 'indInit', invariant: mgEm.invariantName, maxSteps: 0 });
  if (r1.violated) return { verdict: 'weaker-than-guard', witness: r1.witness };

  // Probe 2 — method stronger than guard? (silently narrows the API)
  const gmEm = astToMethodGuardQuery(m, aggregate, transition, mm.requires, mm.params, 'guard-implies-method');
  const r2 = await deps.quintVerify(gmEm, { init: 'indInit', invariant: gmEm.invariantName, maxSteps: 0 });
  if (r2.violated) return { verdict: 'stronger-than-guard', witness: r2.witness };

  return { verdict: 'consistent' };
}
