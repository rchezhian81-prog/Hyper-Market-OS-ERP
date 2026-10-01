import { describe, it, expect } from 'vitest';
import {
  RouteSession,
  NoSuchStopError,
  ReasonRequiredError,
  SENT_WORK_KINDS,
  DELIVERY_STOP_UPDATED,
  ROUTE_SETTLED,
  DRIVER_CASH_HANDED_OVER,
  type StopInput,
} from '../../apps/delivery-app/src/index';
import { ProofRequiredError, InvalidDeliveryTransitionError, CardDataError } from '../../packages/fulfilment/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';

// Nothing is delivered without proof; COD reconciles at end of shift; a failure
// records a reason and routes to reattempt/RTO; contribution flags are visible (M19).

const STOPS: StopInput[] = [
  { stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00, costMinor: 40_00, orderValueMinor: 250_00 },
  { stopId: 's2', orderRef: 'ORD-2', area: 'Gandhipuram', codMinor: 0, costMinor: 30_00, orderValueMinor: 1_000_00 },
];

const OTP = { kind: 'otp' as const, ref: '4821' };

/** The outbox is required now — COD nothing queued is cash in a pocket with no record of it. */
function newRoute(rule?: { maxCostShareBps: number }, outbox: SyncOutbox = new SyncOutbox()) {
  return new RouteSession('route-1', 'driver-1', STOPS, outbox, {
    currency: 'INR',
    now: () => '2026-08-02T10:00:00Z',
    ...(rule === undefined ? {} : { contributionRule: rule }),
  });
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

// The extended delivery lifecycle on the driver's phone (M19-FR-01/FR-03): picked up from the store,
// arrived at the door, and a PARTIAL delivery — the customer kept some of the order, with proof.
describe('RouteSession — picked-up, arrived and partial delivery (M19-FR-01/FR-03)', () => {
  it('drives the full lifecycle: pick up → depart → arrive → deliver', () => {
    const route = newRoute();
    expect(route.pickUp('s1').state).toBe('picked_up'); // left the shelf
    expect(route.depart('s1').state).toBe('out_for_delivery');
    expect(route.arrive('s1').state).toBe('attempted'); // reached the door
    expect(route.deliver('s1', OTP, { codCollectedMinor: 250_00 }).state).toBe('delivered');
  });

  it('refuses an out-of-order lifecycle step (arrive before departing; pick up after departing)', () => {
    const route = newRoute();
    expect(() => route.arrive('s1')).toThrow(InvalidDeliveryTransitionError); // not out for delivery yet
    route.depart('s1');
    expect(() => route.pickUp('s1')).toThrow(InvalidDeliveryTransitionError); // already gone
  });

  it('records a partial delivery with proof — terminal, COD on the books, cannot be re-delivered', () => {
    const route = newRoute();
    route.depart('s1');
    expect(() => route.deliverPartial('s1', undefined, { codCollectedMinor: 100_00 })).toThrow(ProofRequiredError);

    const stop = route.deliverPartial('s1', OTP, { codCollectedMinor: 100_00, codMethod: 'cash' });
    expect(stop.state).toBe('partially_delivered');
    expect(stop.proof).toEqual(OTP);
    expect(route.codHeld()).toEqual(money(100_00, 'INR')); // cash taken on a partial is not off the books
    // Terminal: the undelivered remainder is a downstream compensating event, not a re-delivery here.
    expect(() => route.deliver('s1', OTP)).toThrow(InvalidDeliveryTransitionError);
  });

  it('allows a partial delivery straight from arrival too', () => {
    const route = newRoute();
    route.depart('s1');
    route.arrive('s1');
    expect(route.deliverPartial('s1', OTP, { codCollectedMinor: 50_00 }).state).toBe('partially_delivered');
  });

  it('counts a partial as a terminal outcome — the route completes with a mix of delivered and partial', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliverPartial('s1', OTP, { codCollectedMinor: 100_00 });
    route.depart('s2');
    route.deliver('s2', OTP); // prepaid
    expect(route.progress()).toMatchObject({ total: 2, delivered: 1, partiallyDelivered: 1, remaining: 0, complete: true });
  });

  it('settles a partial delivery to what was actually collected — no false short for the undelivered part', () => {
    const route = newRoute();
    route.depart('s1'); // s1 expects ₹250 COD in full
    route.deliverPartial('s1', OTP, { codCollectedMinor: 100_00, codMethod: 'cash' }); // only some goods handed over
    const settlement = route.settle();
    expect(settlement.matchedCount).toBe(1); // reconciles to the ₹100 actually taken
    expect(settlement.exceptionCount).toBe(0);
  });
});

