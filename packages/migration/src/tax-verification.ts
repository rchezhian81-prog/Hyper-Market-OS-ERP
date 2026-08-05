// Proving the migrated tax against the returns already filed — MG-06, OB-06, §34.
//
// The fourth external check, and the only one that runs **backwards**. Everywhere else in this
// migration we are testing whether the extracted figure is right. Here the filed return is
// already true as a matter of law: it was filed, dated, acknowledged and cannot be un-filed. So
// the question is not *"does the return agree with our books?"* but **"what do our books have to
// become, given the return?"** If the two disagree, it is the books that are wrong.
//
// That inversion is the whole value of this evidence. A report can be re-run until it agrees. A
// filed return cannot be adjusted to make a total come out, which is precisely why the department
// treats it as final and why the CA will ask for it first.
//
// What this module refuses, and why each refusal is load-bearing:
//
//   • **A RETURN WITHOUT AN ACKNOWLEDGEMENT IS NOT A FILED RETURN.** A spreadsheet named
//     `GSTR1_April.xlsx` is a working paper. The ARN is the only thing that distinguishes what was
//     *filed* from what somebody *prepared*, and the difference matters exactly when they differ —
//     which is the case this check exists to find. Same family as `extraction.ts` refusing a total
//     verified against the system that produced it.
//
//   • **A SLAB RATE IS NEVER INFERRED FROM A TOTAL.** A hypermarket sells at 0%, 5%, 12% and 18%
//     in the same basket. Multiply total sales by an average rate and the answer is close enough
//     to pass a glance, wrong on every single line, and **wrong in the one way the department
//     checks automatically** — GSTR-1 is reconciled rate-wise, not in total. So there is no API
//     here that accepts a total and a rate: the comparison is slab by slab or it does not happen.
//
//   • **A RETURN WHOSE OWN ARITHMETIC FAILS IS REFUSED, NOT HANDLED.** If the tax on a line does
//     not follow from its taxable value at its own declared rate, either the transcription is
//     wrong or the filed return is — and reconciling to it would spread the error through every
//     opening figure. `packages/settlement` refuses a provider file the same way.
//
//   • **AN AMENDED PERIOD IS RECONCILED TO THE AMENDMENT.** A GSTR-1 amendment in a later period
//     restates an earlier one. Reconciling to the superseded original produces a wrong answer
//     with a flawless audit trail behind it, which is the worst combination available.
//
// GSTR-1 against GSTR-3B is checked as well as each against the books, because **the department
// reconciles those two automatically** and a difference between them is a notice waiting to
// happen. If one is already there it is inherited, not created, by this migration — and the owner
// is told so in writing rather than discovering it later.
//
// Pure and deterministic: no I/O, no clock. Money is integer minor units (§29.1).

import { bpsOf } from './banking-verification';

export type ReturnKind = 'gstr1' | 'gstr3b';

/** One rate slab within a return or a set of books. Never a blended total. */
export interface TaxSlabLine {
  /** 0, 500 (5%), 1200 (12%), 1800 (18%) — basis points. */
  readonly rateBps: number;
  readonly taxableValueMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly cessMinor: number;
}

export interface FiledReturn {
  /** A whole tax period, `YYYY-MM`. A return covers a month; it cannot be cut at a cutover date. */
  readonly period: string;
  readonly kind: ReturnKind;
  readonly gstin: string;
  readonly filedOn: string;
  /**
   * The portal's acknowledgement reference.
   *
   * The one field that separates a filed return from a working paper, and therefore the one field
   * without which this evidence is not evidence.
   */
  readonly acknowledgementRef: string;
  readonly lines: readonly TaxSlabLine[];
  /** Set when a later period's return restated this one. */
  readonly amendedInPeriod?: string;
}

export type ReturnRefusal =
  | 'no_acknowledgement_reference'
  | 'not_a_whole_tax_period'
  | 'superseded_by_an_amendment'
  | 'tax_does_not_follow_from_the_slab'
  | 'both_igst_and_cgst_on_one_line'
  | 'no_lines';

