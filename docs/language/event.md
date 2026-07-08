# Event

A past-tense fact — something that happened, not something the system holds state for. Events
carry fields like an [entity](entity.md), but they are never mutated and never own a
[lifecycle](lifecycle.md) or [invariants](invariant.md) of their own; instead they are referenced by
name from a [transition](transition.md)'s `when` clause, marking what triggers that transition.

## Syntax

```lat
/// Facts about payment attempts against an invoice.
context Billing {
  entity Invoice {
    invoiceId : Id key
  }

  event PaymentFailed {
    invoiceId : ref Invoice
    at        : Date
  }

  aggregate Account {
    accountId : Id key

    lifecycle standing {
      states { good @initial, pastDue @active }
      transition markPastDue { from good to pastDue; when PaymentFailed }
    }
  }
}
```

`event <PascalId> { <field>* }`, with an optional leading `///` doc. Fields use the same grammar as
an entity's (see [field types](field-types.md)) — typically identifying which aggregate the event
is about, plus whatever facts the event carries (a timestamp, an amount, a reason).

## Semantic Rules

- The event name must be PascalCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier (`invalid-name`, `reserved-word`).
- Field names and types follow the same rules as an entity's fields (`reserved-field-name` for a
  field named `state`, `unresolved-enum`, `unresolved-ref`).
- A [transition](transition.md)'s `when <EventName>` clause must name a declared event; naming an
  undeclared one reports `unknown-event`.
- Events do not carry a `key` requirement — `missing-key` only applies to entities and aggregates.

## Example

```lat
context Billing {
  event InvoiceIssued {
    invoiceId : Id key
    amount    : Money
  }
}
```

## See also

- [Transition](transition.md)
- [Lifecycle](lifecycle.md)
- [Field types](field-types.md)
- [Entity](entity.md)
