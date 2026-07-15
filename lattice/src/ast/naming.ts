/**
 * Fold an identifier onto the camelCase convention (spec P8): underscore-joined segments are
 * concatenated, the first segment lowercased at its head, the rest capitalized at theirs.
 * Capitalization interior to a segment survives, so `NonNegative_Invoice_totalDue` folds to
 * `nonNegativeInvoiceTotalDue` rather than flattening to `nonnegativeinvoicetotaldue`.
 *
 * Applied where CANDIDATE INVARIANT names are authored: cli.ts's `propose`, for agent-submitted
 * candidates on their way into the session, and templates.ts's `matchTemplates`, for
 * template-matched invariant names on their way out. Not every machine-authored name folds —
 * cli.ts's `guardCandidateInvariant` mints `guard_<transition>_<shape>` unfolded, and that
 * underscore form is what reaches the ledger and `explain --name`. Never applied to hand-written
 * `.lat` text — there the convention stays a warning, because the identifier is the author's and
 * rewriting it would overstep. See docs/language/naming-conventions.md.
 */
export function toCamelName(n: string): string {
  const segs = n.split('_').filter(s => s.length > 0);
  if (!segs.length) return n;
  const [head, ...rest] = segs;
  return head!.charAt(0).toLowerCase() + head!.slice(1)
    + rest.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}
