grammar Lat

entry LatFile:
    docs+=DOC* (context=LatContext | map=ContextMapDecl);

LatContext:
    'context' name=ID '{' items+=ContextItem* '}';

ContextMapDecl:
    'contextMap' name=ID '{' contains+=ContainsDecl* relationships+=RelationshipDecl* '}';

ContainsDecl:
    'contains' name=ID ('from' path=STRING)?;

RelationshipDecl:
    docs+=DOC* left=ID
    ( kind='upstream' 'of' right=ID '{'
        ('upstream' 'roles' upstreamRoles+=UpstreamRoleName (',' upstreamRoles+=UpstreamRoleName)*)?
        ('downstream' 'roles' downstreamRoles+=DownstreamRoleName (',' downstreamRoles+=DownstreamRoleName)*)?
        ('exposes' exposes+=ID (',' exposes+=ID)*)?
      '}'
    | kind='partnership' 'with' right=ID '{'
        ('exposes' exposes+=ID (',' exposes+=ID)*)?
      '}'
    | kind='sharedKernel' 'with' right=ID '{'
        ('exposes' exposes+=ID (',' exposes+=ID)*)?
      '}' );

UpstreamRoleName returns string:
    'openHost' | 'publishedLanguage';

DownstreamRoleName returns string:
    'anticorruption' | 'conformist';

ContextItem:
    EnumDecl | EntityDecl | AggregateDecl | EventDecl | TicksDecl | InvariantDecl | ValueDecl | ServiceDecl | BuiltinDecl;

EnumDecl:
    'enum' name=ID '{' values+=ID (',' values+=ID)* '}';

// Opaque builtin/external carrier type (design: derived-invariants.md "carried vs solved"). A
// declared name that a field may be typed with but the solver never encodes — codegen represents it
// (Ruby T::Struct / TS interface), derivation folds it to nothing. Lets a bare carrier name
// (`meta : Metadata`) resolve to a carried TypeRef instead of the unresolved-enum
// fallback, and round-trips (astToCode re-emits the decl).
BuiltinDecl:
    'builtin' name=ID;

ValueDecl:
    docs+=DOC* 'value' name=ID '{' fields+=FieldDecl* invariants+=InvariantDecl* '}';

ServiceDecl:
    docs+=DOC* 'service' name=ID '{' methods+=MethodDecl* '}';

MethodDecl:
    docs+=DOC* name=ID '(' (params+=ParamDecl (',' params+=ParamDecl)*)? ')' (':' returns=LatType)?
        ( readOnly?='read-only'
        | 'performs' performsAgg=ID '.' performsTransition=ID
        | 'creates' creates=ID )
        ('requires' requires=Predicate)?;

ParamDecl:
    name=ID ':' type=LatType;

TicksDecl:
    'ticksPerDay' '=' value=INT;

EntityDecl:
    docs+=DOC* 'entity' name=ID '{' fields+=FieldDecl* '}';

EventDecl:
    docs+=DOC* 'event' name=ID '{' fields+=FieldDecl* '}';

AggregateDecl:
    docs+=DOC* 'aggregate' name=ID '{' (fields+=FieldDecl | entities+=EntityDecl)* lifecycles+=LifecycleDecl* invariants+=InvariantDecl* '}';

FieldDecl:
    name=ID ':' type=LatType (optional?='?')? (key?='key')? (const?='const')? tags+=Tag*;

// Rich CML type surface (see ast/domain.ts TypeRef, "carried vs solved"). Layered by precedence:
// union `|` binds loosest, then the application forms (List/Optional/Map/generic/ref/named). Union
// is parsed left-assoc and flattened to n-ary arms in fromLangium (as `&&`/`||` predicates are).
LatType:
    TypeUnion;

TypeUnion infers LatType:
    TypeApp ({infer UnionType.left=current} '|' right=TypeApp)*;

