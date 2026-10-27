import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import { withTillPeople, issueTillPins, signInOnPhone } from '../support/till-operator';
import { seedOnlineShop, listShopOnline, deliveredOrder, callsFor, codeOf, MANAGER, CHECKER, CUSTOMER, STORE, type ShopCalls } from '../support/online-shop';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { deviceBase as boxDoor, trustTheBoxes } from '../support/box-tls';

/**
 * **R4 · WF-16 (signed, OB-227) — an online return after delivery is COLLECTED BY THE DRIVER: his phone → the REAL store box
 * → head office, in memory and on REAL PostgreSQL, across a cold restart of both.**
 *
 *   • head office books the collection and puts it on the driver's ROUTE (only a booked return, only to a driver who may
 *     collect); the box pulls it and serves it to his phone with the BOOKED lines; a collected one leaves the phone by itself;
 *   • the phone's record rides the device socket (the driver signed in, OB-180/185/187) and the box's durable queue;
 *   • head office checks it ALL again and refuses by name — a NON-DRIVER (403 `driver_lacks_authority`), MORE than booked
 *     (422 `more_than_booked`), a return NOT BOOKED for collection (422 `not_booked_for_collection`) — each a visible refusal
 *     on the box (hard rules #6/#10); nothing is recorded for any of them;
 *   • OFFLINE: with head office unreachable the record waits on the box (nothing lost, nothing recorded yet); both restart
 *     cold; when head office answers it drains and "collected" is recorded EXACTLY as the button records it (one step, the
 *     button's key — the button afterwards says "already collected");
 *   • "not collected" with a reason keeps the booking and is said to the customer;
 *   • head office's next steps are unchanged: received with a count → a person's disposition → the refund to source only
 *     after a second person — and NO money moved and NO refund was made at collection.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const provider = testModePaymentProvider();
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness({ paymentVerifier: provider }), restart: (h) => apiHarness({ store: h.store, paymentVerifier: provider }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), paymentVerifier: provider }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const KEY = ['driver', 'return', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const DRIVER = 'u-driver';
/** In the box's store setup a driver (he may sign in on the van phone), but at head office only a cashier: not a driver. */
const HELPER = 'u-helper';

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = trustTheBoxes(globalThis.fetch); // OB-422: the handheld door is https, trusted by its box's authority
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

type ReturnView = { stage: string; collectedBy?: string; collectedOnRoute?: string; missedCollections: { reason: string; by: string }[]; lines: { productId: string; requestedMinor: number; collectedMinor?: number; receivedMinor?: number }[]; steps: { say: string }[] };

const collection = (returnId: string, driverId: string, over: Record<string, unknown>, key: string) => makeEvent({
  id: key, type: 'ReturnCollectionRecorded', occurredAt: new Date().toISOString(), idempotencyKey: key, source: 'R-7',
  payload: { returnId, routeId: 'R-7', driverId, orderRef: 'ORD-1', occurredAt: new Date().toISOString(), ...over },
});
const item = (e: ReturnType<typeof makeEvent>) => ({ key: e.idempotencyKey, event: e });

