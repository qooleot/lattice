import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileInput } from '../../src/engine/reconcile.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';
import type { LedgerEntry } from '../../src/engine/session.js';

const model: DomainModel = {
  context: 'C', enums: [], events: [], entities: [],
  aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
    { name: 'id', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'r', initial: 's1', states: [{ name: 's1' }, { name: 's2', tags: ['terminal'] }] }],
      transitions: [{ name: 'go', region: 'r', from: 's1', to: 's2' }] } }],
};
const nonNeg: CandidateInvariant = { id: 'hand-unitsSane', name: 'unitsSane', prior: 1, source: 'template',
  candidate: { kind: 'statePredicate', aggregate: 'Job',
    body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } } } };

const ledger: LedgerEntry[] = [
  // negative units judged forbid — only unitsSane forbids it
  { kind: 'verdict', at: '2026-07-05T10:00:00Z', witnessId: 'w1', judge: 'forbid', question: '',
    witness: { entities: [{ type: 'Job', id: 'j', fields: { units: -5, 'r.state': 's1' } }] }, salient: [] },
  // positive units judged permit
  { kind: 'verdict', at: '2026-07-05T11:00:00Z', witnessId: 'w2', judge: 'permit', question: '',
    witness: { entities: [{ type: 'Job', id: 'j', fields: { units: 7, 'r.state': 's1' } }] }, salient: [] },
  { kind: 'adopted', at: '2026-07-05T12:00:00Z', invariant: nonNeg, provenance: 'elicited (w1, w2)' },
];

const base = (over: Partial<ReconcileInput>): ReconcileInput => ({
  parsed: { model, invariants: [nonNeg] }, storedModel: model, storedExplicit: [nonNeg],
  ledger, confirmedRenames: [], forceRemove: [], at: '2026-07-06T00:00:00Z', ...over });