TypeApp infers LatType:
    {infer ListType} 'List' '<' of=LatType '>'
  | {infer OptionalType} 'Optional' '<' of=LatType '>'
  | {infer MapType} 'Map' '<' key=LatType ',' of=LatType '>'
  | {infer RefType} 'ref' target=QualifiedName
    // A bare `name` is a prim/value/owner/carrier/enum (resolved in mapType). With type arguments
    // it is a generic constructor (`Result<T, E>`, user generics) — carried, ctor left opaque.
  | {infer NamedType} name=ID ('<' args+=LatType (',' args+=LatType)* '>')?;

QualifiedName returns string:
    ID ('.' ID)?;

Tag:
    '@' name=TagName;

TagName returns string:
    ID | 'terminal' | 'monotonic' | 'state' | 'key';

LifecycleDecl:
    'lifecycle' name=ID '{'
        'states' '{' states+=StateDecl (',' states+=StateDecl)* '}'
        transitions+=TransitionDecl*
    '}';

StateDecl:
    name=ID tags+=Tag*;

TransitionDecl:
    'transition' name=ID '{' 'from' from+=ID (',' from+=ID)* 'to' to=ID
        (';' 'when' when=ID)?
        (';' 'requires' requires=Predicate)?
        (';' 'emits' emits=ID)?
    '}';

InvariantDecl:
    docs+=DOC* 'invariant' name=ID ('on' target=ID)? ('where' where=Predicate)? '{' body=InvariantBody '}';

InvariantBody:
    UniqueBody | RefsResolveBody | CardinalityBody | TerminalBody | MonotonicBody | ConserveBody | LeadsToBody | SumBody | PredicateBody;

UniqueBody:
    'unique' 'while' region=ID 'in' '{' states+=ID (',' states+=ID)* '}' 'by' '(' by+=PathExpr (',' by+=PathExpr)* ')';

RefsResolveBody:
    {infer RefsResolveBody} 'refs' 'resolve';

CardinalityBody:
    'count' ('where' where=Predicate)? '<=' atMost=INT;

TerminalBody:
    'terminal' region=ID '.' state=ID;

MonotonicBody:
    'monotonic' field=PathExpr;

ConserveBody:
    'conserve' parts+=PathExpr ('+' parts+=PathExpr)+ '==' total=PathExpr;

LeadsToBody:
    'from' from=Predicate 'leads' 'to' to=Predicate 'under' 'fairness' fairness=STRING;

// `field` is a PathExpr, not an ID: the summed field may hop through a value type
// (`sum(postings, amount.amount)` where `Posting.amount : Amount`) since sumOverCollection.field
// widened from `string` to `Path`. `collection` stays an ID — it names one List field on the
// aggregate and never hops.
SumBody:
    total=PathExpr op=('=='|'<='|'>=') 'sum' '(' collection=ID ',' field=PathExpr ')';

PredicateBody:
    pred=Predicate;

Predicate:
    Implication;

Implication infers Predicate:
    Disjunction ({infer BinPred.left=current} op='=>' right=Disjunction)?;

Disjunction infers Predicate:
    Conjunction ({infer BinPred.left=current} op='||' right=Conjunction)*;

Conjunction infers Predicate:
    Negation ({infer BinPred.left=current} op='&&' right=Negation)*;

Negation infers Predicate:
    {infer NotPred} '!' arg=Negation | Primary;

Primary infers Predicate:
    '(' Predicate ')' | StatePred | PresentPred | Comparison;

StatePred:
    'state' region=ID 'in' '{' states+=ID (',' states+=ID)* '}';

PresentPred:
    'present' '(' path=PathExpr ')';

Comparison:
    left=Expr op=('=='|'!='|'<'|'<='|'>'|'>=') right=Expr;

Expr:
    AddExpr;

AddExpr infers Expr:
    PrimaryExpr ({infer PlusExpr.left=current} '+' right=PrimaryExpr)*;

PrimaryExpr infers Expr:
    {infer IntLit} value=INT
  | {infer NowLit} 'now'
  | {infer PathRef} segments+=ID ('.' segments+=ID)*;

PathExpr:
    segments+=ID ('.' segments+=ID)*;

hidden terminal WS: /\s+/;
terminal DOC: /\/\/\/[^\n\r]*/;
terminal ID: /[A-Za-z_][A-Za-z0-9_]*/;
terminal INT: /[0-9]+/;
terminal STRING: /"[^"]*"/;
