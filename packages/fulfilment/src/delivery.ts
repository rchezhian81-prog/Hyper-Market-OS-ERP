// Delivery execution (M19-FR-03) and controlled substitution (M19-FR-01). A stop
// moves through an auditable state machine and a delivery is only complete with
// PROOF (photo / OTP / signature). A short-pick substitution can only be applied
// when the CUSTOMER has confirmed it (A04 / hard rule #5 spirit) — the store never
// swaps an item on a customer without consent. Pure and deterministic; offline the
// caller queues these as events.

export type DeliveryState =
  | 'assigned'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'returned_to_origin';

export type DeliveryEvent = 'depart' | 'deliver' | 'fail' | 'reattempt' | 'rto';

const TRANSITIONS: Readonly<Record<DeliveryState, Partial<Record<DeliveryEvent, DeliveryState>>>> =
  Object.freeze({
    assigned: { depart: 'out_for_delivery' },
    out_for_delivery: { deliver: 'delivered', fail: 'failed' },
    failed: { reattempt: 'out_for_delivery', rto: 'returned_to_origin' },
    delivered: {},
    returned_to_origin: {},
  });

const TERMINAL: ReadonlySet<DeliveryState> = new Set<DeliveryState>([
  'delivered',
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
