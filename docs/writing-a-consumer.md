# Writing a consumer

Lattice's job ends at the IR: it parses `.lat`, verifies the model, and emits a stable,
versioned, language-neutral `ir.json` (see [ir.md](ir.md) for the full contract — this doc
does not repeat it). A **consumer** is anything downstream that turns that IR into source
code: a code generator living in its own repo, targeting its own language, projecting into
its own folder/architecture convention.

The IR is the plugin seam. Nothing team-specific or language-specific lives in lattice —
each consumer owns that on its own side of the boundary. This doc distills the shape that
three independent consumers converged on, so a fourth doesn't have to rediscover it.

## The four roles

A consumer decomposes into four roles, run in a pipeline:

```
 ir.json
    │
    ▼
┌─────────┐     ┌───────────────────┐     ┌──────────┐     ┌───────────┐
│ IR Load │ ──▶ │ LayoutStrategy    │ ──▶ │ Emitter  │ ──▶ │ Generator │ ──▶ files on disk
│         │     │ (the pluggable    │     │          │     │           │
│         │     │  seam)            │     │          │     │           │
└─────────┘     └───────────────────┘     └──────────┘     └───────────┘
 typed IR         decl → {path,           TypeRef →         load → plan →
 structures       namespace},             target-type;      render → write;
                  ref → FQ path            decl → source     preserve hand-
                                                              written regions
```

### 1. IR Load

Parse `ir.json` into typed structures in your target language: `context`, `builtins`,
`records`, `enums`, `values`, `entities`, `aggregates`, `services`, and — running through
all of them — `TypeRef`, the 10-kind discriminated union every field/param/return type is
expressed as.