// ── SP-3c-ii: the phone can say where each piece of work has got to — from the durable queue and the box's word ──────

describe('where each piece of work is — the five shared device states (SP-3c-ii)', () => {
  it('lists every stop outcome, the settlement and the handover newest first as "saved here"; moves to "with the store computer" when the box takes them; "posted" / "refused" only on the box\'s word', () => {
    const outbox = new SyncOutbox();
    const route = newRoute(undefined, outbox);
    expect(route.sentWork()).toEqual([]);
    expect(route.handedKeys()).toEqual([]);
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });
    route.depart('s2');
    route.fail('s2', 'nobody_home');
    route.settle();
    route.handOver({ countedMinor: 240_00, at: '2026-08-02T18:00:00Z', toleranceMinor: 10_000 });

    const before = route.sentWork();
    expect(before.map((w) => [w.kind, w.id, w.state])).toEqual([
      ['handover', 'route-1', 'saved_here'],
      ['settlement', 'route-1', 'saved_here'],
      ['stop', 's2', 'saved_here'],
      ['stop', 's2', 'saved_here'],
      ['stop', 's1', 'saved_here'],
      ['stop', 's1', 'saved_here'],
    ]);
    expect(before[4]).toMatchObject({ what: 'Anna Nagar · ORD-1', detail: 'delivered · 25000 INR' });
    expect(before[5]).toMatchObject({ what: 'Anna Nagar · ORD-1', detail: 'out_for_delivery' });
    expect(before[2]).toMatchObject({ what: 'Gandhipuram · ORD-2', detail: 'failed · nobody_home' });
    expect(before[1]).toMatchObject({ what: 'route-1', detail: '25000 of 25000 INR · 0 exceptions' });
    expect(before[0]).toMatchObject({ what: 'route-1', detail: 'counted 24000 INR · short 1000' });
    for (const kind of SENT_WORK_KINDS) expect(before.some((w) => w.kind === kind)).toBe(true);
    // Never a customer on the list (§31).
    expect(JSON.stringify(before)).not.toMatch(/customer|phone|address/i);

    // The box takes the stop outcomes (the device's "acknowledged" = the box has them — never "posted" on the device's say-so).
    const stopKeys = outbox.pending().filter((i) => i.event.type === DELIVERY_STOP_UPDATED).map((i) => i.key);
    for (const k of stopKeys) outbox.acknowledge(k);
    expect(route.handedKeys()).toEqual(stopKeys);
    expect(route.sentWork().map((w) => w.state)).toEqual(['saved_here', 'saved_here', 'handed_to_box', 'handed_to_box', 'handed_to_box', 'handed_to_box']);

    // The box's word: the delivery posted at head office; the failure refused with the reason.
    route.noteBoxStatus([
      { key: 'stop:route-1:s1:delivered', state: 'posted', attempts: 1 },
      { key: 'stop:route-1:s2:failed', state: 'refused', attempts: 1, reason: 'not_readable_as_a_stop_outcome' },
    ]);
    const after = route.sentWork();
    expect(after.find((w) => w.id === 's1' && w.detail.startsWith('delivered'))?.state).toBe('posted');
    expect(after.find((w) => w.id === 's2' && w.detail.startsWith('failed'))).toMatchObject({ state: 'refused', reason: 'not_readable_as_a_stop_outcome' });

    // A settlement the box refuses outright is dead-lettered on the device, with the reason — and stays listed.
    const settleKey = outbox.pending().find((i) => i.event.type === ROUTE_SETTLED)!.key;
    outbox.deadLetter(settleKey, 'RouteSettled is not a record this box relays for picker');
    expect(route.sentWork()[1]).toMatchObject({ kind: 'settlement', state: 'refused', reason: 'RouteSettled is not a record this box relays for picker' });
    expect(outbox.pending().some((i) => i.event.type === DRIVER_CASH_HANDED_OVER)).toBe(true);
  });
});