export interface ReturnAcceptance {
  readonly ok: boolean;
  readonly refusedBecause?: ReturnRefusal;
  readonly detail: string;
}

const WHOLE_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The Indian GST slabs, in basis points: 0, 0.25, 3, 5, 12, 18 and 28 per cent.
 *
 * A default, not a constant of nature — slabs move at every budget, and this product serves more
 * than one shop in more than one tax regime (OB-05). Overridable per tenant.
 */
export const STATUTORY_SLABS_BPS: readonly number[] = [0, 25, 300, 500, 1_200, 1_800, 2_800];

export const taxOf = (line: TaxSlabLine): number =>
  line.cgstMinor + line.sgstMinor + line.igstMinor;

/**
 * Accept a return as evidence, or refuse it with a reason.
 *
 * A separate callable that runs before any comparison, so no figure is produced from a document
 * that should never have been used — the same shape as `assertNonProduction` and
 * `acceptRouteTerms`.
 */
export function acceptFiledReturn(
  ret: FiledReturn,
  /** Per-line allowance for the statutory rounding on each component. Default ₹1. */
  roundingAllowanceMinor = 100,
): ReturnAcceptance {
  if (ret.acknowledgementRef.trim() === '') {
    return {
      ok: false,
      refusedBecause: 'no_acknowledgement_reference',
      detail: `${ret.kind.toUpperCase()} for ${ret.period} has no acknowledgement reference. A spreadsheet named after a return is a working paper — the ARN is what makes it the thing that was actually filed, and the difference between prepared and filed is exactly what this check exists to find`,
    };
  }

  if (!WHOLE_PERIOD.test(ret.period)) {
    return {
      ok: false,
      refusedBecause: 'not_a_whole_tax_period',
      detail: `"${ret.period}" is not a whole tax period. A return covers a month and cannot be split at a cutover date — a part period reconciled against a whole return is short by design and looks like missing sales`,
    };
  }

  if (ret.amendedInPeriod !== undefined) {
    return {
      ok: false,
      refusedBecause: 'superseded_by_an_amendment',
      detail: `${ret.kind.toUpperCase()} for ${ret.period} was restated in ${ret.amendedInPeriod}. Reconciling to the superseded original gives a wrong answer with a flawless audit trail behind it — use the amended figures`,
    };
  }

  if (ret.lines.length === 0) {
    return {
      ok: false,
      refusedBecause: 'no_lines',
      detail: `${ret.kind.toUpperCase()} for ${ret.period} has no rate slabs. A nil return is a legitimate filing, but it must be recorded as a nil slab rather than as an absent one, so that "we sold nothing" is distinguishable from "nobody transcribed it"`,
    };
  }

  for (const line of ret.lines) {
    if (line.igstMinor > 0 && (line.cgstMinor > 0 || line.sgstMinor > 0)) {
      return {
        ok: false,
        refusedBecause: 'both_igst_and_cgst_on_one_line',
        detail: `the ${line.rateBps / 100}% slab carries both IGST and CGST/SGST. A supply is either inter-state or intra-state, never both, so this is a transcription fault and using it would double-count the tax`,
      };
    }

    // The return's own arithmetic, checked before it is used as the fixed point.
    const expected = bpsOf(line.taxableValueMinor, line.rateBps);
    if (Math.abs(taxOf(line) - expected) > roundingAllowanceMinor) {
      return {
        ok: false,
        refusedBecause: 'tax_does_not_follow_from_the_slab',
        detail: `the ${line.rateBps / 100}% slab declares ${line.taxableValueMinor} taxable and ${taxOf(line)} of tax, where the rate gives ${expected}. Either the transcription is wrong or the filed return is — and reconciling to it would spread the error through every opening figure`,
      };
    }
  }

  return {
    ok: true,
    detail: `${ret.kind.toUpperCase()} ${ret.period} accepted — filed ${ret.filedOn} under ${ret.acknowledgementRef}, and its own arithmetic holds slab by slab`,
  };
}

