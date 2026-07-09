import { describe, it, expect } from 'vitest';
import { astToCode } from '../../src/emit/code.js';
import type { DomainModel } from '../../src/ast/domain.js';
import type { CandidateInvariant } from '../../src/ast/invariant.js';

const m: DomainModel = {
  context: 'Demo', doc: 'Top doc', ticksPerDay: 24,
  enums: [{ name: 'Mode', values: ['fast', 'slow'] }], values: [],
  entities: [{ kind: 'entity', name: 'Plan', doc: 'Entity doc', fields: [
    { name: 'planId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'fee', type: { kind: 'prim', prim: 'Money' } },
    { name: 'bonus', type: { kind: 'prim', prim: 'Money' }, tags: ['signed'] }] }],
  aggregates: [{ kind: 'aggregate', name: 'Job', fields: [
    { name: 'jobId', type: { kind: 'prim', prim: 'Id' }, key: true },
    { name: 'plan', type: { kind: 'ref', target: 'Plan' } },
    { name: 'units', type: { kind: 'prim', prim: 'Int' } }],
    machine: { regions: [{ name: 'run', initial: 'queued', states: [
      { name: 'queued' }, { name: 'going', tags: ['active'] }, { name: 'done', tags: ['terminal'] }] }],
      transitions: [{ name: 'start', region: 'run', from: ['queued'], to: 'going', when: 'kicked' }] } }],
  events: [{ name: 'kicked', fields: [{ name: 'reason', type: { kind: 'prim', prim: 'Text' } }] }],
  services: [{ name: 'JobOps', doc: 'Service doc', methods: [
    { name: 'kickOff', params: [{ name: 'units', type: { kind: 'prim', prim: 'Int' } }],
      kind: { performs: { aggregate: 'Job', transition: 'start' } },
      requires: { kind: 'cmp', op: 'ge', left: { kind: 'param', name: 'units' }, right: { kind: 'int', value: 0 } } },
    { name: 'getJob', params: [{ name: 'jobId', type: { kind: 'prim', prim: 'Id' } }], returns: { kind: 'ref', target: 'Job' },
      kind: { readOnly: true } },
  ] }],
};

const invs: CandidateInvariant[] = [
  { id: 'hand-unitsSane', name: 'unitsSane', prior: 1, source: 'template', doc: 'Units stay sane.',
    candidate: { kind: 'statePredicate', aggregate: 'Job', body: { kind: 'and', args: [
      { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } },
      { kind: 'implies', left: { kind: 'inState', owner: 'self', region: 'run', states: ['going'] },
        right: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 100 } } }] } } },
  // duplicates the implied refsResolveJob → must NOT print
  { id: 'tpl-9-Job', name: 'NoOrphan_Job', prior: 0.9, source: 'template',
    candidate: { kind: 'refsResolve', aggregate: 'Job' } },
  { id: 'hand-planMode', name: 'planMode', prior: 1, source: 'template',
    candidate: { kind: 'statePredicate', aggregate: 'Plan',
      where: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['fee'] }, right: { kind: 'int', value: 1 } },
      body: { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['mode'] },
        right: { kind: 'enumval', enum: 'Mode', value: 'fast' } } } },
];

it('prints the reference form exactly', () => {
  expect(astToCode(m, invs)).toBe(`/// Top doc
context Demo {

  ticksPerDay = 24

  enum Mode { fast, slow }

  /// Entity doc
  entity Plan {
    planId : Id key
    fee    : Money
    bonus  : Money @signed
  }

  event kicked {
    reason : Text
  }

  aggregate Job {
    jobId : Id key
    plan  : ref Plan
    units : Int

    lifecycle run {
      states { queued @initial, going @active, done @terminal }
      transition start { from queued to going; when kicked }
    }

    /// Units stay sane.
    invariant unitsSane { units >= 0 && (state run in {going} => units <= 100) }
  }

  /// Service doc
  service JobOps {
    kickOff(units: Int) performs Job.start requires units >= 0
    getJob(jobId: Id): ref Job read-only
  }

  invariant planMode on Plan where fee >= 1 { mode == Mode.fast }
}
`);
});

it('never emits // and always emits every candidate kind parseably', () => {
  const kinds: CandidateInvariant[] = [
    { id: 'a', name: 'u', prior: 1, source: 'template', candidate: { kind: 'unique', aggregate: 'Job', whileStates: { region: 'run', states: ['going', 'queued'] }, by: [['plan'], ['units']] } },
    { id: 'b', name: 'c', prior: 1, source: 'template', candidate: { kind: 'cardinality', aggregate: 'Job', where: null, atMost: 2 } },
    { id: 'd', name: 'mono', prior: 1, source: 'template', candidate: { kind: 'monotonic', aggregate: 'Job', field: ['units'] } },
    { id: 'e', name: 'cons', prior: 1, source: 'template', candidate: { kind: 'conservation', aggregate: 'Job', parts: [['units'], ['units']], total: ['units'] } },
    { id: 'f', name: 'lt', prior: 1, source: 'template', candidate: { kind: 'leadsTo', aggregate: 'Job',
      from: { kind: 'inState', owner: 'self', region: 'run', states: ['queued'] },
      to: { kind: 'inState', owner: 'self', region: 'run', states: ['done'] }, fairness: 'start fires' } },
  ];
  const text = astToCode(m, kinds);
  expect(text).toContain('invariant u { unique while run in {going, queued} by (plan, units) }');
  expect(text).toContain('invariant c { count <= 2 }');
  expect(text).toContain('invariant mono { monotonic units }');
  expect(text).toContain('invariant cons { conserve units + units == units }');
  expect(text).toContain('invariant lt { from state run in {queued} leads to state run in {done} under fairness "start fires" }');
  for (const line of text.split('\n')) expect(line).not.toMatch(/(^|[^/])\/\/([^/]|$)/);
});

it('refuses degenerate inputs the grammar cannot parse back (throws, no garbage text)', () => {
  const hollowEnum: DomainModel = { ...m, enums: [{ name: 'Hollow', values: [] }], values: [] };
  expect(() => astToCode(hollowEnum, [])).toThrow(/enum Hollow/);
  const onePart: CandidateInvariant = { id: 'hand-c1', name: 'c1', prior: 1, source: 'template',
    candidate: { kind: 'conservation', aggregate: 'Job', parts: [['units']], total: ['units'] } };
  expect(() => astToCode(m, [onePart])).toThrow(/conservation on Job/);
});
