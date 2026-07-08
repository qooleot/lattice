// The CLOSED candidate-invariant grammar (spec §6.1). Growing it is a versioned act, not implicit.
export type Engine = 'alloy' | 'quint';
export type Path = string[];
export type Cmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type Term =
  | { kind: 'field'; owner: string; path: Path }   // owner: 'self' (quantified subject) or an aggregate name
  | { kind: 'int'; value: number }
  | { kind: 'enumval'; enum: string; value: string }
  | { kind: 'now' }                                // current tick (Date/Duration are ticks)
  | { kind: 'plus'; left: Term; right: Term }      // linear arithmetic only
  | { kind: 'param'; name: string };               // method param ref — legal ONLY in a MethodDef.requires
                                                    // (design §3.6); THROWS in evalTerm/termToQuint/termToAlloy

export type Predicate =
  | { kind: 'cmp'; op: Cmp; left: Term; right: Term }
  | { kind: 'inState'; owner: string; region: string; states: string[] }
  | { kind: 'and'; args: Predicate[] }
  | { kind: 'or'; args: Predicate[] }
  | { kind: 'not'; arg: Predicate }
  | { kind: 'implies'; left: Predicate; right: Predicate };

export type Candidate =
  | { kind: 'statePredicate'; aggregate: string; where?: Predicate; body: Predicate }
  | { kind: 'unique'; aggregate: string; whileStates: { region: string; states: string[] }; by: Path[] }
  | { kind: 'refsResolve'; aggregate: string }
  | { kind: 'cardinality'; aggregate: string; where: Predicate | null; atMost: number }
  | { kind: 'terminal'; aggregate: string; region: string; state: string }
  | { kind: 'monotonic'; aggregate: string; field: Path }
  | { kind: 'conservation'; aggregate: string; parts: Path[]; total: Path }
  | { kind: 'leadsTo'; aggregate: string; from: Predicate; to: Predicate; fairness: string } // template-instantiated ONLY
  // elicitable; quint-routed; alloy encodes as adopted constraint only
  | { kind: 'sumOverCollection'; aggregate: string;
      collection: string;                 // owned List field name on the aggregate
      child: string;                      // the nested entity's name (== ownedCollectionChild(...).name)
      field: string;                      // numeric field on the child
      op: 'eq' | 'le' | 'ge';
      total: Path };                      // single-segment numeric path on the aggregate

export interface CandidateInvariant {
  id: string;
  name: string;
  doc?: string;                                     // human-owned /// English (spec P12); round-trips
  prior: number;                                    // LLM plausibility weight, 0..1
  source: 'seed' | 'template' | 'regen' | 'alternative';
  candidate: Candidate;
}

export interface Diagnostic { code: string; message: string; at?: string }
