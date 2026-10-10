import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import { withTillPeople, issueTillPins, signInOnPhone, type TillPerson } from '../support/till-operator';

/**
 * **A driver's phone's stop outcomes, settlement and cash handover reach head office through the store box's DEVICE socket —
 * enrolled once, durable at every hop, exactly once, every disagreement said (SP-3c-ii · ADR-0019 · F11's driver half ·
 * M19-FR-03 · M19-FR-04 · M23 · §28 · §31 · hard rules #1/#2/#3/#4/#6/#10).**
 *
 * Until SP-3c-ii the driver's durable queue reached NOBODY (F11): a phone that died after four stops left the cash with
 * somebody and no record anywhere. The REAL box against the REAL cloud (the API harness behind a `fetch` the test can cut
 * or make lose a reply):
 *
 *   • the phone is turned away from `/driver/` to the enrolment page WITH where it was going; the code enrols it back to the
 *     driver shell, served with its route and a same-origin write base;
 *   • one sync pass makes a stop's outcome head office's fact on the route register — the DRIVER re-verified from their
 *     grants, the box recorded as relay — AND steps the ORDER through its own lifecycle (`GET /v1/delivery/orders/:orderId`
 *     agrees with the phone, in the driver's name); `duplicate` before AND after a box restart; one cloud post;
 *   • an outcome whose cloud reply is lost is retried and settles to ONE record;
 *   • the SETTLEMENT and the counted HANDOVER are compared with the stops head office holds: agreeing → no flags; a
 *     settlement the stops do not support and a material handover are recorded WITH the flags (the cash office is told);
 *   • a stop the order cannot reach from where head office has it is recorded and SAID, never applied blindly;
 *   • an unknown driver is flagged; a payload head office cannot read (a card COD method) is a visible dead-letter on the
 *     box that survives a restart; a driver's batch cannot ride as `picker`;
 *   • a box with no cloud holds the work, counts it, and will not close the day over it.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['driver', 'handheld', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
const AT = '2026-10-01T10:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
/** DF-3-c (OB-28 "A"): the people who may hold the phone, with the job's permission head office re-checks. */
const PHONE_PEOPLE: readonly TillPerson[] = [{ userId: 'u-driver', displayName: 'Driver One', permissions: ['delivery.attempt.record'] }];
const packJson = (deviceStatus = 'registered'): string => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
  lossPreventionRules: [],
  route: {
    routeId: 'R-1', driverId: 'u-driver',
    stops: [
      { stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 },
      { stopId: 's2', orderRef: 'ORD-2', area: 'Gandhipuram', codMinor: 0 },
    ],
  },
  devices: [{ deviceId: 'hh-03', kind: 'handheld', status: deviceStatus, label: 'Van phone', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, PHONE_PEOPLE));

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A stop outcome as the phone queues it (`RouteSession.replace`). */
const stopAt = (stopId: string, state: string, over: Record<string, unknown> = {}, routeId = 'R-1') => makeEvent({
  id: `${routeId}:${stopId}:${state}`, type: 'DeliveryStopUpdated', occurredAt: AT, idempotencyKey: `stop:${routeId}:${stopId}:${state}`, source: routeId,
  payload: {
    routeId, driverId: 'u-driver', stopId, orderRef: stopId === 's1' ? 'ORD-1' : 'ORD-2', state,
    codExpectedMinor: stopId === 's1' ? 250_00 : 0, codCollectedMinor: 0, codMethod: null, proofKind: null,
    geofenceMismatch: false, failureReason: null, contributionFlag: null, currency: 'INR', ...over,
  },
});
const settledRoute = (over: Record<string, unknown> = {}, routeId = 'R-1') => makeEvent({
  id: `${routeId}:settled`, type: 'RouteSettled', occurredAt: AT, idempotencyKey: `settle:${routeId}`, source: routeId,
  payload: { routeId, driverId: 'u-driver', expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00, matchedCount: 1, exceptionCount: 0, currency: 'INR', ...over },
});
const handedOver = (over: Record<string, unknown> = {}, routeId = 'R-1') => makeEvent({
  id: `${routeId}:handover`, type: 'DriverCashHandedOver', occurredAt: AT, idempotencyKey: `handover:${routeId}`, source: routeId,
  payload: { routeId, driverId: 'u-driver', countedMinor: 250_00, recordedMinor: 250_00, varianceMinor: 0, material: false, currency: 'INR', at: AT, reasonCode: null, ...over },
});
const item = (e: ReturnType<typeof makeEvent>) => ({ key: e.idempotencyKey, event: e });

