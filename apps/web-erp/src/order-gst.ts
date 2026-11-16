// GST ON THE ORDER BEING RAISED — fix batch 4b · D-041 · M06-FR-02 · P-07 · P-08.
//
// The walkthrough found "Raise an order" showed no GST and did not say whether "Agreed price per item" included it. The
// agreed price is BEFORE GST; this works out each line's GST at the rate the system already holds for the item (the store
// pack's `taxBps`, from the item's HSN / tax class) and the total with GST. A rate is never invented: an item with no rate
// held is named, and its GST is left out of the total, which then says so. Display only — the order is raised at the agreed
// price before GST, exactly as before. Pure.

export interface OrderLineValue {
  readonly productId: string;
  /** The line's value before GST, in paise. */
  readonly valueMinor: number;
}

export interface OrderGstLine extends OrderLineValue {
  /** The rate held for the item, in basis points (1800 = 18%), or undefined when none is held. */
  readonly taxBps: number | undefined;
  readonly gstMinor: number | undefined;
}

export interface OrderGstSummary {
  readonly lines: readonly OrderGstLine[];
  readonly beforeGstMinor: number;
  /** GST on the lines whose rate is held. */
  readonly gstMinor: number;
  readonly withGstMinor: number;
  /** Items whose GST rate is not held — their GST is NOT in `gstMinor` / `withGstMinor`. */
  readonly noRate: readonly string[];
}

/** One line's GST: value × rate, rounded to the nearest paisa once (half up). */
export const gstOn = (valueMinor: number, taxBps: number): number => Math.floor((valueMinor * taxBps) / 10_000 + 0.5);

export function orderGstSummary(lines: readonly OrderLineValue[], taxBpsOf: (productId: string) => number | undefined): OrderGstSummary {
  const out: OrderGstLine[] = [];
  const noRate: string[] = [];
  let before = 0;
  let gst = 0;
  for (const l of lines) {
    const raw = taxBpsOf(l.productId);
    const taxBps = Number.isInteger(raw) && (raw as number) >= 0 ? raw : undefined;
    const lineGst = taxBps === undefined ? undefined : gstOn(l.valueMinor, taxBps);
    before += l.valueMinor;
    if (lineGst === undefined) { if (!noRate.includes(l.productId)) noRate.push(l.productId); } else gst += lineGst;
    out.push({ ...l, taxBps, gstMinor: lineGst });
  }
  return { lines: out, beforeGstMinor: before, gstMinor: gst, withGstMinor: before + gst, noRate };
}

/** "18%", "5%", "0.25%" — a rate as a person reads it. */
export const ratePercent = (taxBps: number): string => `${(taxBps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
