// Proving what we owe against what the supplier says we owe — MG-06, OB-06, §34.
//
// The second external check after the shelves, and the one that is genuinely obtainable: **the
// supplier keeps their own ledger and will confirm it, because they want paying.** No goodwill is
// required and no vendor has to agree to anything.
//
// `packages/reconciliation` already matches provider settlement lines to POS tenders on an exact
// shared reference. This is a different problem and a harder one, because **the two ledgers have
// no shared key and were never meant to agree at a point in time.** They are kept by different
// people, closed on different days, and both are correct:
//
//     Their statement says we owe 8,40,000.
//     Our books say we owe 7,95,000.
//
//     Neither is wrong. We paid 45,000 on the 29th; they banked it on the 2nd.
//
// So the whole job is telling a **timing difference** from a **real difference**, and the
// distinction turns on one fact: *a timing difference clears by itself and a real one does not*.
// At migration there is usually only one statement, so clearance cannot be observed — and the
// honest thing is to say which items **cannot yet be told apart**, rather than to guess and
// present the guess as a reconciliation.
//
// Three rules this module will not bend:
//
//   • **THE DANGEROUS DIRECTION IS THEIRS, NOT OURS.** An invoice on their statement that is not
//     in our books is a liability we are about to migrate as **zero**. Overstating what we owe
//     gets caught by us; understating it gets caught by nobody until they chase, by which time
//     it is in the opening balance and the CA has signed it.
//   • **NOTHING IS NETTED.** *"They say we owe 45,000 more"* and *"we say we paid 45,000 they
//     have not applied"* may be the same event or two separate problems, and offsetting them
//     produces a clean zero that hides both. They are listed separately, always.
//   • **SIGNS ARE MIRRORED, DELIBERATELY.** Our payable is their receivable. A reconciliation
//     that gets this backwards agrees perfectly at twice the true figure, which is the same
//     failure as reading a `CR` as positive.
//
// Pure and deterministic: no I/O, no clock beyond the dates supplied.

/** One open item, from either side. Amounts are always POSITIVE in minor units; `kind` carries the direction. */
export interface LedgerItem {
  /** The supplier's own document number — the only key both sides plausibly carry. */
  readonly documentNumber: string;
  readonly kind: 'invoice' | 'credit_note' | 'payment';
  readonly amountMinor: number;
  readonly documentDate: string;
  readonly reference?: string;
}

/**
 * What an item does to the balance we owe.
 *
 * Written out rather than inferred from a sign on the amount, because a signed amount read from
 * a statement is exactly where the mirror-image mistake gets in.
 */
export const EFFECT_ON_WHAT_WE_OWE: Readonly<Record<LedgerItem['kind'], 1 | -1>> = {
  invoice: 1,
  credit_note: -1,
  payment: -1,
};

export const balanceOf = (items: readonly LedgerItem[]): number =>
  items.reduce((t, i) => t + i.amountMinor * EFFECT_ON_WHAT_WE_OWE[i.kind], 0);

export type ItemStatus =
  /** Both sides have it, at the same amount. */
  | 'agreed'
  /** Both sides have it, at different amounts — a real difference, never a timing one. */
  | 'amount_differs'
  /** Only we have it. Usually a payment they have not applied yet. */
  | 'only_in_our_books'
  /** Only they have it. **The dangerous one** — a liability we may be about to migrate as zero. */
  | 'only_on_their_statement';

/** Whether an item is young enough for timing to be a plausible explanation. */
export type TimingPlausibility = 'plausibly_timing' | 'too_old_for_timing' | 'not_applicable';

export interface ReconciledItem {
  readonly documentNumber: string;
  readonly status: ItemStatus;
  readonly kind: LedgerItem['kind'];
  readonly ourAmountMinor?: number;
  readonly theirAmountMinor?: number;
  /**
   * This item's contribution to `theirBalanceMinor - ourBalanceMinor`. **Positive means they say
   * we owe more than we do.** One convention for all four statuses, so the items sum to the
   * headline difference exactly — which is the check that catches a mirrored sign, because a
   * reconciliation that reads one side backwards balances at twice the true figure.
   */
  readonly differenceMinor: number;
  readonly documentDate: string;
  readonly timing: TimingPlausibility;
  readonly detail: string;
}

export interface SupplierReconciliation {
  readonly supplierId: string;
  readonly statementDate: string;
  readonly ourBalanceMinor: number;
  readonly theirBalanceMinor: number;
  readonly differenceMinor: number;
  readonly items: readonly ReconciledItem[];
  /** Explained by items young enough for timing — separately, never netted into one figure. */
  readonly plausiblyTimingMinor: number;
  /** Items too old for timing to explain. These are real, and they are the work. */
  readonly unexplainedMinor: number;
  /** The subset that could understate what we owe. Called out on its own, deliberately. */
  readonly understatementRiskMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
  readonly ownerAction: string;
}

