import type { DomainModel, TypeRef } from '../ast/domain.js';
import type { Cmp, Predicate, Term } from '../ast/invariant.js';
import {
  INT_POOL, astToQuint, buildOwnerInit, isIntPrim, owners, pathToQuint, refHopGates, varName,
} from './quint.js';
import type { QuintEmission } from './quint.js';

// Plan 2b Task 5 — method⊨transition entailment (param-aware encoding).
//
// A `performs` method's `requires` may reference method params (the `param` Term, legal ONLY in a
// MethodDef.requires — design §3.6). The ordinary term/pred renderers THROW on a `param` term
// (quint.ts:80/138) because transition guards may never legally carry one — and that throw MUST stay
// intact. This module is the SEPARATE param-aware renderer: it mirrors termToQuint/predToQuint's
// structure exactly, but resolves a `param` to a caller-supplied drawn var (via `paramVars`) instead
// of throwing. Field/ref-hop rendering is reused verbatim from quint.ts (pathToQuint/refHopGates), so
// the two renderers can never drift on the shared cases.

function termToQuintParam(m: DomainModel, t: Term, self: string, ownerName: string, paramVars: Record<string, string>): string {
  switch (t.kind) {
    case 'int': return String(t.value);
    case 'enumval': return `"${t.value}"`;
    case 'now': return 'now';
    case 'plus': return `${termToQuintParam(m, t.left, self, ownerName, paramVars)} + ${termToQuintParam(m, t.right, self, ownerName, paramVars)}`;
    case 'field': return pathToQuint(m, t.path, self, ownerName);
    case 'param': {
      const v = paramVars[t.name];
      if (v === undefined) throw new Error(`method-guard: param '${t.name}' has no drawn var (not encodable, or absent from the method's params)`);
      return v;
    }
  }
}

// Param-aware twin of quint.ts's refHopGatesInTerm: a `param` term is a drawn scalar with no ref
// hop (params are own-scope scalars — slice-4 §5.2.1), so it contributes no gate at all (neither
// an existence check nor an optional-hop Present flag).
function refHopsInTermParam(m: DomainModel, t: Term, self: string, ownerName: string): string[] {
  switch (t.kind) {
    case 'field': return refHopGates(m, t.path, self, ownerName);
    case 'plus': return [...refHopsInTermParam(m, t.left, self, ownerName), ...refHopsInTermParam(m, t.right, self, ownerName)];
    case 'int': case 'enumval': case 'now': case 'param': return [];
  }
}

export function predToQuintParam(
  m: DomainModel, p: Predicate, self: string, ownerName: string, paramVars: Record<string, string>,
): string {
  switch (p.kind) {
    case 'cmp': {
      const ops: Record<Cmp, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
      const cmp = `(${termToQuintParam(m, p.left, self, ownerName, paramVars)} ${ops[p.op]} ${termToQuintParam(m, p.right, self, ownerName, paramVars)})`;
      // Mirror predToQuint's ref-hop gates exactly (quint.ts cmp case): a read through a
      // never-created record, or through an optional hop whose own flag is false, is not a real
      // fact and must evaluate vacuously true, not manufacture a spurious witness. Params add no
      // hops, so an own-scalar guard has gates=[] (no gate).
      const gates = [...refHopsInTermParam(m, p.left, self, ownerName), ...refHopsInTermParam(m, p.right, self, ownerName)];
      if (gates.length === 0) return cmp;
      return `((${[...new Set(gates)].join(' and ')}) implies ${cmp})`;
    }
    case 'inState': return '(' + p.states.map(s => `${self}.${p.region}_state == "${s}"`).join(' or ') + ')';
    // Mirrors predToQuint's 'present' arm verbatim (quint.ts), ref-hop gates included — conjoined,
    // not implied, because presence reads absence as a fact (see the polarity note there). Params
    // never appear in a present() path (present() takes a Path, not a Term), so this needs no
    // param-aware variant and can reuse refHopGates directly.
    case 'present': {
      const flag = `${pathToQuint(m, p.path, self, ownerName)}Present`;
      const gates = refHopGates(m, p.path, self, ownerName);
      if (gates.length === 0) return flag;
      return `((${[...new Set(gates)].join(' and ')}) and ${flag})`;
    }
    case 'and': return '(' + p.args.map(a => predToQuintParam(m, a, self, ownerName, paramVars)).join(' and ') + ')';
    case 'or': return '(' + p.args.map(a => predToQuintParam(m, a, self, ownerName, paramVars)).join(' or ') + ')';
    case 'not': return `(not(${predToQuintParam(m, p.arg, self, ownerName, paramVars)}))`;
    case 'implies': return `(${predToQuintParam(m, p.left, self, ownerName, paramVars)} implies ${predToQuintParam(m, p.right, self, ownerName, paramVars)})`;
  }
}

// The quint row-type of a param, or null if it has no encoding (Id/Text prim, list, value) —
// mirrors fieldQType's prim/enum/ref branches. An unencodable param is never drawn; a `requires`
// that referenced one would throw in termToQuintParam (a malformed spec, out of scope here).
function paramQType(t: TypeRef): string | null {
  if (t.kind === 'ref') return 'str';
  if (t.kind === 'enum') return 'str';
  if (t.kind === 'prim') return isIntPrim(t.prim) ? 'int' : null;
  return null;
}
// The nondet pool a param is drawn from — mirrors initValue's branches (quint.ts:46-71):
// enum → oneOf(Set(...)); ref → oneOf(<TARGET>_IDS); int-prim → oneOf(INT_POOL).
function paramPool(m: DomainModel, t: TypeRef): string | null {
  if (t.kind === 'enum') { const e = m.enums.find(x => x.name === t.enum); return e ? `Set(${e.values.map(v => `"${v}"`).join(', ')})` : null; }
  if (t.kind === 'ref') return `${t.target.toUpperCase()}_IDS`;
  if (t.kind === 'prim' && isIntPrim(t.prim)) return INT_POOL;
  return null;
}

