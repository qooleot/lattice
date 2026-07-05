# Subscriptions

*Subscriptions API: hybrid license-fee + usage-based billing*

## Subscription

A customer's subscription to a Plan; usage accrues per billing period and resets at rollover

**lifecycle lifecycle:** trialing → active → past_due → canceled (terminal) → expired (terminal)

## Invoice

Period invoice: license-fee portion plus usage portion; partial payments accrue

**settlement lifecycle:** draft → open → paid (terminal) → void (terminal) → uncollectible (terminal)

## Always true

- Every reference on Subscription resolves to an existing record.  (template tpl-9-Subscription: NoOrphan_Subscription)
- Once Subscription is canceled, it stays canceled.  (template tpl-3-Subscription-canceled: Terminal_Subscription_canceled)
- Once Subscription is expired, it stays expired.  (template tpl-3-Subscription-expired: Terminal_Subscription_expired)
- On every Invoice: licenseFeeAmount ≥ 0.  (template tpl-2-Invoice-licenseFeeAmount: NonNegative_Invoice_licenseFeeAmount)
- On every Invoice: usageAmount ≥ 0.  (template tpl-2-Invoice-usageAmount: NonNegative_Invoice_usageAmount)
- On every Invoice: totalDue ≥ 0.  (template tpl-2-Invoice-totalDue: NonNegative_Invoice_totalDue)
- On every Invoice: amountPaid ≥ 0.  (template tpl-2-Invoice-amountPaid: NonNegative_Invoice_amountPaid)
- Every reference on Invoice resolves to an existing record.  (template tpl-9-Invoice: NoOrphan_Invoice)
- Once Invoice is paid, it stays paid.  (template tpl-3-Invoice-paid: Terminal_Invoice_paid)
- Once Invoice is void, it stays void.  (template tpl-3-Invoice-void: Terminal_Invoice_void)
- Once Invoice is uncollectible, it stays uncollectible.  (template tpl-3-Invoice-uncollectible: Terminal_Invoice_uncollectible)
- On every Plan: licenseFee ≥ 0.  (template tpl-2-Plan-licenseFee: NonNegative_Plan_licenseFee)
- On every Plan: usageRate ≥ 0.  (template tpl-2-Plan-usageRate: NonNegative_Plan_usageRate)
- On every Invoice: totalDue ≤ licenseFeeAmount + usageAmount.  (elicited (w1, w2): TotalDue_At_Most_Parts)
- On every Invoice: amountPaid ≤ totalDue and if it is paid, then amountPaid is totalDue.  (elicited (w1, w2, w3): Never_Overpaid_And_Paid_Exact)
- Only one Invoice may be draft per (subscription).  (elicited (w1, w2, w3, w4, w5): One_Draft_Invoice_Per_Subscription)
- On every Subscription: periodStart < periodEnd and accruedUnits ≥ 0.  (elicited (w1, w2, w3, w4, w5): Positive_Period_NonNegative_Usage)
- On every Plan: includedUnits ≥ 0 and if pricingMode is overage, then includedUnits ≥ 1.  (elicited (w1, w2, w3, w4, w5): Overage_Implies_Real_Allowance)

## ⚠️ Open decisions

- **composite-invalid distinguish witness** — Witness contains two draft invoices on one subscription, violating adopted One_Draft_Invoice_Per_Subscription (judged forbid at w5). The pair's actual question (active sub with seats=0) was separately judged PERMIT in ledger (translator boundary, Case B). Parked: judging this composite state either way would corrupt pruning.
- **composite-invalid distinguish witness** — Witness violates adopted One_Draft_Invoice_Per_Subscription (two drafts) and Positive_Period_NonNegative_Usage (periodStart=periodEnd). The plan-boundary it probed (all_units plan with includedUnits=24) was judged separately: PERMIT (recorded as structure entry).
- **composite-invalid distinguish witness** — Witness violates adopted One_Draft_Invoice_Per_Subscription and Positive_Period_NonNegative_Usage. Its plan-boundary (overage plan with includedUnits=0) was judged separately: FORBID (recorded as structure entry).
