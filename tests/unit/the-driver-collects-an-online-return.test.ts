import { describe, it, expect } from 'vitest';
import { foldOnlineReturn, checkCollectedLines, type OnlineReturnStep } from '../../packages/storefront/src/online-returns';
import { readRelayedCollection } from '../../services/orders/src/storefront-online-returns';
import { RouteSession, CollectionLinesError, CollectionDoneError, NoSuchCollectionError, RETURN_COLLECTION_RECORDED, SENT_WORK_KINDS } from '../../apps/delivery-app/src/route-session';
import { bootDriver } from '../../apps/delivery-app/src/browser-entry';
import { openDeviceOutbox, guardedStore } from '../../packages/sync/src/device-outbox';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { readAssignmentsFeed } from '../../edge/sync-agent/src/assignments-feed';
import { personNamedBy } from '../../edge/store-edge/src/handheld-sign-in';
import { makeEvent } from '../../packages/contracts/src/event';

/** R4 · WF-16 (signed) — the driver collects an online return: the pure rules on the phone, the record, and head office's reader. */

const AT = '2026-10-19T08:00:00.000Z';
const booked = (extra: OnlineReturnStep[] = []): OnlineReturnStep[] => [
  { kind: 'requested', returnId: 'R', orderId: 'O', customerRef: 'c', lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'BREAD', quantityMinor: 1 }], reason: 'x', at: '2026-10-18T00:00:00.000Z' },
  { kind: 'collection_scheduled', returnId: 'R', collectOn: '2026-10-19', by: 'm', at: '2026-10-18T01:00:00.000Z' },
  ...extra,
];

describe('head office\'s rules for what a driver collected', () => {
  it('only booked lines, whole numbers, never more than booked; a line not named is 0; nothing at all is not a collection', () => {
    const v = foldOnlineReturn(booked())!;
    expect(checkCollectedLines(v, [{ productId: 'MILK', collectedMinor: 1 }])).toEqual({ ok: true, lines: [{ productId: 'MILK', collectedMinor: 1 }, { productId: 'BREAD', collectedMinor: 0 }] });
    expect(checkCollectedLines(v, [{ productId: 'MILK', collectedMinor: 3 }])).toEqual({ ok: false, code: 'more_than_booked', detail: 'MILK: collected 3, but 2 was booked for collection' });
    expect(checkCollectedLines(v, [{ productId: 'EGG', collectedMinor: 1 }])).toMatchObject({ ok: false, code: 'not_on_this_return' });
    expect(checkCollectedLines(v, [{ productId: 'MILK', collectedMinor: 1.5 }])).toMatchObject({ ok: false, code: 'not_a_whole_number' });
    expect(checkCollectedLines(v, [{ productId: 'MILK', collectedMinor: 1 }, { productId: 'MILK', collectedMinor: 1 }])).toMatchObject({ ok: false, code: 'counted_twice' });
    expect(checkCollectedLines(v, [{ productId: 'MILK', collectedMinor: 0 }])).toMatchObject({ ok: false, code: 'nothing_collected' });
  });

  it('a driver\'s collection folds to "collected" with what he took; a miss keeps the booking and is said to the customer', () => {
    const missed = foldOnlineReturn(booked([{ kind: 'collection_missed', returnId: 'R', reason: 'customer_not_available', routeId: 'R-7', by: 'u-driver', at: AT }]))!;
    expect(missed.stage).toBe('collection_scheduled');
    expect(missed.missedCollections).toEqual([{ at: AT, reason: 'customer_not_available', by: 'u-driver' }]);
    expect(missed.steps.at(-1)!.say).toBe('The driver came to collect, but nobody was there to hand it over. The shop will book again.');
    const got = foldOnlineReturn(booked([{ kind: 'collected', returnId: 'R', by: 'u-driver', at: AT, routeId: 'R-7', relayedBy: 'u-box', lines: [{ productId: 'MILK', collectedMinor: 1 }, { productId: 'BREAD', collectedMinor: 0 }] }]))!;
    expect(got).toMatchObject({ stage: 'collected', collectedBy: 'u-driver', collectedOnRoute: 'R-7' });
    expect(got.lines.map((l) => [l.productId, l.collectedMinor])).toEqual([['MILK', 1], ['BREAD', 0]]);
    expect(got.steps.at(-1)!.say).toBe('Collected from you: 1 × MILK');
    // The desk's button (no lines) still reads as it always did.
    const desk = foldOnlineReturn(booked([{ kind: 'collected', returnId: 'R', by: 'm', at: AT }]))!;
    expect(desk.lines[0]!.collectedMinor).toBeUndefined();
    expect(desk.steps.at(-1)!.say).toBe('Collected from you');
  });

  it('the shop\'s count against what the driver took: every difference is shown, never absorbed (hard rule #10)', () => {
    const took = { kind: 'collected' as const, returnId: 'R', by: 'u-driver', at: AT, routeId: 'R-7', relayedBy: 'u-box', lines: [{ productId: 'MILK', collectedMinor: 2 }, { productId: 'BREAD', collectedMinor: 1 }] };
    const counted = (milk: number, bread: number): OnlineReturnStep => ({ kind: 'received', returnId: 'R', by: 'm', at: '2026-10-19T10:00:00.000Z', lines: [{ productId: 'MILK', receivedMinor: milk }, { productId: 'BREAD', receivedMinor: bread }] });
    // Before the count, and when they agree: nothing to show.
    expect(foldOnlineReturn(booked([took]))!.countDifferences).toEqual([]);
    expect(foldOnlineReturn(booked([took, counted(2, 1)]))!.countDifferences).toEqual([]);
    // One milk lost between the van and the shop: named, with both figures.
    expect(foldOnlineReturn(booked([took, counted(1, 1)]))!.countDifferences).toEqual([{ productId: 'MILK', collectedMinor: 2, receivedMinor: 1 }]);
    // The desk's button carries no lines, so there is nothing to compare against — no difference is invented.
    expect(foldOnlineReturn(booked([{ kind: 'collected', returnId: 'R', by: 'm', at: AT }, counted(1, 0)]))!.countDifferences).toEqual([]);
  });

  it('reads the relayed record strictly: the path\'s return, a route, a driver, one of two outcomes, a reason from the closed list', () => {
    const base = { returnId: 'R', routeId: 'R-7', driverId: 'u-driver' };
    expect(readRelayedCollection({ ...base, outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 1 }], occurredAt: AT }, 'R')).toEqual({ routeId: 'R-7', driverId: 'u-driver', outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 1 }], at: AT });
    expect(readRelayedCollection({ ...base, outcome: 'not_collected', reason: 'nothing_handed_over' }, 'R')).toMatchObject({ outcome: 'not_collected', reason: 'nothing_handed_over' });
    expect(readRelayedCollection({ ...base, outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 1 }] }, 'OTHER')).toBeUndefined();
    expect(readRelayedCollection({ ...base, outcome: 'not_collected', reason: 'felt like it' }, 'R')).toBeUndefined();
    expect(readRelayedCollection({ ...base, outcome: 'collected', lines: [] }, 'R')).toBeUndefined();
    expect(readRelayedCollection({ ...base, outcome: 'refunded' }, 'R')).toBeUndefined();
  });
});

