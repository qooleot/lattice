# Subscriptions

*Subscriptions API: hybrid license-fee + usage-based billing*

## Subscription

A customer's subscription to a Plan; usage accrues per billing period and resets at rollover

**status lifecycle:** trialing → active (activate — only if paidInvoiceCount ≥ 1, announces SubscriptionActivated), trialing → expired (terminal) (expireTrial), active → pastDue (paymentFailed), pastDue → active (recover), trialing/active/pastDue → canceled (terminal) (cancel, announces SubscriptionCanceled), pastDue → canceled (terminal) (dunningExhausted)

## Invoice

Period invoice: license-fee portion plus usage portion; partial payments accrue

**settlement lifecycle:** draft → open (finalize, announces InvoiceFinalized), open → paid (terminal) (settle, announces InvoicePaid), draft → void (terminal) (voidDraft), open → void (terminal) (voidOpen), open → uncollectible (terminal) (writeOff)

## Services

- **createSubscription**(plan, seats) — creates a Subscription
- **getSubscription**(subId) — reads
- **activate**(subId) — performs Subscription.activate
- **cancel**(subId) — performs Subscription.cancel

## Always true

- On every Subscription: periodStart < periodEnd and accruedUnits ≥ 0.  (elicited (w1, w2, w3, w4, w5): positivePeriodNonNegativeUsage)
- On every Subscription: where it is pastDue, latestInvoice.retryCount ≤ maxRetries.  (hand-edited 2026-07-08, consistent with w1, w2, w3, w4, w5: retryCapWhilePastDue)
- On every Invoice: totalDue ≤ licenseFeeAmount + usageAmount.  (elicited (w1, w2): totalDueAtMostParts)
- On every Invoice: amountPaid ≤ totalDue and if it is paid, then amountPaid is totalDue.  (elicited (w1, w2, w3): neverOverpaidAndPaidExact)
- Only one Invoice may be draft per (subscription).  (elicited (w1, w2, w3, w4, w5): oneDraftInvoicePerSubscription)
- Every reference on Subscription resolves to an existing record.  (implied by structure: refsResolveSubscription)
- Once Subscription is canceled, it stays canceled.  (implied by structure: terminalSubscriptionStatusCanceled)
- Once Subscription is expired, it stays expired.  (implied by structure: terminalSubscriptionStatusExpired)
- On every Invoice: licenseFeeAmount ≥ 0.  (implied by structure: nonNegativeInvoiceLicenseFeeAmount)
- On every Invoice: usageAmount ≥ 0.  (implied by structure: nonNegativeInvoiceUsageAmount)
- On every Invoice: totalDue ≥ 0.  (implied by structure: nonNegativeInvoiceTotalDue)
- On every Invoice: amountPaid ≥ 0.  (implied by structure: nonNegativeInvoiceAmountPaid)
- Every reference on Invoice resolves to an existing record.  (implied by structure: refsResolveInvoice)
- Once Invoice is paid, it stays paid.  (implied by structure: terminalInvoiceSettlementPaid)
- Once Invoice is void, it stays void.  (implied by structure: terminalInvoiceSettlementVoid)
- Once Invoice is uncollectible, it stays uncollectible.  (implied by structure: terminalInvoiceSettlementUncollectible)

## ⚠️ Open decisions

- **composite-invalid distinguish witness** — Witness contains two draft invoices on one subscription, violating adopted One_Draft_Invoice_Per_Subscription (judged forbid at w5). The pair's actual question (active sub with seats=0) was separately judged PERMIT in ledger (translator boundary, Case B). Parked: judging this composite state either way would corrupt pruning.
- **composite-invalid distinguish witness** — Witness violates adopted One_Draft_Invoice_Per_Subscription (two drafts) and Positive_Period_NonNegative_Usage (periodStart=periodEnd). The plan-boundary it probed (all_units plan with includedUnits=24) was judged separately: PERMIT (recorded as structure entry).
- **composite-invalid distinguish witness** — Witness violates adopted One_Draft_Invoice_Per_Subscription and Positive_Period_NonNegative_Usage. Its plan-boundary (overage plan with includedUnits=0) was judged separately: FORBID (recorded as structure entry).
