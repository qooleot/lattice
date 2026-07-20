# Service

An application-layer entry point: a named group of *methods*, where each method is either a
read-only query, a reference to exactly one declared [transition](transition.md) it performs, or
a constructor for an aggregate. A service carries no fields and no state of its own — it is
carried structure, not a modeled domain object, and (unlike everything else in this reference) it
is **never solver-encoded**: services are validated, printed, diffed, and rendered, but no
invariant is ever checked against them.

## Syntax

```lat
context Billing {
  aggregate Subscription {
    subId     : Id key
    available : Int

    lifecycle standing {
      states { trialing @initial, active @active, held @active, canceled @terminal }
      transition activate { from trialing to active }
      transition reserve { from active to held }
    }
  }

  service SubscriptionService {
    tier = appPrivate
    createSubscription(plan: ref Subscription, seats: Int): Subscription creates Subscription
    getSubscription(subId: Id): Subscription read-only
    activate(subId: Id) performs Subscription.activate
    reserve(subId: Id, delta: Int) performs Subscription.reserve requires available >= delta
  }
}
```

`service <PascalId> { <method>* }`, with an optional leading `///` doc and an optional `tier`
annotation. Each method is one line:

```
<camelId>(<param> (, <param>)*)? (: <type>)? (read-only | performs <Agg>.<transition> | creates <Agg>) (requires <predicate>)?
```

A `<param>` is `<camelId> : <type>` — the same type grammar as a field
([field types](field-types.md)), so a param can be `ref <Agg>` just as a field can. The optional
`: <type>` after the parameter list is the method's return type; it is carried and printed but not
otherwise checked. Exactly one of `read-only`, `performs <Agg>.<transition>`, or `creates <Agg>`
must follow — this is the method's *kind*, and it is exhaustive: every method is one of these
three, nothing else.

## Service tier

An optional `tier` line may appear as the first line inside a service body, before any methods:

```
tier = appPublic | appPrivate | domain
```

- **`appPublic`** (default, may be omitted) — the service is exposed at the application public
  boundary.
- **`appPrivate`** — the service is internal to the application; not exposed at the public boundary.
- **`domain`** — the service operates at the domain layer, below the application boundary.

The tier is carried structure: it is validated, printed, and carried to the Ruby backend codegen,
but it is never solver-encoded. An invalid tier value (anything other than the three above)
reports `unknown-service-tier`.

## Method kinds

- **`read-only`** — a query with no lifecycle effect. Its `requires` guard, if given, may
  reference only the method's own parameters (there is no target aggregate to read fields from).
- **`performs <Aggregate>.<transition>`** — the method's entire lifecycle effect *is* the named
  transition. The transition itself remains the single owner of its `from`/`to`/`requires`/`emits`
  — the method does not redeclare any of that, it only *references* it. Deleting or renaming the
  transition breaks this reference at validation (`unknown-transition`), so drift between a
  service and its aggregate's machine is impossible by construction.
- **`creates <Aggregate>`** — a constructor: the method's effect is bringing a new instance of the
  named aggregate into existence, in its machine's `@initial` state (mirroring CML's
  `[-> CREATED]`). `creates` needs no transition reference because there is no prior state to
  guard from.

## The one-method-one-transition rule (the "archive" rule)

A `performs` method references **exactly one** transition — never a set of transitions chosen by
runtime state. Consider a UI "archive" button whose effect differs by state: cancel a draft,
refund an active subscription. That is not one domain intention wearing a UI label — it is two
intentions that happen to share a button. Stripe's invoice API is the production precedent: a
draft invoice is `delete`d, but a finalized invoice must be `void`ed instead — two distinct
operations, each state-guarded, never a single `archive` that branches internally. Evans'
intention-revealing-interfaces principle says the same thing from the domain-modeling side: a
method name should reveal one intention, not hide a branch.

Concretely: `performs` takes a single `<Aggregate>.<transition>` pair — there is no grammar for
"performs one of several transitions." If your UI wants one button for divergent outcomes, that
one-button affordance is a projection/UI concern layered *on top of* two distinct service methods
— it is not something the language represents as a single method. (A [transition](transition.md)
itself, unlike a service method, *can* legally collapse several **sources landing on the same
target with the same effect** into one multi-source edge — `from trialing, active to canceled` —
because that genuinely is one intention with several legal starting points. The archive rule is
about *divergent outcomes*, not divergent starting states.)

## Method-level `requires`

A method's `requires` guard uses the same predicate grammar as everywhere else (comparisons,
`state <region> in {…}`, `&&`/`||`/`!`/`=>`), but its vocabulary is different from a transition
guard's: it may reference the method's own **parameters**, in addition to the fields the guard is
otherwise entitled to read.

- On a `performs`/`creates` method: params **and** the target aggregate's own fields/states — the
  transition-guard example, `reserve requires available >= delta`, becomes possible for the first
  time in `reserve(subId: Id, delta: Int) performs Subscription.reserve requires available >= delta`
  because methods (unlike transitions) have inputs.
