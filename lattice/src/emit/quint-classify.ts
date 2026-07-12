import type { DomainModel } from '../ast/domain.js';
import type { Candidate } from '../ast/invariant.js';
import { astToQuint, buildOwnerInit, candidateToQuint, owners, varName } from './quint.js';
import type { QuintEmission } from './quint.js';

// The classifier's emitter twin (inference slice, design §7 / spike §4b). Emits the SAME machine as
// astToQuint — every `var`, pool, the permissive `init`, and all transition/`step` actions — plus a
// havoc `indInit` action and the named `val`s the two induction probes check via `runQuintVerify`.
//
// Why a havoc `indInit` rather than `--inductive-invariant` (spike §4a): Apalache's built-in
// inductive mode rejects the emitter's permissive `init` in its base phase and cannot bind the
// map/record state in its consecution phase. The working alternative (spike §4b) is an ordinary
// `quint verify --init indInit` where indInit (i) binds every state var by assignment, (ii) havocs
// every field including the machine-state fields, and (iii) asserts the induction hypothesis on the
// DRAWN nondet values (Quint forbids `invoices'.keys()`-style reads in an init predicate). Because
// every owner's ids share one nondet-drawn record via `mapBy`, a forall-over-map hypothesis reduces
// to the scalar constraint on that single record — so we assert the hypothesis by rebuilding the
// same `IDS.mapBy(id => {...})` map inline (referencing only the nondets, no var at all) and running
// candidateToQuint's predicate over it. That keeps hypothesis-generation a straight reuse of the
// shared candidateToQuint, with no duplicated predicate renderer.
export interface ClassifyQuery {
  invariant: Candidate;    // I (the invariant-under-test, or one conjunct)
  peers: Candidate[];      // expressibleAdopted peers (never I)
  probe: 'consecution' | 'entailment';
  maxSteps: number;        // 1 for consecution; the reachability bound (reachSteps, default 6) for entailment
}

export function astToQuintClassify(m: DomainModel, cq: ClassifyQuery): QuintEmission {
  // Reuse astToQuint verbatim for the machine (decls, pools, `init`, transition/`step` actions):
  // the emitted machine is query-independent, so a throwaway probe-permit query on I produces
  // exactly the machine we want, and we simply discard its predicate section (`val Hi`/`val q_inv`)
  // and append our own indInit + classify vals. This guarantees `step` and the transitions are
  // reused byte-for-byte (not re-derived) and keeps astToQuint the single source of the machine.
  // Plan 3 Task 1 (design §6.2/§6.3): the classifier's machine over-approximates numeric-field
  // evolution (monotone-up, non-terminal-gated) so data-touching invariants get meaningfully
  // tested via consecution instead of trivially holding under frozen data. This flag is set ONLY
  // here — method-guard.ts's astToQuint call stays unflagged (its transition-guard check has no
  // use for accrual, and golden traces must stay byte-identical).
  const base = astToQuint(m, { kind: 'probe-permit', hi: cq.invariant, exclusions: [], maxSteps: cq.maxSteps, abstractEvolution: true });
  const stepIdx = base.source.indexOf('\n  action step = any {');
  if (stepIdx < 0) throw new Error('astToQuintClassify: could not locate the `step` action in the base emission');
  const head = base.source.slice(0, base.source.indexOf('\n', stepIdx + 1));   // module through the `step` line

  // Per-owner havoc draws + the mapBy record set, and the same map rebuilt inline for the hypothesis.
  const ownerInits = owners(m).map(o => {
    const { inits, nondets } = buildOwnerInit(m, o, o.name.toLowerCase(), 'havoc');
    const mapExpr = `${o.name.toUpperCase()}_IDS.mapBy(id => { ${inits.join(', ')} })`;
    return { v: varName(o.name), nondets, mapExpr };
  });
  const allNondets = ownerInits.flatMap(x => x.nondets);
  const sets = [`now' = 0`, ...ownerInits.map(x => `${x.v}' = ${x.mapExpr}`)];
  // Rebuild each owner's map inline (from the same nondets) so the hypothesis references no var.
  const inlineMap = new Map(ownerInits.map(x => [x.v, `(${x.mapExpr})`]));

  // A candidate's induction-hypothesis form: candidateToQuint's predicate with each owner's
  // collection var replaced by its inline nondet-built map — a scalar constraint on the drawn record.
  //
  // Regex-hardening note (Plan 2b Task 1, Step 7): this loop mutates the SAME `expr` string across
  // owners, one `\bvar\b` global-replace per owner, in `owners(m)` order. That is safe ONLY because
  // no owner's inline map text can itself contain another owner's bare collection-var name as a
  // whole word — verified for the current models (test/emit/quint-classify.test.ts's multi-owner
  // hardening test, e.g. `activePaidInFullCandidate` ref-hopping Subscription → Invoice): ref
  // fields draw only an opaque id nondet (`nd_<tag>_<field>`, singular tag, e.g.
  // `nd_subscription_latestInvoice`) or reference the target's pool constant in UPPER_SNAKE
  // (`INVOICE_IDS`), never the lowercase plural var name (`invoices`) itself, so an earlier
  // substitution's inline text never accidentally matches a later owner's `\bvar\b`. If a future
  // owner/field naming scheme ever emits a bare collection-var name inside another owner's inline
  // init (e.g. a raw var-name string literal), this would silently corrupt the earlier
  // substitution — the fix would be to substitute all owners in one pass (a single alternation
  // regex, longest-name-first) rather than sequentially mutating `expr`.
  const hypOf = (c: Candidate): string => {
    const full = candidateToQuint(m, c, '__h');           // `val __h = <expr>`
    let expr = full.slice(full.indexOf(' = ') + 3);       // <expr>, referencing the collection vars
    for (const [v, inline] of inlineMap) expr = expr.replace(new RegExp(`\\b${v}\\b`, 'g'), inline);
    return `(${expr})`;
  };

  // consecution asserts (peersAnd and I); entailment asserts peersAnd only (spike §4d).
  const hyps = cq.probe === 'consecution' ? [cq.invariant, ...cq.peers] : cq.peers;
  const hypStr = hyps.length ? hyps.map(hypOf).join(' and ') : 'true';
  const indInit = `  action indInit = { ${allNondets.join(' ')} all { ${sets.join(', ')}, ${hypStr} } }`;

  // Named vals: q_I (the invariant-under-test), one peerK per peer, peersAnd, and q_peersImpliesI.
  const qI = candidateToQuint(m, cq.invariant, 'q_I');
  const peerVals = cq.peers.map((p, k) => candidateToQuint(m, p, `peer${k}`));
  const peersAnd = `val peersAnd = ${cq.peers.length ? `(${cq.peers.map((_, k) => `peer${k}`).join(' and ')})` : 'true'}`;
  const qPeersImpliesI = `val q_peersImpliesI = (peersAnd implies q_I)`;
  const valLines = [qI, ...peerVals, peersAnd, qPeersImpliesI].map(l => '  ' + l).join('\n');

  const source = `${head}\n\n${indInit}\n\n${valLines}\n}\n`;
  const invariantName = cq.probe === 'consecution' ? 'q_I' : 'q_peersImpliesI';
  return { source, invariantName, varTypes: base.varTypes };
}