describe.each(backings)('WF-16 — the driver collects an online return through the box, on $name', ({ harness, restart }) => {
  it('assigned on a route → served to the phone → refused by name (non-driver 403, over-quantity, unbooked) → offline queue drains after a cold restart → "collected" as the button records it → count, disposition, refund after a second person', async () => {
    let h = harness();
    const T = randomUUID();
    const c: ShopCalls = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c);
    await h.enableFeature(T, 'delivery');
    await h.provisionRole(T, DRIVER, 'store_manager'); // may deliver AND collect (online.return.collect)
    await h.provisionRole(T, HELPER, 'cashier'); // not a driver at head office
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    await deliveredOrder(c, provider, 'ORD-1');
    await deliveredOrder(c, provider, 'ORD-2');
    await ok(req('POST', '/v1/online-returns/policy', { windowDaysByCategory: { dairy: 2, household: 7 }, nonReturnable: [], reason: 'test windows (synthetic)' }), 'policy');
    await ok(req('POST', '/v1/me/orders/ORD-1/online-returns/RET-1', { lines: [{ productId: 'MILK', quantityMinor: 2 }], reason: 'sour (synthetic)' }, CUSTOMER), 'raise RET-1');
    await ok(req('POST', '/v1/me/orders/ORD-1/online-returns/RET-2', { lines: [{ productId: 'BROOM', quantityMinor: 1 }], reason: 'not needed (synthetic)' }, CUSTOMER), 'raise RET-2');
    await ok(req('POST', '/v1/me/orders/ORD-2/online-returns/RET-3', { lines: [{ productId: 'MILK', quantityMinor: 1 }], reason: 'sour (synthetic)' }, CUSTOMER), 'raise RET-3');
    const today = shopDateIn(new Date().toISOString());
    await ok(req('POST', '/v1/online-returns/RET-1/collection', { collectOn: today }, MANAGER), 'book RET-1');
    await ok(req('POST', '/v1/online-returns/RET-3/collection', { collectOn: today }, MANAGER), 'book RET-3');

    // ── Head office puts the BOOKED collections on the driver's route — never an unbooked one, never to a non-driver ──
    const route = (driverId: string, collections: unknown[]) => req('POST', '/v1/delivery/routes/R-7/assignment', { storeId: STORE, driverId, stops: [], collections });
    expect(codeOf(await route(DRIVER, [{ returnId: 'RET-2', area: 'Anna Nagar' }]))).toBe('not_booked_for_collection');
    expect(codeOf(await route(HELPER, [{ returnId: 'RET-1', area: 'Anna Nagar' }]))).toBe('driver_lacks_authority');
    expect((await route(DRIVER, [{ returnId: 'RET-1', area: 'Gandhipuram' }, { returnId: 'RET-3', area: 'RS Puram' }])).status).toBe(201);

    // ── The box (pulls under its own credential), and a head office the test can cut ──
    let cloudUp = true;
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!cloudUp) throw new Error('ECONNREFUSED');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-driver-return-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE, branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
      lossPreventionRules: [],
      devices: [{ deviceId: 'hh-03', kind: 'handheld', status: 'registered', label: 'Van phone', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, [{ userId: DRIVER, permissions: ['delivery.attempt.record'] }, { userId: HELPER, permissions: ['delivery.attempt.record'] }])), 'utf8');
    await issueTillPins(dir, KEY, [DRIVER, HELPER]);
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
        EDGE_DATA_DIR: dir, EDGE_PACK_FILE: packFile,
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE }),
      }, () => {}))!;
      cleanups.push(async () => { await edge.stop(); });
      return edge;
    };
    let edge = await startBox();
    const base = () => `${boxDoor(edge)}`;
    const enrolled = await savedFetch(`${base()}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-03', code: CODE }) });
    const device = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    const asDriver = await signInOnPhone(base(), device, DRIVER, 'driver');
    const post = async (cookie: string, items: unknown[]): Promise<DeviceAck[]> => {
      const res = await savedFetch(`${base()}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'driver', items }) });
      return ((await res.json()) as { acks: DeviceAck[] }).acks;
    };
    const statusOf = async (keys: string[]): Promise<BoxItemStatus[]> =>
      ((await (await savedFetch(`${base()}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`, { headers: { cookie: asDriver } })).json()) as { items: BoxItemStatus[] }).items;
    const returnAt = async (id: string): Promise<ReturnView> =>
      ((await ok(req('GET', '/v1/online-returns', undefined, MANAGER), 'desk')).body as { returns: (ReturnView & { returnId: string })[] }).returns.find((r) => r.returnId === id)!;

    // The box pulls the route; the driver's phone is served it with the BOOKED lines.
    await edge.refreshAssignmentsFeed!();
    const shell = await (await savedFetch(`${base()}/driver/`, { headers: { accept: 'text/html', cookie: asDriver } })).text();
    expect(shell).toContain('"collections":[{"returnId":"RET-1","area":"Gandhipuram","orderRef":"ORD-1"');
    expect(shell).toContain('"lines":[{"productId":"MILK","quantityMinor":2');
    expect(shell).toContain('"returnId":"RET-3"');

    // ── Refused by name at head office: a non-driver, more than booked, an unbooked return ──
    const asHelper = await signInOnPhone(base(), device, HELPER, 'driver');
    const byHelper = collection('RET-1', HELPER, { outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 1 }] }, 'return-collection:R-7:RET-1:helper');
    expect((await post(asHelper, [item(byHelper)])).map((a) => a.status)).toEqual(['accepted']);
    const asDriverAgain = await signInOnPhone(base(), device, DRIVER, 'driver');
    const over = collection('RET-1', DRIVER, { outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 3 }] }, 'return-collection:R-7:RET-1:over');
    const unbooked = collection('RET-2', DRIVER, { outcome: 'collected', lines: [{ productId: 'BROOM', collectedMinor: 1 }] }, 'return-collection:R-7:RET-2:collected');
    expect((await post(asDriverAgain, [item(over), item(unbooked)])).map((a) => a.status)).toEqual(['accepted', 'accepted']);
    const refused = await edge.syncOnce!();
    expect(refused).toMatchObject({ sent: 0, dead: 3 });
    const said = await statusOf([byHelper.idempotencyKey, over.idempotencyKey, unbooked.idempotencyKey]);
    expect(said.map((s) => s.state)).toEqual(['refused', 'refused', 'refused']);
    expect(said[0]!.reason).toContain('403');
    expect(said[0]!.reason).toContain('driver_lacks_authority');
    expect(said[1]!.reason).toContain('more_than_booked');
    expect(said[2]!.reason).toContain('not_booked_for_collection');
    expect((await returnAt('RET-1')).stage).toBe('collection_scheduled');
    expect((await returnAt('RET-2')).stage).toBe('requested');
    // The same three straight at head office, in words (the box relays under its own credential).
    const direct = (e: ReturnType<typeof makeEvent>) => h.raw({ method: 'POST', path: `/v1/online-returns/${(e.payload as { returnId: string }).returnId}/collection/synced`, token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE }), idempotencyKey: `x-${randomUUID()}`, body: e.payload });
    const r403 = await direct(byHelper);
    expect([r403.status, codeOf(r403)]).toEqual([403, 'driver_lacks_authority']);
    const r422 = await direct(over);
    expect([r422.status, codeOf(r422), (r422.body as { error: { whatHappened: string } }).error.whatHappened]).toEqual([422, 'more_than_booked', 'The collection of return RET-1 was not recorded: MILK: collected 3, but 2 was booked for collection.']);
    expect(codeOf(await direct(unbooked))).toBe('not_booked_for_collection');
    // The relay hop is the box's alone: a manager cannot post a phone's record himself.
    expect((await req('POST', '/v1/online-returns/RET-1/collection/synced', byHelper.payload, MANAGER)).status).toBe(403);

    // ── OFFLINE: head office unreachable. The driver's real records wait on the box; nothing is recorded yet ──
    cloudUp = false;
    const took = collection('RET-1', DRIVER, { outcome: 'collected', lines: [{ productId: 'MILK', collectedMinor: 1 }] }, 'return-collection:R-7:RET-1:collected');
    const missed = collection('RET-3', DRIVER, { outcome: 'not_collected', reason: 'customer_not_available' }, 'return-collection:R-7:RET-3:not_collected:1');
    expect((await post(asDriverAgain, [item(took), item(missed)])).map((a) => a.status)).toEqual(['accepted', 'accepted']);
    expect(await edge.syncOnce!()).toMatchObject({ sent: 0, dead: 0 });
    expect((await statusOf([took.idempotencyKey]))[0]!.state).toBe('pending');
    cloudUp = true;
    expect((await returnAt('RET-1')).stage).toBe('collection_scheduled');
    cloudUp = false;

    // ── A COLD RESTART of both: the box from its disk, head office from its store ──
    await edge.stop();
    cleanups.pop();
    edge = await startBox();
    h = restart(h);
    cloudUp = true;
    const drained = await edge.syncOnce!();
    expect(drained).toMatchObject({ sent: 2, dead: 0 });
    expect((await statusOf([took.idempotencyKey, missed.idempotencyKey])).map((s) => s.state)).toEqual(['posted', 'posted']);

    // "Collected" — exactly as the button records it: one step, in the DRIVER's name, with what he took.
    const one = await returnAt('RET-1');
    expect(one).toMatchObject({ stage: 'collected', collectedBy: DRIVER, collectedOnRoute: 'R-7' });
    expect(one.lines).toEqual([{ productId: 'MILK', requestedMinor: 2, collectedMinor: 1 }]);
    expect(((await ok(req('POST', '/v1/online-returns/RET-1/collected', {}, MANAGER), 'button')).body as { alreadyCollected?: boolean }).alreadyCollected).toBe(true);
    // A re-sent record is still one collection.
    expect((await direct(took)).status).toBe(200);
    // "Not collected" keeps the booking, and the customer is told.
    const three = await returnAt('RET-3');
    expect(three.stage).toBe('collection_scheduled');
    expect(three.missedCollections).toEqual([expect.objectContaining({ reason: 'customer_not_available', by: DRIVER })]);
    const mine = ((await ok(req('GET', '/v1/me/online-returns', undefined, CUSTOMER), 'mine')).body as { returns: (ReturnView & { returnId: string })[] }).returns;
    expect(mine.find((r) => r.returnId === 'RET-1')!.steps.map((s) => s.say)).toContain('Collected from you: 1 × MILK');
    expect(mine.find((r) => r.returnId === 'RET-3')!.steps.at(-1)!.say).toBe('The driver came to collect, but nobody was there to hand it over. The shop will book again.');

    // NO money moved and NO refund was made at collection.
    expect(((await ok(req('GET', '/v1/orders/refunds/pending'), 'pending')).body as { pendingRefunds: unknown[] }).pendingRefunds).toEqual([]);

    // The collected one leaves the driver's phone by itself; the missed one is still on his route.
    await edge.refreshAssignmentsFeed!();
    const after = await (await savedFetch(`${base()}/driver/`, { headers: { accept: 'text/html', cookie: asDriverAgain } })).text();
    expect(after).not.toContain('"returnId":"RET-1"');
    expect(after).toContain('"returnId":"RET-3"');

    // ── Head office's next steps, unchanged: received with a count → a person's disposition → refund after a second person ──
    h = restart(h);
    await ok(req('POST', '/v1/online-returns/RET-1/received', { lines: [{ productId: 'MILK', receivedMinor: 1 }] }, MANAGER), 'received');
    // The shop counted what the driver took (1 × MILK): no count difference is shown (hard rule #10 — one would be named).
    const listed = ((await ok(req('GET', '/v1/online-returns', undefined, MANAGER), 'list')).body as { returns: { returnId: string; countDifferences: unknown[] }[] }).returns;
    expect(listed.find((r) => r.returnId === 'RET-1')!.countDifferences).toEqual([]);
    await ok(req('POST', '/v1/online-returns/RET-1/lines/MILK/disposition', { disposition: 'quarantine' }, MANAGER), 'disposition');
    expect(codeOf(await req('POST', '/v1/online-returns/RET-1/refund', { refundId: 'rf-1' }, MANAGER))).toBe('given_without_approval');
    const body = await approvedBody(h, T, MANAGER, CHECKER, 'order_refund', 'ORD-1/rf-1', { refundId: 'rf-1' }, { returnId: 'RET-1' }, 60_00);
    const refunded = (await ok(req('POST', '/v1/online-returns/RET-1/refund', body, MANAGER), 'refund')).body as { refund: { amountMinor: number; shown: string } };
    expect(refunded.refund).toMatchObject({ amountMinor: 60_00, shown: 'waiting' });
  }, 180_000);
});
