// Three-way match: purchase order ↔ goods receipt ↔ supplier invoice (M07-FR-04),
// with landed cost (D03-FR-05).
//
// This is the control that stops the shop paying for goods it never got, at a
// price it never agreed. The rule the roadmap sets is blunt and this module keeps
// it blunt: **no payment on an unmatched or out-of-tolerance invoice without an
// approval** — and the approver is never the person who received the goods (§28).
//
// Every variance is VALUED and OWNED. "The invoice doesn't tie up" is not an
// outcome anyone can act on; "₹1,240 over-charged on 3 lines, needs the buyer"
// is (P-03 / P-08).
//
// Landed cost is what the stock is really worth on the shelf: the invoice price
// plus freight, duty and other charges apportioned across the lines by value, to
// the paisa, with no rounding remainder left behind (§29.1). Valuation that
// ignores freight understates cost and overstates margin — the shop then thinks
// it is making money it is not.
//
// Pure and deterministic — no clock, no I/O.

import { allocateByRatios, type Money } from '../../contracts/src/money';

export interface OrderedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly quantityMinor: number;
  /** Agreed unit cost on the purchase order. */
  readonly unitCost: Money;
}

export interface ReceivedLine {
  readonly lineId: string;
  readonly productId: string;
  /** What was actually accepted into stock (quarantine and rejects excluded). */
  readonly quantityMinor: number;
}

export interface InvoicedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly quantityMinor: number;
  readonly unitCost: Money;
  /** Tax charged on the line, as invoiced. */
  readonly taxMinor?: number;
}

/** Charges that belong to the goods but are not on any one line (D03-FR-05). */
export interface LandedCharges {
  readonly freight?: Money;
  readonly duty?: Money;
  readonly other?: Money;
}

/** Tolerances — per tenant, chosen, never hard-coded. */
export interface MatchPolicy {
  /** Price above the PO accepted without approval, in basis points. */
  readonly priceToleranceBp: number;
  /** Quantity difference accepted without approval, in basis points. */
  readonly quantityToleranceBp: number;
  /** Absolute value below which a variance is not worth anyone's time. */
  readonly immaterialMinor: number;
}

export type VarianceKind =
  | 'price_over'
  | 'price_under'
  | 'quantity_over_invoiced'
  | 'quantity_under_invoiced'
  | 'not_on_order'
  | 'not_received'
  | 'tax_unexpected';

export interface MatchVariance {
  readonly lineId: string;
  readonly productId: string;
  readonly kind: VarianceKind;
  /** What the difference is worth — signed: positive means we are being over-charged. */
  readonly value: Money;
  readonly withinTolerance: boolean;
  readonly detail: string;
}

export type MatchOutcome = 'matched' | 'variance_within_tolerance' | 'blocked_pending_approval';

export interface LandedCostLine {
  readonly lineId: string;
  readonly productId: string;
  readonly quantityMinor: number;
  /** Invoice value of the line before apportioned charges. */
  readonly goodsValue: Money;
  /** This line's share of freight/duty/other. */
  readonly apportionedCharges: Money;
  /** goodsValue + apportionedCharges — what the stock actually cost. */
  readonly landedValue: Money;
}

export interface MatchResult {
  readonly invoiceId: string;
  readonly outcome: MatchOutcome;
  /** True only when it is safe to pay without a further human decision. */
  readonly payable: boolean;
  readonly variances: readonly MatchVariance[];
  /** Net over-charge (positive) or under-charge (negative) across all lines. */
  readonly netVariance: Money;
  readonly landedCost: readonly LandedCostLine[];
  /** Why it is blocked, in plain English — empty when payable. */
  readonly blockedReason: string;
}

/** Raised when an approval is offered for an invoice it does not cover. */
export class InvalidMatchApprovalError extends Error {
  constructor(public readonly invoiceId: string) {
    super(`The approval provided does not authorise invoice "${invoiceId}"`);
    this.name = 'InvalidMatchApprovalError';
  }
}

export interface MatchApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
}

const BP = 10_000;

function m(minor: number, currency: Money['currency']): Money {
  return { minor, currency };
}

/**
 * Apportion freight/duty/other across the lines by goods value, exactly — the
 * remainder is distributed rather than dropped, so the parts always sum to the
 * whole (§29.1).
 */
function apportion(
  charges: number,
  goodsValues: readonly number[],
  currency: Money['currency'],
): Money[] {
  if (charges === 0 || goodsValues.length === 0) {
    return goodsValues.map(() => m(0, currency));
  }
  const total = goodsValues.reduce((s, v) => s + v, 0);
  if (total === 0) {
    // Nothing to weight by — split evenly rather than losing the charge.
    return allocateByRatios(m(charges, currency), goodsValues.map(() => 1));
  }
  return allocateByRatios(m(charges, currency), goodsValues.slice());
}

/**
 * Match a supplier invoice against the purchase order and the goods receipt,
 * value every variance, compute landed cost, and decide whether it may be paid.
 *
 * An out-of-tolerance variance blocks payment until someone with the authority —
 * and who did not receive the goods — approves it (§28).
 */
