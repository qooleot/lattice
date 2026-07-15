// Conform type model (spec plan §4): types shared by the contract renderer, the binder,
// and the observer. No solver usage anywhere in this module tree.

export interface FieldBinding {
  field: string;
  kind: 'auto' | 'override';
  column?: string;
  note?: string;
}

export interface AggregateBinding {
  aggregate: string;
  table: string;
  keyColumn: string;
  fields: FieldBinding[];
  unbound: string[];
}

export interface BindingManifest {
  aggregates: AggregateBinding[];
}

export interface ConformViolation {
  invariant: string;
  specElement: string;
  anchors: string[];
  witnessIds: string[];
  source: string;
  detail: string;
}

export interface ConformReport {
  target: string;
  snapshots: number;
  invariantsChecked: number;
  optOuts: { invariant: string; reason: string }[];
  violations: ConformViolation[];
  residual: { autoBound: number; overridden: number; total: number };
  traceRowsChecked: number;
  guardedTransitions: string[];   // reported-unevaluated (design §4.4 honesty line)
  durationMs: number;
}

export type OverrideFn = (db: unknown, row: Record<string, unknown>) => string | number | boolean;

// aggregate → field → fn
export type OverridesModule = Record<string, Record<string, OverrideFn>>;
