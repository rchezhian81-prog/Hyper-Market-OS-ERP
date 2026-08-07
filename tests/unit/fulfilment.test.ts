import { describe, it, expect } from 'vitest';
import {
  transitionDelivery,
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