const COLLECTIONS = [
  { returnId: 'RET-1', orderRef: 'ORD-1', area: 'Gandhipuram', collectOn: '2026-10-19', lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'BREAD', quantityMinor: 1 }] },
  { returnId: 'RET-2', orderRef: 'ORD-2', area: 'RS Puram', collectOn: '2026-10-19', lines: [{ productId: 'MILK', quantityMinor: 1 }] },
];

describe('the driver\'s phone', () => {
  it('collects from the booked lines only — more than booked is refused by name and queues nothing; once collected, never again', () => {
    const outbox = new SyncOutbox();
    const s = new RouteSession('R-7', 'u-driver', [], outbox, { collections: COLLECTIONS, now: () => AT });
    expect(s.collections().map((c) => c.state)).toEqual(['booked', 'booked']);
    expect(() => s.collect('RET-1', [{ productId: 'MILK', collectedMinor: 3 }])).toThrow(CollectionLinesError);
    try { s.collect('RET-1', [{ productId: 'MILK', collectedMinor: 3 }]); } catch (e) { expect((e as CollectionLinesError).code).toBe('more_than_booked'); expect((e as Error).message).toBe('MILK: collected 3, but 2 was booked for collection'); }
    expect(() => s.collect('RET-1', [{ productId: 'EGG', collectedMinor: 1 }])).toThrow(/was not booked/);
    expect(() => s.collect('RET-1', [])).toThrow(/nothing handed over/);
    expect(() => s.collect('NOPE', [])).toThrow(NoSuchCollectionError);
    expect(outbox.all()).toHaveLength(0);

    const c = s.collect('RET-1', [{ productId: 'MILK', collectedMinor: 1 }]);
    expect(c).toMatchObject({ state: 'collected', taken: [{ productId: 'MILK', collectedMinor: 1 }, { productId: 'BREAD', collectedMinor: 0 }] });
    expect(() => s.collect('RET-1', [{ productId: 'MILK', collectedMinor: 1 }])).toThrow(CollectionDoneError);
    expect(() => s.notCollected('RET-1', 'customer_not_available')).toThrow(CollectionDoneError);
    s.notCollected('RET-2', 'customer_not_available');
    expect(() => s.notCollected('RET-2', 'bored' as never)).toThrow();
    const items = outbox.all();
    expect(items.map((i) => [i.event.type, i.key])).toEqual([
      [RETURN_COLLECTION_RECORDED, 'return-collection:R-7:RET-1:collected'],
      [RETURN_COLLECTION_RECORDED, 'return-collection:R-7:RET-2:not_collected:1'],
    ]);
    // Thin: references, products and quantities, the reason. No customer, no money.
    expect(items[0]!.event.payload).toEqual({ returnId: 'RET-1', routeId: 'R-7', driverId: 'u-driver', orderRef: 'ORD-1', outcome: 'collected', occurredAt: AT, lines: [{ productId: 'MILK', collectedMinor: 1 }, { productId: 'BREAD', collectedMinor: 0 }] });
    expect(s.sentWork().map((w) => [w.kind, w.id, w.detail])).toEqual([
      ['collection', 'RET-2', 'not collected · customer_not_available'],
      ['collection', 'RET-1', 'collected 1 × MILK'],
    ]);
    expect(SENT_WORK_KINDS).toContain('collection');
  });

  it('after the app is closed the durable queue decides: a collected return stays collected; a route of collections alone still boots', () => {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => { backing.set(k, v); } };
    const first = bootDriver({ routeId: 'R-7', driverId: 'u-driver', stops: [], collections: COLLECTIONS }, openDeviceOutbox(guardedStore('q', storage, () => {}), () => {}), () => AT)!;
    first.collect('RET-1', [{ productId: 'MILK', collectedMinor: 2 }]);
    first.notCollected('RET-2', 'nothing_handed_over');
    const again = bootDriver({ routeId: 'R-7', driverId: 'u-driver', stops: [], collections: COLLECTIONS }, openDeviceOutbox(guardedStore('q', storage, () => {}), () => {}), () => AT)!;
    expect(again.collections().map((c) => [c.returnId, c.state, c.missedVisits])).toEqual([['RET-1', 'collected', 0], ['RET-2', 'not_collected', 1]]);
    expect(() => again.collect('RET-1', [{ productId: 'MILK', collectedMinor: 1 }])).toThrow(CollectionDoneError);
    again.notCollected('RET-2', 'customer_not_available');
    expect(bootDriver({ routeId: 'R-7', driverId: 'u-driver', stops: [], collections: [] }, openDeviceOutbox(guardedStore('z', storage, () => {}), () => {}))).toBeNull();
  });
});

