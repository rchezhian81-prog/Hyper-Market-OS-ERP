import { describe, it, expect } from 'vitest';
import {
  RouteSession,
  NoSuchStopError,
  ReasonRequiredError,
  type StopInput,
} from '../../apps/delivery-app/src/index';
import { ProofRequiredError, InvalidDeliveryTransitionError, CardDataError } from '../../packages/fulfilment/src/index';
import { money } from '../../packages/contracts/src/money';

// Nothing is delivered without proof; COD reconciles at end of shift; a failure
// records a reason and routes to reattempt/RTO; contribution flags are visible (M19).

const STOPS: StopInput[] = [
  { stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00, costMinor: 40_00, orderValueMinor: 250_00 },
  { stopId: 's2', orderRef: 'ORD-2', area: 'Gandhipuram', codMinor: 0, costMinor: 30_00, orderValueMinor: 1_000_00 },
];

const OTP = { kind: 'otp' as const, ref: '4821' };

function newRoute(rule?: { maxCostShareBps: number }) {
  return new RouteSession('route-1', 'driver-1', STOPS, 'INR', rule);
}

describe('RouteSession — the driver’s day', () => {
  it('lists assigned stops, all waiting', () => {
    const route = newRoute();
    expect(route.route()).toHaveLength(2);
    expect(route.progress()).toMatchObject({ total: 2, delivered: 0, remaining: 2, complete: false });
  });

  it('will not mark a stop delivered without proof (M19-FR-03)', () => {
    const route = newRoute();
    route.depart('s1');
    expect(() => route.deliver('s1', undefined, { codCollectedMinor: 250_00 })).toThrow(ProofRequiredError);
    expect(() => route.deliver('s1', { kind: 'photo', ref: '  ' })).toThrow(ProofRequiredError);
    expect(route.route()[0]?.state).toBe('out_for_delivery'); // not delivered
  });

  it('delivers with proof and records COD to the paisa', () => {
    const route = newRoute();
    route.depart('s1');
    const stop = route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });
    expect(stop.state).toBe('delivered');
    expect(stop.proof).toEqual(OTP);
    expect(route.codHeld()).toEqual(money(250_00, 'INR'));
  });

  it('refuses an illegal step, e.g. delivering before departing', () => {
    const route = newRoute();
    expect(() => route.deliver('s1', OTP)).toThrow(InvalidDeliveryTransitionError);
  });

  it('flags a geofence mismatch without blocking the delivery', () => {
    const route = newRoute();
    route.depart('s1');
    const stop = route.deliver('s1', OTP, { codCollectedMinor: 250_00, withinGeofence: false });
    expect(stop.state).toBe('delivered'); // not blocked — the driver may be a street away
    expect(stop.geofenceMismatch).toBe(true); // but it is visible on sync
  });

  it('records a failure with a reason and routes to reattempt or RTO', () => {
    const route = newRoute();
    route.depart('s1');
    expect(() => route.fail('s1', '  ')).toThrow(ReasonRequiredError);

    const failed = route.fail('s1', 'customer not at home');
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toBe('customer not at home');

    expect(route.reattempt('s1').state).toBe('out_for_delivery');
    route.fail('s1', 'still not home');
    expect(route.returnToOrigin('s1').state).toBe('returned_to_origin');
  });

  it('rejects an unknown stop', () => {
    const route = newRoute();
    expect(() => route.depart('nope')).toThrow(NoSuchStopError);
  });
});

describe('contribution stop rules (D09)', () => {
  it('flags an unprofitable stop rather than continuing silently', () => {
    // s1 costs ₹40 to deliver a ₹250 order = 16% > the 10% limit
    const route = newRoute({ maxCostShareBps: 1000 });
    route.depart('s1');
    const stop = route.deliver('s1', OTP, { codCollectedMinor: 250_00 });
    expect(stop.contributionFlag).toContain('16.0% of order value');
    expect(route.contributionFlags()).toHaveLength(1);
  });

  it('does not flag a stop within the rule', () => {
    // s2 costs ₹30 on a ₹1,000 order = 3%
    const route = newRoute({ maxCostShareBps: 1000 });
    route.depart('s2');
    const stop = route.deliver('s2', OTP);
    expect(stop.contributionFlag).toBeUndefined();
    expect(route.contributionFlags()).toHaveLength(0);
  });

  it('does not flag anything when the tenant has no rule configured', () => {
    const route = newRoute(); // no rule
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00 });
    expect(route.contributionFlags()).toHaveLength(0);
  });
});

describe('end-of-shift settlement (M19-FR-04)', () => {
  it('reconciles cash collected against the orders delivered', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });
    route.depart('s2');
    route.deliver('s2', OTP); // prepaid, no COD expected

    const settlement = route.settle();
    expect(settlement.matchedCount).toBe(1);
    expect(settlement.exceptionCount).toBe(0);
  });

  it('surfaces a short collection as a valued exception', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 200_00, codMethod: 'cash' }); // ₹50 short

    const settlement = route.settle();
    expect(settlement.exceptions[0]).toMatchObject({
      orderId: 'ORD-1',
      kind: 'short',
      varianceMinor: -50_00,
    });
  });

  it('surfaces an uncollected COD on a delivered stop', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 0 }); // delivered but nothing collected

    const settlement = route.settle();
    expect(settlement.exceptions[0]?.kind).toBe('uncollected');
  });

  it('refuses a card method — COD is cash/UPI only (hard rule #3)', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'card' });
    expect(() => route.settle()).toThrow(CardDataError);
  });

  it('carries no customer PII on the device', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00 });
    expect(JSON.stringify(route.route())).not.toMatch(/customerName|phone|email/i);
  });
});
