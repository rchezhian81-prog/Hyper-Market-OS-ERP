// Forecast-driven, constraint-aware order proposal (D-2, M09·M06). The reorder engine in `replenishment.ts`
// answers "are we below the line, and how much to get back to the max" — a good reflex. This answers the
// buyer's real question: **given how much we expect to sell, and when the supplier next delivers, how much
// should this order be?**
//
// Two constraints the roadmap names, both DATA the caller supplies (never inferred here):
//   • **The supplier's calendar.** An order placed now arrives at the NEXT delivery and must last until the
//     one AFTER — so it covers exactly the demand of that window, no more. Ordering to a fixed max level
//     ignores when the next lorry comes; this does not.
//   • **Case / pallet packaging.** Stock is bought in whole cases, and cases stack into pallets. The order
//     rounds up to whole cases and reports the pallet + loose-case breakdown a buyer actually places.
//
// It nets what is already on the way (open orders) and what is on the shelf against the forecast, and it
// only **proposes** — an authorised human commits the purchase (hard rule #5). Pure and deterministic.

/** A day's forecast demand (YYYY-MM-DD, quantity in the product's minor unit). From D-1. */
export interface ForecastPoint {
  readonly day: string;
  readonly qty: number;
}

export interface ConstrainedOrderInput {
  readonly productId: string;
  readonly onHand: number;
  /** Already on the way (open purchase orders), assumed to arrive by the next delivery. */
  readonly onOrder?: number;
  /** Per-day forecast covering at least [asOf, the delivery after next). */
  readonly forecast: readonly ForecastPoint[];
  /** The supplier's upcoming delivery dates (YYYY-MM-DD, ascending). Two are needed to bound a cover window. */
  readonly upcomingDeliveries: readonly string[];
  readonly asOf: string;
  /** Units in a case — the order rounds up to whole cases. */
  readonly unitsPerCase?: number;
  /** Cases in a pallet — for the pallet / loose-case breakdown. */
  readonly casesPerPallet?: number;
  readonly minOrderQty?: number;
  /** Used to round when there is no case size. */
  readonly orderMultiple?: number;
}

export type ConstrainedOrderReason = 'ordered' | 'covered' | 'no_supplier_calendar';

export interface ConstrainedOrderProposal {
  readonly productId: string;
  readonly reason: ConstrainedOrderReason;
  /** The next delivery this order rides in on, and the delivery it must last until. */
  readonly arrivesOn?: string;
  readonly coversUntil?: string;
  /** Forecast demand across the cover window [arrivesOn, coversUntil). */
  readonly coverDemand: number;
  /** Expected stock the moment this order lands (on-hand + on-order − what sells before it arrives). */
  readonly projectedOnHandAtArrival: number;
  /** What the window needs, before packaging rounding. */
  readonly requiredQty: number;
  /** What to order after rounding to whole cases / the supplier minimum. */
  readonly suggestedQty: number;
  readonly cases?: number;
  readonly pallets?: number;
  readonly looseCases?: number;
  /** Always true — this can never become a purchase order by itself (hard rule #5). */
  readonly advisoryOnly: true;
  readonly detail: string;
}

export class InvalidConstrainedOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConstrainedOrderError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const requireWhole = (field: string, v: number, min: number): void => {
  if (!Number.isInteger(v) || v < min) throw new InvalidConstrainedOrderError(`${field} must be a whole number of at least ${min}`);
};

/**
 * Propose a supplier order that covers forecast demand from the next delivery to the one after, netting stock
 * and open orders, rounded to whole cases (and reported in pallets). Advisory only. Throws on malformed input.
 */