describe('the record\'s road: phone → box → head office', () => {
  const ev = makeEvent({ id: 'k', type: RETURN_COLLECTION_RECORDED, occurredAt: AT, idempotencyKey: 'k', source: 'R-7', payload: { returnId: 'RET-1', routeId: 'R-7', driverId: 'u-driver', outcome: 'collected', lines: [] } });
  it('rides only from the driver\'s phone, names the driver, and goes to its own head-office route', () => {
    expect(isRelayable(RETURN_COLLECTION_RECORDED, 'driver')).toBe(true);
    expect(isRelayable(RETURN_COLLECTION_RECORDED, 'picker')).toBe(false);
    expect(isRelayable(RETURN_COLLECTION_RECORDED, 'manager')).toBe(false);
    expect(personNamedBy(ev)).toEqual({ ok: true, userId: 'u-driver' });
    expect(pathFor(ev)).toBe('/v1/online-returns/RET-1/collection/synced');
  });
  it('the box reads a feed\'s collections strictly — a line without a quantity makes the whole feed unreadable', () => {
    const feed = { asAt: AT, storeId: 's', waves: [], routes: [{ routeId: 'R-7', driverId: 'd', assignedBy: 'o', assignedAt: AT, stops: [], collections: COLLECTIONS }] };
    expect(readAssignmentsFeed(feed)).toBeDefined();
    expect(readAssignmentsFeed({ ...feed, routes: [{ ...feed.routes[0]!, collections: [{ ...COLLECTIONS[0]!, lines: [{ productId: 'MILK' }] }] }] })).toBeUndefined();
  });
});