export type SlabStatus = 'agrees' | 'books_differ' | 'missing_from_the_return' | 'missing_from_the_books';

export interface SlabComparison {
  readonly rateBps: number;
  readonly status: SlabStatus;
  readonly returnTaxableMinor: number;
  readonly booksTaxableMinor: number;
  readonly returnTaxMinor: number;
  readonly booksTaxMinor: number;
  /** books − return. The books are what must move, so the sign points at the correction. */
  readonly taxableDifferenceMinor: number;
  readonly taxDifferenceMinor: number;
  readonly detail: string;
}

export interface TaxPeriodReconciliation {
  readonly period: string;
  readonly accepted: boolean;
  readonly refusedBecause?: ReturnRefusal | 'a_rate_that_is_not_a_slab';
  readonly slabs: readonly SlabComparison[];
  /** GSTR-1 total tax less GSTR-3B total tax. The department reconciles these two automatically. */
  readonly returnsDisagreeByMinor: number;
  readonly booksTaxMinor: number;
  readonly filedTaxMinor: number;
  /** filed − books: what the opening books must move by, and in which direction. */
  readonly booksMustMoveByMinor: number;
  /** A rate we traded at that never reached a return. Serious, and never a rounding matter. */
  readonly slabsNeverDeclared: readonly number[];
  /** True when the difference is not a data fix but something the CA has to be told. */
  readonly disclosureRequired: boolean;
  readonly reconciles: boolean;
  /**
   * Typed as the literal `false`: a return proves what was **declared**, never what was correctly
   * **charged**. Sell at 5% what should have been 12% and the books and the return agree exactly.
   */
  readonly provesTaxWasCorrectlyCharged: false;
  readonly detail: string;
  readonly ownerAction: string;
}

const sumTax = (lines: readonly TaxSlabLine[]): number =>
  lines.reduce((t, l) => t + taxOf(l), 0);

/**
 * Reconcile one tax period: the books against GSTR-1, and GSTR-1 against GSTR-3B.
 *
 * Slab by slab throughout. There is deliberately no entry point that accepts a total and a rate,
 * because the moment one exists somebody will reconcile a hypermarket's mixed basket at an average
 * rate and get a figure that is right in total and wrong on every line.
 */
