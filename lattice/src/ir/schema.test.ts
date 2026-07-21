import { describe, it, expect } from 'vitest';
import type { DomainModel, TypeRef } from '../ast/domain.js';
import { IR_VERSION, toIR } from './schema.js';

// Hand-crafted (not parsed) DomainModel exercising every TypeRef kind, every Def type, and the
// optional/normalized fields toIR must handle. Not a valid spec by grammar rules (e.g. the service
// method params/returns reference ad hoc TypeRefs) — toIR takes a DomainModel directly and makes no
// claim about validity, so this is deliberately a shape-coverage fixture, not a valid-model fixture.

const listOfPrim: TypeRef = { kind: 'list', of: { kind: 'prim', prim: 'Int' } };
const mapType: TypeRef = { kind: 'map', key: { kind: 'prim', prim: 'Text' }, of: { kind: 'prim', prim: 'Money' } };
const genericType: TypeRef = { kind: 'generic', ctor: 'Result', args: [{ kind: 'prim', prim: 'Int' }, { kind: 'prim', prim: 'Text' }] };
const unionType: TypeRef = { kind: 'union', arms: [{ kind: 'prim', prim: 'Int' }, { kind: 'prim', prim: 'Text' }] };
const carrierType: TypeRef = { kind: 'carrier', name: 'Currency' };
const optionalType: TypeRef = { kind: 'optional', of: { kind: 'prim', prim: 'Money' } };
const enumType: TypeRef = { kind: 'enum', enum: 'Status' };
const refType: TypeRef = { kind: 'ref', target: 'Widget' };
const valueType: TypeRef = { kind: 'value', value: 'Amount' };
const primType: TypeRef = { kind: 'prim', prim: 'Int' };

const model: DomainModel = {
  context: 'Abstract',
  doc: 'a hand-built model exercising every IR shape',
  ticksPerDay: 24,
  builtins: [
    { name: 'Currency' },                                        // no ref
    { name: 'Decimal', ref: 'Some::External::Decimal' },         // with ref
    { name: 'ModBuiltin', module: 'Extras' },
  ],
  typeAliases: [
    { name: 'Cents', target: primType, doc: 'alias doc' },
    { name: 'ModAlias', target: primType, module: 'Extras' },
  ],
  records: [
    { name: 'Dto', fields: [{ name: 'note', type: { kind: 'prim', prim: 'Text' } }] },
    { name: 'ModRecord', fields: [{ name: 'x', type: primType }], module: 'Extras' },
  ],
  enums: [
    {
      name: 'Status', values: ['pending', 'monetary'],
      payloads: { monetary: { kind: 'prim', prim: 'Money' } },   // sum-type payload
      doc: 'status enum',
    },
  ],
  values: [
    {
      kind: 'value', name: 'Amount',
      fields: [
        { name: 'amount', type: { kind: 'prim', prim: 'Money' }, key: true, const: true, optional: false, tags: ['balance'], doc: 'the amount' },
        { name: 'currency', type: carrierType, optional: true, tags: ['tag2'] },
      ],
      invariants: [{ name: 'nonNegative', body: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['amount'] }, right: { kind: 'int', value: 0 } }, doc: 'must be >= 0' }],
      doc: 'a monetary amount',
    },
  ],
  entities: [
    { kind: 'entity', name: 'Gadget', fields: [{ name: 'label', type: { kind: 'prim', prim: 'Text' } }] },
  ],
  aggregates: [
    {
      kind: 'aggregate', name: 'Widget',
      fields: [
        { name: 'widgetId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'lengths', type: listOfPrim },
        { name: 'balances', type: mapType },
        { name: 'outcome', type: genericType },
        { name: 'variant', type: unionType },
        { name: 'label', type: carrierType },
        { name: 'approved', type: optionalType },
        { name: 'status', type: enumType },
        { name: 'gadgetRef', type: refType },
        { name: 'total', type: valueType },
      ],
      entities: [{ kind: 'entity', name: 'Part', fields: [{ name: 'partId', type: { kind: 'prim', prim: 'Id' }, key: true }] }],
      machine: {
        regions: [{ name: 'lifecycle', initial: 'draft', states: [{ name: 'draft' }, { name: 'active', tags: ['active'] }, { name: 'done', tags: ['terminal'] }] }],
        transitions: [{ name: 'activate', region: 'lifecycle', from: ['draft'], to: 'active', emits: 'WidgetActivated' }],
      },
      doc: 'a widget aggregate',
    },
  ],
  events: [
    { name: 'WidgetActivated', fields: [{ name: 'widgetId', type: { kind: 'prim', prim: 'Id' } }] },
  ],
  services: [
    {
      name: 'WidgetService', tier: 'appPublic',
      methods: [
        { name: 'getWidget', params: [{ name: 'id', type: { kind: 'prim', prim: 'Id' } }], returns: refType, kind: { readOnly: true } },
        { name: 'activateWidget', params: [{ name: 'id', type: { kind: 'prim', prim: 'Id' } }], kind: { performs: { aggregate: 'Widget', transition: 'activate' } } },
        { name: 'createWidget', params: [{ name: 'label', type: { kind: 'prim', prim: 'Text' } }], returns: refType, kind: { creates: 'Widget' } },
      ],
      doc: 'service over widgets',
    },
  ],
};

describe('toIR', () => {
  it('adds irVersion and normalizes optional collections, otherwise mirroring the model', () => {
    const ir = toIR(model);
    expect(ir).toEqual({
      irVersion: '1',
      context: model.context,
      doc: model.doc,
      ticksPerDay: model.ticksPerDay,
      builtins: model.builtins,
      typeAliases: model.typeAliases,
      records: model.records,
      enums: model.enums,
      values: model.values,
      entities: model.entities,
      aggregates: model.aggregates,
      events: model.events,
      services: model.services,
    });
    expect(ir.irVersion).toBe(IR_VERSION);
  });

  it('normalizes absent optional collections (builtins/typeAliases/records) to []', () => {
    const bare: DomainModel = {
      context: 'Bare', enums: [], values: [], entities: [], aggregates: [], events: [], services: [],
    };
    const ir = toIR(bare);
    expect(ir.builtins).toEqual([]);
    expect(ir.typeAliases).toEqual([]);
    expect(ir.records).toEqual([]);
  });

  it('deep-clones — mutating the source model after the fact does not affect the IR', () => {
    const ir = toIR(model);
    const originalName = model.aggregates[0]!.name;
    model.aggregates[0]!.name = 'MUTATED';
    expect(ir.aggregates[0]!.name).toBe(originalName);
    model.aggregates[0]!.name = originalName;   // restore, since `model` is shared across tests
  });

  it('every TypeRef kind appears somewhere in the produced IR', () => {
    const ir = toIR(model);
    const kinds = new Set<string>();
    const walk = (v: unknown): void => {
      if (v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      const obj = v as Record<string, unknown>;
      if (typeof obj.kind === 'string') kinds.add(obj.kind);
      for (const val of Object.values(obj)) walk(val);
    };
    walk(ir);
    const expectedKinds = ['prim', 'enum', 'ref', 'list', 'value', 'optional', 'map', 'generic', 'union', 'carrier'];
    for (const k of expectedKinds) expect(kinds.has(k)).toBe(true);
  });

  it('is JSON-stable: JSON round-trip is a deep-equal no-op', () => {
    const ir = toIR(model);
    const roundTripped = JSON.parse(JSON.stringify(ir));
    expect(roundTripped).toEqual(ir);
  });
});