// Emit a havoc harness for the `∀ params, ∀ state: <implication>` entailment query (design §5).
//
// Structure mirrors astToQuintClassify: reuse astToQuint verbatim for the machine (decls, pools,
// `init`, transition/`step` actions) so the module typechecks, then append (i) per-encodable-param
// `var`/`nondet`/assignment and (ii) a havoc `indInit` binding + havocing every state var, and check
// the guard implication as a pure state predicate at `--init indInit --max-steps 0`.
//
// The implication is checked as the INVARIANT (never asserted at indInit): a violation is a
// (params, state) draw where the antecedent holds but the consequent fails. Params are drawn into
// STATE vars (not just action-scope nondets) so their values persist into the max-steps-0 invariant
// check. Since a machine-bearing owner's ids all share one drawn record (mapBy), the forall-over-map
// reduces to the scalar constraint on that record — exactly the classifier's reduction.
//
// `direction`:
//   'method-implies-guard' → invariant `methodReq ⇒ guard` (violated ⇒ method WEAKER than guard),
//   'guard-implies-method' → invariant `guard ⇒ methodReq` (violated ⇒ method STRONGER than guard).
// An absent `methodReq` is the weakest antecedent (`true`); an absent guard is `true` likewise.
export function astToMethodGuardQuery(
  m: DomainModel, aggregate: string, transition: string, methodReq: Predicate | undefined,
  params: { name: string; type: TypeRef }[], direction: 'method-implies-guard' | 'guard-implies-method',
): QuintEmission {
  // Resolve method→transition with validate.ts:229-234's inline pattern; read the transition guard.
  const agg = m.aggregates.find(a => a.name === aggregate);
  if (!agg) throw new Error(`astToMethodGuardQuery: unknown aggregate ${aggregate}`);
  const t = agg.machine?.transitions.find(x => x.name === transition);
  if (!t) throw new Error(`astToMethodGuardQuery: unknown transition ${aggregate}.${transition}`);
  const guard = t.requires;

  // Reuse astToQuint's machine verbatim (through the `step` line) — the predicate tail is discarded.
  // A trivial `from`-state statePredicate is a safe, always-renderable `hi` (guards are param-free).
  const base = astToQuint(m, {
    kind: 'probe-permit',
    hi: { kind: 'statePredicate', aggregate, body: { kind: 'inState', owner: 'self', region: t.region, states: t.from } },
    exclusions: [], maxSteps: 0,
  });
  const stepIdx = base.source.indexOf('\n  action step = any {');
  if (stepIdx < 0) throw new Error('astToMethodGuardQuery: could not locate the `step` action in the base emission');
  const head = base.source.slice(0, base.source.indexOf('\n', stepIdx + 1));   // module through the `step` line

  // Per-encodable-param: a state var, a nondet draw, and the binding assignment. paramVars maps the
  // param name → its STATE var (read by the invariant), the drawn value persisting to max-steps 0.
  const paramVars: Record<string, string> = {};
  const paramDecls: string[] = [];
  const paramNondets: string[] = [];
  const paramSets: string[] = [];
  for (const p of params) {
    const pool = paramPool(m, p.type); const qt = paramQType(p.type);
    if (!pool || !qt) continue;
    const sv = `param_${p.name}`, nd = `nd_param_${p.name}`;
    paramDecls.push(`  var ${sv}: ${qt}`);
    paramNondets.push(`nondet ${nd} = oneOf(${pool})`);
    paramSets.push(`${sv}' = ${nd}`);
    paramVars[p.name] = sv;
  }

  // Havoc every owner (each var must be assigned in the init action); the invariant reads only the
  // transition's aggregate var, but a well-formed init binds them all.
  const ownerInits = owners(m).map(o => {
    const { inits, nondets } = buildOwnerInit(m, o, o.name.toLowerCase(), 'havoc');
    return { v: varName(o.name), nondets, mapExpr: `${o.name.toUpperCase()}_IDS.mapBy(id => { ${inits.join(', ')} })` };
  });
  const allNondets = [...ownerInits.flatMap(x => x.nondets), ...paramNondets];
  const sets = [`now' = 0`, ...ownerInits.map(x => `${x.v}' = ${x.mapExpr}`), ...paramSets];
  const indInit = `  action indInit = { ${allNondets.join(' ')} all { ${sets.join(', ')} } }`;

  // The implication, over the aggregate's drawn record (forall-over-map, mirroring candidateToQuint's
  // statePredicate shape). Guard is param-free (empty paramVars); methodReq resolves params to state vars.
  const v = varName(aggregate);
  const methodStr = methodReq ? predToQuintParam(m, methodReq, 'x', aggregate, paramVars) : 'true';
  const guardStr = guard ? predToQuintParam(m, guard, 'x', aggregate, {}) : 'true';
  const impl = direction === 'method-implies-guard' ? `(${methodStr}) implies (${guardStr})` : `(${guardStr}) implies (${methodStr})`;
  const q = `  val q_methodGuard = ${v}.keys().forall(k => { val x = ${v}.get(k) (not(x.exists) or (${impl})) })`;

  const headWithParams = paramDecls.length
    ? head.replace('module lattice_q {\n', `module lattice_q {\n${paramDecls.join('\n')}\n`)
    : head;
  const source = `${headWithParams}\n\n${indInit}\n\n${q}\n}\n`;
  return { source, invariantName: 'q_methodGuard', varTypes: base.varTypes };
}
