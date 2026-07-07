# Catalog

*Product catalog: plan definitions consumed by Subscriptions.*

## Always true

- On every Plan: includedUnits ≥ 0 and if pricingMode is overage, then includedUnits ≥ 1.  (hand-authored 2026-07-07: overageImpliesRealAllowance)
- On every Plan: licenseFee ≥ 0.  (implied by structure: nonNegativePlanLicenseFee)
- On every Plan: usageRate ≥ 0.  (implied by structure: nonNegativePlanUsageRate)
