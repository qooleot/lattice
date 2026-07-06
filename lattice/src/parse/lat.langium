grammar Lat

entry LatContext:
    docs+=DOC* 'context' name=ID '{' items+=ContextItem* '}';

ContextItem:
    EnumDecl | EntityDecl | AggregateDecl | EventDecl | TicksDecl | InvariantDecl;

EnumDecl:
    'enum' name=ID '{' values+=ID (',' values+=ID)* '}';

TicksDecl:
    'ticksPerDay' '=' value=INT;

EntityDecl:
    docs+=DOC* 'entity' name=ID '{' fields+=FieldDecl* '}';

EventDecl:
    docs+=DOC* 'event' name=ID '{' fields+=FieldDecl* '}';

AggregateDecl:
    docs+=DOC* 'aggregate' name=ID '{' fields+=FieldDecl* machine=MachineDecl? invariants+=InvariantDecl* '}';

FieldDecl:
    name=ID ':' type=LatType (key?='key')? tags+=Tag*;

LatType:
    {infer ListType} 'List' '<' of=LatType '>'
  | {infer RefType} 'ref' target=ID
  | {infer NamedType} name=ID;

Tag:
    '@' name=TagName;

TagName returns string:
    ID | 'terminal' | 'monotonic' | 'state' | 'key';

MachineDecl:
    'machine' '{' regions+=RegionDecl+ transitions+=TransitionDecl* '}';

RegionDecl:
    'region' name=ID '{' 'states' '{' states+=StateDecl (',' states+=StateDecl)* '}' '}';

StateDecl:
    name=ID tags+=Tag*;

TransitionDecl:
    'transition' name=ID '{' 'region' region=ID ';' 'from' from=ID 'to' to=ID (';' 'when' when=ID)? '}';

InvariantDecl:
    docs+=DOC* 'invariant' name=ID ('on' target=ID)? ('where' where=Predicate)? '{' body=InvariantBody '}';

InvariantBody:
    UniqueBody | RefsResolveBody | CardinalityBody | TerminalBody | MonotonicBody | ConserveBody | LeadsToBody | PredicateBody;

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
    '(' Predicate ')' | StatePred | Comparison;

StatePred:
    'state' region=ID 'in' '{' states+=ID (',' states+=ID)* '}';

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
