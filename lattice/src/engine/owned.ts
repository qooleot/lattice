// Shared constants/helpers for owned-collection encoding (design §6.1). A bounded map keeps the
// per-owner record finite (Quint/Apalache require a fixed shape; Alloy needs a bound too) — every
// owned collection is capped at OWNED_BOUND live children, tracked by a companion `<field>Count`.
export const OWNED_BOUND = 3;

// The child-typing key `varTypes` uses for an owned-collection field: `<ownerVar>#<field>`
// (e.g. `invoices#lines`), distinct from the owner's own `varTypes[ownerVar] -> EntityName` entry.
export const childVarKey = (ownerVar: string, field: string) => `${ownerVar}#${field}`;