- On a `read-only` method: params only — there is no target aggregate to read a field from, so an
  ordinary field reference reports `guard-cross-aggregate` just as a transition guard reading a
  foreign aggregate's field would.

A bare parameter name inside a method's `requires` refers to that parameter — **params shadow
fields**: if a method parameter and the target aggregate's field share a name, the bare name in a
`requires` clause always resolves to the parameter. In practice this means a param name that
collides with a target field name is legal to declare but produces surface text that cannot
distinguish the two on re-read (`delta >= delta` parses back as "param delta ≥ param delta", never
"field delta ≥ param delta") — pick param names that don't collide with the target's field names
if you need the guard to compare a field against a like-named parameter.

## Never solver-encoded

This is the most important thing about services: they are **carried structure only**. A service
method's guard is validated (every path resolves, every param is declared), printed exactly, and
rendered into prose and diagrams — but it is never checked by a solver, and never evaluated at
runtime by this reference implementation. Concretely, the `param` term kind that a method guard
introduces is a closed extension to `Term` that exists *only* for this purpose:

- `evalTerm`, `termToQuint`, and `termToAlloy` all **throw** if they ever encounter a `param`
  term — this is a loud routing restriction, not a silent gap. A `param` term reaching any of
  those three functions is a bug, not a feature that quietly no-ops.
- `validateCandidate` (the gate every solver-bound candidate invariant passes through) rejects any
  `param` term as `ill-typed` — a hand-built or LLM-emitted candidate can never carry one, because
  candidates are a different, closed grammar from method guards (design §6.1).

**Honest ceiling:** a method's `requires` guard is elicited, rendered, and carried faithfully —
but nothing verifies that a real implementation actually enforces it, and nothing checks it
against the state-machine dynamics of the aggregate it targets. It is a declarative annotation on
an application-layer entry point, not a verified domain law. Data-write methods with no lifecycle
move at all (e.g. a `recordUsage` that only mutates a running counter, with no transition) are not
representable in v1 — they need an effects language that is out of scope here.

## Semantic Rules

- `performs <Aggregate>.<transition>` must name a declared aggregate; an undeclared name reports
  `unknown-aggregate`. The named transition must exist on that aggregate's machine; an undeclared
  transition reports `unknown-transition`.
- `creates <Aggregate>` must name a declared aggregate; an undeclared name reports
  `unknown-aggregate`.
- A method's `requires` is validated against its kind's scope (see above): an unknown parameter
  reports `unknown-param`; a field path outside the legal scope reports `guard-cross-aggregate`
  (same code a transition guard uses for the analogous violation); an unknown field, region, state,
  or enum value reports the same codes the shared scoped-predicate walker uses elsewhere
  (`unknown-path`, `unknown-region`, `unknown-state`, `unknown-enum`, `unknown-enum-value`).
- A `param` term appearing anywhere it should not (a transition guard, a value invariant, or a
  hand-built candidate) reports `ill-typed` with the message "param terms are method-guard-only" —
  enforced both at the shared scoped-predicate walker and at `validateCandidate`.
- The service name must be PascalCase by convention; method and parameter names must be camelCase
  by convention (`naming-convention`) — all valid, non-[reserved](naming-conventions.md)
  identifiers. Services do **not** join the flat duplicate-name pool that enums/values/entities/
  aggregates/events share — a service name may coincide with another construct's name without
  triggering `duplicate-name` (services live in their own namespace).

## Projections

- **Printer** (`.lat`): one line per method, in the exact grammar shown above — the surface form
  round-trips exactly.
- **Prose**: a `## Services` section listing each method as `**name**(params) — <what it does>`,
  with `requires` rendered in the same plain-English style as everywhere else.
- **Diagrams**: a service becomes a `<<service>>`-stereotyped class box (method signatures only,
  no fields — a service carries no state) with one dashed dependency edge per distinct aggregate
  it performs against or creates, deduplicated per service+target.
- **Diff**: services do not participate in rename detection (no ledger references exist for a
  method or parameter in v1) — an added/removed/renamed service or method shows up only as a
  structural note (`added service X`, `removed method X.y`, `changed method X.y`), never a rename
  proposal.

## Example

```lat
context Billing {
  aggregate Invoice {
    invId      : Id key
    amountPaid : Money
    totalDue   : Money

    lifecycle settlement {
      states { open @initial, paid @terminal }
      transition settle { from open to paid; requires amountPaid >= totalDue }
    }
  }

  /// Public billing service.
  service BillingService {
    tier = appPublic
    settle(invId: Id) performs Invoice.settle
    getInvoice(invId: Id): Invoice read-only
  }
}
```

## See also

- [Transition](transition.md)
- [Lifecycle](lifecycle.md)
- [Aggregate](aggregate.md)
- [Field types](field-types.md)
- [Invariant](invariant.md)
- [Naming conventions](naming-conventions.md)
