// Allocate a bill-level discount across the lines it applied to (M05 promotions · M23 tax). A basket
// promotion (buy-3-pay-2, ₹50 off ₹500, a coupon) is computed as ONE figure for the whole basket, but a
// tax invoice and the GST return are per line: each line's taxable value must reflect its share of that
// discount, or the tax filed is too high and the line totals do not add up to what the customer paid.
//
// The rule the law and the arithmetic both want (CGST s.15(3): a discount known at supply reduces the
// taxable value): split the discount **in proportion to each line's value**, in whole paise, so the parts
// sum to the discount EXACTLY. Any rounding remainder is handed out a paisa at a time to the lines with the
// largest fractional shares (largest-remainder apportionment) — deterministic, and never more than a line
// is worth (a line total can never go negative). Pure and deterministic; integer maths throughout.

export class InvalidDiscountAllocation extends Error {
  constructor(detail: string) {
    super(`Cannot allocate the discount: ${detail}`);
    this.name = 'InvalidDiscountAllocation';
  }
}

/**
 * Split `discountMinor` across `lineTotalsMinor` in proportion to each line's total, in whole minor units,
 * so the returned shares sum to `discountMinor` exactly and no share exceeds its line's total. Returns all
 * zeros when there is no discount (or nothing to discount).
 *
 * @throws InvalidDiscountAllocation if a line total is not a whole non-negative number, the discount is not
 *   a whole non-negative number, or the discount exceeds the basket total (a discount cannot be larger than
 *   the thing it discounts — that is a pricing error upstream, surfaced not silently clamped).
 */
export function allocateDiscount(lineTotalsMinor: readonly number[], discountMinor: number): number[] {
  for (const t of lineTotalsMinor) {
    if (!Number.isInteger(t) || t < 0) throw new InvalidDiscountAllocation('each line total must be a whole non-negative number of minor units');
  }
  if (!Number.isInteger(discountMinor) || discountMinor < 0) throw new InvalidDiscountAllocation('the discount must be a whole non-negative number of minor units');
  const sum = lineTotalsMinor.reduce((a, b) => a + b, 0);
  if (discountMinor > sum) throw new InvalidDiscountAllocation(`the discount (${discountMinor}) cannot exceed the basket total (${sum})`);
  if (discountMinor === 0 || sum === 0) return lineTotalsMinor.map(() => 0);

  // Floor each line's exact share, then distribute the leftover paise to the largest fractional remainders.
  const shares: number[] = new Array(lineTotalsMinor.length);
  const remainders: { index: number; rem: number }[] = [];
  let allocated = 0;
  for (let i = 0; i < lineTotalsMinor.length; i += 1) {
    const numerator = discountMinor * lineTotalsMinor[i]!; // exact integer share × sum
    const floor = Math.floor(numerator / sum);
    shares[i] = floor;
    allocated += floor;
    remainders.push({ index: i, rem: numerator - floor * sum }); // 0 .. sum-1
  }
  const leftover = discountMinor - allocated; // 0 .. lineCount-1
  remainders.sort((a, b) => b.rem - a.rem || a.index - b.index); // largest remainder first, stable by index
  for (let k = 0; k < leftover; k += 1) {
    shares[remainders[k]!.index]! += 1;
  }
  return shares;
}
