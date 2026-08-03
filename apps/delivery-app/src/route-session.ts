// Driver route session (M19 / M18 / D09) — the model behind the delivery screens
// (`docs/design/screens/delivery.md`). It runs on a low-spec Android phone in a
// moving vehicle, so it is **synchronous and local by construction**: the assigned
// stops are cached, proof and COD are captured on the device, and nothing awaits the
// network (§31 delivery row). Location and PII are minimised — a stop carries the
// order reference and an area label, never the customer's name or phone.
//
// What it enforces rather than trusting the driver:
//   • NOTHING IS "DELIVERED" WITHOUT PROOF — photo / OTP / signature per policy
//     (M19-FR-03), delegated to `packages/fulfilment`;
//   • COD IS RECORDED TO THE PAISA and reconciled at end of shift against the orders
//     actually delivered, with short/over/uncollected surfaced as valued exceptions
//     (M19-FR-04) — and COD is cash/UPI only, never card data (hard rule #3);
//   • A FAILED DELIVERY RECORDS A REASON and routes to reattempt or return-to-origin
//     — never quietly dropped;
//   • A GEOFENCE MISMATCH IS FLAGGED on the stop (not blocked — a driver may
//     legitimately be a street away), so it is visible on sync;
//   • CONTRIBUTION STOP RULES (D09) surface an unprofitable stop rather than
//     silently continuing.

