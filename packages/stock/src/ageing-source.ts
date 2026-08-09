// Stock ageing source (M08-FR-04) — turns the append-only movement ledger into the CURRENT
// remaining stock, aged by receipt date and valued at weighted-average cost.
//
// The ageing report answers "how long has the money been asleep, and how much of it". That needs two
// things the ledger holds but does not state directly: which physical units are STILL on hand (issues
// have to be drawn down against receipts), and when each remaining unit arrived. This engine folds
// both out, then hands `StockLot[]` to the `stockAgeing` presenter (`metrics.ts`), which buckets them.
//
// Two conventions, and why each is the only honest one given the owner's weighted-average policy:
//
//   • **Physical draw-down is FIFO by receipt date.** An issue (a sale, a wastage, a transfer out)
//     takes the OLDEST stock first, so the remaining stock skews newer — the standard ageing
//     assumption. A return / transfer-in / positive count re-enters as a lot dated when it came back,
//     because that is when that money went back to sleep.
//   • **Value is the weighted-average pool spread across the remaining units.** The owner chose to
//     value stock at weighted-average, which is a POOL: value is not attributable to a physical unit,
//     so every on-hand unit carries the same average value and each lot's value is its share of the
//     product's WAC stock value. This makes the ageing total reconcile EXACTLY to the valuation's
//     stock value — two reports about one shelf that cannot disagree — rather than valuing lots at
//     their own receipt cost, which would contradict the chosen method. Stock received WITHOUT a cost
//     has no purchase price of its own, so its QUANTITY is reported as `unvalued` to make the gap
//     visible (P-08); the value that IS known is what gets apportioned, never a made-up cost.
//
// Pure and deterministic — no clock, no I/O. Exact integer minor units throughout.

import { weightedAverageValuation, share, type ValuationMovement } from './valuation';
import type { StockLot } from './metrics';
import type { Money } from '../../contracts/src/money';

/** A movement to age: the valuation fields plus WHEN it happened and its batch. */
export interface DatedMovement extends ValuationMovement {
  /** ISO-8601 timestamp; the date part (YYYY-MM-DD) is the receipt date the stock is aged from. */
  readonly occurredAt: string;
  readonly batchId?: string | null;
}

export interface AgeingSource {
  /** Current remaining stock as lots, each valued at its share of the WAC stock value. */
  readonly lots: readonly StockLot[];
  /** On-hand quantity received WITHOUT a cost — not in any lot's value, surfaced not hidden (P-08). */
  readonly unvaluedMinor: number;
}

interface Lot {
  receivedOn: string;
  qty: number;
  batchId: string | null;
}

const keyOf = (m: { productId: string; locationId: string }): string => `${m.productId}\u001f${m.locationId}`;
const sumQty = (q: readonly Lot[]): number => q.reduce((s, l) => s + l.qty, 0);

/**
 * Fold the movement ledger into current, WAC-valued, receipt-dated stock lots.
 *
 * The valuation (value, on-hand, unvalued) is computed by the SAME engine the valuation report uses,
 * so the two reconcile by construction: the lots' total value equals the WAC stock value, and the
 * lots' total quantity equals on-hand.
 */
export function agedStockLots(
  movements: readonly DatedMovement[],
  currency: Money['currency'],
): AgeingSource {
  // Fold once, in occurrence order — weighted average and FIFO draw-down are both sequence-dependent.
  const inOrder = [...movements].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  // 1. Authoritative weighted-average pool figures per product+location.
  const valuations = weightedAverageValuation(
    inOrder.map((m): ValuationMovement => ({
      productId: m.productId, locationId: m.locationId, effect: m.effect,
      quantityMinor: m.quantityMinor, isPurchaseReceipt: m.isPurchaseReceipt,
      ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }),
    })),
    currency,
  );
  const pool = new Map<string, { productId: string; value: number; onHand: number; unvalued: number }>();
  for (const v of valuations) {
    pool.set(keyOf(v), { productId: v.productId, value: v.value.minor, onHand: v.onHandMinor, unvalued: v.unvaluedMinor });
  }

  // 2. FIFO receipt-date lot queues, drawn down by each issue in occurrence order.
  const queues = new Map<string, Lot[]>();
  for (const m of inOrder) {
    const q = queues.get(keyOf(m)) ?? [];
    if (m.effect === 1) {
      q.push({ receivedOn: m.occurredAt.slice(0, 10), qty: m.quantityMinor, batchId: m.batchId ?? null });
    } else {
      let remaining = m.quantityMinor;
      while (remaining > 0 && q.length > 0) {
        const front = q[0]!;
        if (front.qty > remaining) { front.qty -= remaining; remaining = 0; } else { remaining -= front.qty; q.shift(); }
      }
      // Any leftover is an overdraw the ledger recorded — negative stock, an M08 exception reported
      // elsewhere; there is nothing on the shelf to age for it.
    }
    queues.set(keyOf(m), q);
  }

  // 3. Value each remaining lot at its share of the WAC stock value.
  const lots: StockLot[] = [];
  let unvaluedMinor = 0;
  for (const [key, q] of queues) {
    const p = pool.get(key);
    if (p === undefined) continue;
    unvaluedMinor += p.unvalued;
    if (p.onHand <= 0 || q.length === 0) continue;

    // Out-of-order issues can leave the queue holding more than is really on hand (an issue that
    // arrived before its receipt drew nothing). On-hand from the valuation is authoritative, so trim
    // the excess off the OLDEST lots — those are the ones the overdraw consumed.
    let excess = sumQty(q) - p.onHand;
    while (excess > 0 && q.length > 0) {
      const front = q[0]!;
      if (front.qty > excess) { front.qty -= excess; excess = 0; } else { excess -= front.qty; q.shift(); }
    }

    // Spread the WAC value across the remaining lots by quantity, carrying the exact remainder forward
    // so the last lot takes it — the lots' total value is then EXACTLY the WAC stock value.
    let remValue = p.value;
    let remQty = p.onHand;
    q.forEach((lot, i) => {
      const value = i === q.length - 1 ? remValue : share(remValue, lot.qty, remQty);
      remValue -= value;
      remQty -= lot.qty;
      lots.push({
        productId: p.productId, batchId: lot.batchId,
        quantityMinor: lot.qty, receivedOn: lot.receivedOn,
        value: { minor: value, currency },
      });
    });
  }
  return { lots, unvaluedMinor };
}
