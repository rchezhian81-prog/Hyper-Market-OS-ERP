// Goods-in capture (M07-FR-02) and discrepancy handling (M07-FR-03).
//
// This is the back door of the shop, where most of the money is actually lost —
// not at the till. A short delivery nobody counted, a batch received with no
// expiry, an MRP that quietly differs from the master, damaged stock put on the
// shelf: each is a real loss that the paperwork hides. So the receipt is checked
// BEFORE it becomes stock, and anything that does not add up becomes a visible,
// valued, owned exception (P-03 / P-08) instead of a silent write-off later.
//
// What this module refuses to let through:
//   • a batch-tracked item with no batch or no expiry — you cannot trace or
//     recall what you cannot identify (M10);
//   • already-expired stock — it never enters as sellable;
//   • damaged or QC-failed stock counted as good — it goes to QUARANTINE, which
//     is deliberately not available to sell (M08 status / M07-FR-03);
//   • an excess beyond tolerance accepted without an approval above the
//     receiver's authority (§28).
//
// Everything is capturable offline (§31); approvals that need a second person
// resolve on sync — the receipt itself is never blocked on the network.
//
// Pure and deterministic: no clock, no I/O. Money is exact minor units (§29.1).

import type { Money } from '../../contracts/src/money';

/** Where received stock lands. Quarantine is deliberately NOT sellable. */
export type ReceiptDisposition = 'sellable' | 'quarantine' | 'rejected';

/** The condition the receiver actually found the goods in. */
export type GoodsCondition = 'good' | 'damaged' | 'temperature_breach';

/** The QC verdict, where the item or the tenant's policy requires one. */
export type QcStatus = 'not_required' | 'passed' | 'failed';

/** What the product master says about a line — supplied, not assumed. */
export interface ProductReceiptRules {
  readonly productId: string;
  /** Batch-tracked items cannot be received without a batch and an expiry (M10). */
  readonly batchTracked: boolean;
  /** MRP on the master; a different MRP on the delivery is flagged for review. */
  readonly mrp?: Money;
  /** Cold-chain items need temperature evidence at receipt (D05-FR-04). */
  readonly coldChain?: boolean;
}

/** One line as counted at the dock. */
export interface CapturedLine {
  readonly lineId: string;
  readonly productId: string;
  /** What the purchase order expects, in the UOM's smallest unit. */
  readonly orderedMinor: number;
  /** What was actually counted — the number that matters. */
  readonly countedMinor: number;
  readonly uom: string;
  readonly batchId?: string | null;
  /** ISO-8601 date (YYYY-MM-DD) — mandatory for batch-tracked items. */
  readonly expiry?: string | null;
  /** MRP printed on the delivered goods. */
  readonly mrp?: Money;
  /** Cost per unit as delivered — feeds landed cost (FR-04) and valuation (M08). */
  readonly unitCost: Money;
  readonly condition: GoodsCondition;
  readonly qc?: QcStatus;
  /** Recorded temperature, where cold-chain evidence is required. */
  readonly temperatureC?: number;
}

/** Tolerances and thresholds — per tenant, chosen, never hard-coded. */
export interface ReceiptPolicy {
  /** Excess above the ordered quantity accepted without approval, in basis points. */
  readonly excessToleranceBp: number;
  /** A shortage at or above this many basis points is a discrepancy worth raising. */
  readonly shortageToleranceBp: number;
  /** Stock expiring within this many days is flagged at receipt. */
  readonly nearExpiryDays: number;
  /** Cold-chain acceptance range, in °C. */
  readonly coldChainMaxC?: number;
}

export type DiscrepancyKind =
  | 'short'
  | 'excess'
  | 'damaged'
  | 'qc_failed'
  | 'expired'
  | 'near_expiry'
  | 'mrp_mismatch'
  | 'temperature_breach';

/** A visible, valued, owned exception — never a silent adjustment (P-03/P-08). */
export interface ReceiptDiscrepancy {
  readonly lineId: string;
  readonly productId: string;
  readonly kind: DiscrepancyKind;
  /** Quantity affected, in the UOM's smallest unit. */
  readonly quantityMinor: number;
  /** What it is worth — an exception with no value cannot be prioritised. */
  readonly value: Money;
  /** True when it cannot be accepted without a second person (§28). */
  readonly requiresApproval: boolean;
  /** Plain English, for the person who has to act on it. */
  readonly detail: string;
}

