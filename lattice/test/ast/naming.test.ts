import { describe, it, expect } from 'vitest';
import { toCamelName } from '../../src/ast/naming.js';

describe('toCamelName', () => {
  // Every pair here is a real rename a human had to perform by hand, via the `--rename`
  // confirmation ceremony, on the committed subscriptions session — because the agent authored
  // the name in Pascal_Snake_Case and nothing normalized it on the way in.
  it.each([
    ['TotalDue_At_Most_Parts', 'totalDueAtMostParts'],
    ['Never_Overpaid_And_Paid_Exact', 'neverOverpaidAndPaidExact'],
    ['One_Draft_Invoice_Per_Subscription', 'oneDraftInvoicePerSubscription'],
    ['Positive_Period_NonNegative_Usage', 'positivePeriodNonNegativeUsage'],
    ['Overage_Implies_Real_Allowance', 'overageImpliesRealAllowance'],
  ])('folds the elicited name %s onto the convention', (from, to) => {
    expect(toCamelName(from)).toBe(to);
  });

  it('preserves capitalization interior to a segment', () => {
    expect(toCamelName('NonNegative_Invoice_totalDue')).toBe('nonNegativeInvoiceTotalDue');
  });

  it('is idempotent — an already-conventional name is returned verbatim', () => {
    for (const n of ['totalDueAtMostParts', 'nonNegativeTotal', 'x'])
      expect(toCamelName(n)).toBe(n);
  });

  it('leaves a name with no underscore-joined segments alone', () => {
    expect(toCamelName('_')).toBe('_');
    expect(toCamelName('')).toBe('');
  });
});