export function reconcileTaxPeriod(input: {
  readonly period: string;
  readonly gstr1: FiledReturn;
  readonly gstr3b: FiledReturn;
  /** The migrated books for the same period, split by rate. A blended rate is refused. */
  readonly books: readonly TaxSlabLine[];
  /**
   * The rates this tenant may legally have traded at, in basis points.
   *
   * Configurable rather than fixed: slabs change by budget, and this product is not written for
   * one shop in one country (OB-05). Defaults to the Indian set.
   */
  readonly permittedSlabsBps?: readonly number[];
  /** Difference at or below which a slab need not block. Per-tenant; statutory rounding only. */
  readonly toleranceMinor?: number;
}): TaxPeriodReconciliation {
  const tolerance = input.toleranceMinor ?? 0;

  const empty = (
    detail: string,
    refusedBecause: ReturnRefusal | 'a_rate_that_is_not_a_slab',
  ): TaxPeriodReconciliation => ({
    period: input.period, accepted: false, refusedBecause, slabs: [],
    returnsDisagreeByMinor: 0, booksTaxMinor: 0, filedTaxMinor: 0, booksMustMoveByMinor: 0,
    slabsNeverDeclared: [], disclosureRequired: false, reconciles: false,
    provesTaxWasCorrectlyCharged: false, detail, ownerAction: detail,
  });

  for (const ret of [input.gstr1, input.gstr3b]) {
    const a = acceptFiledReturn(ret);
    if (!a.ok) return empty(a.detail, a.refusedBecause!);
  }

  // The books must arrive split by rate, and a blended rate announces itself: an average is not a
  // slab anybody could have charged. 11.4% is not a GST rate, so a line at 1,140 bps is proof that
  // a mixed basket was collapsed to one figure — right in total, wrong on every line, and wrong in
  // the one way the department checks automatically.
  const permitted = new Set(input.permittedSlabsBps ?? STATUTORY_SLABS_BPS);
  const blended = input.books.find((l) => !permitted.has(l.rateBps));
  if (blended !== undefined) {
    return empty(
      `the books carry a line at ${blended.rateBps / 100}%, which is not a rate anything could have been sold at. That is an average across a mixed basket, and GSTR-1 is reconciled rate-wise by the department — so a blended figure fails the only comparison that matters. Re-extract the sales split by tax rate`,
      'a_rate_that_is_not_a_slab',
    );
  }

  const byRate = new Map<number, { ret?: TaxSlabLine; books?: TaxSlabLine }>();
  for (const l of input.gstr1.lines) byRate.set(l.rateBps, { ...byRate.get(l.rateBps), ret: l });
  for (const l of input.books) byRate.set(l.rateBps, { ...byRate.get(l.rateBps), books: l });

  const slabs: SlabComparison[] = [];
  for (const rateBps of [...byRate.keys()].sort((a, b) => a - b)) {
    const { ret, books } = byRate.get(rateBps)!;
    const returnTaxableMinor = ret?.taxableValueMinor ?? 0;
    const booksTaxableMinor = books?.taxableValueMinor ?? 0;
    const returnTaxMinor = ret === undefined ? 0 : taxOf(ret);
    const booksTaxMinor = books === undefined ? 0 : taxOf(books);
    const taxDifferenceMinor = booksTaxMinor - returnTaxMinor;

    const status: SlabStatus = ret === undefined ? 'missing_from_the_return'
      : books === undefined ? 'missing_from_the_books'
        : Math.abs(taxDifferenceMinor) <= tolerance
          && Math.abs(booksTaxableMinor - returnTaxableMinor) <= tolerance ? 'agrees' : 'books_differ';

    slabs.push({
      rateBps, status, returnTaxableMinor, booksTaxableMinor, returnTaxMinor, booksTaxMinor,
      taxableDifferenceMinor: booksTaxableMinor - returnTaxableMinor,
      taxDifferenceMinor,
      detail: status === 'agrees'
        ? `${rateBps / 100}%: agrees at ${returnTaxMinor}`
        : status === 'missing_from_the_return'
          ? `${rateBps / 100}%: the books show ${booksTaxableMinor} of sales at this rate and the filed return declares this slab nowhere. Sales at a rate that was never declared is not a reconciliation difference — it is undeclared turnover`
          : status === 'missing_from_the_books'
            ? `${rateBps / 100}%: declared on the return at ${returnTaxableMinor} taxable and absent from the books. The return was filed; the extraction has lost this slab`
            : `${rateBps / 100}%: books ${booksTaxMinor} against ${returnTaxMinor} filed. The return cannot be changed, so the books move by ${returnTaxMinor - booksTaxMinor}`,
    });
  }

  const filedTaxMinor = sumTax(input.gstr1.lines);
  const booksTaxMinor = sumTax(input.books);
  const returnsDisagreeByMinor = filedTaxMinor - sumTax(input.gstr3b.lines);
  const slabsNeverDeclared = slabs.filter((s) => s.status === 'missing_from_the_return').map((s) => s.rateBps);

  const reconciles = slabs.every((s) => s.status === 'agrees') && Math.abs(returnsDisagreeByMinor) <= tolerance;
  // A difference against a filed return is never a private data fix. Somebody signed that return.
  const disclosureRequired = !reconciles;

  return {
    period: input.period,
    accepted: true,
    slabs,
    returnsDisagreeByMinor,
    booksTaxMinor,
    filedTaxMinor,
    booksMustMoveByMinor: filedTaxMinor - booksTaxMinor,
    slabsNeverDeclared,
    disclosureRequired,
    reconciles,
    provesTaxWasCorrectlyCharged: false,
    detail: reconciles
      ? `${input.period}: the books agree with GSTR-1 slab by slab at ${filedTaxMinor}, and GSTR-1 agrees with GSTR-3B`
      : `${input.period}: filed ${filedTaxMinor}, books ${booksTaxMinor}. ${slabs.filter((s) => s.status !== 'agrees').length} slab(s) differ${returnsDisagreeByMinor === 0 ? '' : `, and GSTR-1 and GSTR-3B are themselves ${Math.abs(returnsDisagreeByMinor)} apart`}`,
    ownerAction: slabsNeverDeclared.length > 0
      ? `the books show sales at ${slabsNeverDeclared.map((r) => `${r / 100}%`).join(', ')} that no filed return declares. That is not a reconciliation difference and it is not ours to correct quietly — take it to the CA before the opening books are signed`
      : returnsDisagreeByMinor !== 0
        ? `GSTR-1 and GSTR-3B for ${input.period} disagree by ${Math.abs(returnsDisagreeByMinor)} between themselves. The department reconciles these two automatically, so this is a notice waiting to happen — and it is inherited, not created by the migration. The CA should see it either way`
        : reconciles
          ? 'nothing — the filed returns confirm the tax figures'
          : `the books must move by ${filedTaxMinor - booksTaxMinor} to meet what was filed. The return is dated, acknowledged and cannot be adjusted, so where the two disagree it is the books that are wrong`,
  };
}