/** A line that could not be received at all — the capture is refused. */
export class IncompleteCaptureError extends Error {
  constructor(
    public readonly lineId: string,
    public readonly missing: string,
  ) {
    super(`Line "${lineId}" cannot be received without ${missing}`);
    this.name = 'IncompleteCaptureError';
  }
}

/** The outcome for one line after checking. */
export interface CheckedLine {
  readonly lineId: string;
  readonly productId: string;
  /** Quantity that becomes available to sell. */
  readonly sellableMinor: number;
  /** Quantity held back — present, counted, but not sellable. */
  readonly quarantinedMinor: number;
  /** Quantity refused outright (returned to the supplier / claimed). */
  readonly rejectedMinor: number;
  readonly disposition: ReceiptDisposition;
  readonly uom: string;
  readonly batchId: string | null;
  readonly expiry: string | null;
}

export interface CapturedReceipt {
  readonly receiptId: string;
  readonly lines: readonly CheckedLine[];
  readonly discrepancies: readonly ReceiptDiscrepancy[];
  /** True when at least one discrepancy needs a second person's approval (§28). */
  readonly requiresApproval: boolean;
  /** Total value of everything that did not arrive as ordered. */
  readonly discrepancyValue: Money;
}

const BP = 10_000;

function valueOf(unitCost: Money, quantityMinor: number): Money {
  return { minor: unitCost.minor * quantityMinor, currency: unitCost.currency };
}

