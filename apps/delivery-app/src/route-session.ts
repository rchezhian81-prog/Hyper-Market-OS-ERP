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
//
// ── The outbox, and why this is the worst place to have been missing one ─────
//
// The paragraph above used to say the proof and COD "queue for sync afterwards" and **nothing
// queued**. Every stop lived in a JavaScript object on a phone in a moving vehicle and nowhere
// else.
//
// On the picker's handheld the same gap loses a wave, which is a bad afternoon. Here it loses
// **money that has already changed hands**. A driver collects ₹6,000 across four stops, the phone
// dies, and there is no record anywhere that any of it was ever collected — not in the store, not
// in the cloud, not on the device. The end-of-shift settlement has nothing to reconcile against,
// so the cash in his pocket is unexplained in a way that is unfair to an honest driver and
// invisible to a dishonest one.
//
// The outbox is therefore a **required** constructor argument. Every stop that reaches a terminal
// state queues its own event, and so does the settlement.

import { makeEvent } from '../../../packages/contracts/src/event';
import { money, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
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

/** What the driver counted, against what the day recorded. Only ever produced by `handOver`. */
export interface CashHandover {
  readonly routeId: string;
  readonly driverId: string;
  /** The only figure the driver supplied. */
  readonly countedMinor: number;
  /** What the recorded collections add up to — revealed only now, never before the count. */
  readonly recordedMinor: number;
  /** counted − recorded (positive = more cash than the day recorded). */
  readonly varianceMinor: number;
  /** True when the difference is large enough to need the cash office. */
  readonly material: boolean;
  readonly currency: CurrencyCode;
  readonly at: string;
  readonly reasonCode: string | null;
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

  private readonly currency: CurrencyCode;
  private readonly contributionRule: ContributionRule | undefined;
  private readonly at: () => string;

  constructor(
    readonly routeId: string,
    readonly driverId: string,
    assigned: readonly StopInput[],
    /** Where every completed stop and the settlement are queued for sync. Required — see above. */
    private readonly outbox: SyncOutbox,
    options: {
      readonly currency?: CurrencyCode;
      readonly contributionRule?: ContributionRule;
      /** Injected so a test is deterministic; the phone passes its own clock. */
      readonly now?: () => string;
    } = {},
  ) {
    this.currency = options.currency ?? 'INR';
    this.contributionRule = options.contributionRule;
    this.at = options.now ?? (() => new Date().toISOString());
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

  /**
   * Record a stop's new state — and queue it.
   *
   * Every path that moves a stop goes through here, so a path added later cannot forget to queue.
   * Idempotent on stop id **and state**, so re-recording one outcome collapses to a single item
   * while a genuine change (failed, then reattempted, then delivered) queues each step — because
   * each of those is a separate thing that happened to somebody's order.
   *
   * **What travels is deliberately thin** (§31 PII minimisation): the order reference, the state,
   * the money and the proof KIND. Never the customer's name, never their phone number, and never
   * the photograph itself — a route's worth of doorstep photographs on a queue is a privacy
   * problem being synced rather than a delivery being proved.
   */
  private replace(next: Stop): void {
    const index = this.stops.findIndex((s) => s.stopId === next.stopId);
    this.stops[index] = next;
    this.outbox.enqueue(
      makeEvent({
        id: `${this.routeId}:${next.stopId}:${next.state}`,
        type: 'DeliveryStopUpdated',
        occurredAt: this.at(),
        idempotencyKey: `stop:${this.routeId}:${next.stopId}:${next.state}`,
        source: this.routeId,
        payload: {
          routeId: this.routeId,
          driverId: this.driverId,
          stopId: next.stopId,
          orderRef: next.orderRef,
          state: next.state,
          codExpectedMinor: next.codMinor,
          codCollectedMinor: next.codCollectedMinor ?? 0,
          codMethod: next.codMethod ?? null,
          proofKind: next.proof?.kind ?? null,
          geofenceMismatch: next.geofenceMismatch === true,
          failureReason: next.failureReason ?? null,
          contributionFlag: next.contributionFlag ?? null,
          currency: this.currency,
        },
      }),
    );
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
    const result = reconcileCod(expectations, collections);

    // Queued whatever it says. A settlement that only reached the cloud when it balanced would be
    // a reconciliation that can only ever report success — the short and the over are the two
    // outcomes anybody actually needs to see (M19-FR-04, M23).
    this.outbox.enqueue(
      makeEvent({
        id: `${this.routeId}:settled`,
        type: 'RouteSettled',
        occurredAt: this.at(),
        idempotencyKey: `settle:${this.routeId}`,
        source: this.routeId,
        payload: {
          routeId: this.routeId,
          driverId: this.driverId,
          expectedMinor: expectations.reduce((sum, e) => sum + e.expectedMinor, 0),
          collectedMinor: collections.reduce((sum, c) => sum + c.collectedMinor, 0),
          cashHeldMinor: this.codHeld().minor,
          matchedCount: result.matchedCount,
          exceptionCount: result.exceptionCount,
          currency: this.currency,
        },
      }),
    );
    return result;
  }

  /**
   * Hand the cash over at the end of the shift, against a **counted** figure.
   *
   * ── The blind count, a third time ─────────────────────────────────────────
   *
   * The till does this for the drawer and the stock count does it for the shelf, for the same
   * reason and it applies just as hard here: **the driver is never shown what they should be
   * holding before they count it.** Shown "you should have ₹6,000", people hand over ₹6,000 and
   * count nothing — not from dishonesty, but because a number on a screen is an answer and
   * counting is work. A handover anchored to the expectation finds nothing, which is the one thing
   * a handover exists to do.
   *
   * So there is no method on this session that returns the expected cash before a count. The
   * variance only exists **after** a counted figure has been given, and it comes back as part of
   * the result. `codHeld()` is the recorded total and is what the cash office reconciles against;
   * it is not a target to read out to the driver first, which is why the screen never shows it
   * until this has been called.
   */
  handOver(input: {
    readonly countedMinor: number;
    readonly at: string;
    /** |over/short| at or above which the variance needs the cash office. Per-tenant. */
    readonly toleranceMinor: number;
    readonly reasonCode?: string;
  }): CashHandover {
    if (!Number.isSafeInteger(input.countedMinor) || input.countedMinor < 0) {
      throw new CodAmountError(this.routeId);
    }
    const recordedMinor = this.codHeld().minor;
    const varianceMinor = input.countedMinor - recordedMinor;
    const material = Math.abs(varianceMinor) >= input.toleranceMinor;

    const handover: CashHandover = Object.freeze({
      routeId: this.routeId,
      driverId: this.driverId,
      countedMinor: input.countedMinor,
      recordedMinor,
      varianceMinor,
      material,
      currency: this.currency,
      at: input.at,
      reasonCode: input.reasonCode ?? null,
    });

    // Queued whatever it says — a handover that only reached the cash office when it balanced
    // would be a control that can only ever report success.
    this.outbox.enqueue(
      makeEvent({
        id: `${this.routeId}:handover`,
        type: 'DriverCashHandedOver',
        occurredAt: input.at,
        idempotencyKey: `handover:${this.routeId}`,
        source: this.routeId,
        payload: { ...handover },
      }),
    );
    return handover;
  }
}
