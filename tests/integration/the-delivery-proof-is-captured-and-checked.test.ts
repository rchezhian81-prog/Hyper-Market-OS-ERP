import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, dayFigures, codeOf, OWNER, DISPATCHER, DRIVER, DRIVER2, CASHIER, STORE_ID, DOORS, type Shop } from '../support/fulfilment-shop';

// M19-FR-03 · WF-15 · D08-FR-05 · D09-FR-05 · OB-294 (owner, 23 Oct 2026) — the dispatch office plans the day from head
// office's OWN confirmed delivery orders and hands each route to its driver; head office issues each order's 4-digit code,
// which only that customer's app can read (another customer is refused AND recorded); the customer sees the driver's last
// stamped stop and an ETA; when the driver's phone reaches head office (through the store computer) the code is judged
// (matched / wrong), the phone's location is judged against the booking's stored coordinates (radius "not set" decides
// nothing; the owner's radius then says inside / outside — the coordinates are not kept), and the captured photo is kept
// as a document whose SHA-256 must be the bytes' own. A driver off the road: routes no door was recorded on are taken
// back and the day re-planned; a started route is refused. 403s throughout. In memory and on real PostgreSQL, with a
// cold restart. Synthetic data.

const backings = useRestartableBackings();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(300, 9), Buffer.from([0xff, 0xd9])]);
const SHA = createHash('sha256').update(JPEG).digest('hex');

interface PlanBody { plan: { routes: { routeId: string; driverId: string; slotId: string; stops: { stopId: string; orderId: string; sequence: number }[] }[]; unplanned: { orderId: string; reason: string }[] }; held: unknown[] }

async function planned(shop: Shop, drivers?: readonly string[]): Promise<PlanBody> {
  return (await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, DISPATCHER, dayFigures(shop, drivers))) as unknown as PlanBody;
}
/** What the driver's phone queues for a stop, as the store computer relays it (`DeliveryStopUpdated`). */
const stopUpdate = (routeId: string, stopId: string, orderRef: string, state: string, extra: Record<string, unknown> = {}) => ({
  routeId, stopId, driverId: DRIVER, orderRef, state, codExpectedMinor: 0, codCollectedMinor: 0, codMethod: null, proofKind: null,
  geofenceMismatch: false, failureReason: null, contributionFlag: null, currency: 'INR', occurredAt: new Date().toISOString(), ...extra,
});