export function proposeConstrainedOrder(input: ConstrainedOrderInput): ConstrainedOrderProposal {
  if (!DAY.test(input.asOf)) throw new InvalidConstrainedOrderError('asOf must be a YYYY-MM-DD date');
  if (!Number.isInteger(input.onHand)) throw new InvalidConstrainedOrderError('onHand must be a whole number');
  const onOrder = input.onOrder ?? 0;
  requireWhole('onOrder', onOrder, 0);
  if (input.unitsPerCase !== undefined) requireWhole('unitsPerCase', input.unitsPerCase, 1);
  if (input.casesPerPallet !== undefined) requireWhole('casesPerPallet', input.casesPerPallet, 1);
  if (input.minOrderQty !== undefined) requireWhole('minOrderQty', input.minOrderQty, 1);
  if (input.orderMultiple !== undefined) requireWhole('orderMultiple', input.orderMultiple, 1);
  for (const d of input.upcomingDeliveries) {
    if (!DAY.test(d)) throw new InvalidConstrainedOrderError('every delivery date must be YYYY-MM-DD');
  }

  const base = { productId: input.productId, advisoryOnly: true as const };

  // Need two deliveries to bound a cover window: the one this order rides in on, and the next after it.
  if (input.upcomingDeliveries.length < 2) {
    return {
      ...base, reason: 'no_supplier_calendar', coverDemand: 0, projectedOnHandAtArrival: input.onHand + onOrder,
      requiredQty: 0, suggestedQty: 0,
      detail: 'need at least two upcoming delivery dates to size an order (this delivery and the next)',
    };
  }
  const arrivesOn = input.upcomingDeliveries[0]!;
  const coversUntil = input.upcomingDeliveries[1]!;

  // Forecast demand over a half-open [from, to) day window.
  const demandOver = (from: string, to: string): number =>
    input.forecast.reduce((s, p) => (DAY.test(p.day) && p.day >= from && p.day < to && Number.isFinite(p.qty) ? s + p.qty : s), 0);

  const demandUntilArrival = demandOver(input.asOf, arrivesOn);
  const coverDemand = demandOver(arrivesOn, coversUntil);
  const projectedOnHandAtArrival = input.onHand + onOrder - demandUntilArrival;
  const requiredQty = coverDemand - Math.max(0, projectedOnHandAtArrival);

  if (requiredQty <= 0) {
    return {
      ...base, reason: 'covered', arrivesOn, coversUntil, coverDemand, projectedOnHandAtArrival,
      requiredQty: Math.max(0, requiredQty), suggestedQty: 0,
      detail: `covered — ~${Math.max(0, projectedOnHandAtArrival)} on hand at ${arrivesOn} meets the ${coverDemand} forecast to ${coversUntil}`,
    };
  }

  // Round up to whole cases (or the order multiple), then raise to the supplier minimum — still in whole cases.
  const grain = input.unitsPerCase ?? input.orderMultiple ?? 1;
  let suggestedQty = Math.ceil(requiredQty / grain) * grain;
  if (input.minOrderQty !== undefined && suggestedQty < input.minOrderQty) {
    suggestedQty = Math.ceil(input.minOrderQty / grain) * grain;
  }

  const cases = input.unitsPerCase !== undefined ? suggestedQty / input.unitsPerCase : undefined;
  const pallets = input.casesPerPallet !== undefined && cases !== undefined ? Math.floor(cases / input.casesPerPallet) : undefined;
  const looseCases = pallets !== undefined && cases !== undefined ? cases - pallets * input.casesPerPallet! : undefined;

  return {
    ...base,
    reason: 'ordered',
    arrivesOn,
    coversUntil,
    coverDemand,
    projectedOnHandAtArrival,
    requiredQty,
    suggestedQty,
    ...(cases === undefined ? {} : { cases }),
    ...(pallets === undefined ? {} : { pallets }),
    ...(looseCases === undefined ? {} : { looseCases }),
    detail: `order ${suggestedQty}${cases === undefined ? '' : ` (${cases} case(s)${pallets === undefined ? '' : ` = ${pallets} pallet(s) + ${looseCases} case(s)`})`} to cover ${coverDemand} from ${arrivesOn} to ${coversUntil} (a person approves)`,
  };
}
