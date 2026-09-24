import { describe, it, expect } from 'vitest';
import {
  transitionDelivery,
  canTransitionDelivery,
  isTerminalDelivery,
  assertProofOfDelivery,
  confirmSubstitution,
  reconcileCod,
  InvalidDeliveryTransitionError,
  ProofRequiredError,
  SubstitutionNotConfirmedError,
  CardDataError,
  type DeliveryState,
} from '../../packages/fulfilment/src/index';

// Delivery is an auditable state machine needing proof; substitution needs customer
// confirmation; COD reconciles to the paisa and never uses card data (M19).

describe('delivery lifecycle', () => {
  it('walks assigned → out_for_delivery → delivered', () => {
    let state: DeliveryState = 'assigned';
    state = transitionDelivery(state, 'depart');
    state = transitionDelivery(state, 'deliver');
    expect(state).toBe('delivered');
    expect(isTerminalDelivery(state)).toBe(true);
  });

  it('supports fail → reattempt and fail → return-to-origin', () => {
    const failed = transitionDelivery('out_for_delivery', 'fail');
    expect(failed).toBe('failed');
    expect(transitionDelivery('failed', 'reattempt')).toBe('out_for_delivery');
    expect(transitionDelivery('failed', 'rto')).toBe('returned_to_origin');
  });

  it('refuses an illegal transition', () => {
    expect(() => transitionDelivery('assigned', 'deliver')).toThrow(InvalidDeliveryTransitionError);
  });

  // M19: the full lifecycle — picked up, out for delivery, attempted, then delivered /
  // partially delivered / failed / returned. The customer got some goods on a partial,
  // so it is a COMPLETE (terminal) delivery, distinct from a whole-order return.
  it('walks the full path assigned → picked_up → out_for_delivery → attempted → delivered', () => {
    let state: DeliveryState = 'assigned';
    state = transitionDelivery(state, 'pick_up');
    expect(state).toBe('picked_up');
    state = transitionDelivery(state, 'depart');
    expect(state).toBe('out_for_delivery');
    state = transitionDelivery(state, 'arrive');
    expect(state).toBe('attempted');
    state = transitionDelivery(state, 'deliver');
    expect(state).toBe('delivered');
    expect(isTerminalDelivery(state)).toBe(true);
  });

  it('records a partial delivery as its own terminal outcome (some lines delivered, with proof)', () => {
    const attempted = transitionDelivery('out_for_delivery', 'arrive');
    const partial = transitionDelivery(attempted, 'deliver_partial');
    expect(partial).toBe('partially_delivered');
    expect(isTerminalDelivery('partially_delivered')).toBe(true);
    // Terminal — nothing follows a partial on the delivery machine; the undelivered
    // remainder is a compensating money/stock event downstream, not a state change.
    expect(canTransitionDelivery('partially_delivered', 'rto')).toBe(false);
    expect(canTransitionDelivery('partially_delivered', 'deliver')).toBe(false);
  });

  it('an attempt can also fail, then reattempt or return to origin', () => {
    const attempted = transitionDelivery('out_for_delivery', 'arrive');
    const failed = transitionDelivery(attempted, 'fail');
    expect(failed).toBe('failed');
    expect(transitionDelivery('failed', 'reattempt')).toBe('out_for_delivery');
    expect(transitionDelivery('failed', 'rto')).toBe('returned_to_origin');
    expect(isTerminalDelivery('returned_to_origin')).toBe(true);
  });

  it('keeps the direct offline shortcuts valid — no second tap forced with no signal', () => {
    // Depart straight from assigned (no separate pick-up ping) …
    expect(transitionDelivery('assigned', 'depart')).toBe('out_for_delivery');
    // … and resolve the outcome straight from out_for_delivery (no separate arrival ping).
    expect(transitionDelivery('out_for_delivery', 'deliver')).toBe('delivered');
    expect(transitionDelivery('out_for_delivery', 'deliver_partial')).toBe('partially_delivered');
    expect(transitionDelivery('out_for_delivery', 'fail')).toBe('failed');
  });

  it('refuses the illegal new transitions too', () => {
    expect(() => transitionDelivery('assigned', 'deliver_partial')).toThrow(InvalidDeliveryTransitionError);
    expect(() => transitionDelivery('picked_up', 'deliver')).toThrow(InvalidDeliveryTransitionError);
    expect(() => transitionDelivery('out_for_delivery', 'pick_up')).toThrow(InvalidDeliveryTransitionError);
    expect(() => transitionDelivery('delivered', 'deliver_partial')).toThrow(InvalidDeliveryTransitionError);
  });
});

describe('proof of delivery', () => {
  it('accepts a valid proof', () => {
    expect(() => assertProofOfDelivery({ kind: 'otp', ref: '4821' })).not.toThrow();
  });
  it('requires proof to complete a delivery', () => {
    expect(() => assertProofOfDelivery(undefined)).toThrow(ProofRequiredError);
    expect(() => assertProofOfDelivery({ kind: 'photo', ref: '  ' })).toThrow(ProofRequiredError);
  });
});

describe('substitution', () => {
  const base = { orderLineId: 'l1', originalProductId: 'p1', substituteProductId: 'p2' };
  it('applies only when the customer confirmed', () => {
    const accepted = confirmSubstitution({ ...base, customerConfirmed: true });
    expect(accepted.status).toBe('accepted');
    expect(accepted.substituteProductId).toBe('p2');
  });
  it('is refused without customer confirmation (A04)', () => {
    expect(() => confirmSubstitution({ ...base, customerConfirmed: false })).toThrow(
      SubstitutionNotConfirmedError,
    );
  });
});

describe('reconcileCod', () => {
  it('matches collections to expectations to the paisa', () => {
    const result = reconcileCod(
      [{ orderId: 'o1', expectedMinor: 250_00 }],
      [{ orderId: 'o1', collectedMinor: 250_00, method: 'cash' }],
    );
    expect(result.matchedCount).toBe(1);
    expect(result.exceptionCount).toBe(0);
  });

  it('flags short, over, uncollected and unexpected COD', () => {
    const result = reconcileCod(
      [
        { orderId: 'o1', expectedMinor: 250_00 },
        { orderId: 'o2', expectedMinor: 100_00 },
        { orderId: 'o3', expectedMinor: 90_00 }, // uncollected
      ],
      [
        { orderId: 'o1', collectedMinor: 200_00, method: 'cash' }, // short
        { orderId: 'o2', collectedMinor: 120_00, method: 'upi' }, // over
        { orderId: 'o4', collectedMinor: 50_00, method: 'cash' }, // unexpected
      ],
    );
    const kinds = Object.fromEntries(result.exceptions.map((e) => [e.orderId, e.kind]));
    expect(kinds).toEqual({ o1: 'short', o2: 'over', o3: 'uncollected', o4: 'unexpected' });
    const short = result.exceptions.find((e) => e.orderId === 'o1');
    expect(short?.varianceMinor).toBe(-50_00);
  });

  it('refuses a card method (COD is cash/UPI only, hard rule #3)', () => {
    expect(() =>
      reconcileCod([{ orderId: 'o1', expectedMinor: 100_00 }], [
        { orderId: 'o1', collectedMinor: 100_00, method: 'card' },
      ]),
    ).toThrow(CardDataError);
  });
});