export function matchInvoice(input: {
  readonly invoiceId: string;
  readonly ordered: readonly OrderedLine[];
  readonly received: readonly ReceivedLine[];
  readonly invoiced: readonly InvoicedLine[];
  readonly charges?: LandedCharges;
  readonly policy: MatchPolicy;
  readonly currency: Money['currency'];
  /** Who booked the goods in — never the person who may approve the variance. */
  readonly receivedBy: string;
  readonly approval?: MatchApproval;
}): MatchResult {
  const orderedBy = new Map(input.ordered.map((l) => [l.lineId, l]));
  const receivedBy = new Map(input.received.map((l) => [l.lineId, l]));
  const variances: MatchVariance[] = [];

  const raise = (
    line: { lineId: string; productId: string },
    kind: VarianceKind,
    valueMinor: number,
    detail: string,
    tolerated: boolean,
  ): void => {
    variances.push({
      lineId: line.lineId,
      productId: line.productId,
      kind,
      value: m(valueMinor, input.currency),
      withinTolerance: tolerated || Math.abs(valueMinor) < input.policy.immaterialMinor,
      detail,
    });
  };

  for (const line of input.invoiced) {
    const order = orderedBy.get(line.lineId);
    const receipt = receivedBy.get(line.lineId);

    if (!order) {
      raise(
        line,
        'not_on_order',
        line.unitCost.minor * line.quantityMinor,
        'invoiced but never ordered — nothing authorises this charge',
        false,
      );
      continue;
    }
    if (!receipt || receipt.quantityMinor === 0) {
      raise(
        line,
        'not_received',
        line.unitCost.minor * line.quantityMinor,
        'invoiced but never received — do not pay for goods that did not arrive',
        false,
      );
      continue;
    }

    // Price: compare what we are charged against what we agreed.
    const priceDelta = line.unitCost.minor - order.unitCost.minor;
    if (priceDelta !== 0) {
      const bp = order.unitCost.minor === 0 ? BP : Math.round((Math.abs(priceDelta) * BP) / order.unitCost.minor);
      const tolerated = priceDelta < 0 || bp <= input.policy.priceToleranceBp;
      raise(
        line,
        priceDelta > 0 ? 'price_over' : 'price_under',
        priceDelta * line.quantityMinor,
        priceDelta > 0
          ? `charged above the agreed cost (${bp} bp over the purchase order)`
          : `charged below the agreed cost (${bp} bp under) — check the credit is real`,
        tolerated,
      );
    }

    // Quantity: never pay for more than was actually accepted into stock.
    const qtyDelta = line.quantityMinor - receipt.quantityMinor;
    if (qtyDelta !== 0) {
      const bp =
        receipt.quantityMinor === 0 ? BP : Math.round((Math.abs(qtyDelta) * BP) / receipt.quantityMinor);
      const tolerated = qtyDelta < 0 || bp <= input.policy.quantityToleranceBp;
      raise(
        line,
        qtyDelta > 0 ? 'quantity_over_invoiced' : 'quantity_under_invoiced',
        qtyDelta * line.unitCost.minor,
        qtyDelta > 0
          ? `invoiced ${qtyDelta} more than was received into stock`
          : `invoiced ${-qtyDelta} fewer than received — a further invoice may follow`,
        tolerated,
      );
    }
  }

  // Received but not invoiced at all: not a payment risk, but the buyer must know
  // an invoice is still coming, or the period will close understating the cost.
  for (const receipt of input.received) {
    if (receipt.quantityMinor === 0) continue;
    if (input.invoiced.some((l) => l.lineId === receipt.lineId)) continue;
    const order = orderedBy.get(receipt.lineId);
    raise(
      receipt,
      'quantity_under_invoiced',
      -(order?.unitCost.minor ?? 0) * receipt.quantityMinor,
      'received but not on this invoice — an invoice is still outstanding',
      true,
    );
  }

  // --- landed cost ------------------------------------------------------------
  const goodsValues = input.invoiced.map((l) => l.unitCost.minor * l.quantityMinor);
  const chargeTotal =
    (input.charges?.freight?.minor ?? 0) +
    (input.charges?.duty?.minor ?? 0) +
    (input.charges?.other?.minor ?? 0);
  const shares = apportion(chargeTotal, goodsValues, input.currency);
  const landedCost: LandedCostLine[] = input.invoiced.map((line, i) => {
    const goods = goodsValues[i] ?? 0;
    const share = shares[i]?.minor ?? 0;
    return {
      lineId: line.lineId,
      productId: line.productId,
      quantityMinor: line.quantityMinor,
      goodsValue: m(goods, input.currency),
      apportionedCharges: m(share, input.currency),
      landedValue: m(goods + share, input.currency),
    };
  });

  // --- decision ---------------------------------------------------------------
  const blocking = variances.filter((v) => !v.withinTolerance);
  const netVariance = m(
    variances.reduce((sum, v) => sum + v.value.minor, 0),
    input.currency,
  );

  if (blocking.length === 0) {
    return {
      invoiceId: input.invoiceId,
      outcome: variances.length === 0 ? 'matched' : 'variance_within_tolerance',
      payable: true,
      variances,
      netVariance,
      landedCost,
      blockedReason: '',
    };
  }

  const approval = input.approval;
  if (approval !== undefined && approval.subjectRef !== input.invoiceId) {
    throw new InvalidMatchApprovalError(input.invoiceId);
  }
  const approved =
    approval !== undefined &&
    approval.status === 'approved' &&
    approval.decidedBy !== input.receivedBy; // the receiver never clears their own receipt (§28)

  if (approved) {
    return {
      invoiceId: input.invoiceId,
      outcome: 'variance_within_tolerance',
      payable: true,
      variances,
      netVariance,
      landedCost,
      blockedReason: '',
    };
  }

  const worst = blocking.reduce((a, b) => (Math.abs(b.value.minor) > Math.abs(a.value.minor) ? b : a));
  return {
    invoiceId: input.invoiceId,
    outcome: 'blocked_pending_approval',
    payable: false,
    variances,
    netVariance,
    landedCost,
    blockedReason:
      approval !== undefined && approval.decidedBy === input.receivedBy
        ? 'the person who received the goods cannot approve the variance on them (§28)'
        : `${blocking.length} variance(s) beyond tolerance, the largest being ${worst.detail} — needs approval before payment`,
  };
}