/** Days between two ISO dates, without a clock or a timezone. */
function daysBetween(from: string, to: string): number {
  const parse = (d: string): number => {
    const [y = 0, m = 1, day = 1] = d.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, day) / 86_400_000;
  };
  return parse(to) - parse(from);
}

/**
 * Reconcile our open items against the supplier's statement.
 *
 * The output is deliberately **not a single difference figure**. A supplier reconciliation that
 * reports *"out by 45,000"* has answered the least useful question available: what a person needs
 * is which documents, on which side, and whether each is the kind of thing that clears by itself.
 */
export function reconcileSupplierStatement(input: {
  readonly supplierId: string;
  readonly statementDate: string;
  readonly ourItems: readonly LedgerItem[];
  readonly theirItems: readonly LedgerItem[];
  /** Within this many days of the statement date, timing is a plausible explanation. Default 15. */
  readonly timingWindowDays?: number;
}): SupplierReconciliation {
  const window = input.timingWindowDays ?? 15;
  const ours = new Map(input.ourItems.map((i) => [i.documentNumber, i]));
  const theirs = new Map(input.theirItems.map((i) => [i.documentNumber, i]));

  const items: ReconciledItem[] = [];
  const seen = new Set<string>();

  const timingOf = (date: string): TimingPlausibility =>
    daysBetween(date, input.statementDate) <= window ? 'plausibly_timing' : 'too_old_for_timing';

  for (const [documentNumber, our] of ours) {
    seen.add(documentNumber);
    const their = theirs.get(documentNumber);
    const effect = EFFECT_ON_WHAT_WE_OWE[our.kind];

    if (their === undefined) {
      const timing = timingOf(our.documentDate);
      items.push({
        documentNumber, status: 'only_in_our_books', kind: our.kind,
        ourAmountMinor: our.amountMinor,
        // Negated: this is what the item does to OUR balance, and the field is the contribution
        // to theirs minus ours. A payment only we have recorded makes them say we owe MORE.
        differenceMinor: -(our.amountMinor * effect),
        documentDate: our.documentDate, timing,
        detail: timing === 'plausibly_timing'
          ? `${our.kind} of ${our.amountMinor} dated ${our.documentDate}, not yet on their statement — within ${window} days, so a payment in transit or a credit they have not processed is the ordinary explanation`
          : `${our.kind} of ${our.amountMinor} dated ${our.documentDate}, still not on their statement after ${daysBetween(our.documentDate, input.statementDate)} days. Too old for timing: either they never received it, or they have applied it somewhere else`,
      });
      continue;
    }

    if (our.amountMinor === their.amountMinor) {
      items.push({
        documentNumber, status: 'agreed', kind: our.kind,
        ourAmountMinor: our.amountMinor, theirAmountMinor: their.amountMinor,
        differenceMinor: 0, documentDate: our.documentDate, timing: 'not_applicable',
        detail: `agreed at ${our.amountMinor}`,
      });
      continue;
    }

    items.push({
      documentNumber, status: 'amount_differs', kind: our.kind,
      ourAmountMinor: our.amountMinor, theirAmountMinor: their.amountMinor,
      differenceMinor: (their.amountMinor - our.amountMinor) * effect,
      documentDate: our.documentDate,
      // Never timing. Both sides have the document; they simply disagree about it.
      timing: 'not_applicable',
      detail: `we have ${our.amountMinor}, they have ${their.amountMinor}. Both sides hold this document, so this is not timing — it is a price, a quantity or a tax the two of us read differently, and it is settled by looking at the delivery note`,
    });
  }

  for (const [documentNumber, their] of theirs) {
    if (seen.has(documentNumber)) continue;
    const timing = timingOf(their.documentDate);
    const effect = EFFECT_ON_WHAT_WE_OWE[their.kind];
    items.push({
      documentNumber, status: 'only_on_their_statement', kind: their.kind,
      theirAmountMinor: their.amountMinor,
      differenceMinor: their.amountMinor * effect,
      documentDate: their.documentDate, timing,
      detail: their.kind === 'invoice'
        ? `an INVOICE of ${their.amountMinor} dated ${their.documentDate} that is not in our books at all${timing === 'plausibly_timing' ? ' — recent enough that it may simply be in the post' : `, and ${daysBetween(their.documentDate, input.statementDate)} days old, which is past any postal explanation`}. This is the dangerous direction: migrated as it stands, we open owing nothing for it, and nobody finds out until they chase`
        : `${their.kind} of ${their.amountMinor} on their statement and not in our books`,
    });
  }

  const ourBalanceMinor = balanceOf(input.ourItems);
  const theirBalanceMinor = balanceOf(input.theirItems);
  const differenceMinor = theirBalanceMinor - ourBalanceMinor;

  // Kept apart, never netted. "They say we owe 45,000 more" and "we say we paid 45,000 they have
  // not applied" may be the same event or two separate problems, and offsetting them produces a
  // clean zero that hides both.
  const plausiblyTimingMinor = items
    .filter((i) => i.timing === 'plausibly_timing')
    .reduce((t, i) => t + Math.abs(i.differenceMinor), 0);
  const unexplainedMinor = items
    .filter((i) => i.status !== 'agreed' && i.timing !== 'plausibly_timing')
    .reduce((t, i) => t + Math.abs(i.differenceMinor), 0);
  const understatementRiskMinor = items
    .filter((i) => i.status === 'only_on_their_statement' && i.kind === 'invoice')
    .reduce((t, i) => t + i.theirAmountMinor!, 0);

  const reconciles = differenceMinor === 0 && items.every((i) => i.status === 'agreed');

  return {
    supplierId: input.supplierId,
    statementDate: input.statementDate,
    ourBalanceMinor,
    theirBalanceMinor,
    differenceMinor,
    // Worst first, and the ones that could understate what we owe above the ones that could not.
    items: [...items].sort((a, b) => {
      const risk = (i: ReconciledItem): number => (i.status === 'only_on_their_statement' && i.kind === 'invoice' ? 1 : 0);
      return risk(b) - risk(a) || Math.abs(b.differenceMinor) - Math.abs(a.differenceMinor);
    }),
    plausiblyTimingMinor,
    unexplainedMinor,
    understatementRiskMinor,
    reconciles,
    detail: reconciles
      ? `${input.supplierId} agrees item for item at ${ourBalanceMinor}`
      : `${input.supplierId}: we say ${ourBalanceMinor}, they say ${theirBalanceMinor}. ${plausiblyTimingMinor} sits in items young enough for timing and ${unexplainedMinor} does not — reported separately, because netting them produces a clean zero that hides both`,
    ownerAction: understatementRiskMinor > 0
      ? `${understatementRiskMinor} of invoices are on their statement and not in our books. Migrated as they stand we open owing nothing for them — get copies from the supplier before the opening balance is signed. Overstating what we owe gets caught by us; understating it gets caught by nobody until they chase`
      : unexplainedMinor > 0
        ? `${unexplainedMinor} cannot be explained by timing. Each item is listed with its date — they are settled against the delivery notes, one at a time`
        : reconciles
          ? 'nothing — this supplier agrees with us item for item'
          : `the difference is entirely in items dated within ${window} days of the statement. Ask for a statement dated after they clear, and check the same items have gone`,
  };
}