import { money, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import {
  transitionDelivery,
  assertProofOfDelivery,
  reconcileCod,
  type DeliveryState,
  type ProofOfDelivery,
  type CodExpectation,
  type CodCollection,
  type CodReconResult,
} from '../../../packages/fulfilment/src/index';

/** One assigned stop. PII-minimised: an order reference and an area, no names. */
export interface StopInput {
  readonly stopId: string;
  readonly orderRef: string;
  /** Coarse area label for the driver (e.g. "Anna Nagar, 3rd St") — not a full address record. */
  readonly area: string;
  /** Amount to collect on delivery, in minor units; 0 when prepaid. */
  readonly codMinor: number;
  /** Delivery cost attributed to this stop (fuel/time) — feeds the contribution rule. */
  readonly costMinor?: number;
  /** Order value, used with cost for the contribution rule (D09). */
  readonly orderValueMinor?: number;
}

export interface Stop extends StopInput {
  readonly state: DeliveryState;
  readonly proof?: ProofOfDelivery;
  readonly codCollectedMinor?: number;
  readonly codMethod?: string;
  readonly failureReason?: string;
  /** True when the delivery was confirmed outside the expected geofence. */
  readonly geofenceMismatch?: boolean;
  /** Set when the contribution rule flags this stop as unprofitable (D09). */
  readonly contributionFlag?: string;
}

/** The tenant's contribution stop rule — choose-able, never hard-coded (D09). */
export interface ContributionRule {
  /** Flag when delivery cost exceeds this share of order value, in basis points. */
  readonly maxCostShareBps: number;
}

export interface RouteProgress {
  readonly total: number;
  readonly delivered: number;
  readonly failed: number;
  readonly returned: number;
  readonly remaining: number;
  readonly complete: boolean;
}

export class NoSuchStopError extends Error {
  constructor(stopId: string) {
    super(`No stop "${stopId}" on this route.`);
    this.name = 'NoSuchStopError';
  }
}

export class ReasonRequiredError extends Error {
  constructor() {
    super('A failed delivery needs a reason — it is recorded against the order.');
    this.name = 'ReasonRequiredError';
  }
}

export class CodAmountError extends Error {
  constructor(stopId: string) {
    super(`Stop "${stopId}" COD must be a non-negative amount.`);
    this.name = 'CodAmountError';
  }
}

/**
 * A driver's route for the shift. Everything is local and synchronous — the phone
 * works with no signal and the proof/COD queue for sync afterwards.
 */
export class RouteSession {
  private readonly stops: Stop[];

  constructor(
    readonly routeId: string,
    readonly driverId: string,
    assigned: readonly StopInput[],
    private readonly currency: CurrencyCode = 'INR',
    private readonly contributionRule?: ContributionRule,
  ) {
    this.stops = assigned.map((s) => ({ ...s, state: 'assigned' as DeliveryState }));
  }

  /** The assigned stops, as the phone lists them. */
  route(): readonly Stop[] {
    return this.stops.slice();
  }

  progress(): RouteProgress {
    const delivered = this.stops.filter((s) => s.state === 'delivered').length;
    const failed = this.stops.filter((s) => s.state === 'failed').length;
    const returned = this.stops.filter((s) => s.state === 'returned_to_origin').length;
    const remaining = this.stops.filter((s) => s.state === 'assigned' || s.state === 'out_for_delivery').length;
    return {
      total: this.stops.length,
      delivered,
      failed,
      returned,
      remaining,
      complete: remaining === 0,
    };
  }

  private stopOrThrow(stopId: string): Stop {
    const stop = this.stops.find((s) => s.stopId === stopId);
    if (stop === undefined) throw new NoSuchStopError(stopId);
    return stop;
  }

  private replace(next: Stop): void {
    const index = this.stops.findIndex((s) => s.stopId === next.stopId);
    this.stops[index] = next;
  }

  /** Leave for a stop. Refuses an illegal transition (the state machine is the rule). */
  depart(stopId: string): Stop {
    const stop = this.stopOrThrow(stopId);
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'depart') };
    this.replace(next);
    return next;
  }

  /** Flag the contribution rule if this stop's cost is out of proportion (D09). */
  private contributionFlagFor(stop: Stop): string | undefined {
    const rule = this.contributionRule;
    if (rule === undefined || stop.costMinor === undefined || !stop.orderValueMinor) return undefined;
    const shareBps = Math.round((stop.costMinor * 10_000) / stop.orderValueMinor);
    if (shareBps <= rule.maxCostShareBps) return undefined;
    return `Delivery cost is ${(shareBps / 100).toFixed(1)}% of order value (limit ${(rule.maxCostShareBps / 100).toFixed(1)}%).`;
  }

  /**
   * Complete a delivery. Requires PROOF (photo/OTP/signature) — without it nothing is
   * marked delivered (M19-FR-03). COD is recorded to the paisa; a geofence mismatch
   * is flagged (not blocked) so it surfaces on sync; the contribution rule is
   * evaluated and surfaced rather than silently continued (D09).
   */
  deliver(
    stopId: string,
    proof: ProofOfDelivery | undefined,
    options: { codCollectedMinor?: number; codMethod?: string; withinGeofence?: boolean } = {},
  ): Stop {
    const stop = this.stopOrThrow(stopId);
    // Throws ProofRequiredError when proof is missing or empty.
    assertProofOfDelivery(proof);

    const collected = options.codCollectedMinor ?? 0;
    if (!Number.isSafeInteger(collected) || collected < 0) {
      throw new CodAmountError(stopId);
    }

    const delivered: Stop = {
      ...stop,
      state: transitionDelivery(stop.state, 'deliver'),
      proof,
      codCollectedMinor: collected,
      codMethod: options.codMethod,
      geofenceMismatch: options.withinGeofence === false ? true : undefined,
    };
    const next: Stop = { ...delivered, contributionFlag: this.contributionFlagFor(delivered) };
    this.replace(next);
    return next;
  }

  /** Record a failed delivery with a reason — never quietly dropped (M19-FR-04). */
  fail(stopId: string, reason: string): Stop {
    const stop = this.stopOrThrow(stopId);
    if (reason.trim() === '') throw new ReasonRequiredError();
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'fail'), failureReason: reason };
    this.replace(next);
    return next;
  }

  /** Send a failed stop out again. */
  reattempt(stopId: string): Stop {
    const stop = this.stopOrThrow(stopId);
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'reattempt') };
    this.replace(next);
    return next;
  }

  /** Return a failed stop to the store (RTO). */
  returnToOrigin(stopId: string): Stop {
    const stop = this.stopOrThrow(stopId);
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'rto') };
    this.replace(next);
    return next;
  }

  /** Stops the contribution rule flagged — surfaced for the dispatcher, not buried. */
  contributionFlags(): readonly Stop[] {
    return this.stops.filter((s) => s.contributionFlag !== undefined);
  }

  /** Total cash the driver should be holding, from delivered stops. */
  codHeld(): Money {
    const total = this.stops
      .filter((s) => s.state === 'delivered')
      .reduce((sum, s) => sum + (s.codCollectedMinor ?? 0), 0);
    return money(total, this.currency);
  }

  /**
   * End-of-shift settlement: reconcile what was collected against what the delivered
   * orders expected, using the tested COD engine — short / over / uncollected /
   * unexpected each surface as a valued exception, and a card method is refused
   * (hard rule #3). Feeds finance reconciliation (M23).
   */
  settle(): CodReconResult {
    const deliveredStops = this.stops.filter((s) => s.state === 'delivered' && s.codMinor > 0);
    const expectations: CodExpectation[] = deliveredStops.map((s) => ({
      orderId: s.orderRef,
      expectedMinor: s.codMinor,
    }));
    const collections: CodCollection[] = deliveredStops
      .filter((s) => (s.codCollectedMinor ?? 0) > 0)
      .map((s) => ({
        orderId: s.orderRef,
        collectedMinor: s.codCollectedMinor ?? 0,
        method: s.codMethod ?? 'cash',
      }));
    return reconcileCod(expectations, collections);
  }
}
