// The return register (M13-FR-01) — **the producer that made the at-most-once rule real.**
//
// `commitReturn` has enforced *a line is returned at most once* since the day it was written, and
// it enforces it against `alreadyReturnedMinor`, which the caller supplies. Nothing in this system
// supplied it. Outside one unit test the field was never set, so every return was judged against
// **nothing already returned** — and the same receipt could be refunded today, again tomorrow, and
// again the day after, each one passing a rule written specifically to stop it.
//
// It is the same shape as the uncounted shelf and the blank shrinkage report, in the place where it
// costs money directly: a control described, tested, and fed by nobody.
//
// ── Why it aggregates by product rather than by line number ─────────────────
//
// A bill can carry the same product on two lines — two separate scans of the same tin, a price
// override applied to one of them. Matching a return to a *line index* then depends on which of
// the two the person at the desk happens to pick, and returning "line 2" twice while "line 1" is
// untouched would pass. Aggregating by product against the whole bill cannot be gamed that way:
// what may come back is what was sold of that product on that bill, however it was rung.
//
// ── What it is projected from ───────────────────────────────────────────────
//
// The box's own durable return log, plus whatever history the cloud pack carried. **Both, not
// either.** The cloud alone would leave the guard blind exactly when the line is down, which is
// when a shop is least supervised; the box alone would miss a return taken at another branch or
// before this box was installed. Where they overlap, the same return id counts once.
//
// Pure and deterministic: no clock, no I/O.

/** One line of a return, as it was recorded. */
export interface ReturnedLine {
  readonly productId: string;
  readonly uom: string;
  /** Magnitude, in the UOM's smallest unit. Always positive — direction is not this field's job. */
  readonly quantityMinor: number;
}

/** A return that has happened, from this box's log or from the cloud's history. */
export interface RecordedReturn {
  readonly returnId: string;
  /** The bill it came off. `null` for a no-receipt return, which is against no bill by definition. */
  readonly originalSaleId: string | null;
  readonly processedAt: string;
  readonly lines: readonly ReturnedLine[];
}

/** One line of the original bill, as it was sold. */
export interface SoldLine {
  readonly productId: string;
  readonly uom: string;
  readonly quantityMinor: number;
}

/** An original bill, as this box recorded it. */
export interface OriginalSale {
  readonly saleId: string;
  readonly number: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly totalMinor: number;
  readonly lines: readonly SoldLine[];
  /**
   * How it was paid. A refund goes back to the original tender where it can (M13-FR-03).
   *
   * **Absent when the record did not carry it** — which is different from having been paid by
   * nothing, and means the desk cannot offer "back to the original tender" for this bill.
   */
  readonly tenders?: readonly { readonly kind: string; readonly amountMinor: number }[];
}

/** What may still come back on one line of a bill. */
export interface ReturnableLine {
  readonly productId: string;
  readonly uom: string;
  readonly soldMinor: number;
  readonly alreadyReturnedMinor: number;
  /** What may still be returned. Never negative — see `returnableLines`. */
  readonly returnableMinor: number;
}

/**
 * How much of each product has already come back against each bill.
 *
 * Keyed by sale id, then by product id. A no-receipt return is against no bill and so contributes
 * to nothing here — it is capped a different way, by value, because there is no line to count
 * against (M13-FR-01).
 *
 * **The same return id counts once**, however many sources carried it. The box's log and the
 * cloud's history overlap by design, and double-counting an overlap would refuse a second,
 * legitimate return of a different unit — a customer turned away at the desk over a bookkeeping
 * artefact, which is the failure people remember.
 */
export function returnRegister(
  returns: readonly RecordedReturn[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const seen = new Set<string>();
  const bySale = new Map<string, Map<string, number>>();

  for (const record of returns) {
    if (record.originalSaleId === null) continue;
    if (seen.has(record.returnId)) continue;
    seen.add(record.returnId);

    const forSale = bySale.get(record.originalSaleId) ?? new Map<string, number>();
    for (const line of record.lines) {
      forSale.set(line.productId, (forSale.get(line.productId) ?? 0) + Math.abs(line.quantityMinor));
    }
    bySale.set(record.originalSaleId, forSale);
  }
  return bySale;
}

/**
 * What may still be returned against one bill.
 *
 * Lines carrying the same product are **summed into one entry**, for the reason at the top of this
 * file: the rule is about the product on the bill, not about which of two identical scans somebody
 * points at.
 *
 * `returnableMinor` is clamped at nought. A negative would mean more has come back than went out,
 * which is a real thing to investigate — see `overReturned` — but it is not an amount anybody may
 * be handed at the desk, and a negative arriving at `commitReturn` would be arithmetic nobody
 * could explain.
 */
export function returnableLines(
  sale: OriginalSale,
  register: ReadonlyMap<string, ReadonlyMap<string, number>>,
): readonly ReturnableLine[] {
  const returned = register.get(sale.saleId);
  const sold = new Map<string, { uom: string; quantityMinor: number }>();
  for (const line of sale.lines) {
    const held = sold.get(line.productId);
    sold.set(line.productId, {
      uom: held?.uom ?? line.uom,
      quantityMinor: (held?.quantityMinor ?? 0) + line.quantityMinor,
    });
  }

  return [...sold.entries()].map(([productId, line]) => {
    const already = returned?.get(productId) ?? 0;
    return {
      productId,
      uom: line.uom,
      soldMinor: line.quantityMinor,
      alreadyReturnedMinor: already,
      returnableMinor: Math.max(0, line.quantityMinor - already),
    };
  });
}

/**
 * Products where **more has come back than went out** on a bill.
 *
 * This should be impossible and is therefore worth surfacing rather than clamping away: it means
 * either a return was recorded against the wrong bill, or the same goods were refunded twice
 * before this register existed. Both are money, and both are things a person has to look at.
 */
export function overReturned(
  sale: OriginalSale,
  register: ReadonlyMap<string, ReadonlyMap<string, number>>,
): readonly { readonly productId: string; readonly soldMinor: number; readonly returnedMinor: number }[] {
  const found: { productId: string; soldMinor: number; returnedMinor: number }[] = [];
  for (const line of returnableLines(sale, register)) {
    if (line.alreadyReturnedMinor > line.soldMinor) {
      found.push({
        productId: line.productId,
        soldMinor: line.soldMinor,
        returnedMinor: line.alreadyReturnedMinor,
      });
    }
  }
  return found;
}

/**
 * What has already been refunded in value against a bill, so a second refund cannot exceed what is
 * left of it (M13-FR-03: *a refund cannot exceed the original paid amount*).
 *
 * Separate from the line register on purpose. The line rule stops the same **goods** coming back
 * twice; this stops the same **money** going out twice, and a partial refund of a discounted bill
 * can breach the second without breaching the first.
 */
export function alreadyRefundedMinor(
  saleId: string,
  refunds: readonly { readonly returnId: string; readonly originalSaleId: string | null; readonly refundMinor: number }[],
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const refund of refunds) {
    if (refund.originalSaleId !== saleId) continue;
    if (seen.has(refund.returnId)) continue;
    seen.add(refund.returnId);
    total += Math.abs(refund.refundMinor);
  }
  return total;
}