export interface SupplierPosition {
  readonly reconciliations: readonly SupplierReconciliation[];
  readonly agreed: number;
  readonly withDifferences: number;
  readonly totalUnexplainedMinor: number;
  readonly totalUnderstatementRiskMinor: number;
  /** Suppliers who never sent a statement. Unverified — which is not the same as agreed. */
  readonly noStatementReceived: readonly string[];
  readonly sufficientToVerify: boolean;
  readonly detail: string;
}

/**
 * The position across every supplier.
 *
 * A supplier who never replied is listed **by name** as unverified, not quietly counted as
 * agreeing. Silence is the most common response to a statement request and the easiest to read
 * as consent — and the balance it leaves unproved goes into the opening books either way.
 */
export function supplierPosition(input: {
  readonly reconciliations: readonly SupplierReconciliation[];
  readonly suppliersAsked: readonly string[];
  /** Value at or below which an unexplained difference need not block. Per-tenant. */
  readonly toleranceMinor?: number;
}): SupplierPosition {
  const tolerance = input.toleranceMinor ?? 0;
  const replied = new Set(input.reconciliations.map((r) => r.supplierId));
  const noStatementReceived = input.suppliersAsked.filter((s) => !replied.has(s)).sort();

  const agreed = input.reconciliations.filter((r) => r.reconciles).length;
  const withDifferences = input.reconciliations.length - agreed;
  const totalUnexplainedMinor = input.reconciliations.reduce((t, r) => t + r.unexplainedMinor, 0);
  const totalUnderstatementRiskMinor = input.reconciliations.reduce((t, r) => t + r.understatementRiskMinor, 0);

  const sufficientToVerify = noStatementReceived.length === 0
    && totalUnderstatementRiskMinor === 0
    && totalUnexplainedMinor <= tolerance;

  return {
    reconciliations: input.reconciliations,
    agreed, withDifferences, totalUnexplainedMinor, totalUnderstatementRiskMinor,
    noStatementReceived, sufficientToVerify,
    detail: sufficientToVerify
      ? `all ${agreed} suppliers confirmed, with nothing unexplained — the payables in the opening books are the suppliers' own figures, not the old system's`
      : `${agreed} agreed, ${withDifferences} with differences, ${noStatementReceived.length} never replied. ${totalUnexplainedMinor} unexplained and ${totalUnderstatementRiskMinor} of invoices we may be about to open owing nothing for`,
    // Named, never counted. Silence is the commonest reply and the easiest to read as consent.
  };
}
