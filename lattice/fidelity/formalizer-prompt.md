# Formalizer Prompt Template

(Orchestrator: replace {{RULE_ID}}, {{RULE_TEXT}}, and {{GRAMMAR}} — the last with the full contents
of `src/ast/invariant.ts` — then dispatch to a FRESH subagent. Send nothing else. The subagent must
not read any repo files.)

---

You are formalizing ONE business rule into a closed invariant grammar. Work only from what is in this
message — do not read any files. Reply with ONE JSON object and nothing else (no markdown fences, no
commentary).

## The rule

> {{RULE_TEXT}}

## The grammar (TypeScript types — your formalization must be a `Candidate`)

{{GRAMMAR}}

## Domain model

Define a minimal domain model containing only what this rule needs. Shape:

```
{ "context": string, "ticksPerDay": 24,
  "enums":      [{ "name", "values": [string] }],
  "entities":   [{ "kind": "entity", "name", "fields": [Field] }],
  "aggregates": [{ "kind": "aggregate", "name", "fields": [Field], "machine"?: Machine }],
  "events": [] }
```

Field: `{ "name": string, "type": TypeRef, "key"?: true, "tags"?: [string] }` with TypeRef one of
`{"kind":"prim","prim":"Int"|"Text"|"Date"|"Duration"|"Money"|"Id"}`, `{"kind":"enum","enum":name}`,
`{"kind":"ref","target":name}`, `{"kind":"list","of":TypeRef}`. Every entity/aggregate needs one
`"key": true` field. Machine: `{ "regions": [{ "name", "initial", "states": [{ "name", "tags"?:
["active"|"terminal"] }] }], "transitions": [] }`. If the rule involves a lifecycle (open/closed,
active/canceled …), model it as a machine region, not an enum field.

## Test cases

Provide exactly 3 "obvious" cases: concrete states where the rule's verdict is unambiguous — at least
one `"expected": "permit"` and at least one `"expected": "forbid"`. Case shape:

```
{ "desc": string, "expected": "permit" | "forbid",
  "state": { "now"?: number, "entities": [{ "type", "id", "fields": { ... } }],
             "trace"?: [[entity snapshots]] } }
```

Conventions (binding):
- Machine state is a field with key `"<Region>.state"`, value = state name (e.g. `"Lifecycle.state": "Open"`).
- A ref field's value is the target entity's `id`, and that entity must be present in `entities`.
- All other data fields must be numbers or enum-value strings. Never put free-text strings in fields.
- Time: `now` and Date/Duration fields are integer ticks; 24 ticks = 1 day.
- Include `trace` (prior snapshots of the same entities, oldest first) ONLY if your formalization is
  `terminal` or `monotonic` — those judge change over time; all other kinds judge a single state.

## Output

Exactly this shape:

```
{ "ruleId": "{{RULE_ID}}",
  "status": "formalized" | "not-formalizable",
  "model": <domain model>,
  "formalization": <Candidate> | null,
  "cases": [<3 cases>],
  "adversarial": null,
  "humanVerdict": null,
  "notes": <string, optional — required if not-formalizable: one line on why> }
```

Use `"not-formalizable"` only if the rule genuinely cannot be expressed as any `Candidate` — that is
an honest and acceptable answer. Do not stretch the grammar with a formalization you believe is wrong.
Give your single best formalization; you will not get a second attempt.
