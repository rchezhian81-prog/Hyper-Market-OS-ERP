// Delivery execution (M19-FR-03) and controlled substitution (M19-FR-01). A stop
// moves through an auditable state machine and a delivery is only complete with
// PROOF (photo / OTP / signature). A short-pick substitution can only be applied
// when the CUSTOMER has confirmed it (A04 / hard rule #5 spirit) — the store never
// swaps an item on a customer without consent. Pure and deterministic; offline the
// caller queues these as events.
//
// The full delivery lifecycle (M19 target):
//
//   assigned → picked up → out for delivery → attempted → delivered
//                                                        → partially delivered
//                                                        → failed → reattempt / returned to origin
//
// - `order ready` is NOT a state here: it belongs to the ORDER lifecycle
//   (`packed`/`dispatched`); a ready order handed to a run ENTERS this machine at
//   `assigned`. We do not duplicate it as a delivery state.
// - `picked_up` is the parcels leaving the store's custody into the driver's; `arrive`
//   records the driver at the door BEFORE the outcome is known — useful for a failed or
//   partial attempt. Recording arrival is optional: offline a driver may go straight to
//   the outcome from `out_for_delivery` in one action, so those direct transitions stay
//   valid too (never force a second tap on a low-spec phone with no signal).
// - `partially_delivered` is TERMINAL: some lines were delivered WITH proof and the
//   customer interaction is complete. The undelivered remainder is corrected by
//   compensating money/stock events downstream (append-only, hard rule #2) — it is NOT
//   modelled by moving the whole delivery into `returned_to_origin`, which stays reserved
//   for the whole-order-undelivered case reached via `failed → rto`.

export type DeliveryState =
  | 'assigned'
  | 'picked_up'
  | 'out_for_delivery'
  | 'attempted'
  | 'delivered'
  | 'partially_delivered'
  | 'failed'
  | 'returned_to_origin';

export type DeliveryEvent =
  | 'pick_up'
  | 'depart'
  | 'arrive'
  | 'deliver'
  | 'deliver_partial'
  | 'fail'
  | 'reattempt'
  | 'rto';

const TRANSITIONS: Readonly<Record<DeliveryState, Partial<Record<DeliveryEvent, DeliveryState>>>> =
  Object.freeze({
    // The driver takes custody of the parcels, then departs. Departing straight from
    // `assigned` (without a separate pick-up ping) stays valid for offline one-tap use.
    assigned: { pick_up: 'picked_up', depart: 'out_for_delivery' },
    picked_up: { depart: 'out_for_delivery' },
    // At the door the driver may record arrival first (`arrive`) or go straight to an
    // outcome. Every outcome is reachable both ways so the device never loses an event.
    out_for_delivery: {
      arrive: 'attempted',
      deliver: 'delivered',
      deliver_partial: 'partially_delivered',
      fail: 'failed',
    },
    attempted: { deliver: 'delivered', deliver_partial: 'partially_delivered', fail: 'failed' },
    failed: { reattempt: 'out_for_delivery', rto: 'returned_to_origin' },
    delivered: {},
    partially_delivered: {},
    returned_to_origin: {},
  });

const TERMINAL: ReadonlySet<DeliveryState> = new Set<DeliveryState>([
  'delivered',
  'partially_delivered',
  'returned_to_origin',
]);

export class InvalidDeliveryTransitionError extends Error {
  constructor(from: DeliveryState, event: DeliveryEvent) {
    super(`Delivery cannot "${event}" from state "${from}".`);
    this.name = 'InvalidDeliveryTransitionError';
  }
}

export function transitionDelivery(from: DeliveryState, event: DeliveryEvent): DeliveryState {
  const next = TRANSITIONS[from][event];
  if (next === undefined) {
    throw new InvalidDeliveryTransitionError(from, event);
  }
  return next;
}

export function canTransitionDelivery(from: DeliveryState, event: DeliveryEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function isTerminalDelivery(state: DeliveryState): boolean {
  return TERMINAL.has(state);
}

export type ProofKind = 'photo' | 'otp' | 'signature';

export interface ProofOfDelivery {
  readonly kind: ProofKind;
  /** A reference/token for the proof artifact (PII minimized). */
  readonly ref: string;
}

export class ProofRequiredError extends Error {
  constructor() {
    super('A delivery cannot be marked delivered without proof (photo/OTP/signature).');
    this.name = 'ProofRequiredError';
  }
}

/** Assert a valid proof exists before completing a delivery (M19-FR-03). */
export function assertProofOfDelivery(proof: ProofOfDelivery | undefined): asserts proof {
  if (proof === undefined || typeof proof.ref !== 'string' || proof.ref.trim() === '') {
    throw new ProofRequiredError();
  }
}

export interface SubstitutionInput {
  readonly orderLineId: string;
  readonly originalProductId: string;
  readonly substituteProductId: string;
  /** The customer must have confirmed the swap (A04). */
  readonly customerConfirmed: boolean;
}

export interface AcceptedSubstitution {
  readonly orderLineId: string;
  readonly originalProductId: string;
  readonly substituteProductId: string;
  readonly status: 'accepted';
}

export class SubstitutionNotConfirmedError extends Error {
  constructor(orderLineId: string) {
    super(`Substitution on line "${orderLineId}" needs customer confirmation (A04).`);
    this.name = 'SubstitutionNotConfirmedError';
  }
}

/**
 * Apply a controlled substitution — only when the customer has confirmed it (A04).
 * Without confirmation it is refused; the line stays short and the order is updated
 * honestly (M18). Pure.
 */
export function confirmSubstitution(input: SubstitutionInput): AcceptedSubstitution {
  if (!input.customerConfirmed) {
    throw new SubstitutionNotConfirmedError(input.orderLineId);
  }
  return {
    orderLineId: input.orderLineId,
    originalProductId: input.originalProductId,
    substituteProductId: input.substituteProductId,
    status: 'accepted',
  };
}
