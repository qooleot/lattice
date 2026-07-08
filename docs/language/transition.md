# Transition

An edge in a [lifecycle](lifecycle.md) block: a named move from one or more source states to a
target state, optionally triggered by a declared [event](event.md).

## Syntax

```lat
context Billing {
  event PaymentReceived {
    invoiceId : Id key
  }

  aggregate Invoice {
    invoiceId  : Id key
    amountPaid : Money
    totalDue   : Money

    lifecycle settlement {
      states { open @initial, paid @terminal }
      transition settle { from open to paid; when PaymentReceived; requires amountPaid == totalDue }
    }
  }
}
```

`transition <camelId> { from <s> (, <s>)* to <s> (; when <EventName>)? (; requires <predicate>)? }`.
The `from`/`to`, optional `when`, and optional `requires` clauses are separated by `;` inside the
braces, in that order. `from` names one or more source states and `to` names a single target
state, all declared in the enclosing `lifecycle` block; `when`, if present, names a declared
[event](event.md) — the domain fact that causes this transition to fire; `requires`, if present,
is a guard [predicate](invariant.md) — a condition that must hold for the transition to fire.

Multiple `from` states (`from a, b to c`) collapse several distinct transitions that all land on
the same target into a single named edge — the transition fires whenever the instance is in *any*
of the listed source states. A shared `requires` guard applies to every listed source; if the
guard should differ per source, that is two intentions and needs two transitions.

## Guards (`requires`)

The `requires` clause uses the same predicate grammar as [invariant](invariant.md) bodies
(comparisons, `state <region> in {…}`, `&&`/`||`/`!`/`=>`). In v1 it is restricted to the
transition's **own aggregate** — every field path in the guard must be a single segment naming a
field declared on that same aggregate, and every `state <region> in {…}` clause must name a
region/state pair on that aggregate's own machine. A path that hops through a `ref` field (e.g.
`other.amount`) reports `guard-cross-aggregate`; this is deliberately closed until cross-aggregate
guard usage is evidenced (design §3.3, §5.2.1) — the same evidence-gated posture as ref-hops in
invariants.

Guards render as an extra action conjunct in the Quint projection (alongside the `from`-state
check), as `— only if <predicate>` in the prose lifecycle summary, and as a sanitized
`[predicate]` suffix on the mermaid statechart edge label. **Honest ceiling:** a guard may read a
field that machine transitions themselves evolve (e.g. a running counter mutated by another
transition) — such guards are elicited, rendered, and carried faithfully, but the dynamics of how
that field changes over time are not modeled or checked; the guard is a declarative snapshot
condition, not a temporal claim (design §3.4).

## Semantic Rules

- Every state in `from`, and `to`, must name a state declared in the enclosing `lifecycle` block;
  otherwise `unknown-transition-state` (reported once per unresolved state).
- `from` may not repeat the same source state twice — `duplicate-source`.
- `to` may not also appear in `from` — self-loops need evidence before the grammar admits them,
  so this reports `self-loop`.
- `when`, if given, must name a declared [event](event.md); an undeclared name reports
  `unknown-event`.
- `requires`, if given, is validated own-aggregate-only:
  - a multi-segment field path (a ref-hop) reports `guard-cross-aggregate`;
  - a single-segment path naming an undeclared field reports `unknown-path`;
  - a `state <region> in {…}` clause naming an undeclared region reports `unknown-region`, and an
    undeclared state within a known region reports `unknown-state`;
  - an enum value comparison naming an undeclared enum reports `unknown-enum`, and an undeclared
    value within a known enum reports `unknown-enum-value`.
- The transition name must be camelCase by convention (`naming-convention`) and a valid,
  non-[reserved](naming-conventions.md) identifier.

## Example

```lat
context Billing {
  aggregate Subscription {
    subId : Id key

    lifecycle standing {
      states { trialing @initial, active @active, pastDue @active, canceled @terminal }
      transition activate { from trialing to active }
      transition cancel { from trialing, active, pastDue to canceled }
    }
  }
}
```

## See also

- [Lifecycle](lifecycle.md)
- [Event](event.md)
- [Aggregate](aggregate.md)
- [Tags](tags.md)