function daysUntil(date: string, asOfDate: string): number {
  return Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${asOfDate}T00:00:00Z`)) / 86_400_000);
}

/**
 * Check a delivery line by line and decide what may be sold, what is held in
 * quarantine and what is refused — raising a valued discrepancy for everything
 * that differs from the order.
 *
 * `receivedOnDate` is the trading date (YYYY-MM-DD), passed in: no clock here.
 */
export function captureReceipt(input: {
  readonly receiptId: string;
  readonly lines: readonly CapturedLine[];
  readonly rules: readonly ProductReceiptRules[];
  readonly policy: ReceiptPolicy;
  readonly receivedOnDate: string;
  readonly currency: Money['currency'];
}): CapturedReceipt {
  const ruleFor = new Map(input.rules.map((r) => [r.productId, r]));
  const discrepancies: ReceiptDiscrepancy[] = [];
  const lines: CheckedLine[] = [];

  for (const line of input.lines) {
    const rule = ruleFor.get(line.productId);
    if (!rule) {
      throw new IncompleteCaptureError(line.lineId, 'the product master rules for it');
    }
    if (line.countedMinor < 0) {
      throw new IncompleteCaptureError(line.lineId, 'a count that is not negative');
    }

    // Traceability is not optional: an unidentified batch cannot be recalled (M10).
    if (rule.batchTracked) {
      if (line.batchId === undefined || line.batchId === null || line.batchId.trim() === '') {
        throw new IncompleteCaptureError(line.lineId, 'a batch number (the item is batch-tracked)');
      }
      if (line.expiry === undefined || line.expiry === null || line.expiry.trim() === '') {
        throw new IncompleteCaptureError(line.lineId, 'an expiry date (the item is batch-tracked)');
      }
    }
    if (rule.coldChain === true && line.temperatureC === undefined) {
      throw new IncompleteCaptureError(line.lineId, 'a recorded temperature (cold-chain item)');
    }

    const raise = (
      kind: DiscrepancyKind,
      quantityMinor: number,
      requiresApproval: boolean,
      detail: string,
    ): void => {
      discrepancies.push({
        lineId: line.lineId,
        productId: line.productId,
        kind,
        quantityMinor,
        value: valueOf(line.unitCost, quantityMinor),
        requiresApproval,
        detail,
      });
    };

    // --- quantity against the order -------------------------------------------
    const delta = line.countedMinor - line.orderedMinor;
    if (delta < 0) {
      const shortBp = line.orderedMinor === 0 ? BP : Math.round((-delta * BP) / line.orderedMinor);
      if (shortBp >= input.policy.shortageToleranceBp) {
        raise(
          'short',
          -delta,
          false,
          `${-delta} ${line.uom} short of the ${line.orderedMinor} ordered — claim or credit note due from the supplier`,
        );
      }
    } else if (delta > 0) {
      const excessBp = line.orderedMinor === 0 ? BP : Math.round((delta * BP) / line.orderedMinor);
      const overTolerance = excessBp > input.policy.excessToleranceBp;
      raise(
        'excess',
        delta,
        overTolerance,
        overTolerance
          ? `${delta} ${line.uom} more than ordered — beyond tolerance, needs approval before it is accepted`
          : `${delta} ${line.uom} more than ordered — within tolerance`,
      );
    }

    // --- condition, QC and expiry ---------------------------------------------
    let sellable = line.countedMinor;
    let quarantined = 0;
    let rejected = 0;

    const expiry = line.expiry ?? null;
    const expired = expiry !== null && daysUntil(expiry, input.receivedOnDate) <= 0;
    if (expired) {
      rejected = line.countedMinor;
      sellable = 0;
      raise('expired', line.countedMinor, true, `expired on ${expiry} — refused, never received as sellable`);
    } else if (line.condition === 'damaged') {
      quarantined = line.countedMinor;
      sellable = 0;
      raise('damaged', line.countedMinor, true, 'received damaged — quarantined, not available to sell');
    } else if (line.qc === 'failed') {
      quarantined = line.countedMinor;
      sellable = 0;
      raise('qc_failed', line.countedMinor, true, 'failed quality check — quarantined pending disposition');
    } else if (line.condition === 'temperature_breach') {
      quarantined = line.countedMinor;
      sellable = 0;
      raise('temperature_breach', line.countedMinor, true, 'cold chain broken in transit — quarantined');
    } else if (
      rule.coldChain === true &&
      input.policy.coldChainMaxC !== undefined &&
      line.temperatureC !== undefined &&
      line.temperatureC > input.policy.coldChainMaxC
    ) {
      quarantined = line.countedMinor;
      sellable = 0;
      raise(
        'temperature_breach',
        line.countedMinor,
        true,
        `arrived at ${line.temperatureC}°C, above the ${input.policy.coldChainMaxC}°C limit — quarantined`,
      );
    } else if (expiry !== null && daysUntil(expiry, input.receivedOnDate) <= input.policy.nearExpiryDays) {
      // Still sellable, but the buyer must see it now, not when it is dead stock.
      raise(
        'near_expiry',
        line.countedMinor,
        false,
        `expires on ${expiry}, within ${input.policy.nearExpiryDays} days of receipt — sell down or refuse`,
      );
    }

    // --- MRP against the master ------------------------------------------------
    if (rule.mrp !== undefined && line.mrp !== undefined && line.mrp.minor !== rule.mrp.minor) {
      raise(
        'mrp_mismatch',
        line.countedMinor,
        false,
        `delivered MRP differs from the master — review before it reaches the shelf`,
      );
    }

    lines.push({
      lineId: line.lineId,
      productId: line.productId,
      sellableMinor: sellable,
      quarantinedMinor: quarantined,
      rejectedMinor: rejected,
      disposition: rejected > 0 ? 'rejected' : quarantined > 0 ? 'quarantine' : 'sellable',
      uom: line.uom,
      batchId: line.batchId ?? null,
      expiry,
    });
  }

  return {
    receiptId: input.receiptId,
    lines,
    discrepancies,
    requiresApproval: discrepancies.some((d) => d.requiresApproval),
    discrepancyValue: {
      minor: discrepancies.reduce((sum, d) => sum + Math.abs(d.value.minor), 0),
      currency: input.currency,
    },
  };
}

/** Quantity that actually becomes available to sell — quarantine never counts. */
export function availableFromReceipt(receipt: CapturedReceipt): number {
  return receipt.lines.reduce((sum, l) => sum + l.sellableMinor, 0);
}
