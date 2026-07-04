# Fidelity Gate — Judging Worksheet

15 survivors after Amendment 1 (b10, r05 appended at bottom; b08, r03, b02, b03, r04 out — see AMENDMENT.md). Fill in the adversarial case + expected verdict for each, then tell the orchestrator to continue.

## b01 — "A customer may have at most one active subscription per product family."

**Formalization (raw):**

```json
{
  "kind": "unique",
  "aggregate": "Subscription",
  "whileStates": {
    "region": "Lifecycle",
    "states": [
      "Active"
    ]
  },
  "by": [
    [
      "customer"
    ],
    [
      "family"
    ]
  ]
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Two active subscriptions for the same customer in different product families are permitted

| Entity | Id | Fields |
| --- | --- | --- |
| Customer | `c1` | — |
| Subscription | `s1` | customer = "c1"<br>family = "Storage"<br>Lifecycle.state = "Active" |
| Subscription | `s2` | customer = "c1"<br>family = "Compute"<br>Lifecycle.state = "Active" |


*Case 2 — expected `permit`:* One active and one canceled subscription for the same customer and family is permitted (only active counts)

| Entity | Id | Fields |
| --- | --- | --- |
| Customer | `c1` | — |
| Subscription | `s1` | customer = "c1"<br>family = "Storage"<br>Lifecycle.state = "Active" |
| Subscription | `s2` | customer = "c1"<br>family = "Storage"<br>Lifecycle.state = "Canceled" |


*Case 3 — expected `forbid`:* Two active subscriptions for the same customer and same product family are forbidden

| Entity | Id | Fields |
| --- | --- | --- |
| Customer | `c1` | — |
| Subscription | `s1` | customer = "c1"<br>family = "Storage"<br>Lifecycle.state = "Active" |
| Subscription | `s2` | customer = "c1"<br>family = "Storage"<br>Lifecycle.state = "Active" |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## b04 — "An active subscription whose latest invoice is unpaid past the grace period must not remain active."

**Formalization (raw):**

```json
{
  "kind": "statePredicate",
  "aggregate": "Subscription",
  "where": {
    "kind": "inState",
    "owner": "self",
    "region": "Lifecycle",
    "states": [
      "Active"
    ]
  },
  "body": {
    "kind": "not",
    "arg": {
      "kind": "and",
      "args": [
        {
          "kind": "cmp",
          "op": "eq",
          "left": {
            "kind": "field",
            "owner": "self",
            "path": [
              "latestInvoice",
              "status"
            ]
          },
          "right": {
            "kind": "enumval",
            "enum": "InvoiceStatus",
            "value": "Unpaid"
          }
        },
        {
          "kind": "cmp",
          "op": "gt",
          "left": {
            "kind": "now"
          },
          "right": {
            "kind": "plus",
            "left": {
              "kind": "field",
              "owner": "self",
              "path": [
                "latestInvoice",
                "dueAt"
              ]
            },
            "right": {
              "kind": "field",
              "owner": "self",
              "path": [
                "latestInvoice",
                "gracePeriod"
              ]
            }
          }
        }
      ]
    }
  }
}
```

**Its 3 obvious cases:**

*Case 1 — expected `forbid`:* Active subscription, latest invoice unpaid and past grace period — must not remain active  (`now` = 2400)

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `sub1` | Lifecycle.state = "Active"<br>latestInvoice = "inv1" |
| Invoice | `inv1` | status = "Unpaid"<br>dueAt = 1200<br>gracePeriod = 168 |


*Case 2 — expected `permit`:* Active subscription, latest invoice unpaid but still within grace period — allowed  (`now` = 1300)

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `sub1` | Lifecycle.state = "Active"<br>latestInvoice = "inv1" |
| Invoice | `inv1` | status = "Unpaid"<br>dueAt = 1200<br>gracePeriod = 168 |


*Case 3 — expected `permit`:* Active subscription with latest invoice paid — allowed regardless of time  (`now` = 5000)

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `sub1` | Lifecycle.state = "Active"<br>latestInvoice = "inv1" |
| Invoice | `inv1` | status = "Paid"<br>dueAt = 1200<br>gracePeriod = 168 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## b05 — "A canceled subscription never transitions to any other state."

**Formalization (raw):**

```json
{
  "kind": "terminal",
  "aggregate": "Subscription",
  "region": "Lifecycle",
  "state": "Canceled"
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Subscription stays Canceled across ticks — no transition out of terminal state

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s1` | Lifecycle.state = "Canceled" |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s1` | Lifecycle.state = "Canceled" |

snapshot 2:
| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s1` | Lifecycle.state = "Canceled" |


*Case 2 — expected `permit`:* Active subscription transitions to Canceled — entering terminal state is allowed

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s2` | Lifecycle.state = "Canceled" |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s2` | Lifecycle.state = "Active" |


*Case 3 — expected `forbid`:* Canceled subscription transitions back to Active — leaving terminal state is forbidden

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s3` | Lifecycle.state = "Active" |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `s3` | Lifecycle.state = "Canceled" |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## b06 — "Total refunds for an invoice may never exceed the amount captured for it."

**Formalization (raw):**

```json
{
  "kind": "statePredicate",
  "aggregate": "Invoice",
  "body": {
    "kind": "cmp",
    "op": "le",
    "left": {
      "kind": "field",
      "owner": "self",
      "path": [
        "totalRefunded"
      ]
    },
    "right": {
      "kind": "field",
      "owner": "self",
      "path": [
        "amountCaptured"
      ]
    }
  }
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Refunds below captured amount

| Entity | Id | Fields |
| --- | --- | --- |
| Invoice | `inv1` | amountCaptured = 10000<br>totalRefunded = 4000 |


*Case 2 — expected `permit`:* Refunds exactly equal captured amount

| Entity | Id | Fields |
| --- | --- | --- |
| Invoice | `inv2` | amountCaptured = 10000<br>totalRefunded = 10000 |


*Case 3 — expected `forbid`:* Refunds exceed captured amount

| Entity | Id | Fields |
| --- | --- | --- |
| Invoice | `inv3` | amountCaptured = 10000<br>totalRefunded = 12000 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## b07 — "Every invoice references an existing subscription."

**Formalization (raw):**

```json
{
  "kind": "refsResolve",
  "aggregate": "Invoice"
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Invoice references an existing subscription

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `sub1` | — |
| Invoice | `inv1` | subscription = "sub1" |


*Case 2 — expected `forbid`:* Invoice references a subscription that does not exist

| Entity | Id | Fields |
| --- | --- | --- |
| Invoice | `inv2` | subscription = "sub_missing" |


*Case 3 — expected `permit`:* Two invoices both reference the same existing subscription

| Entity | Id | Fields |
| --- | --- | --- |
| Subscription | `sub2` | — |
| Invoice | `inv3` | subscription = "sub2" |
| Invoice | `inv4` | subscription = "sub2" |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## b09 — "Available plus reserved balance always equals the account's total balance."

**Formalization (raw):**

```json
{
  "kind": "conservation",
  "aggregate": "Account",
  "parts": [
    [
      "available"
    ],
    [
      "reserved"
    ]
  ],
  "total": [
    "total"
  ]
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* available 70 plus reserved 30 equals total 100

| Entity | Id | Fields |
| --- | --- | --- |
| Account | `a1` | available = 70<br>reserved = 30<br>total = 100 |


*Case 2 — expected `permit`:* available 0 plus reserved 0 equals total 0

| Entity | Id | Fields |
| --- | --- | --- |
| Account | `a2` | available = 0<br>reserved = 0<br>total = 0 |


*Case 3 — expected `forbid`:* available 70 plus reserved 30 equals 100 but total is 90

| Entity | Id | Fields |
| --- | --- | --- |
| Account | `a3` | available = 70<br>reserved = 30<br>total = 90 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r01 — "For every performance obligation, recognized plus deferred revenue equals its allocated contract value."

**Formalization (raw):**

```json
{
  "kind": "conservation",
  "aggregate": "PerformanceObligation",
  "parts": [
    [
      "recognizedRevenue"
    ],
    [
      "deferredRevenue"
    ]
  ],
  "total": [
    "allocatedValue"
  ]
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Half recognized, half deferred: 60 recognized + 40 deferred equals 100 allocated

| Entity | Id | Fields |
| --- | --- | --- |
| PerformanceObligation | `po1` | obligationType = "Service"<br>allocatedValue = 100<br>recognizedRevenue = 60<br>deferredRevenue = 40 |


*Case 2 — expected `permit`:* Fully deferred at inception: 0 recognized + 100 deferred equals 100 allocated

| Entity | Id | Fields |
| --- | --- | --- |
| PerformanceObligation | `po2` | obligationType = "License"<br>allocatedValue = 100<br>recognizedRevenue = 0<br>deferredRevenue = 100 |


*Case 3 — expected `forbid`:* Parts do not sum to allocated value: 60 recognized + 30 deferred is not 100 allocated

| Entity | Id | Fields |
| --- | --- | --- |
| PerformanceObligation | `po3` | obligationType = "Good"<br>allocatedValue = 100<br>recognizedRevenue = 60<br>deferredRevenue = 30 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r02 — "Cumulative recognized revenue for an obligation never decreases."

**Formalization (raw):**

```json
{
  "kind": "monotonic",
  "aggregate": "Obligation",
  "field": [
    "cumulativeRecognized"
  ]
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Cumulative recognized revenue increases over successive snapshots — permitted.  (`now` = 48)

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o1` | Lifecycle.state = "Open"<br>cumulativeRecognized = 500 |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o1` | Lifecycle.state = "Open"<br>cumulativeRecognized = 100 |

snapshot 2:
| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o1` | Lifecycle.state = "Open"<br>cumulativeRecognized = 300 |


*Case 2 — expected `permit`:* Cumulative recognized revenue stays flat across snapshots — permitted (non-decreasing).  (`now` = 48)

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o2` | Lifecycle.state = "Open"<br>cumulativeRecognized = 300 |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o2` | Lifecycle.state = "Open"<br>cumulativeRecognized = 300 |


*Case 3 — expected `forbid`:* Cumulative recognized revenue drops from 400 to 250 — forbidden.  (`now` = 48)

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o3` | Lifecycle.state = "Open"<br>cumulativeRecognized = 250 |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o3` | Lifecycle.state = "Open"<br>cumulativeRecognized = 400 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r06 — "At most one accounting period is open at any time."

**Formalization (raw):**

```json
{
  "kind": "cardinality",
  "aggregate": "AccountingPeriod",
  "where": {
    "kind": "inState",
    "owner": "self",
    "region": "Lifecycle",
    "states": [
      "Open"
    ]
  },
  "atMost": 1
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* No open periods: two closed periods coexist

| Entity | Id | Fields |
| --- | --- | --- |
| AccountingPeriod | `p1` | Lifecycle.state = "Closed"<br>startsAt = 0<br>endsAt = 720 |
| AccountingPeriod | `p2` | Lifecycle.state = "Closed"<br>startsAt = 720<br>endsAt = 1440 |


*Case 2 — expected `permit`:* Exactly one open period alongside a closed one

| Entity | Id | Fields |
| --- | --- | --- |
| AccountingPeriod | `p1` | Lifecycle.state = "Closed"<br>startsAt = 0<br>endsAt = 720 |
| AccountingPeriod | `p2` | Lifecycle.state = "Open"<br>startsAt = 720<br>endsAt = 1440 |


*Case 3 — expected `forbid`:* Two periods open simultaneously

| Entity | Id | Fields |
| --- | --- | --- |
| AccountingPeriod | `p1` | Lifecycle.state = "Open"<br>startsAt = 0<br>endsAt = 720 |
| AccountingPeriod | `p2` | Lifecycle.state = "Open"<br>startsAt = 720<br>endsAt = 1440 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r07 — "Every revenue entry references an existing obligation and an existing accounting period."

**Formalization (raw):**

```json
{
  "kind": "refsResolve",
  "aggregate": "RevenueEntry"
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Revenue entry references an existing obligation and an existing accounting period

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `ob1` | — |
| AccountingPeriod | `ap1` | — |
| RevenueEntry | `re1` | obligation = "ob1"<br>period = "ap1" |


*Case 2 — expected `forbid`:* Revenue entry references a non-existent obligation

| Entity | Id | Fields |
| --- | --- | --- |
| AccountingPeriod | `ap1` | — |
| RevenueEntry | `re1` | obligation = "ob_missing"<br>period = "ap1" |


*Case 3 — expected `forbid`:* Revenue entry references a non-existent accounting period

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `ob1` | — |
| RevenueEntry | `re1` | obligation = "ob1"<br>period = "ap_missing" |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r08 — "Recognized revenue for an obligation never exceeds its allocated amount."

**Formalization (raw):**

```json
{
  "kind": "statePredicate",
  "aggregate": "Obligation",
  "body": {
    "kind": "cmp",
    "op": "le",
    "left": {
      "kind": "field",
      "owner": "self",
      "path": [
        "recognizedRevenue"
      ]
    },
    "right": {
      "kind": "field",
      "owner": "self",
      "path": [
        "allocatedAmount"
      ]
    }
  }
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Recognized revenue below allocated amount is permitted

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o1` | allocatedAmount = 1000<br>recognizedRevenue = 600 |


*Case 2 — expected `permit`:* Recognized revenue equal to allocated amount is permitted (boundary)

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o2` | allocatedAmount = 1000<br>recognizedRevenue = 1000 |


*Case 3 — expected `forbid`:* Recognized revenue exceeding allocated amount is forbidden

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o3` | allocatedAmount = 1000<br>recognizedRevenue = 1200 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r09 — "A closed period's recognized total is immutable; late adjustments post as corrections to an open period."

**Formalization (raw):**

```json
{
  "kind": "monotonic",
  "aggregate": "Period",
  "field": [
    "recognizedTotal"
  ]
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Closed period recognizedTotal held constant across snapshots is permitted

| Entity | Id | Fields |
| --- | --- | --- |
| Period | `P1` | Lifecycle.state = "Closed"<br>recognizedTotal = 5000 |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Period | `P1` | Lifecycle.state = "Closed"<br>recognizedTotal = 5000 |


*Case 2 — expected `permit`:* Open period recognizedTotal growing across snapshots is permitted (monotonic non-decrease)

| Entity | Id | Fields |
| --- | --- | --- |
| Period | `P1` | Lifecycle.state = "Open"<br>recognizedTotal = 7000 |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Period | `P1` | Lifecycle.state = "Open"<br>recognizedTotal = 3000 |


*Case 3 — expected `forbid`:* A period whose recognizedTotal decreases between snapshots violates immutability

| Entity | Id | Fields |
| --- | --- | --- |
| Period | `P1` | Lifecycle.state = "Closed"<br>recognizedTotal = 4000 |

_trace (prior snapshots, oldest first):_

snapshot 1:
| Entity | Id | Fields |
| --- | --- | --- |
| Period | `P1` | Lifecycle.state = "Closed"<br>recognizedTotal = 5000 |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

## r10 — "An on-delivery obligation recognizes its full allocated amount in the period of delivery."

**Formalization (raw):**

```json
{
  "kind": "statePredicate",
  "aggregate": "Obligation",
  "where": {
    "kind": "and",
    "args": [
      {
        "kind": "cmp",
        "op": "eq",
        "left": {
          "kind": "field",
          "owner": "self",
          "path": [
            "trigger"
          ]
        },
        "right": {
          "kind": "enumval",
          "enum": "RecognitionTrigger",
          "value": "OnDelivery"
        }
      },
      {
        "kind": "inState",
        "owner": "self",
        "region": "Delivery",
        "states": [
          "Delivered"
        ]
      }
    ]
  },
  "body": {
    "kind": "cmp",
    "op": "eq",
    "left": {
      "kind": "field",
      "owner": "self",
      "path": [
        "recognizedAmount"
      ]
    },
    "right": {
      "kind": "field",
      "owner": "self",
      "path": [
        "allocatedAmount"
      ]
    }
  }
}
```

**Its 3 obvious cases:**

*Case 1 — expected `permit`:* Delivered on-delivery obligation with full amount recognized

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o1` | trigger = "OnDelivery"<br>allocatedAmount = 1000<br>recognizedAmount = 1000<br>Delivery.state = "Delivered" |


*Case 2 — expected `forbid`:* Delivered on-delivery obligation recognizing only part of allocated amount

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o2` | trigger = "OnDelivery"<br>allocatedAmount = 1000<br>recognizedAmount = 400<br>Delivery.state = "Delivered" |


*Case 3 — expected `permit`:* Undelivered on-delivery obligation recognizes nothing yet — where-clause excludes it, so permitted

| Entity | Id | Fields |
| --- | --- | --- |
| Obligation | `o3` | trigger = "OnDelivery"<br>allocatedAmount = 1000<br>recognizedAmount = 0<br>Delivery.state = "Undelivered" |


**YOUR TURN (human):**
- Adversarial case: describe ONE concrete state a domain expert would flag — a boundary, a sign trick, an off-by-one-period — where you suspect this formalization disagrees with the rule's intent. Plain English is fine. State what the correct verdict should be: permit or forbid.
- Optional override: if the formalization is obviously wrong/right regardless of the case, say so.

---

---

# AMENDMENT 1 UPDATE — survivor set is now 15 (see AMENDMENT.md)

Re-run round results: **b10 and r05 join the survivors** (blocks below). Final non-survivors:
b02, b03, r04 (not-formalizable, second strike) · b08, r03 (failed-obvious — caught by their own cases).

## b10 — "After the configured maximum failed payment retries, a subscription is marked delinquent and no further retries occur."

**Formalization (raw):** statePredicate on `Subscription`, where `failedRetryCount >= maxRetries`, body: `Lifecycle.state in {Delinquent}`.
Cases: (below max, Active → permit ✓) (at max, Delinquent → permit ✓) (past max, still Active → forbid ✓)

**YOUR TURN (human):** adversarial case + expected verdict (permit|forbid), optional override.

## r05 — "A usage-based obligation recognizes revenue only in or after the period in which the usage was reported."

**Formalization (raw):** statePredicate on `UsageObligation`, body: `recognizedPeriod >= usageReportedPeriod` (periods as integers).
Cases: (same period → permit ✓) (later period → permit ✓) (earlier period → forbid ✓)

**YOUR TURN (human):** adversarial case + expected verdict (permit|forbid), optional override.
