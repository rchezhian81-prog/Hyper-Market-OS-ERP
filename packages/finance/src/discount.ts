// Discount eligibility under CGST section 15(3) (roadmap v2.1 A11).
//
// Not every discount reduces the GST taxable value, and getting this wrong is a common, expensive
// error: charge tax on the discounted figure when the discount does NOT qualify, and the shop has
// under-declared output tax — a mismatch the recipient's GSTR-2B exposes. So this decides eligibility
// deterministically, and refuses to let a post-supply discount reduce the taxable value unless every
// statutory condition is met.
//
//   s.15(3)(a) — a discount given at or before the time of supply and recorded ON the tax invoice
//               reduces the taxable value (tax is charged on the net).
//   s.15(3)(b) — a discount AFTER supply reduces the taxable value ONLY IF all three hold together:
//               (i)  it was established in an agreement entered into before/at the time of supply,
//               (ii) it is linked to the specific invoices it relates to, AND
//               (iii)the recipient has reversed the proportionate input tax credit.
//
// Anything else is a commercial discount only: real money off the price, but the GST stays on the
// pre-discount value. Pure and deterministic — no storage, no I/O.

export type DiscountBasis = 'on_invoice' | 'post_supply_agreement' | 'not_eligible';

export interface DiscountEligibility {
  readonly discountMinor: number;
  /** True iff the discount reduces the GST taxable value under s.15(3). */
  readonly reducesTaxableValue: boolean;
  /** The amount that reduces the taxable value — the discount if eligible, otherwise 0. */
  readonly eligibleReductionMinor: number;
  readonly basis: DiscountBasis;
  readonly detail: string;
}

export class InvalidDiscountInput extends Error {
  constructor(detail: string) {
    super(`Cannot assess the discount: ${detail}`);
    this.name = 'InvalidDiscountInput';
  }
}

/**
 * Decide whether a discount reduces the GST taxable value (CGST s.15(3), A11).
 *
 * @throws InvalidDiscountInput if the discount is not a whole, non-negative amount of minor units.
 */
export function assessDiscountEligibility(input: {
  readonly discountMinor: number;
  /** Recorded on the tax invoice, given at/before the time of supply — s.15(3)(a). */
  readonly onInvoice: boolean;
  /** Established in an agreement entered into before/at the time of supply — s.15(3)(b)(i). */
  readonly preAgreed?: boolean;
  /** Linked to the specific invoices it relates to — s.15(3)(b)(ii). */
  readonly invoiceLinked?: boolean;
  /** The recipient has reversed the proportionate input tax credit — s.15(3)(b)(iii). */
  readonly itcReversed?: boolean;
}): DiscountEligibility {
  if (!Number.isInteger(input.discountMinor) || input.discountMinor < 0) {
    throw new InvalidDiscountInput('the discount must be a whole, non-negative amount of minor units');
  }

  const postSupplyQualifies =
    (input.preAgreed ?? false) && (input.invoiceLinked ?? false) && (input.itcReversed ?? false);
  const reduces = input.onInvoice || postSupplyQualifies;
  const basis: DiscountBasis = input.onInvoice
    ? 'on_invoice'
    : postSupplyQualifies
      ? 'post_supply_agreement'
      : 'not_eligible';

  const detail =
    basis === 'on_invoice'
      ? 'on the invoice at/before supply — reduces the taxable value (s.15(3)(a))'
      : basis === 'post_supply_agreement'
        ? 'post-supply, but pre-agreed, invoice-linked and the ITC is reversed — reduces the taxable value (s.15(3)(b))'
        : 'a commercial discount only — money off the price, but the GST stays on the pre-discount value (a post-supply discount reduces tax only when pre-agreed AND invoice-linked AND the ITC is reversed)';

  return {
    discountMinor: input.discountMinor,
    reducesTaxableValue: reduces,
    eligibleReductionMinor: reduces ? input.discountMinor : 0,
    basis,
    detail,
  };
}
