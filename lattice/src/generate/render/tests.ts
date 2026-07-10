import type { GenPlan } from '../plan.js';

// Stub — Task 9 fills in the real generated-test-suite renderer (guards reject bad commands,
// invariants hold/reject, events land in the outbox, plus determinism/differential tests).
// generate.ts imports this now so the orchestrator's wiring is complete ahead of Task 9.
export function renderTests(plan: GenPlan): string {
  return '';
}
