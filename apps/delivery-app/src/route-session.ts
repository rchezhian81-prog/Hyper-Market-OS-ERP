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
import { deviceItemReason, deviceItemState, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';
import {
  transitionDelivery,
  assertProofOfDelivery,
  reconcileCod,
  isDeliveryCode,
  isFix,
  bytesOfBase64,
  sha256Hex,
  proofRefOf,
  ProofRequiredError,
  IMAGE_PROOF_KINDS,
  PROOF_IMAGE_MAX_BASE64,
  type DeliveryState,
  type DeviceFix,
  type ProofKind,
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
  /** The fingerprint of the photo / signature captured at the door (OB-288 · M19-FR-03). */
  readonly proofSha256?: string;
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
  /** Stops where the customer received SOME of the order, with proof — a terminal outcome. */
  readonly partiallyDelivered: number;
  readonly failed: number;
  readonly returned: number;
  readonly remaining: number;
  readonly complete: boolean;
}

/**
 * The proof a driver gives at the door — CAPTURED, never typed (OB-294 · M19-FR-03, owner, 23 Oct 2026):
 *   • `otp` — the customer's 4-digit delivery code, read out from their app (`code`; an older caller's `ref` is read as it);
 *   • `photo` — the phone camera's picture of the hand-over; `signature` — the customer's finger on the screen. Each carries
 *     the captured `image` (a JPEG / PNG / WebP, base64), which the phone fingerprints and queues as its own record.
 */
export interface CapturedImage {
  readonly mediaType: string;
  readonly contentBase64: string;
}
export interface CapturedProof {
  readonly kind: ProofKind;
  readonly ref?: string;
  readonly code?: string;
  readonly image?: CapturedImage;
}

/** A photo / signature proof with no captured image: a typed reference is not proof (OB-294). */
export class ProofNotCapturedError extends ProofRequiredError {
  constructor(kind: string) {
    super();
    this.message = `A ${kind} proof must be captured on the phone — a typed reference is not proof.`;
    this.name = 'ProofNotCapturedError';
  }
}

/** The customer's code is four digits (OB-294) — anything else is refused before anything is queued. */
export class DeliveryCodeFormatError extends Error {
  constructor() {
    super('The delivery code is the four numbers in the customer\'s app.');
    this.name = 'DeliveryCodeFormatError';
  }
}

/** A captured image that cannot be kept: not an image the phone can read, or larger than a proof image may be. */
export class ProofImageError extends Error {
  constructor(readonly code: 'not_an_image' | 'too_large') {
    super(code === 'too_large' ? `The picture is larger than the ${PROOF_IMAGE_MAX_BASE64} characters a proof image may be — take it again.` : 'The picture could not be read — take it again.');
    this.name = 'ProofImageError';
  }
}

/** The event types this phone queues — named once, for the session, the box's allow-list and the cloud routes. */
export const DELIVERY_STOP_UPDATED = 'DeliveryStopUpdated';
/** OB-288 · M19-FR-03: a photo / signature captured at the door, queued BEFORE the stop it proves. */
export const DELIVERY_PROOF_CAPTURED = 'DeliveryProofCaptured';
export const ROUTE_SETTLED = 'RouteSettled';
export const DRIVER_CASH_HANDED_OVER = 'DriverCashHandedOver';
/** R4 gap lane "driver" (WF-16): an online return collected at the door — or not, with the reason. No money moves. */
export const RETURN_COLLECTION_RECORDED = 'ReturnCollectionRecorded';

/** The kinds of work this phone sends: a stop's outcome, the route's settlement, the cash handover, a return collection. A guardrail binds the shell's words to this. */
export const SENT_WORK_KINDS = Object.freeze(['stop', 'settlement', 'handover', 'collection', 'proof'] as const);
export type SentWorkKind = (typeof SENT_WORK_KINDS)[number];

/**
 * One piece of work this phone queued, and where it has got to (SP-3c-ii · the five shared device states). Read from the
 * DURABLE device queue plus the store computer's own word — so the list is the same after the app is closed, which for a
 * driver carrying cash is the difference between a record and a rumour.
 */
export interface SentWork {
  readonly kind: SentWorkKind;
  /** The stop id for a stop outcome; the route id for the settlement and the handover. */
  readonly id: string;
  /** What it was: the area and the order reference for a stop; the route for the rest. Never a customer. */
  readonly what: string;
  /** The outcome in the model's own words: the state and the cash for a stop; the figures for the rest. */
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

// ── R4 gap lane "driver" (WF-16): online returns to collect on this route ────────────────────────────────
//
// Head office books a collection and puts it on the driver's route; the box serves it with the BOOKED lines. At the door the
// driver records one of two things: what he took (from the booked lines only, never more than was booked), or that nothing
// was collected and why. Either is queued here on the phone, stamped with his sign-in like every other record, and relayed
// by the box. Head office checks it all again. No money changes hands at the door and nothing is refunded here: the refund
// follows only after the shop receives and counts the goods, a person chooses where they go, and a second person approves.

/** One booked line of a return collection. PII-minimised: a product and a quantity. */
export interface CollectionLineInput {
  readonly productId: string;
  readonly quantityMinor: number;
  /** The product's name from the store's catalogue, when the box knows it. */
  readonly name?: string;
  readonly nameTa?: string;
}

/** One online return booked for collection on this route — a reference and an area, never the customer's name or number. */
export interface CollectionInput {
  readonly returnId: string;
  readonly orderRef: string;
  readonly area: string;
  readonly collectOn: string;
  readonly lines: readonly CollectionLineInput[];
}

/** Why nothing was collected. Chosen on the phone, never typed — head office reads the same two words. */
export const COLLECTION_MISS_REASONS = Object.freeze(['customer_not_available', 'nothing_handed_over'] as const);
export type CollectionMissReason = (typeof COLLECTION_MISS_REASONS)[number];

export type CollectionState = 'booked' | 'collected' | 'not_collected';

export interface Collection extends CollectionInput {
  readonly state: CollectionState;
  /** What the driver recorded taking, per booked line (0 for a line not taken) — once collected. */
  readonly taken?: readonly { readonly productId: string; readonly collectedMinor: number }[];
  /** How many visits came back without the goods. */
  readonly missedVisits: number;
  readonly lastMissReason?: CollectionMissReason;
}

export class NoSuchCollectionError extends Error {
  constructor(returnId: string) {
    super(`No return collection "${returnId}" on this route.`);
    this.name = 'NoSuchCollectionError';
  }
}

/** A line, or a quantity, that was not booked. Refused BY NAME on the phone, before anything is queued. */
export class CollectionLinesError extends Error {
  constructor(readonly code: 'not_on_this_return' | 'not_a_whole_number' | 'more_than_booked' | 'counted_twice' | 'nothing_collected', detail: string) {
    super(detail);
    this.name = 'CollectionLinesError';
  }
}

export class CollectionDoneError extends Error {
  constructor(returnId: string) {
    super(`Return ${returnId} is already recorded as collected.`);
    this.name = 'CollectionDoneError';
  }
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
  /** The store computer's word on each item it took, keyed by queue key — filled by `noteBoxStatus` (SP-3c-ii). */
  private readonly boxWord = new Map<string, BoxItemStatus>();
  /** WF-16 (driver): the return collections on this route. */
  private readonly pickups: Collection[];

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
      /** WF-16 (driver): the online returns booked for collection on this route. */
      readonly collections?: readonly CollectionInput[];
    } = {},
  ) {
    this.currency = options.currency ?? 'INR';
    this.contributionRule = options.contributionRule;
    this.at = options.now ?? (() => new Date().toISOString());
    this.stops = assigned.map((s) => ({ ...s, state: 'assigned' as DeliveryState }));
    // A collection already recorded on this phone stays recorded after the app is closed: the durable queue is the authority,
    // so a reopened screen can never offer to collect the same return twice.
    this.pickups = (options.collections ?? []).map((c) => {
      let state: CollectionState = 'booked';
      let taken: Collection['taken'];
      let missedVisits = 0;
      let lastMissReason: CollectionMissReason | undefined;
      for (const item of this.outbox.all()) {
        if (item.event.type !== RETURN_COLLECTION_RECORDED) continue;
        const p = item.event.payload as { routeId: string; returnId: string; outcome: string; lines?: Collection['taken']; reason?: CollectionMissReason };
        if (p.routeId !== this.routeId || p.returnId !== c.returnId) continue;
        if (p.outcome === 'collected') { state = 'collected'; taken = p.lines; } else if (state !== 'collected') { state = 'not_collected'; missedVisits += 1; lastMissReason = p.reason; }
      }
      return { ...c, state, ...(taken === undefined ? {} : { taken }), missedVisits, ...(lastMissReason === undefined ? {} : { lastMissReason }) };
    });
  }

  /** WF-16 (driver): the online returns to collect on this route, as the phone lists them. */
  collections(): readonly Collection[] {
    return this.pickups.slice();
  }

  private collectionOrThrow(returnId: string): Collection {
    const c = this.pickups.find((x) => x.returnId === returnId);
    if (c === undefined) throw new NoSuchCollectionError(returnId);
    return c;
  }

  private queueCollection(c: Collection, outcome: 'collected' | 'not_collected', extra: Record<string, unknown>, key: string): void {
    const occurredAt = this.at();
    this.outbox.enqueue(makeEvent({
      id: key, type: RETURN_COLLECTION_RECORDED, occurredAt, idempotencyKey: key, source: this.routeId,
      // Thin, like a stop: the return and order references, the product ids and quantities, the reason. No customer, no money.
      payload: { returnId: c.returnId, routeId: this.routeId, driverId: this.driverId, orderRef: c.orderRef, outcome, occurredAt, ...extra },
    }));
  }

  /**
   * "Collected": the lines and quantities the driver took, from the BOOKED lines only — never more than was booked. A line
   * not named was not taken. Refused by name, before anything is queued: a line not on the return, a part item, more than
   * was booked, a line named twice, or nothing at all (that is "nothing handed over"). Once per return.
   */
  collect(returnId: string, lines: readonly { readonly productId: string; readonly collectedMinor: number }[]): Collection {
    const c = this.collectionOrThrow(returnId);
    if (c.state === 'collected') throw new CollectionDoneError(returnId);
    const booked = new Map(c.lines.map((l) => [l.productId, l.quantityMinor] as const));
    const took = new Map<string, number>();
    for (const l of lines) {
      if (took.has(l.productId)) throw new CollectionLinesError('counted_twice', `${l.productId} is named twice`);
      const b = booked.get(l.productId);
      if (b === undefined) throw new CollectionLinesError('not_on_this_return', `${l.productId} was not booked on this return`);
      if (!Number.isInteger(l.collectedMinor) || l.collectedMinor < 0) throw new CollectionLinesError('not_a_whole_number', `${l.productId}: ${l.collectedMinor} is not a whole number of items`);
      if (l.collectedMinor > b) throw new CollectionLinesError('more_than_booked', `${l.productId}: collected ${l.collectedMinor}, but ${b} was booked for collection`);
      took.set(l.productId, l.collectedMinor);
    }
    const taken = c.lines.map((l) => ({ productId: l.productId, collectedMinor: took.get(l.productId) ?? 0 }));
    if (taken.every((l) => l.collectedMinor === 0)) throw new CollectionLinesError('nothing_collected', 'no item was taken — record it as "nothing handed over" instead');
    const next: Collection = { ...c, state: 'collected', taken };
    this.pickups[this.pickups.indexOf(c)] = next;
    this.queueCollection(next, 'collected', { lines: taken }, `return-collection:${this.routeId}:${returnId}:collected`);
    return next;
  }

  /** "Customer not available" / "nothing handed over": the visit is recorded with its reason; the booking stands. */
  notCollected(returnId: string, reason: CollectionMissReason): Collection {
    const c = this.collectionOrThrow(returnId);
    if (c.state === 'collected') throw new CollectionDoneError(returnId);
    if (!(COLLECTION_MISS_REASONS as readonly string[]).includes(reason)) throw new ReasonRequiredError();
    const next: Collection = { ...c, state: 'not_collected', missedVisits: c.missedVisits + 1, lastMissReason: reason };
    this.pickups[this.pickups.indexOf(c)] = next;
    this.queueCollection(next, 'not_collected', { reason }, `return-collection:${this.routeId}:${returnId}:not_collected:${next.missedVisits}`);
    return next;
  }

  /** The assigned stops, as the phone lists them. */
  route(): readonly Stop[] {
    return this.stops.slice();
  }

  progress(): RouteProgress {
    const delivered = this.stops.filter((s) => s.state === 'delivered').length;
    const partiallyDelivered = this.stops.filter((s) => s.state === 'partially_delivered').length;
    const failed = this.stops.filter((s) => s.state === 'failed').length;
    const returned = this.stops.filter((s) => s.state === 'returned_to_origin').length;
    // Everything not yet at a terminal state — including the new in-flight states picked_up and
    // attempted — so a stop that has left the shelf but not reached a resolution is never "complete".
    const IN_FLIGHT = new Set<DeliveryState>(['assigned', 'picked_up', 'out_for_delivery', 'attempted']);
    const remaining = this.stops.filter((s) => IN_FLIGHT.has(s.state)).length;
    return {
      total: this.stops.length,
      delivered,
      partiallyDelivered,
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
   * the money, the proof KIND and its fingerprint. Never the customer's name or phone number. The
   * photograph (OB-294: the owner chose a real capture, kept as a document at head office) travels
   * as its OWN record, small, once — never inside every stop step — and the phone's location rides
   * only on a hand-over, for head office to compare with the stored address and then discard.
   */
  private replace(next: Stop, door: { readonly code?: string; readonly deviceFix?: DeviceFix } = {}): void {
    const index = this.stops.findIndex((s) => s.stopId === next.stopId);
    this.stops[index] = next;
    this.outbox.enqueue(
      makeEvent({
        id: `${this.routeId}:${next.stopId}:${next.state}`,
        type: DELIVERY_STOP_UPDATED,
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
          // OB-294 · M19-FR-03: the four digits the customer read out (checked at head office), the captured image's
          // fingerprint (the image itself travels as its own record), and — only at a hand-over — where the phone was,
          // which head office compares with what it holds for the stop and does not keep.
          proofCode: door.code ?? null,
          proofSha256: next.proofSha256 ?? null,
          deviceFix: door.deviceFix ?? null,
          geofenceMismatch: next.geofenceMismatch === true,
          failureReason: next.failureReason ?? null,
          contributionFlag: next.contributionFlag ?? null,
          currency: this.currency,
        },
      }),
    );
  }

  /**
   * Mark the order **picked up from the store** before the van leaves (M19-FR-03 lifecycle:
   * `assigned → picked_up`). It is a distinct, recorded step so a stop that left the building can be
   * told from one still on the shelf — the difference a customer asking "where is my order?" needs.
   * Optional in the flow: a driver can still `depart` straight from `assigned`, so a low-signal phone
   * is never forced into a second tap. The state machine refuses an illegal transition.
   */
  pickUp(stopId: string): Stop {
    const stop = this.stopOrThrow(stopId);
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'pick_up') };
    this.replace(next);
    return next;
  }

  /** Leave for a stop. Refuses an illegal transition (the state machine is the rule). */
  depart(stopId: string): Stop {
    const stop = this.stopOrThrow(stopId);
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'depart') };
    this.replace(next);
    return next;
  }

  /**
   * Mark **arrival at the doorstep** (M19-FR-03 lifecycle: `out_for_delivery → attempted`). It records
   * that the driver reached the address, which is what separates a genuine failed attempt ("nobody
   * home", recorded from `attempted`) from a stop that was never actually driven to. Deliver, partial
   * delivery and fail all remain reachable from here, exactly as from `out_for_delivery`.
   */
  arrive(stopId: string): Stop {
    const stop = this.stopOrThrow(stopId);
    const next: Stop = { ...stop, state: transitionDelivery(stop.state, 'arrive') };
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
    proof: CapturedProof | undefined,
    options: { codCollectedMinor?: number; codMethod?: string; withinGeofence?: boolean; deviceFix?: DeviceFix } = {},
  ): Stop {
    const stop = this.stopOrThrow(stopId);
    // Throws ProofRequiredError when proof is missing; the capture rules (OB-294) before anything is queued.
    const captured = this.capture(proof);

    const collected = options.codCollectedMinor ?? 0;
    if (!Number.isSafeInteger(collected) || collected < 0) {
      throw new CodAmountError(stopId);
    }

    const delivered: Stop = {
      ...stop,
      state: transitionDelivery(stop.state, 'deliver'),
      proof: captured.proof,
      ...(captured.sha256 === undefined ? {} : { proofSha256: captured.sha256 }),
      codCollectedMinor: collected,
      codMethod: options.codMethod,
      geofenceMismatch: options.withinGeofence === false ? true : undefined,
    };
    const next: Stop = { ...delivered, contributionFlag: this.contributionFlagFor(delivered) };
    this.queueImage(next, captured);
    this.replace(next, this.doorFacts(captured, options.deviceFix));
    return next;
  }

  /**
   * Complete a **partial delivery** — the customer received some of the order and kept it, with proof
   * (M19-FR-01/FR-03 lifecycle: `out_for_delivery`/`attempted → partially_delivered`). It is a
   * TERMINAL outcome: the customer has some goods with proof, and the undelivered remainder is a
   * compensating money/stock event downstream (hard rule #2 — a ledger is never overwritten), NOT a
   * return of the whole stop. Like a full delivery it requires proof, records the COD actually taken
   * for what was handed over (so no cash the driver holds goes unrecorded — §31/P-01), flags a
   * geofence mismatch rather than blocking, and evaluates the contribution rule (D09).
   */
  deliverPartial(
    stopId: string,
    proof: CapturedProof | undefined,
    options: { codCollectedMinor?: number; codMethod?: string; withinGeofence?: boolean; deviceFix?: DeviceFix } = {},
  ): Stop {
    const stop = this.stopOrThrow(stopId);
    // Throws ProofRequiredError when proof is missing — some goods were handed over; the capture rules before anything is queued.
    const captured = this.capture(proof);

    const collected = options.codCollectedMinor ?? 0;
    if (!Number.isSafeInteger(collected) || collected < 0) {
      throw new CodAmountError(stopId);
    }

    const partial: Stop = {
      ...stop,
      state: transitionDelivery(stop.state, 'deliver_partial'),
      proof: captured.proof,
      ...(captured.sha256 === undefined ? {} : { proofSha256: captured.sha256 }),
      codCollectedMinor: collected,
      codMethod: options.codMethod,
      geofenceMismatch: options.withinGeofence === false ? true : undefined,
    };
    const next: Stop = { ...partial, contributionFlag: this.contributionFlagFor(partial) };
    this.queueImage(next, captured);
    this.replace(next, this.doorFacts(captured, options.deviceFix));
    return next;
  }

  /**
   * The capture rules (OB-294 · M19-FR-03), checked before ANYTHING is queued: a code proof is the four digits the customer
   * read out; a photo or signature is an image the phone captured, small enough to keep, fingerprinted here. A typed
   * reference for a photo or a signature is refused — it proves nothing.
   */
  private capture(proof: CapturedProof | undefined): { readonly proof: ProofOfDelivery; readonly code?: string; readonly sha256?: string; readonly image?: CapturedImage } {
    if (proof === undefined) assertProofOfDelivery(undefined);
    const p = proof!;
    if (p.kind === 'otp') {
      const code = p.code ?? p.ref;
      if (!isDeliveryCode(code)) throw new DeliveryCodeFormatError();
      return { proof: { kind: 'otp', ref: proofRefOf('otp', code) }, code };
    }
    if (!IMAGE_PROOF_KINDS.has(p.kind)) assertProofOfDelivery(undefined);
    if (p.image === undefined || typeof p.image.contentBase64 !== 'string' || typeof p.image.mediaType !== 'string') throw new ProofNotCapturedError(p.kind);
    if (p.image.contentBase64.length > PROOF_IMAGE_MAX_BASE64) throw new ProofImageError('too_large');
    const bytes = bytesOfBase64(p.image.contentBase64);
    if (bytes === undefined || bytes.length < 8) throw new ProofImageError('not_an_image');
    const sha256 = sha256Hex(bytes);
    return { proof: { kind: p.kind, ref: proofRefOf(p.kind, sha256) }, sha256, image: p.image };
  }

  /** What the stop record carries about the door: the code, and the phone's location (only a readable one). */
  private doorFacts(captured: { readonly code?: string }, deviceFix: DeviceFix | undefined): { code?: string; deviceFix?: DeviceFix } {
    return { ...(captured.code === undefined ? {} : { code: captured.code }), ...(isFix(deviceFix) ? { deviceFix } : {}) };
  }

  /** Queue the captured image as its own record, before the stop it proves — keyed on the image, so a retry is one record. */
  private queueImage(stop: Stop, captured: { readonly sha256?: string; readonly image?: CapturedImage }): void {
    if (captured.sha256 === undefined || captured.image === undefined || stop.proof === undefined) return;
    const occurredAt = this.at();
    const key = `proof:${this.routeId}:${stop.stopId}:${captured.sha256.slice(0, 24)}`;
    this.outbox.enqueue(makeEvent({
      id: key, type: DELIVERY_PROOF_CAPTURED, occurredAt, idempotencyKey: key, source: this.routeId,
      // The order reference, the kind, the image and its fingerprint — never a customer's name, number or address.
      payload: {
        routeId: this.routeId, stopId: stop.stopId, driverId: this.driverId, orderRef: stop.orderRef, kind: stop.proof.kind,
        mediaType: captured.image.mediaType, contentBase64: captured.image.contentBase64, sha256: captured.sha256, capturedAt: occurredAt,
      },
    }));
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

  /** Total cash the driver should be holding — from delivered AND partially-delivered stops, so cash
   *  taken on a partial delivery is never off the books (§31/P-01). */
  codHeld(): Money {
    const total = this.stops
      .filter((s) => s.state === 'delivered' || s.state === 'partially_delivered')
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
    // A full delivery is expected to collect the order's whole COD; a partial delivery reconciles to
    // what was actually taken for the goods handed over — the undelivered remainder's money is a
    // compensating event settled downstream (M18/M23), never a driver "short" invented here.
    const deliveredStops = this.stops.filter((s) => s.state === 'delivered' && s.codMinor > 0);
    const partialStops = this.stops.filter((s) => s.state === 'partially_delivered' && (s.codCollectedMinor ?? 0) > 0);
    const settledStops = [...deliveredStops, ...partialStops];
    const expectations: CodExpectation[] = settledStops.map((s) => ({
      orderId: s.orderRef,
      expectedMinor: s.state === 'partially_delivered' ? (s.codCollectedMinor ?? 0) : s.codMinor,
    }));
    const collections: CodCollection[] = settledStops
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
        type: ROUTE_SETTLED,
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
        type: DRIVER_CASH_HANDED_OVER,
        occurredAt: input.at,
        idempotencyKey: `handover:${this.routeId}`,
        source: this.routeId,
        payload: { ...handover },
      }),
    );
    return handover;
  }

  // ── Where each piece of work has got to (SP-3c-ii · the shared device → box → head office leg) ────────

  /** Fold in the store computer's word on the items it holds (asked over `/lane/outbox/status`). */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void {
    for (const s of statuses) this.boxWord.set(s.key, s);
  }

  /** The keys the box has taken — the ones worth asking it about. */
  handedKeys(): readonly string[] {
    return this.outbox.all().filter((item) => item.state === 'acknowledged').map((item) => item.key);
  }

  /**
   * Every stop outcome, the settlement and the handover this phone queued, newest first, each with one of the five shared
   * state words. The device's own "acknowledged" means the BOX has it — only the box's word says head office does (P-08).
   * A refusal carries its reason, because a person has to act on it. Never a customer's name or number (§31).
   */
  sentWork(): readonly SentWork[] {
    return this.outbox.all()
      .flatMap((item): SentWork[] => {
        const box = this.boxWord.get(item.key);
        const common = { at: item.event.occurredAt, state: deviceItemState(item, box), attempts: item.attempts } as const;
        const reason = deviceItemReason(item, box);
        const withReason = reason === undefined ? {} : { reason };
        if (item.event.type === DELIVERY_STOP_UPDATED) {
          const p = item.event.payload as { stopId: string; orderRef: string; state: DeliveryState; codCollectedMinor: number; currency: string; failureReason: string | null };
          const area = this.stops.find((s) => s.stopId === p.stopId)?.area ?? p.stopId;
          const money = p.codCollectedMinor > 0 ? ` · ${p.codCollectedMinor} ${p.currency}` : '';
          const why = p.failureReason === null ? '' : ` · ${p.failureReason}`;
          return [{ kind: 'stop', id: p.stopId, what: `${area} · ${p.orderRef}`, detail: `${p.state}${money}${why}`, ...common, ...withReason }];
        }
        if (item.event.type === ROUTE_SETTLED) {
          const p = item.event.payload as { routeId: string; expectedMinor: number; collectedMinor: number; exceptionCount: number; currency: string };
          return [{ kind: 'settlement', id: p.routeId, what: p.routeId, detail: `${p.collectedMinor} of ${p.expectedMinor} ${p.currency} · ${p.exceptionCount} ${p.exceptionCount === 1 ? 'exception' : 'exceptions'}`, ...common, ...withReason }];
        }
        if (item.event.type === RETURN_COLLECTION_RECORDED) {
          const p = item.event.payload as { returnId: string; orderRef: string; outcome: string; lines?: { productId: string; collectedMinor: number }[]; reason?: string };
          const area = this.pickups.find((c) => c.returnId === p.returnId)?.area ?? p.returnId;
          const detail = p.outcome === 'collected'
            ? `collected ${(p.lines ?? []).filter((l) => l.collectedMinor > 0).map((l) => `${l.collectedMinor} × ${l.productId}`).join(', ')}`
            : `not collected · ${p.reason ?? ''}`;
          return [{ kind: 'collection', id: p.returnId, what: `${area} · ${p.returnId}`, detail, ...common, ...withReason }];
        }
        if (item.event.type === DELIVERY_PROOF_CAPTURED) {
          const p = item.event.payload as { stopId: string; orderRef: string; kind: string; contentBase64: string };
          const area = this.stops.find((s) => s.stopId === p.stopId)?.area ?? p.stopId;
          return [{ kind: 'proof', id: p.stopId, what: `${area} · ${p.orderRef}`, detail: `${p.kind} · ${Math.round((p.contentBase64.length * 3) / 4 / 1024)} KB`, ...common, ...withReason }];
        }
        if (item.event.type === DRIVER_CASH_HANDED_OVER) {
          const p = item.event.payload as CashHandover;
          const variance = p.varianceMinor === 0 ? 'balanced' : p.varianceMinor > 0 ? `over ${p.varianceMinor}` : `short ${-p.varianceMinor}`;
          return [{ kind: 'handover', id: p.routeId, what: p.routeId, detail: `counted ${p.countedMinor} ${p.currency} · ${variance}${p.material ? ' · cash office' : ''}`, ...common, ...withReason }];
        }
        return [];
      })
      .reverse();
  }
}
