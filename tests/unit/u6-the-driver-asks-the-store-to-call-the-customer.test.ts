import { describe, it, expect } from 'vitest';
import {
  RouteSession, NoSuchStopError, CallAlreadyAskedError, StopFinishedError, DELIVERY_CALL_REQUESTED, SENT_WORK_KINDS,
} from '../../apps/delivery-app/src/route-session';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { personNamedBy } from '../../edge/store-edge/src/handheld-sign-in';
import { readRelayedCallRequest } from '../../services/fulfilment/src/driver-runs';

/**
 * **U6 · OB-700 (owner, 7 Nov 2026, decision 3 = B) · M19 · §31 — the driver asks the STORE to call the customer.**
 *
 * The driver's phone never holds the customer's name or number (§31, the handheld guardrail). So "customer contact" on a
 * stop is a request to the shop: one tap queues it on the phone, the store computer relays it, head office records it
 * once and tells the store. Thin payload: route, driver, stop, order reference, the area label — nothing about the person.
 */
const AT = '2026-11-07T13:30:00.000Z';
const STOPS = [
  { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 25_000 },
  { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0 },
];

describe('the driver asks the store to call the customer (OB-700)', () => {
  it('one tap queues ONE request per stop, thin, in the driver\'s name; a second ask is refused by name; a finished stop takes none', () => {
    const outbox = new SyncOutbox();
    const s = new RouteSession('R-7', 'u-driver', STOPS, outbox, { now: () => AT });
    const asked = s.askStoreToCall('s1');
    expect(asked).toEqual({ stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', askedAt: AT });
    expect(() => s.askStoreToCall('s1')).toThrow(CallAlreadyAskedError);
    expect(() => s.askStoreToCall('nope')).toThrow(NoSuchStopError);
    const items = outbox.all();
    expect(items.map((i) => [i.event.type, i.key])).toEqual([[DELIVERY_CALL_REQUESTED, 'call:R-7:s1']]);
    expect(items[0]!.event.payload).toEqual({ routeId: 'R-7', driverId: 'u-driver', stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', occurredAt: AT });
    expect(JSON.stringify(items[0]!.event.payload)).not.toMatch(/customer|phone|mobile|name|address/i);
    expect(s.callRequested('s1')).toBe(true);
    expect(s.callRequested('s2')).toBe(false);
    // The "Sent from this phone" list names it as its own kind of work.
    expect((SENT_WORK_KINDS as readonly string[]).includes('call')).toBe(true);
    expect(s.sentWork().map((w) => [w.kind, w.id, w.what])).toEqual([['call', 's1', 'Anna Nagar, 3rd St · ORD-1041']]);
    // A stop already delivered needs no call.
    s.depart('s2'); s.arrive('s2');
    s.deliver('s2', { kind: 'otp', code: '1234' });
    expect(() => s.askStoreToCall('s2')).toThrow(StopFinishedError);
    expect(outbox.all().filter((i) => i.event.type === DELIVERY_CALL_REQUESTED)).toHaveLength(1);
  });

  it('rides the box\'s allow-list as driver work, is routed to its own synced route, and names the driver for the box\'s sign-in check', () => {
    const outbox = new SyncOutbox();
    new RouteSession('R-7', 'u-driver', STOPS, outbox, { now: () => AT }).askStoreToCall('s1');
    const ev = outbox.all()[0]!.event;
    expect(isRelayable(DELIVERY_CALL_REQUESTED, 'driver')).toBe(true);
    expect(isRelayable(DELIVERY_CALL_REQUESTED, 'picker')).toBe(false);
    expect(pathFor(ev)).toBe('/v1/delivery/routes/R-7/stops/s1/call-request/synced');
    expect(personNamedBy(ev)).toEqual({ ok: true, userId: 'u-driver' });
  });

  it('head office reads exactly the thin payload and nothing less', () => {
    const good = { routeId: 'R-7', driverId: 'u-driver', stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar', occurredAt: AT };
    expect(readRelayedCallRequest(good, 'R-7', 's1', '2026-11-07T14:00:00.000Z')).toEqual({ driverId: 'u-driver', orderRef: 'ORD-1041', area: 'Anna Nagar', at: AT });
    expect(readRelayedCallRequest({ ...good, routeId: 'R-9' }, 'R-7', 's1', AT)).toBeUndefined();
    expect(readRelayedCallRequest({ ...good, driverId: '' }, 'R-7', 's1', AT)).toBeUndefined();
    expect(readRelayedCallRequest({ ...good, orderRef: undefined }, 'R-7', 's1', AT)).toBeUndefined();
    expect(readRelayedCallRequest({ ...good, occurredAt: 'yesterday' }, 'R-7', 's1', AT)).toEqual({ driverId: 'u-driver', orderRef: 'ORD-1041', area: 'Anna Nagar', at: AT });
    expect(readRelayedCallRequest('nope', 'R-7', 's1', AT)).toBeUndefined();
  });
});