export interface TaxPosition {
  readonly periods: readonly TaxPeriodReconciliation[];
  /** Periods we hold no filed return for. Unverified — which is not the same as agreeing. */
  readonly periodsWithNoReturn: readonly string[];
  readonly totalBooksMustMoveByMinor: number;
  readonly disclosuresRequired: readonly string[];
  readonly sufficientToVerify: boolean;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * The position across every period being migrated.
 *
 * A period with no filed return in hand is named, never skipped. A gap in the middle of a
 * reconciled run is the period somebody could not make agree, and it is invisible unless the
 * expected periods are stated in advance rather than derived from the returns that turned up.
 */
export function taxPosition(input: {
  readonly reconciliations: readonly TaxPeriodReconciliation[];
  /** Every period the migration covers, listed up front. */
  readonly periodsExpected: readonly string[];
  readonly toleranceMinor?: number;
}): TaxPosition {
  const tolerance = input.toleranceMinor ?? 0;
  const held = new Set(input.reconciliations.filter((r) => r.accepted).map((r) => r.period));
  const periodsWithNoReturn = input.periodsExpected.filter((p) => !held.has(p)).sort();

  const totalBooksMustMoveByMinor = input.reconciliations
    .reduce((t, r) => t + r.booksMustMoveByMinor, 0);
  const disclosuresRequired = input.reconciliations
    .filter((r) => r.disclosureRequired).map((r) => r.period).sort();

  const sufficientToVerify = periodsWithNoReturn.length === 0
    && disclosuresRequired.length === 0
    && Math.abs(totalBooksMustMoveByMinor) <= tolerance;

  return {
    periods: input.reconciliations,
    periodsWithNoReturn,
    totalBooksMustMoveByMinor,
    disclosuresRequired,
    sufficientToVerify,
    detail: sufficientToVerify
      ? `all ${input.periodsExpected.length} periods reconcile to the returns as filed — the tax in the opening books is what was actually declared to the department`
      : `${disclosuresRequired.length} period(s) do not reconcile, ${periodsWithNoReturn.length} have no filed return in hand, and the books move by ${totalBooksMustMoveByMinor} in total`,
    ownerAction: periodsWithNoReturn.length > 0
      ? `no filed return in hand for ${periodsWithNoReturn.join(', ')}. Download them from the GST portal — they are yours, they are already filed, and nobody has to agree to give them to you`
      : disclosuresRequired.length > 0
        ? `${disclosuresRequired.join(', ')} do not reconcile to what was filed. Every one goes to the CA in writing before the opening balance is signed — a difference against a return somebody has already signed is not ours to correct quietly`
        : 'nothing — every period ties to the return that was filed for it',
  };
}
