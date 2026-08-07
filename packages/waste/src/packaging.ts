// Carry bags, reusable packaging and packaging stock (M28-FR-03 / M12 / M05 / P-01).
//
// Two small things that go wrong constantly in Indian retail, and one legal one.
//
// The legal one first: a carry bag charge is a **priced line on the bill**, GST and all, not
// a rounding adjustment or an amount quietly added to the total. Charging for a bag without
// showing it is a consumer-protection complaint that the shop will lose, and it costs the
// shop nothing to show it properly.
//
//   • **A BAG CHARGE IS A LINE, ALWAYS VISIBLE, AND NEVER APPLIED WITHOUT ONE.** If the
//     tenant has not enabled it, there is no charge — not a zero-value line, no charge.
//   • **THE CHARGE WORKS OFFLINE** (hard rule #1). Bag policy is part of the price pack the
//     lane already holds; a till with no internet still bills a bag correctly.
//   • **A REUSABLE CRATE IS AN ASSET IN CIRCULATION, NOT A CONSUMABLE.** Crates go out with
//     deliveries and most come back. A shop that treats them as consumed buys the same 400
//     crates every year and never asks where they went. So circulation is projected from
//     issues and returns, and shrinkage is a number rather than a feeling.
//   • **NEGATIVE PACKAGING STOCK IS AN EXCEPTION, NOT A CLAMP TO ZERO.** Bags going out with
//     none recorded in means the goods-in was never entered — and clamping to zero destroys
//     the only evidence of that.
//
// Exact integer money (§29.1). Pure and deterministic.

export type PackagingKind = 'carry_bag' | 'reusable_crate' | 'delivery_bag' | 'cold_box' | 'wrapping';

export interface PackagingItem {
  readonly packagingId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: PackagingKind;
  /** Charged to the customer where the tenant enables it. Absent means free. */
  readonly chargeMinor?: number;
  readonly taxRateBps?: number;
  /** True for crates and cold boxes: they are expected back. */
  readonly returnable: boolean;
  /** Refundable deposit on a returnable, where the tenant uses one. */
  readonly depositMinor?: number;
}

export interface BagChargePolicy {
  /** Per-tenant, per-branch. OFF unless the tenant turns it on. */
  readonly enabled: boolean;
  /** Bags are never charged on these order types, e.g. a home delivery the shop packs. */
  readonly exemptChannels?: readonly string[];
  /** Customers who bring their own are not charged, obviously — this records the choice. */
  readonly chargeOnlyIfIssued: boolean;
}

export type BagChargeOutcome = 'charged' | 'not_enabled' | 'exempt_channel' | 'none_issued' | 'no_price';

export interface BagChargeLine {
  readonly packagingId: string;
  readonly description: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
}

export interface BagChargeResult {
  readonly outcome: BagChargeOutcome;
  readonly charged: boolean;
  /** Absent when nothing is charged. There is no zero-value line. */
  readonly line?: BagChargeLine;
  readonly detail: string;
}

/**
 * Decide the carry-bag charge for a sale.
 *
 * **A charge is a visible line or it does not exist.** Adding an amount to a total without a
 * line on the bill is the version of this that ends in a consumer complaint the shop loses,
 * and showing it properly costs nothing.
 *
 * This is pure arithmetic over the price pack the lane already holds, so it works with the
 * internet down (hard rule #1).
 */
export function chargeForBags(input: {
  readonly item: PackagingItem;
  readonly policy: BagChargePolicy;
  readonly bagsIssued: number;
  readonly channel?: string;
}): BagChargeResult {
  if (!input.policy.enabled) {
    return {
      outcome: 'not_enabled',
      charged: false,
      detail: 'this tenant does not charge for bags — so there is NO line, not a line worth nothing',
    };
  }
  if (input.channel !== undefined && (input.policy.exemptChannels ?? []).includes(input.channel)) {
    return {
      outcome: 'exempt_channel',
      charged: false,
      detail: `bags are not charged on ${input.channel} — the shop chose the packaging, so the shop pays for it`,
    };
  }
  if (input.bagsIssued <= 0) {
    return {
      outcome: 'none_issued',
      charged: false,
      detail: 'no bag was taken, so nothing is charged',
    };
  }
  if (input.item.chargeMinor === undefined || input.item.chargeMinor <= 0) {
    return {
      outcome: 'no_price',
      charged: false,
      detail: `"${input.item.name}" has no price set, and a charge with no price is not a charge`,
    };
  }

  const netMinor = input.item.chargeMinor * input.bagsIssued;
  const taxMinor =
    input.item.taxRateBps === undefined
      ? 0
      : Number((BigInt(netMinor) * BigInt(input.item.taxRateBps) + 5_000n) / 10_000n);

  return {
    outcome: 'charged',
    charged: true,
    line: {
      packagingId: input.item.packagingId,
      description: input.item.name,
      qty: input.bagsIssued,
      unitPriceMinor: input.item.chargeMinor,
      netMinor,
      taxMinor,
      grossMinor: netMinor + taxMinor,
    },
    detail: `${input.bagsIssued} × ${input.item.name} at ${input.item.chargeMinor} shown as its own line on the bill`,
  };
}

