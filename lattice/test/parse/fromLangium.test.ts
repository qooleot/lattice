import { describe, it, expect } from 'vitest';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { ownedCollectionChild } from '../../src/ast/domain.js';
import type { AggregateDef } from '../../src/ast/domain.js';

const SPEC = `/// Top doc
context Demo {
  ticksPerDay = 24
  enum Mode { fast, slow }
  /// Entity doc
  entity Plan {
    planId : Id key
    fee    : Money
    bonus  : Money @signed
    mode   : Mode
  }
  /// Event doc
  event kicked { reason : Text }
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
    invariant oneGoing { unique while run in {going} by (plan) }
  }
  invariant planMode on Plan where fee >= 1 { mode == Mode.fast || ! (fee + 1 <= 3) }
}
`;

describe('loadLatText', () => {
  const r = loadLatText(SPEC);
  it('maps the model', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { model } = r;
    expect(model.context).toBe('Demo');
    expect(model.doc).toBe('Top doc');
    expect(model.ticksPerDay).toBe(24);
    expect(model.enums).toEqual([{ name: 'Mode', values: ['fast', 'slow'] }]);
    expect(model.entities[0]!.doc).toBe('Entity doc');
    expect(model.entities[0]!.fields[1]).toEqual({ name: 'fee', type: { kind: 'prim', prim: 'Money' } });
    expect(model.entities[0]!.fields[2]!.tags).toEqual(['signed']);
    expect(model.events).toEqual([{ name: 'kicked', doc: 'Event doc',
      fields: [{ name: 'reason', type: { kind: 'prim', prim: 'Text' } }] }]);
    const job = model.aggregates[0]!;
    expect(job.machine!.regions[0]).toEqual({ name: 'run', initial: 'queued', states: [
      { name: 'queued' }, { name: 'going', tags: ['active'] }, { name: 'done', tags: ['terminal'] }] });
    expect(job.machine!.transitions[0]).toEqual({ name: 'start', region: 'run', from: ['queued'], to: 'going', when: 'kicked' });
  });

  it('maps invariants with docs, owners, bodies', () => {
    if (!r.ok) throw new Error('parse failed');
    const [unitsSane, oneGoing, planMode] = r.invariants;
    expect(unitsSane!.name).toBe('unitsSane');
    expect(unitsSane!.doc).toBe('Units stay sane.');
    expect(unitsSane!.id).toBe('hand-unitsSane');
    expect(unitsSane!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Job',
      body: { kind: 'and', args: [
        { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 0 } },
        { kind: 'implies',
          left: { kind: 'inState', owner: 'self', region: 'run', states: ['going'] },
          right: { kind: 'cmp', op: 'le', left: { kind: 'field', owner: 'self', path: ['units'] }, right: { kind: 'int', value: 100 } } }] } });
    expect(oneGoing!.candidate).toEqual({ kind: 'unique', aggregate: 'Job',
      whileStates: { region: 'run', states: ['going'] }, by: [['plan']] });
    expect(planMode!.candidate).toEqual({ kind: 'statePredicate', aggregate: 'Plan',
      where: { kind: 'cmp', op: 'ge', left: { kind: 'field', owner: 'self', path: ['fee'] }, right: { kind: 'int', value: 1 } },
      body: { kind: 'or', args: [
        { kind: 'cmp', op: 'eq', left: { kind: 'field', owner: 'self', path: ['mode'] }, right: { kind: 'enumval', enum: 'Mode', value: 'fast' } },
        { kind: 'not', arg: { kind: 'cmp', op: 'le',
          left: { kind: 'plus', left: { kind: 'field', owner: 'self', path: ['fee'] }, right: { kind: 'int', value: 1 } },
          right: { kind: 'int', value: 3 } } }] } });
  });

  it('drops explicit duplicates of implied invariants with a warning', () => {
    const dup = loadLatText(`context C { aggregate A { aId : Id key
      lifecycle r { states { s @initial, t @terminal } transition x { from s to t } }
      invariant stays { terminal r.t } } }`);
    expect(dup.ok).toBe(true);
    if (dup.ok) {
      expect(dup.invariants).toHaveLength(0);
      expect(dup.warnings.some(w => w.code === 'redundant-invariant')).toBe(true);
    }
  });

  it('closed grammar: unknown paths/states are structured diagnostics, not crashes', () => {
    const bad = loadLatText('context C { aggregate A { aId : Id key\n invariant x { nosuch >= 0 } } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const d = bad.diagnostics.find(d => d.code === 'unknown-path')!;
      // validateCandidate's sub-expression path rides along in the message
      expect(d.message).toContain('(at body)');
    }
  });

  it('missing on-target at context level is a diagnostic', () => {
    const bad = loadLatText('context C { entity E { eId : Id key }\n invariant x { 1 <= 1 } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'missing-target')).toBe(true);
  });

  it('ill-formed model (two @initial) is a diagnostic', () => {
    const bad = loadLatText(`context C { aggregate A { aId : Id key
      lifecycle r { states { s @initial, t @initial } transition x { from s to t } } } }`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'multiple-initial')).toBe(true);
  });

  it('warns on naming convention violations without failing, at the declaring line', () => {
    const r2 = loadLatText('context C {\n  entity Plan {\n    plan_id : Id key\n  }\n}');
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      const w = r2.warnings.find(w => w.code === 'naming-convention')!;
      expect(w.message).toContain('plan_id');
      expect(w.line).toBe(3);
    }
  });

  it('validateModel diagnostics carry the dotted path in the message', () => {
    const bad = loadLatText('context C { entity E { eId : Id key\n  broken : ref Nowhere } }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'unresolved-ref' && d.message.includes('E.broken'))).toBe(true);
  });

  it('does not drop a real cmp invariant on an aggregate with implied Money rules', () => {
    const r2 = loadLatText(`context C { aggregate Inv { invId : Id key
      total : Money
      fee   : Money
      invariant totalAtMostFee { total <= fee + 1 } } }`);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.invariants.map(i => i.name)).toEqual(['totalAtMostFee']);
      expect(r2.warnings.some(w => w.code === 'redundant-invariant')).toBe(false);
    }
  });

  it('parses lifecycle blocks into Machine regions + region-tagged transitions', () => {
    const r = loadLatText(`context C {
  aggregate Invoice {
    invoiceId : Id key
    lifecycle settlement {
      states { draft @initial, open @active, paid @terminal }
      transition finalize { from draft to open }
      transition close { from draft, open to paid }
    }
  }
}`);
    expect(r.ok).toBe(true);
    const m = (r as any).model;
    expect(m.aggregates[0].machine.regions[0]).toMatchObject({ name: 'settlement', initial: 'draft' });
    expect(m.aggregates[0].machine.transitions).toEqual([
      { name: 'finalize', region: 'settlement', from: ['draft'], to: 'open' },
      { name: 'close', region: 'settlement', from: ['draft', 'open'], to: 'paid' },
    ]);
  });
});