describe.each(backings)('delivery proof is captured and checked (M19-FR-03 · OB-294 · D09-FR-05) — on $name', ({ harness }) => {
  it('plan → hand out → the customer\'s own code and ETA → the door: code judged, location judged, photo kept → the board → a restart', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    await shop.placeConfirmed('c-1', 'ORD-1', [['RICE', 1]], 1, DOORS.near);
    await shop.placeConfirmed('c-2', 'ORD-2', [['DAL', 2]], 1, DOORS.mid);
    await shop.placeConfirmed('c-3', 'ORD-3', [['OIL', 1]], 3, DOORS.far);

    // ── Plan from head office's own orders; refused for a cashier and for a body without the day's figures.
    expect((await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, CASHIER, dayFigures(shop))).status).toBe(403);
    expect(codeOf(await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, DISPATCHER, { storeId: STORE_ID, drivers: [] }))).toBe('not_readable_as_a_dispatch');
    const p = await planned(shop);
    expect(p.plan.unplanned).toEqual([]);
    expect(p.plan.routes.map((r) => r.stops.map((s) => s.orderId))).toEqual([['ORD-1', 'ORD-2'], ['ORD-3']]); // windows beat geography
    const [r1, r2] = p.plan.routes as [PlanBody['plan']['routes'][0], PlanBody['plan']['routes'][0]];

    // ── Not given out yet; the customer's ETA says "not on a route".
    const board0 = await shop.ok('GET', `/v1/delivery/dispatch/${shop.runDate}/board`, DISPATCHER, undefined, { storeId: STORE_ID });
    expect((board0['routes'] as { status: string }[]).map((r) => r.status)).toEqual(['not_assigned', 'not_assigned']);
    expect(await shop.ok('GET', '/v1/storefront/orders/ORD-1/delivery-eta', 'c-1')).toMatchObject({ state: 'not_on_a_route', estimatedArrivalAt: null });

    // ── Hand route 1 to the driver: on the register the box pulls; each order's code issued; the stop index written.
    expect((await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(r1.routeId)}/assign`, CASHIER, { storeId: STORE_ID })).status).toBe(403);
    expect((await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(r1.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID })).status).toBe(201);
    const pulled = await shop.ok('GET', '/v1/fulfilment/assignments', OWNER, undefined, { storeId: STORE_ID });
    expect(pulled['routes']).toEqual([expect.objectContaining({ routeId: r1.routeId, driverId: DRIVER, stops: [expect.objectContaining({ orderRef: 'ORD-1' }), expect.objectContaining({ orderRef: 'ORD-2' })] })]);
    expect(JSON.stringify(pulled)).not.toMatch(/"code"|11\.02|76\.96/); // the phone is never handed the code or the door's coordinates
    expect(await shop.ok('GET', '/v1/delivery/orders/ORD-1/proof', DISPATCHER)).toMatchObject({ codeIssued: true, door: null, images: [] });

    // ── The customer's OWN code: four digits; another customer is refused and the attempt recorded; staff never see it.
    const code1 = (await shop.ok('GET', '/v1/storefront/orders/ORD-1/delivery-code', 'c-1'))['code'] as string;
    expect(code1).toMatch(/^\d{4}$/);
    expect((await shop.ok('GET', '/v1/storefront/orders/ORD-1/delivery-code', 'c-1'))['code']).toBe(code1); // issued once
    const probe = await shop.call('GET', '/v1/storefront/orders/ORD-1/delivery-code', 'c-2');
    expect([probe.status, codeOf(probe)]).toEqual([403, 'not_your_order']);
    expect(((await shop.ok('GET', '/v1/storefront/access-refusals', OWNER))['refusals'] as { orderId: string; customerRef: string }[])).toEqual([expect.objectContaining({ orderId: 'ORD-1', customerRef: 'c-2' })]);
    expect((await shop.call('GET', '/v1/storefront/orders/ORD-1/delivery-code', DISPATCHER)).status).toBe(403);
    expect(JSON.stringify(await shop.ok('GET', '/v1/delivery/orders/ORD-1/proof', DISPATCHER))).not.toContain(code1);
    expect(await shop.ok('GET', '/v1/storefront/orders/ORD-2/delivery-eta', 'c-2')).toMatchObject({ state: 'not_started', stopsBeforeYou: 1, stopsOnRun: 2, estimateIs: 'straight_line_estimate' });

    // ── The door, as the store computer relays the phone's records. Stop 1: the customer's code, the phone at the door.
    const [s1, s2] = r1.stops as unknown as [{ stopId: string }, { stopId: string }];
    const relay = (stopId: string, body: unknown) => shop.call('POST', `/v1/delivery/routes/${encodeURIComponent(r1.routeId)}/stops/${encodeURIComponent(stopId)}/synced`, OWNER, body);
    expect((await relay(s1.stopId, stopUpdate(r1.routeId, s1.stopId, 'ORD-1', 'out_for_delivery'))).status).toBe(202);
    const d1 = await relay(s1.stopId, stopUpdate(r1.routeId, s1.stopId, 'ORD-1', 'delivered', { proofKind: 'otp', proofCode: code1, deviceFix: { lat: DOORS.near.lat + 0.0001, lon: DOORS.near.lon, accuracyMetres: 10 } }));
    expect(d1.status).toBe(202);
    // The owner has not set the radius: the distance is said, nothing is decided.
    expect((d1.body as { proofCheck: unknown }).proofCheck).toEqual({ code: 'matched', fence: { result: 'radius_not_set', distanceMetres: expect.any(Number), accuracyMetres: 10 }, imageSha256: null });
    expect((d1.body as { flags: string[] }).flags).toEqual([]);
    // A malformed code from a phone cannot be read at all — kept at the store for a person, never guessed.
    expect(codeOf(await relay(s2.stopId, stopUpdate(r1.routeId, s2.stopId, 'ORD-2', 'delivered', { proofKind: 'otp', proofCode: '12' })))).toBe('not_readable_as_a_stop_outcome');

    // ── The owner sets the radius (only the owner); then stop 2: a photo, the phone 2 km from the door → outside.
    expect((await shop.call('POST', '/v1/delivery/controls', DISPATCHER, { geofenceRadiusMetres: 150 })).status).toBe(403);
    expect(codeOf(await shop.call('POST', '/v1/delivery/controls', OWNER, { geofenceRadiusMetres: 0 }))).toBe('not_readable_as_delivery_controls');
    await shop.ok('POST', '/v1/delivery/controls', OWNER, { geofenceRadiusMetres: 150 });
    const controls = await shop.ok('GET', '/v1/delivery/controls', DISPATCHER);
    expect((controls['numbers'] as { key: string; value: unknown; state: string }[]).find((n) => n.key === 'geofenceRadiusMetres')).toMatchObject({ value: 150, state: 'set', setBy: OWNER });
    expect(controls['notSet']).toEqual(['contributionThresholdMinor', 'costPerDropMinor', 'costPerKmMinor', 'fleetRate']);
    expect((await relay(s2.stopId, stopUpdate(r1.routeId, s2.stopId, 'ORD-2', 'out_for_delivery'))).status).toBe(202);
    const d2 = await relay(s2.stopId, stopUpdate(r1.routeId, s2.stopId, 'ORD-2', 'delivered', { proofKind: 'photo', proofSha256: SHA, deviceFix: DOORS.far }));
    expect((d2.body as { flags: string[] }).flags).toEqual(['outside_geofence']);
    expect((d2.body as { proofCheck: { fence: { result: string; radiusMetres: number } } }).proofCheck.fence).toMatchObject({ result: 'outside', radiusMetres: 150 });

    // ── The photo itself, relayed as its own record: a file whose hash is not its own is refused; the right one kept once.
    const photo = (sha: string, bytes = JPEG) => ({ routeId: r1.routeId, stopId: s2.stopId, driverId: DRIVER, orderRef: 'ORD-2', kind: 'photo', mediaType: 'image/jpeg', contentBase64: bytes.toString('base64'), sha256: sha, capturedAt: new Date().toISOString() });
    const proofPath = `/v1/delivery/routes/${encodeURIComponent(r1.routeId)}/stops/${encodeURIComponent(s2.stopId)}/proof/synced`;
    expect(codeOf(await shop.call('POST', proofPath, OWNER, photo('0'.repeat(64))))).toBe('not_readable_as_a_proof_image');
    expect(codeOf(await shop.call('POST', proofPath, OWNER, { ...photo(SHA), mediaType: 'image/png' }))).toBe('not_readable_as_a_proof_image');
    expect((await shop.call('POST', proofPath, 'c-1', photo(SHA))).status).toBe(403); // a customer cannot speak for the store computer
    const kept = await shop.call('POST', proofPath, OWNER, photo(SHA));
    expect(kept.status).toBe(202);
    expect((await shop.call('POST', proofPath, OWNER, photo(SHA))).body).toMatchObject({ alreadyRecorded: true });
    const proof2 = await shop.ok('GET', '/v1/delivery/orders/ORD-2/proof', DISPATCHER);
    expect(proof2['images']).toEqual([expect.objectContaining({ kind: 'photo', sha256: SHA, bytes: JPEG.length, driverId: DRIVER, governanceFlags: [] })]);
    expect(proof2['door']).toMatchObject({ state: 'delivered', proofKind: 'photo', flags: ['outside_geofence'] });
    expect(JSON.stringify(proof2)).not.toMatch(/11\.05|76\.99|contentBase64/); // no coordinates; no bytes in the list
    const imageId = (proof2['images'] as { imageId: string }[])[0]!.imageId;
    expect((await shop.ok('GET', `/v1/delivery/proof-images/${imageId}`, DISPATCHER))['contentBase64']).toBe(JPEG.toString('base64'));

    // ── Route 2: a WRONG code is an exception on the board, never a quiet delivery.
    await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(r2.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID });
    const code3 = (await shop.ok('GET', '/v1/storefront/orders/ORD-3/delivery-code', 'c-3'))['code'] as string;
    const wrong = code3 === '0000' ? '0001' : '0000';
    const s3 = r2.stops[0]!;
    const relay2 = (body: unknown) => shop.call('POST', `/v1/delivery/routes/${encodeURIComponent(r2.routeId)}/stops/${encodeURIComponent(s3.stopId)}/synced`, OWNER, body);
    expect((await relay2(stopUpdate(r2.routeId, s3.stopId, 'ORD-3', 'out_for_delivery'))).status).toBe(202);
    const d3 = await relay2(stopUpdate(r2.routeId, s3.stopId, 'ORD-3', 'delivered', { proofKind: 'otp', proofCode: wrong }));
    expect((d3.body as { flags: string[] }).flags).toEqual(['delivery_code_wrong']);
    expect((d3.body as { proofCheck: { fence: { result: string } } }).proofCheck.fence.result).toBe('no_device_location');

    // ── The customers' ETAs now: c-1 reached; c-2 reached; the board shows every door with its verdicts.
    expect(await shop.ok('GET', '/v1/storefront/orders/ORD-1/delivery-eta', 'c-1')).toMatchObject({ state: 'reached' });
    const board = await shop.ok('GET', `/v1/delivery/dispatch/${shop.runDate}/board`, DISPATCHER, undefined, { storeId: STORE_ID });
    const routes = board['routes'] as { routeId: string; status: string; stops: { orderRef: string; state: string; flags: string[]; imagesKept: number; proofCheck: { code: string } | null }[] }[];
    expect(routes.map((r) => r.status)).toEqual(['assigned', 'assigned']);
    expect(routes[0]!.stops.map((s) => [s.orderRef, s.state, s.proofCheck?.code, s.flags, s.imagesKept])).toEqual([['ORD-1', 'delivered', 'matched', [], 0], ['ORD-2', 'delivered', 'not_given', ['outside_geofence'], 1]]);
    expect(routes[1]!.stops[0]).toMatchObject({ orderRef: 'ORD-3', proofCheck: { code: 'wrong' }, flags: ['delivery_code_wrong'] });

    // ── Taking a started route back is refused: the goods and cash are in the van.
    expect(codeOf(await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/reassign-driver`, DISPATCHER, { ...dayFigures(shop), withoutDriverId: DRIVER, reason: 'van broke down' }))).toBe('route_started');

    // ── A cold restart reads the same board.
    const again = harness(h);
    const board2 = (await again.request({ method: 'GET', path: `/v1/delivery/dispatch/${shop.runDate}/board`, userId: DISPATCHER, tenantId: shop.t, query: { storeId: STORE_ID } })).body as { routes: unknown };
    expect(board2.routes).toEqual(board['routes']);
  }, 90_000);

  it('a driver off the road before any door: his routes are taken back (kept on the register) and the day re-planned without him', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    await shop.placeConfirmed('c-1', 'ORD-1', [['RICE', 1]], 1, DOORS.near);
    const p = await planned(shop, [DRIVER]);
    const r = p.plan.routes[0]!;
    await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(r.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID });
    expect(codeOf(await shop.call('POST', `/v1/delivery/dispatch/${shop.runDate}/reassign-driver`, DISPATCHER, { ...dayFigures(shop, [DRIVER, DRIVER2]), withoutDriverId: DRIVER, reason: 'ill' }))).toBe('reassign_needs_a_driver_and_a_reason');
    const re = await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/reassign-driver`, DISPATCHER, { ...dayFigures(shop, [DRIVER, DRIVER2]), withoutDriverId: DRIVER, reason: 'van broke down at 9' });
    expect(re['withdrawn']).toEqual([r.routeId]);
    const next = (re['plan'] as PlanBody['plan']).routes;
    expect(next.map((x) => [x.driverId, x.stops.map((s) => s.orderId)])).toEqual([[DRIVER2, ['ORD-1']]]);
    // The withdrawn route is no longer on the driver's phone; the board says "taken back" with the reason.
    expect((await shop.ok('GET', '/v1/fulfilment/assignments', OWNER, undefined, { storeId: STORE_ID }))['routes']).toEqual([]);
    const board = await shop.ok('GET', `/v1/delivery/dispatch/${shop.runDate}/board`, DISPATCHER, undefined, { storeId: STORE_ID });
    expect((board['routes'] as { routeId: string; status: string; withdrawn?: { reason: string } }[]).find((x) => x.routeId === r.routeId)).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'van broke down at 9' } });
    // Hand the new route out; the customer's ETA now follows it.
    await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(next[0]!.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID });
    expect((await shop.ok('GET', '/v1/fulfilment/assignments', OWNER, undefined, { storeId: STORE_ID }))['routes']).toEqual([expect.objectContaining({ driverId: DRIVER2 })]);
    expect(await shop.ok('GET', '/v1/storefront/orders/ORD-1/delivery-eta', 'c-1')).toMatchObject({ state: 'not_started', stopsOnRun: 1 });
  }, 90_000);
});
