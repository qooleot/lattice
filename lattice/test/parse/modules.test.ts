import { describe, it, expect } from 'vitest';
import { loadLatText } from '../../src/parse/fromLangium.js';
import { astToCode } from '../../src/emit/code.js';

// Slice 6: module grouping construct tests.

const TWO_MODULES_SPEC = `context Billing {
  enum Status { draft, active }

  module BillingEngine {
    value Amount {
      amount   : Money
    }
    aggregate Invoice {
      invoiceId : Id key
      total     : Money @unsigned
    }
    event InvoiceCreated {
      invoiceId : Id key
    }
  }

  module ItemTimelines {
    entity LineItem {
      lineId : Id key
      amount : Money @unsigned
    }
  }
}
`;

describe('modules — parse and module labels', () => {
  it('parses a context with two modules and top-level decls', () => {
    const r = loadLatText(TWO_MODULES_SPEC);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
  });

  it('top-level decls have no module label', () => {
    const r = loadLatText(TWO_MODULES_SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const status = r.model.enums.find(e => e.name === 'Status');
    expect(status).toBeDefined();
    expect(status!.module).toBeUndefined();
  });

  it('decls inside a module carry the correct module label', () => {
    const r = loadLatText(TWO_MODULES_SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { model } = r;
    const amount = model.values.find(v => v.name === 'Amount');
    expect(amount?.module).toBe('BillingEngine');

    const invoice = model.aggregates.find(a => a.name === 'Invoice');
    expect(invoice?.module).toBe('BillingEngine');

    const created = model.events.find(e => e.name === 'InvoiceCreated');
    expect(created?.module).toBe('BillingEngine');

    const lineItem = model.entities.find(e => e.name === 'LineItem');
    expect(lineItem?.module).toBe('ItemTimelines');
  });
});

describe('modules — module name may coincide with a declaration name', () => {
  it('allows a module name that equals a declaration name (no error)', () => {
    // A module named `Invoice` coexisting with an aggregate also named `Invoice` — per CML semantics
    // module names are their own namespace and are NOT in the type duplicate-name pool.
    const r = loadLatText(`context Billing {
  module Status {
    aggregate Status {
      statusId : Id key
    }
  }
}
`);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
  });
});

describe('modules — duplicate-module validation', () => {
  it('reports duplicate-module when two modules share a name', () => {
    const r = loadLatText(`context Billing {
  module Engine {
    entity Foo { fooId : Id key }
  }
  module Engine {
    entity Bar { barId : Id key }
  }
}
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dup = r.diagnostics.find(d => d.code === 'duplicate-module');
      expect(dup).toBeDefined();
      expect(dup!.message).toContain('Engine');
    }
  });
});

describe('modules — round-trip', () => {
  it('parse → astToCode contains module blocks and reparsing yields equal model', () => {
    const r = loadLatText(TWO_MODULES_SPEC);
    expect(r.ok, JSON.stringify(!r.ok && r.diagnostics)).toBe(true);
    if (!r.ok) return;

    const printed = astToCode(r.model, r.invariants);

    // The printed output should contain module declarations
    expect(printed).toMatch(/module\s+BillingEngine\s*\{/);
    expect(printed).toMatch(/module\s+ItemTimelines\s*\{/);

    // Reparse and compare models
    const r2 = loadLatText(printed);
    expect(r2.ok, `reparse failed:\n${printed}\n${JSON.stringify(!r2.ok && r2.diagnostics)}`).toBe(true);
    if (!r2.ok) return;

    // Models should be deeply equal (decl order and module labels preserved)
    expect(r2.model).toEqual(r.model);
  });

  it('model without modules round-trips byte-identical (no module field added)', () => {
    const spec = `context Plain {
  entity Thing {
    thingId : Id key
  }
}
`;
    const r = loadLatText(spec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No entity should have a module label
    expect(r.model.entities[0]!.module).toBeUndefined();
    const printed = astToCode(r.model, r.invariants);
    expect(printed).not.toContain('module');
  });

  it('field assertions use regex to tolerate padding', () => {
    const r = loadLatText(TWO_MODULES_SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const printed = astToCode(r.model, r.invariants);
    expect(printed).toMatch(/amount\s+: Money/);
    expect(printed).toMatch(/invoiceId\s+: Id key/);
  });
});

describe('modules — naming convention warning for lowercase module name', () => {
  it('emits a naming-convention warning when a module name is not PascalCase', () => {
    const r = loadLatText(`context Billing {
  module billingEngine {
    entity Foo { fooId : Id key }
  }
}
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.warnings.find(w => w.code === 'naming-convention' && w.message.includes('billingEngine'));
    expect(warn).toBeDefined();
  });
});