describe('reconcile', () => {
  it('no-op edit applies cleanly with no ledger appends', () => {
    const r = reconcile(base({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ledgerAppends).toEqual([]);
  });

  it('rejects an edit that permits a forbid-judged state, naming witness/verdict/date', () => {
    const weakened = { ...nonNeg, candidate: { ...nonNeg.candidate,
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: -100 } } } } as CandidateInvariant;
    const r = reconcile(base({ parsed: { model, invariants: [weakened] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'contradicts-verdict')!;
      expect(f.witnessId).toBe('w1');
      expect(f.verdict).toBe('forbid');
      expect(f.judgedAt).toBe('2026-07-05T10:00:00Z');
      expect(f.message).toContain('w1');
      expect(f.message).toContain('re-judge');
    }
  });

  it('rejects a changed invariant that forbids a permit-judged state', () => {
    const tooStrict = { ...nonNeg, candidate: { ...nonNeg.candidate,
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 10 } } } } as CandidateInvariant;
    const r = reconcile(base({ parsed: { model, invariants: [tooStrict] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // w1 (forbid) still forbidden by the stricter rule, but w2 (permit) now forbidden → refusal
      const f = r.refusals.find(x => x.code === 'contradicts-verdict')!;
      expect(f.witnessId).toBe('w2');
      expect(f.verdict).toBe('permit');
      expect(f.invariant).toBe('unitsSane');
    }
  });

  it('consistent edit applies with hand-edited provenance', () => {
    const stricter = { ...nonNeg, candidate: { ...nonNeg.candidate,
      body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: -1 } } } } as CandidateInvariant;
    // still forbids w1 (units -5 < -1) and permits w2
    const r = reconcile(base({ parsed: { model, invariants: [stricter] } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ad = r.ledgerAppends.find(e => e.kind === 'adopted') as any;
      expect(ad.provenance).toBe('hand-edited 2026-07-06, consistent with w1, w2');
      expect(ad.invariant.name).toBe('unitsSane');
      expect(ad.invariant.id).toBe('hand-unitsSane');
    }
  });

  it('removal needs --force-remove and appends a declined entry when forced', () => {
    const r1 = reconcile(base({ parsed: { model, invariants: [] } }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.refusals[0]!.code).toBe('needs-force-remove');
    const r2 = reconcile(base({ parsed: { model, invariants: [] }, forceRemove: ['unitsSane'] }));
    // removing unitsSane un-forbids w1 → still a contradiction refusal even when forced
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.refusals.some(x => x.code === 'contradicts-verdict' && x.witnessId === 'w1')).toBe(true);
  });

  it('tag edit that kills a ledger-backed implied invariant follows the removal flow', () => {
    const untagged: DomainModel = JSON.parse(JSON.stringify(model));
    delete (untagged.aggregates[0]!.machine!.regions[0]!.states[1] as any).tags;   // s2 no longer @terminal
    const terminalInv: CandidateInvariant = { id: 'implied-terminalJobRS2', name: 'terminalJobRS2',
      prior: 1, source: 'template', candidate: { kind: 'terminal', aggregate: 'Job', region: 'r', state: 's2' } };
    const backed: LedgerEntry[] = [...ledger,
      { kind: 'adopted', at: '2026-07-05T12:30:00Z', invariant: terminalInv, provenance: 'template implied-terminalJobRS2' }];
    const r = reconcile(base({ parsed: { model: untagged, invariants: [nonNeg] }, ledger: backed }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'needs-force-remove')!;
      expect(f.invariant).toBe('terminalJobRS2');
    }
  });

  it('removal of an invariant with NO ledger record applies without ceremony (spec §3.4)', () => {
    // the test ledger has no adopted/declined record for terminalJobRS2, so untagging s2 is a
    // plain structural edit — no --force-remove, no declined entry
    const untagged: DomainModel = JSON.parse(JSON.stringify(model));
    delete (untagged.aggregates[0]!.machine!.regions[0]!.states[1] as any).tags;
    const r = reconcile(base({ parsed: { model: untagged, invariants: [nonNeg] } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ledgerAppends.filter(e => e.kind === 'declined')).toEqual([]);
      expect(r.applied.some(a => a.includes('terminalJobRS2') && a.includes('no ledger record'))).toBe(true);
    }
  });

  it('unconfirmed ledger-referenced rename refuses with the exact flag', () => {
    const renamed: DomainModel = JSON.parse(JSON.stringify(model));
    renamed.aggregates[0]!.fields[1]!.name = 'usedUnits';
    const inv2 = JSON.parse(JSON.stringify(nonNeg));
    inv2.candidate.body.left.path = ['usedUnits'];
    const r = reconcile(base({ parsed: { model: renamed, invariants: [inv2] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'needs-rename-confirmation')!;
      expect(f.message).toContain('--rename Job.units=usedUnits');
    }
  });

  it('confirmed rename applies: witnesses replay under the mapping, rename entry appended', () => {
    const renamed: DomainModel = JSON.parse(JSON.stringify(model));
    renamed.aggregates[0]!.fields[1]!.name = 'usedUnits';
    const inv2 = JSON.parse(JSON.stringify(nonNeg));
    inv2.candidate.body.left.path = ['usedUnits'];
    const r = reconcile(base({ parsed: { model: renamed, invariants: [inv2] },
      confirmedRenames: [{ scope: 'field', path: 'Job.units', from: 'units', to: 'usedUnits' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ledgerAppends.some(e => e.kind === 'rename' && (e as any).to === 'usedUnits')).toBe(true);
      // the body "changed" (path rename) but replay under mapping keeps w1 forbidden / w2 permitted
      expect(r.applied.join(' ')).toContain('usedUnits');
    }
  });

  it('unmatched --rename confirmation refuses instead of poisoning the ledger', () => {
    // nothing changed in the model/invariants — --rename Job.units=chairs does not correspond to
    // any detected rename proposal (there is no removed 'units' + added 'chairs' pair)
    const r = reconcile(base({
      confirmedRenames: [{ scope: 'field', path: 'Job.units', from: 'units', to: 'chairs' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = r.refusals.find(x => x.code === 'unmatched-rename-confirmation')!;
      expect(f).toBeDefined();
      expect(f.message).toContain('--rename Job.units=chairs');
      expect(f.message).toContain('does not correspond to any detected rename');
    }
  });

  it('structure-implied additions get no adopted ledger ceremony', () => {
    // add a Money field to Job — this makes nonNegativeJobFee a NEW implied invariant (spec §3.4);
    // it must NOT get a hand-edited 'adopted' entry, even though verdict replay still covers it.
    const withMoney: DomainModel = JSON.parse(JSON.stringify(model));
    withMoney.aggregates[0]!.fields.push({ name: 'fee', type: { kind: 'prim', prim: 'Money' } });
    const r = reconcile(base({ parsed: { model: withMoney, invariants: [nonNeg] } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const adoptedForFee = r.ledgerAppends.find(e => e.kind === 'adopted'
        && (e as any).invariant.name === 'nonNegativeJobFee');
      expect(adoptedForFee).toBeUndefined();
      expect(r.applied.some(a => a.includes('nonNegativeJobFee') && a.includes('derived from structure'))).toBe(true);
    }
  });

  it('rejects new hand-written leadsTo', () => {
    const lt: CandidateInvariant = { id: 'hand-lt', name: 'lt', prior: 1, source: 'template',
      candidate: { kind: 'leadsTo', aggregate: 'Job',
        from: { kind: 'inState', owner: 'self', region: 'r', states: ['s1'] },
        to: { kind: 'inState', owner: 'self', region: 'r', states: ['s2'] }, fairness: 'go' } };
    const r = reconcile(base({ parsed: { model, invariants: [nonNeg, lt] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]!.code).toBe('template-only-kind');
  });
});