const deviceBase = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.devices!.port}`;
const enrol = async (edge: EdgeProcess, code = CODE, deviceId = 'hh-03', next?: string): Promise<{ status: number; cookie: string | undefined; body: Record<string, unknown> }> => {
  const res = await savedFetch(`${deviceBase(edge)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code, ...(next === undefined ? {} : { next }) }) });
  const device = res.headers.get('set-cookie')?.split(';')[0];
  const body = (await res.json()) as Record<string, unknown>;
  // DF-3-c (OB-28 "A"): an enrolled phone is then signed in by the person holding it, with the till PIN.
  const cookie = res.status === 200 && device !== undefined ? await signInOnPhone(deviceBase(edge), device, 'u-driver', 'driver') : device;
  return { status: res.status, cookie, body };
};
const postBatch = async (edge: EdgeProcess, cookie: string | undefined, items: unknown[], source = 'driver'): Promise<{ status: number; acks: DeviceAck[]; body: Record<string, unknown> }> => {
  const res = await savedFetch(`${deviceBase(edge)}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ source, items }),
  });
  const body = (await res.json()) as Record<string, unknown> & { acks?: DeviceAck[] };
  return { status: res.status, acks: body.acks ?? [], body };
};
const statusOf = async (edge: EdgeProcess, cookie: string, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`${deviceBase(edge)}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`, { headers: { cookie } });
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};
const recordsOn = async (edge: EdgeProcess): Promise<{ idempotencyKey: string; type: string }[]> =>
  (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => { const p = JSON.parse(r.ok ? r.record : '{}') as { idempotencyKey: string; type: string }; return { idempotencyKey: p.idempotencyKey, type: p.type }; });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

const EDGE_ENV = { EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps' };

async function boxWithoutCloud(dir?: string): Promise<EdgeProcess> {
  const d = dir ?? await tempDir('sre-driver-handheld-nocloud-');
  const packFile = join(d, 'store-pack.json');
  await writeFile(packFile, packJson(), 'utf8');
  await issueTillPins(d, KEY, PHONE_PEOPLE.map((p) => p.userId));
  const edge = (await startEdge({ ...EDGE_ENV, EDGE_DATA_DIR: d, EDGE_PACK_FILE: packFile }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

interface Cloud { h: ApiHarness; start: (deviceStatus?: string) => Promise<EdgeProcess>; loseNextReply: () => void; posts: () => number }

/** A real cloud — cast: the owner, the driver (a store manager: may deliver), the box (a cashier: may relay); the delivery feature on. */
async function cloud(): Promise<Cloud> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-driver', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  await h.enableFeature(A, 'delivery'); // this shop's plan includes home delivery (M36-FR-01)
  const dir = await tempDir('sre-driver-handheld-cloud-');

  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/delivery/') && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); }
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const start = async (deviceStatus = 'registered'): Promise<EdgeProcess> => {
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, packJson(deviceStatus), 'utf8');
    await issueTillPins(dir, KEY, PHONE_PEOPLE.map((p) => p.userId));
    const edge = (await startEdge({
      ...EDGE_ENV, EDGE_DATA_DIR: dir, EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, start, loseNextReply: () => { lose = true; }, posts: () => posts };
}

interface RouteView { stops: Record<string, unknown>[]; settlement: Record<string, unknown> | null; handover: Record<string, unknown> | null; flags: string[]; cash: { expectedMinor: number; collectedMinor: number; cashHeldMinor: number } }
const routeAt = async (h: ApiHarness, routeId = 'R-1'): Promise<RouteView> =>
  (await h.request({ method: 'GET', path: `/v1/delivery/routes/${routeId}`, userId: 'u-owner', tenantId: A })).body as RouteView;
const orderAt = async (h: ApiHarness, orderId: string): Promise<{ state: string; history: Record<string, unknown>[] }> =>
  (await h.request({ method: 'GET', path: `/v1/delivery/orders/${orderId}`, userId: 'u-owner', tenantId: A })).body as { state: string; history: Record<string, unknown>[] };

describe('the driver\'s phone: enrol → device socket → box (durable) → head office (once)', () => {
  it('is sent to enrol WITH where it was going; the code enrols it back to the driver shell; a stop outcome is on the box\'s disk before accepted, reaches the route register once with the driver re-verified AND steps the order, and is duplicate before and after a restart', async () => {
    const c = await cloud();
    const first = await c.start();
    const departed = stopAt('s1', 'out_for_delivery');
    expect((await postBatch(first, undefined, [item(departed)])).status).toBe(403);
    const away = await savedFetch(`${deviceBase(first)}/driver/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(away.status).toBe(302);
    expect(away.headers.get('location')).toBe('/device/enrol?why=no_credential&next=%2Fdriver%2F');
    const { status: enrolStatus, cookie, body } = await enrol(first, CODE, 'hh-03', '/driver/');
    expect(enrolStatus).toBe(200);
    expect(body).toEqual({ enrolled: true, deviceId: 'hh-03', next: '/driver/' });
    const shell = await (await savedFetch(`${deviceBase(first)}/driver/`, { headers: { accept: 'text/html', cookie: cookie! } })).text();
    expect(shell).toContain('"routeId":"R-1"');
    expect(shell).toContain('"driverId":"u-driver"');
    expect(shell).toContain('window.laneWriteBase = "";');

    const { status, acks } = await postBatch(first, cookie, [item(departed)]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'stop:R-1:s1:out_for_delivery', status: 'accepted' }]);
    expect(await recordsOn(first)).toEqual([{ idempotencyKey: 'stop:R-1:s1:out_for_delivery', type: 'DeliveryStopUpdated' }]);
    expect((await routeAt(c.h)).stops).toEqual([]); // nothing at head office yet — the box has it
    expect((await orderAt(c.h, 'ORD-1')).state).toBe('assigned');

    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(0);
    const view = await routeAt(c.h);
    expect(view.stops).toEqual([expect.objectContaining({ stopId: 's1', state: 'out_for_delivery', driverId: 'u-driver', relayedBy: 'u-box', governanceFlags: [], orderStep: { event: 'depart', from: 'assigned', to: 'out_for_delivery' } })]);
    // The ORDER moved too, in the driver's name — the dispatcher's "where is it" and the phone agree.
    const order = await orderAt(c.h, 'ORD-1');
    expect(order.state).toBe('out_for_delivery');
    expect(order.history).toEqual([expect.objectContaining({ event: 'depart', by: 'u-driver' })]);
    expect((await statusOf(first, cookie!, ['stop:R-1:s1:out_for_delivery']))[0]?.state).toBe('posted');

    expect((await postBatch(first, cookie, [item(departed)])).acks).toEqual([{ key: 'stop:R-1:s1:out_for_delivery', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    expect((await postBatch(second, cookie, [item(departed)])).acks).toEqual([{ key: 'stop:R-1:s1:out_for_delivery', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect((await orderAt(c.h, 'ORD-1')).history).toHaveLength(1);
    expect(second.enrolments!.enrolled().map((d) => d.deviceId)).toEqual(['hh-03']);
  });

  it('an outcome whose cloud reply is lost is retried and settles to ONE record and ONE order step (RR-F02)', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    await postBatch(edge, cookie, [item(stopAt('s2', 'out_for_delivery'))]);
    c.loseNextReply();
    const first = await edge.syncOnce!();
    expect(first.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('stop:R-1:s2:out_for_delivery')).toMatchObject({ state: 'pending', attempts: 1 });
    expect((await orderAt(c.h, 'ORD-2')).history).toHaveLength(1); // the cloud DID record it; the reply was what got lost
    const second = await edge.syncOnce!();
    expect(second.sent).toBe(1);
    expect((await routeAt(c.h)).stops).toHaveLength(1);
    expect((await orderAt(c.h, 'ORD-2')).history).toHaveLength(1); // once
    expect(c.posts()).toBe(2);
    expect((await statusOf(edge, cookie!, ['stop:R-1:s2:out_for_delivery']))[0]?.state).toBe('posted');
  });

  it('a whole shift: departed → delivered with cash → the second stop failed and returned → settlement → counted handover; the register, the orders and the cash agree, no flags; a disagreeing settlement and a material handover on another route are posted AND flagged', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    const events = [
      stopAt('s1', 'out_for_delivery'),
      stopAt('s1', 'delivered', { codCollectedMinor: 250_00, codMethod: 'cash', proofKind: 'otp' }),
      stopAt('s2', 'out_for_delivery'),
      stopAt('s2', 'failed', { failureReason: 'nobody_home' }),
      stopAt('s2', 'returned_to_origin', { failureReason: 'nobody_home' }),
      settledRoute(),
      handedOver(),
    ];
    expect((await postBatch(edge, cookie, events.map(item))).acks.map((a) => a.status)).toEqual(events.map(() => 'accepted'));
    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(7);
    expect(pass.dead).toBe(0);
    const view = await routeAt(c.h);
    expect(view.stops.map((s) => [s['stopId'], s['state'], s['outcomesRecorded']])).toEqual([['s1', 'delivered', 2], ['s2', 'returned_to_origin', 3]]);
    expect(view.cash).toEqual({ expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00 });
    expect(view.settlement).toMatchObject({ driverId: 'u-driver', relayedBy: 'u-box', expectedMinor: 250_00, collectedMinor: 250_00, fromStops: { cashHeldMinor: 250_00 }, governanceFlags: [] });
    expect(view.handover).toMatchObject({ countedMinor: 250_00, recordedMinor: 250_00, varianceMinor: 0, material: false, governanceFlags: [] });
    expect(view.flags).toEqual([]);
    // The orders followed the phone, step by step, in the driver's name; the delivery carries the proof kind and where it is held.
    const o1 = await orderAt(c.h, 'ORD-1');
    expect(o1.state).toBe('delivered');
    expect(o1.history.map((h) => h['event'])).toEqual(['depart', 'deliver']);
    expect(o1.history[1]).toMatchObject({ by: 'u-driver', proofRef: 'otp@handheld:R-1/s1' });
    const o2 = await orderAt(c.h, 'ORD-2');
    expect(o2.state).toBe('returned_to_origin');
    expect(o2.history.map((h) => h['event'])).toEqual(['depart', 'fail', 'rto']);
    expect((await statusOf(edge, cookie!, ['stop:R-1:s1:delivered', 'settle:R-1', 'handover:R-1'])).map((i) => i.state)).toEqual(['posted', 'posted', 'posted']);

    // Re-sending the handover after a lost reply is duplicate at the box; a second pass reaches head office with nothing new.
    expect((await postBatch(edge, cookie, [item(handedOver())])).acks).toEqual([{ key: 'handover:R-1', status: 'duplicate' }]);
    await edge.syncOnce!();
    expect(c.posts()).toBe(7);

    // Another route: the phone's settlement claims more than its stops support; the counted cash is materially short.
    const r2 = [
      stopAt('s1', 'out_for_delivery', { orderRef: 'ORD-3' }, 'R-2'),
      stopAt('s1', 'delivered', { orderRef: 'ORD-3', codCollectedMinor: 200_00, codMethod: 'upi', proofKind: 'photo' }, 'R-2'),
      settledRoute({ expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00 }, 'R-2'),
      handedOver({ countedMinor: 50_00, recordedMinor: 200_00, varianceMinor: -150_00, material: true }, 'R-2'),
    ];
    expect((await postBatch(edge, cookie, r2.map(item))).acks.map((a) => a.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    const pass2 = await edge.syncOnce!();
    expect(pass2.sent).toBe(4);
    expect(pass2.dead).toBe(0);
    const v2 = await routeAt(c.h, 'R-2');
    expect(v2.cash).toEqual({ expectedMinor: 250_00, collectedMinor: 200_00, cashHeldMinor: 200_00 });
    expect(v2.settlement).toMatchObject({ collectedMinor: 250_00, fromStops: { collectedMinor: 200_00 }, governanceFlags: ['stops_disagree'] });
    expect(v2.handover).toMatchObject({ countedMinor: 50_00, material: true, governanceFlags: ['cash_office_review'] });
    expect(v2.flags).toEqual(['stops_disagree', 'cash_office_review']);
  });

  it('OB-09 — a PARTIAL delivery and a customer who had no cash reach the per-driver run reconciliation with their exact reason, quantities and cash balances', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    const events = [
      stopAt('s1', 'out_for_delivery', { orderRef: 'ORD-6', codExpectedMinor: 300_00 }, 'R-3'),
      stopAt('s1', 'partially_delivered', { orderRef: 'ORD-6', codExpectedMinor: 300_00, codCollectedMinor: 120_00, codMethod: 'cash', proofKind: 'photo' }, 'R-3'),
      stopAt('s2', 'out_for_delivery', { orderRef: 'ORD-7', codExpectedMinor: 450_00 }, 'R-3'),
      stopAt('s2', 'failed', { orderRef: 'ORD-7', codExpectedMinor: 450_00, failureReason: 'customer_had_no_cash' }, 'R-3'),
      stopAt('s2', 'returned_to_origin', { orderRef: 'ORD-7', codExpectedMinor: 450_00, failureReason: 'customer_had_no_cash' }, 'R-3'),
    ];
    expect((await postBatch(edge, cookie, events.map(item))).acks.map((a) => a.status)).toEqual(events.map(() => 'accepted'));
    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(5);
    expect(pass.dead).toBe(0);
    const view = await routeAt(c.h, 'R-3');
    expect(view.flags).toEqual([]);
    const runDate = (view.stops[0]!['at'] as string).slice(0, 10);
    expect(view.stops.map((s) => [s['stopId'], s['state'], s['runAttempt']])).toEqual([
      ['s1', 'partially_delivered', { attemptId: 'R-3/s1/partially_delivered', outcome: 'partially_delivered', runDate }],
      ['s2', 'returned_to_origin', 'not_a_door_outcome'],
    ]);
    expect(view.cash).toEqual({ expectedMinor: 120_00, collectedMinor: 120_00, cashHeldMinor: 120_00 });
    // The driver's RUN — the register the direct route and the dispatcher read — counts the stops apart and holds the money.
    const run = (await c.h.request({ method: 'GET', path: '/v1/delivery/runs/u-driver', userId: 'u-owner', tenantId: A, query: { runDate, cashHandedInMinor: '12000' } })).body as Record<string, unknown>;
    expect(run).toMatchObject({
      attempts: 2, delivered: 0, partiallyDelivered: 1, failed: 1, customerHadNoCash: 1, cashExpectedMinor: 120_00, differenceMinor: 0,
      codUncollectedMinor: 450_00, noCashOrders: ['ORD-7'], partialRemainderMinor: 180_00, partialOrders: ['ORD-6'],
    });
    expect(run['detail']).toContain('1 partly delivered, 1 failed (1 because the customer had no cash)');
    // No dispatch plan named these orders: the run says so rather than reconciling against nothing (the earlier finding).
    expect(run['unassigned']).toEqual(['ORD-6', 'ORD-7']);
    // The orders followed: ORD-6 partially delivered with the proof kind and where it is held; ORD-7 failed and went back.
    const o6 = await orderAt(c.h, 'ORD-6');
    expect(o6.state).toBe('partially_delivered');
    expect(o6.history[1]).toMatchObject({ by: 'u-driver', proofRef: 'photo@handheld:R-3/s1' });
    expect((await orderAt(c.h, 'ORD-7')).history.map((h) => h['event'])).toEqual(['depart', 'fail', 'rto']);
  });

  it('a stop the order cannot reach from where head office has it is recorded and SAID; a stop naming a driver who never held this phone is refused at the box by name (DF-3-c); a card COD method is a visible dead-letter that survives a restart and recorded nothing', async () => {
    const c = await cloud();
    const first = await c.start();
    const { cookie } = await enrol(first);
    const skipped = stopAt('s1', 'delivered', { codCollectedMinor: 250_00, codMethod: 'cash', proofKind: 'otp' }); // delivered with no departure seen
    const stranger = stopAt('s2', 'out_for_delivery', { driverId: 'u-stranger' });
    const card = stopAt('s2', 'delivered', { codCollectedMinor: 0, codMethod: 'card', proofKind: 'otp' });
    const acks = (await postBatch(first, cookie, [skipped, stranger, card].map(item))).acks;
    expect(acks.map((a) => a.status)).toEqual(['accepted', 'refused', 'accepted']);
    // DF-3-c (OB-28 "A"): the phone is signed in as u-driver; a stop naming anybody else never leaves the box.
    expect(acks[1]?.reason).toBe('the record names u-stranger, who has not been signed in on this phone this shift');
    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(1);
    const view = await routeAt(c.h);
    expect(view.stops).toEqual([
      expect.objectContaining({ stopId: 's1', state: 'delivered', orderStep: 'disagrees', governanceFlags: ['order_state_disagrees'] }),
    ]);
    expect((await orderAt(c.h, 'ORD-1')).state).toBe('assigned'); // not applied blindly
    const status = await statusOf(first, cookie!, ['stop:R-1:s2:delivered']);
    expect(status[0]?.state).toBe('refused');
    expect(status[0]?.reason).toMatch(/not_readable_as_a_stop_outcome/);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    const after = await statusOf(second, cookie!, ['stop:R-1:s2:delivered']);
    expect(after[0]?.state).toBe('refused');
    expect((await routeAt(c.h)).stops).toHaveLength(1);
  });

  it('a driver\'s batch cannot ride as the picker, and a picker type cannot ride as the driver — refused at the box, never taken', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    const e = stopAt('s1', 'out_for_delivery');
    expect((await postBatch(edge, cookie, [item(e)], 'picker')).acks).toEqual([{ key: 'stop:R-1:s1:out_for_delivery', status: 'refused', reason: 'DeliveryStopUpdated is not a record this box relays for picker' }]);
    const pick = makeEvent({ id: 'W-1:l1:picked', type: 'PickLineResolved', occurredAt: AT, idempotencyKey: 'pick:W-1:l1:picked', source: 'W-1', payload: { waveId: 'W-1', lineId: 'l1' } });
    expect((await postBatch(edge, cookie, [item(pick)], 'driver')).acks[0]).toMatchObject({ status: 'refused', reason: 'PickLineResolved is not a record this box relays for driver' });
    expect((await postBatch(edge, cookie, [item(e)], 'manager')).status).toBe(403);
    expect(await recordsOn(edge)).toEqual([]);
  });

  it('a box with no cloud takes the outcomes, holds them durably across a restart, counts them, and will not close the day over them', async () => {
    const dir = await tempDir('sre-driver-handheld-hold-');
    const first = await boxWithoutCloud(dir);
    const { cookie } = await enrol(first);
    const e = stopAt('s1', 'out_for_delivery');
    const h = handedOver();
    expect((await postBatch(first, cookie, [item(e), item(h)])).acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    expect(first.syncStatus()).toMatchObject({ cloud: 'not_configured', unsent: 2 });
    expect((await first.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' })).closed).toBe(false);
    await first.stop();
    cleanups.pop();
    const second = await boxWithoutCloud(dir);
    expect(second.deviceEventsOutbox.pending().map((i) => i.key)).toEqual(['stop:R-1:s1:out_for_delivery', 'handover:R-1']);
    expect(second.syncStatus().unsent).toBe(2);
    expect((await postBatch(second, cookie, [item(h)])).acks).toEqual([{ key: 'handover:R-1', status: 'duplicate' }]);
  });
});