export type PackagingMovementKind =
  | 'received'
  | 'issued_to_customer'
  | 'issued_to_delivery'
  | 'returned'
  | 'written_off';

export interface PackagingMovement {
  readonly movementId: string;
  readonly packagingId: string;
  readonly branchId: string;
  readonly kind: PackagingMovementKind;
  /** Always positive. The kind says which way it goes. */
  readonly qty: number;
  readonly at: string;
  readonly reference?: string;
}

export interface PackagingPosition {
  readonly packagingId: string;
  readonly name: string;
  readonly branchId: string;
  readonly onHand: number;
  /** Returnables that have gone out and not come back. */
  readonly inCirculation: number;
  readonly issuedTotal: number;
  readonly returnedTotal: number;
  readonly writtenOff: number;
  /** Basis points of returnables that never came back. */
  readonly lossRateBps: number | 'not_meaningful';
  /** True when the projection says we hold less than nothing. */
  readonly negative: boolean;
  readonly detail: string;
}

/**
 * Project a packaging position from its movements (hard rule #2 — nothing is stored).
 *
 * The number worth having is `inCirculation`: crates that went out and never came back. A
 * shop that treats crates as consumed buys four hundred of them again every year and never
 * asks the question. A shop that can see 118 crates unaccounted for asks it once and stops
 * buying them.
 *
 * A negative on-hand is **reported as negative**, not clamped. Bags going out with none
 * recorded in means a goods-in was never entered, and clamping to zero destroys the only
 * evidence that it happened.
 */
export function projectPackaging(input: {
  readonly item: PackagingItem;
  readonly branchId: string;
  readonly movements: readonly PackagingMovement[];
}): PackagingPosition {
  const mine = input.movements.filter(
    (m) => m.packagingId === input.item.packagingId && m.branchId === input.branchId,
  );
  const sum = (kind: PackagingMovementKind): number =>
    mine.filter((m) => m.kind === kind).reduce((s, m) => s + m.qty, 0);

  const received = sum('received');
  const toCustomer = sum('issued_to_customer');
  const toDelivery = sum('issued_to_delivery');
  const returned = sum('returned');
  const writtenOff = sum('written_off');

  const issuedTotal = toCustomer + toDelivery;
  const onHand = received - issuedTotal + returned - writtenOff;

  // Only a returnable can be "in circulation". A carry bag is gone.
  const outstanding = input.item.returnable ? toDelivery - returned : 0;
  const lossRateBps =
    !input.item.returnable || toDelivery === 0
      ? ('not_meaningful' as const)
      : Number((BigInt(Math.max(0, outstanding)) * 10_000n) / BigInt(toDelivery));

  return {
    packagingId: input.item.packagingId,
    name: input.item.name,
    branchId: input.branchId,
    onHand,
    inCirculation: Math.max(0, outstanding),
    issuedTotal,
    returnedTotal: returned,
    writtenOff,
    lossRateBps,
    negative: onHand < 0,
    detail:
      onHand < 0
        ? `${input.item.name} projects to ${onHand} — more has gone out than ever came in, which means a goods-in was never entered. It is shown NEGATIVE rather than clamped, because the negative IS the evidence`
        : input.item.returnable && outstanding > 0
          ? `${onHand} on hand and ${outstanding} still out with customers or drivers${lossRateBps === 'not_meaningful' ? '' : ` — ${(lossRateBps / 100).toFixed(1)}% of what went out has not come back`}`
          : `${onHand} on hand`,
  };
}