describe('qualified cross-context refs', () => {
  const SPEC = `context Shop {
  entity Customer {
    id : Id key
  }
  aggregate Order {
    orderId : Id key
    plan    : ref Catalog.Plan
    who     : ref Customer
  }
}
`;
  it('parses a qualified ref target into TypeRef.target verbatim', () => {
    const r = loadLatText(SPEC);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const f = r.model.aggregates[0]!.fields.find(f => f.name === 'plan')!;
    expect(f.type).toEqual({ kind: 'ref', target: 'Catalog.Plan' });
  });
  it('rejects a malformed qualified target (three segments) at parse time', () => {
    const r = loadLatText(SPEC.replace('Catalog.Plan', 'A.B.C'));
    expect(r.ok).toBe(false);
  });
});

describe('nested entities in aggregates', () => {
  const SPEC = `context Billing {
  aggregate Invoice {
    invoiceId : Id key
    lines     : List<InvoiceLine>

    entity InvoiceLine {
      lineId : Id key
      amount : Money
    }
  }
}
`;
  it('maps a nested entity into AggregateDef.entities and classifies the owned collection', () => {
    const r = loadLatText(SPEC);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const a = r.model.aggregates[0] as AggregateDef;
    expect(a.entities).toEqual([{ kind: 'entity', name: 'InvoiceLine',
      fields: [{ name: 'lineId', type: { kind: 'prim', prim: 'Id' }, key: true },
        { name: 'amount', type: { kind: 'prim', prim: 'Money' } }] }]);
    const linesField = a.fields.find(f => f.name === 'lines')!;
    expect(linesField.type).toEqual({ kind: 'list', of: { kind: 'ref', target: 'InvoiceLine' } });
    expect(ownedCollectionChild(a, linesField)?.name).toBe('InvoiceLine');
  });

  it('a bare NamedType naming a nested entity resolves to ref, not enum', () => {
    // mapType's fallback treats any unknown NamedType as an unresolved enum UNLESS the name is
    // in the pre-pass owners set; a nested entity name must land in that set even when it's
    // referenced (via List<...>) before/without an explicit `ref` keyword.
    const r = loadLatText(SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.model.aggregates[0] as AggregateDef;
    const linesField = a.fields.find(f => f.name === 'lines')!;
    expect(linesField.type.kind).toBe('list');
    expect((linesField.type as any).of).toEqual({ kind: 'ref', target: 'InvoiceLine' });
  });

  it('rejects an unkeyed nested entity (missing-key)', () => {
    const bad = loadLatText(SPEC.replace('lineId : Id key', 'lineId : Id'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'missing-key')).toBe(true);
  });

  it('rejects a ref/list field inside a nested entity (nested-entity-flat)', () => {
    const bad = loadLatText(SPEC.replace('amount : Money', 'amount : Money\n      bad : ref Invoice'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'nested-entity-flat')).toBe(true);
  });

  it('round-trips a nested entity through astToCode', async () => {
    const { astToCode } = await import('../../src/emit/code.js');
    const r = loadLatText(SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const printed = astToCode(r.model, []);
    const reparsed = loadLatText(printed);
    expect(reparsed.ok, JSON.stringify(!reparsed.ok && reparsed.diagnostics)).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.model.aggregates[0]!.entities).toEqual(r.model.aggregates[0]!.entities);
  });
});

describe('value objects', () => {
  const SPEC = `context Billing {
  value Period {
    start : Date
    end   : Date

    invariant wellOrdered { start < end }
  }

  aggregate Lease {
    leaseId : Id key
    term    : Period
  }
}
`;
  it('maps a value declaration into DomainModel.values, including its own-field invariant', () => {
    const r = loadLatText(SPEC);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;
    expect(r.model.values).toEqual([{ kind: 'value', name: 'Period',
      fields: [
        { name: 'start', type: { kind: 'prim', prim: 'Date' } },
        { name: 'end', type: { kind: 'prim', prim: 'Date' } }],
      invariants: [{ name: 'wellOrdered',
        body: { kind: 'cmp', op: 'lt',
          left: { kind: 'field', owner: 'self', path: ['start'] },
          right: { kind: 'field', owner: 'self', path: ['end'] } } }] }]);
  });

  it('a field typed with a declared value name maps to TypeRef kind value', () => {
    const r = loadLatText(SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lease = r.model.aggregates[0] as AggregateDef;
    const term = lease.fields.find(f => f.name === 'term')!;
    expect(term.type).toEqual({ kind: 'value', value: 'Period' });
  });

  it('rejects `on`/`where` on a value invariant (value-invariant-plain)', () => {
    const bad = loadLatText(SPEC.replace(
      'invariant wellOrdered { start < end }',
      'invariant wellOrdered where start < end { start < end }'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some(d => d.code === 'value-invariant-plain')).toBe(true);
  });

  it('round-trips a value declaration through astToCode', async () => {
    const { astToCode } = await import('../../src/emit/code.js');
    const r = loadLatText(SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const printed = astToCode(r.model, r.invariants);
    const reparsed = loadLatText(printed);
    expect(reparsed.ok, JSON.stringify(!reparsed.ok && reparsed.diagnostics)).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.model.values).toEqual(r.model.values);
  });
});