Reject an unknown `irVersion` outright rather than guessing at a shape. The IR's versioning
policy (see [ir.md](ir.md#versioning-policy)) only promises a v1 reader can read v1; there
is no promise a v1 reader can read v2. Fail loudly, don't degrade silently.

### 2. LayoutStrategy — the pluggable seam

This is the *only* place a team's folder/architecture convention lives. It answers two
questions for every declaration:

- **Where does it go?** — a file path, and a fully-qualified namespace/package.
- **How do cross-references resolve?** — when one declared type's field refers to another
  (a `ref`, a `value`, an `enum`), the strategy resolves that reference to the *target's*
  fully-qualified path so the emitter can write a correct import/qualified name.

Because this is isolated, the same IR can drive genuinely different architectures just by
swapping the strategy: one team's `domain/types/` layered convention, another's
`core/data/` hexagonal convention, a third's flat language package — same declarations, same
fields, different trees. The IR does not encode any of that; the strategy does.

### 3. Emitter

Two things: a `TypeRef → target-type` mapping (see [Type-map completeness](#type-map-completeness)
below), and rendering for each declaration kind (record, enum, value, entity, aggregate,
service) into source text.

Reuse your language's *existing* emission machinery — templates, formatters, whatever
already produces the target codebase's idiomatic output — rather than inventing a new
rendering path. That reuse is what makes byte-fidelity with an existing, hand-maintained
codebase possible at all (see [Faithfulness needs a deterministic
target](#faithfulness-needs-a-deterministic-target)).

### 4. Generator

The orchestrator: load the IR, plan file placement via the LayoutStrategy, render each
declaration via the Emitter, and write files. On regeneration, preserve hand-written
regions — fixed points the generator must not clobber (a marked block, a companion file it
never touches, a merge instead of an overwrite). Generation is something a consumer runs
repeatedly against an evolving spec; treat every write as a merge into existing state, not a
wholesale replacement of it.

## Principles

**Layout ≠ emission.** WHERE a declaration lands (file path, package, namespace) is
team-specific and belongs entirely in the LayoutStrategy. WHAT gets emitted (the shape of
the generated type, the field mapping) is mostly team-agnostic and belongs in the Emitter.
Keep the boundary sharp: if you find yourself branching on a team convention inside the
Emitter, that logic belongs in the LayoutStrategy instead. Confining all divergence to one
seam is what lets two teams share an Emitter while disagreeing about folders.

**Reuse existing emission machinery.** Don't reinvent templates or formatters your target
codebase already has; wire the Emitter to call them. This isn't just less work — it's the
difference between "generates something roughly right" and "generates the exact bytes a
human would have written by hand."

**Faithfulness needs a deterministic target.** Byte-for-byte reproduction is a meaningful
goal only when the *existing* output you're matching is itself the product of a
deterministic pipeline (templates + a formatter) — there, matching it byte-for-byte is a
real, checkable property. It is not a meaningful goal for hand-written logic: validation
bodies derived from invariants, service method bodies, anything a human wrote by judgment
rather than by rule. The IR is data-only — it has no bytecode for "the specific if-statement
a human wrote here." For that surface, scaffold a stub (a method signature, a TODO, a
guard-shaped comment) and say plainly that a human still owns the body. Don't quietly drop
it, and don't pretend a generated guess is a reproduction.

## Gotchas

- **Template-root coupling.** A template that hardcodes a root namespace or package prefix
  (`com.example.domain`) only works for the team that owns that root. Parameterize the root
  through the LayoutStrategy, or fork the template per team — don't let a hardcoded root
  silently make the Emitter single-tenant.
- **Rendering-pipeline fidelity.** The *exact* formatter in the chain matters for
  byte-equality, not just "a" formatter of the right language — e.g. a Ruby pipeline that
  goes through `erubi` templates and then `rubyfmt`, or a Java pipeline through
  `google-java-format`. A naive string-template render that skips the real formatter will
  produce valid code that does not match, defeating the point of chasing byte-fidelity at
  all.
- **Head-optional normalization.** Lattice folds a head `Optional<T>` into the field's
  `optional` flag plus the inner type `T` — the IR does not hand you a literal `optional`
  `TypeRef` kind at the field head (see [ir.md](ir.md#types-typeref)). Your emitter must
  re-wrap based on that flag: nullable in one language, an `Optional`/`Maybe` wrapper in
  another. Forgetting this produces a field typed as its bare inner type with no way to
  represent absence.
- **Type-map completeness.** All 10 `TypeRef` kinds are real and each needs a mapping.
  Verify coverage against a golden output rather than trusting a mental checklist — it's
  easy to handle the kinds your first few fixtures happen to exercise and never notice the
  rest are unmapped. For a kind you haven't exercised yet, mark it as an explicit TODO in
  the mapper (so it fails loudly if hit) rather than letting it fall through to a default
  that looks done but isn't.
- **Cross-context references — explicit FQN, never inference.** A type owned by *another*
  bounded context is named with an explicit fully-qualified path, because the referencing
  spec does not know the foreign context's layout. The idiomatic form is an **external
  builtin** (`builtin BillToken = "…::BillToken"` → a `carrier` you emit verbatim). A dotted
  `ref Context.Type` must be resolved through an **explicit `Context.Type → FQN` mapping** the
  consumer is given, and **fail loud** on an unmapped one — do NOT reconstruct the foreign
  context's namespace by inferring its layout (see [ir.md](ir.md#cross-context-references)).
  A silent fallback here (emitting `T.untyped`, or the raw dotted string as a type) is a
  correctness bug, not a graceful degrade.

## Worked example

A tiny spec with a cross-context ref, an enum, and a couple of fields:

```lat
context Catalog {
  entity Sku {
    skuId : Id key
  }
}
```

```lat
context Storefront {
  enum OrderStatus { pending, fulfilled }

  aggregate Order {
    orderId : Id key
    item    : ref Catalog.Sku
    total   : Money
    status  : OrderStatus
    note    : Text?
  }
}
```

```
engine emit-ir --spec storefront.lat --out ir.json
```

The four roles over that IR, sketched (pseudocode, lightly Ruby-flavored):

```ruby
# 1. IR Load
ir = IR.load_json("ir.json")
raise "unsupported irVersion #{ir.version}" unless ir.version == SUPPORTED_VERSION
order = ir.aggregates.find { |a| a.name == "Order" }
# order.fields => [orderId: Id key, item: ref Catalog.Sku, total: Money,
#                  status: enum OrderStatus, note: Text (optional: true)]
```

```ruby
# 2. LayoutStrategy — layered-DDD convention, this team's choice
class LayeredLayout
  def path_for(decl)
    "app/domain/#{decl.context.underscore}/#{decl.name.underscore}.rb"
  end

  def namespace_for(decl)
    "Domain::#{decl.context.camelize}"
  end

  def resolve_ref(from_decl, type_ref)
    # Catalog.Sku -> fully-qualified path in *this* team's tree
    "Domain::Catalog::Sku"
  end
end
```

```ruby
# 3. Emitter
class TypeMapper
  def map(type_ref)
    case type_ref.kind
    when "prim"     then PRIM_MAP.fetch(type_ref.prim)   # Money -> Money, Id -> String, ...
    when "enum"     then type_ref.enum                    # emitted enum's constant name
    when "ref"      then layout.resolve_ref(type_ref)      # via the LayoutStrategy
    when "value"    then type_ref.value
    # ... all 10 kinds handled, unexercised ones marked TODO explicitly
    end
  end
end

class RecordEmitter
  def render(decl)
    fields = decl.fields.map do |f|
      target_type = type_mapper.map(f.type)
      target_type = "T.nilable(#{target_type})" if f.optional   # re-wrap head-optional
      "#{f.name}: #{target_type}"
    end
    template.render("aggregate.erb", name: decl.name, fields: fields)  # existing template
  end
end
```

```ruby
# 4. Generator
ir = IRLoad.load("ir.json")
layout = LayeredLayout.new
plan = layout.plan(ir.aggregates + ir.enums)   # decl -> {path, namespace}
plan.each do |decl, location|
  source = RecordEmitter.new(layout).render(decl)
  FileWriter.write(location.path, source, preserve: :hand_written_region_markers)
end
```

Swap `LayeredLayout` for a `HexagonalLayout` (different `path_for`/`namespace_for`,
same `resolve_ref` contract) and the same IR produces a different tree — the Emitter and
Generator above don't change at all.

## Case studies

Three consumers have validated this shape so far:

- **A layered-DDD generator** — projects the IR into a conventional domain/application/
  infrastructure layering, one file per declaration under a domain-scoped namespace.
- **A hexagonal generator** — same IR, a different LayoutStrategy: ports-and-adapters
  folders and a different namespace convention. The Emitter and IR Load code are close to
  identical to the layered generator's; only the LayoutStrategy differs meaningfully.
- **A JVM generator** — a different target language entirely (immutable value-object
  generation), proving the four-role shape isn't tied to one language's idioms.

None of the above should be read as an endorsement of any specific folder name, package
name, or file layout — the point of the case studies is that the *same* IR, run through
*different* strategies, produced three legitimately different, idiomatic outputs without
lattice knowing anything about any of them.

## Versioning and confidentiality

Pin the `irVersion` your consumer reads and reject anything else (see [IR Load](#1-ir-load)
above) — see [ir.md's versioning policy](ir.md#versioning-policy) for what does and doesn't
trigger a bump. Keep your consumer's own examples and test fixtures abstract, the same way
lattice's are (see [ir.md's confidentiality note](ir.md#confidentiality)): real domain specs
and their emitted IR belong only in the consuming repo, never upstream in lattice.
