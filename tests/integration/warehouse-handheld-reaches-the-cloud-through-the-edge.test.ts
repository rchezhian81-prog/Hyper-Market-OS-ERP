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

/**
 * **A warehouse handheld's scans reach head office through the store box's DEVICE socket — enrolled once, durable at
 * every hop, exactly once, every refusal visible (SP-3a · ADR-0019 · S1 · F11's handheld half · M09-FR-01 · M07-FR-01 ·
 * §31 · hard rules #1/#2/#4/#6/#10).**
 *
 * The REAL box (`startEdge` with a device socket, its fsync'd device-events log, its enrolment register, its sync agent)
 * against the REAL cloud (the API harness behind a `fetch` the test can cut or make lose a reply):
 *
 *   • the handheld enrols with head office's one-time code (its hash in the pack) and gets a cookie; without it the
 *     socket serves nothing, with it a batch is on the box's disk before the device hears `accepted`;
 *   • one sync pass makes a put-away head office's fact — the cloud bin holds the goods — and the status route says
 *     `posted`; the same batch again is `duplicate` before AND after a box restart (the enrolment survives the restart
 *     too), and nothing is re-sent;
 *   • a receiving scan whose cloud reply is lost is retried and settles to ONE `received` movement at the store;
 *   • a movement head office refuses (a bin it does not have) is a visible dead-letter on the box, with the code in its
 *     reason, that survives a restart — and moved nothing;
 *   • a device the pack now BLOCKS is refused at its next request, even with a valid cookie;
 *   • a box with no cloud holds the scans, counts them, and will not close the day over them.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['warehouse', 'handheld', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T10:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const packJson = (deviceStatus = 'registered'): string => JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'on_hand', expiry: null }],
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: deviceStatus, label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
});

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A put-away as the handheld queues it: the command it applied, who applied it, the command id on top for the route. */
const putAway = (id: string, over: Record<string, unknown> = {}) => makeEvent({
  id: `wh-move-${id}`, type: 'WarehouseMovementApplied', occurredAt: AT, idempotencyKey: `wh-move:${id}`, source: 'A-1',
  payload: {
    commandId: id, movedBy: 'u-worker',
    command: { commandId: id, kind: 'put_away', storeId: 'store-1', productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', fromBinId: null, toBinId: 'BIN-A', movedBy: 'u-worker', at: AT, ...over },
    movements: [],
  },
});
/** A receiving scan as the handheld queues it. */
const scanned = (id: string) => makeEvent({
  id: `recv-grn-1-${id}`, type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: `recv:grn-1:${id}`, source: 'A-1',
  payload: { grnId: 'grn-1', commandId: id, productId: 'p-rice', batchId: null, quantityMinor: 1, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT },
});

const deviceBase = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.devices!.port}`;
const enrol = async (edge: EdgeProcess, code = CODE, deviceId = 'hh-01'): Promise<{ status: number; cookie: string | undefined; body: Record<string, unknown> }> => {
  const res = await savedFetch(`${deviceBase(edge)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code }) });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: (await res.json()) as Record<string, unknown> };
};
const postBatch = async (edge: EdgeProcess, cookie: string | undefined, items: unknown[], source = 'warehouse'): Promise<{ status: number; acks: DeviceAck[]; body: Record<string, unknown> }> => {
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

async function boxWithoutCloud(dir?: string, deviceStatus = 'registered'): Promise<EdgeProcess> {
  const d = dir ?? await tempDir('sre-wh-handheld-nocloud-');
  const packFile = join(d, 'store-pack.json');
  await writeFile(packFile, packJson(deviceStatus), 'utf8');
  const edge = (await startEdge({ ...EDGE_ENV, EDGE_DATA_DIR: d, EDGE_PACK_FILE: packFile }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

/** A real cloud — cast, a registered bin — behind a controllable `fetch`. */
async function cloud(): Promise<{ h: ApiHarness; dir: string; start: (deviceStatus?: string) => Promise<EdgeProcess>; setOnline: (v: boolean) => void; loseNextReply: () => void; posts: () => number }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-worker', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  expect((await h.request({ method: 'POST', path: '/v1/warehouse/bins/BIN-A', userId: 'u-owner', tenantId: A, idempotencyKey: 'bin-a', body: { storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' } })).status).toBe(201);
  const dir = await tempDir('sre-wh-handheld-cloud-');

  let online = true;
  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if ((path.startsWith('/v1/warehouse/') || path.startsWith('/v1/inventory/')) && (init.method ?? 'GET') === 'POST') posts += 1;
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
    const edge = (await startEdge({
      ...EDGE_ENV, EDGE_DATA_DIR: dir, EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, dir, start, setOnline: (v) => { online = v; }, loseNextReply: () => { lose = true; }, posts: () => posts };
}

const binAt = async (h: ApiHarness) => (await h.request({ method: 'GET', path: '/v1/warehouse/bins/BIN-A', userId: 'u-owner', tenantId: A })).body as { occupancyMinor: number };
const onHandAt = async (h: ApiHarness, productId: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === 'store-1').reduce((s, r) => s + r.onHandMinor, 0);

describe('the warehouse handheld: enrol → device socket → box (durable) → head office (once)', () => {
  it('serves nothing without a credential; the one-time code enrols; a put-away is on the box\'s disk before accepted, reaches the cloud bin once, and is duplicate before and after a restart', async () => {
    const c = await cloud();
    const first = await c.start();
    const e = putAway('mv-1');
    // No cookie: nothing — not the shell, not the routes.
    expect((await postBatch(first, undefined, [{ key: e.idempotencyKey, event: e }])).status).toBe(403);
    expect((await savedFetch(`${deviceBase(first)}/warehouse/`, { headers: { accept: 'text/html' }, redirect: 'manual' })).status).toBe(302);
    expect((await enrol(first, 'ABCDE-FGHJK-LMNPQ-RSTUW')).status).toBe(403);
    const { status: enrolStatus, cookie } = await enrol(first);
    expect(enrolStatus).toBe(200);
    expect(cookie).toMatch(/^sre_device=hh-01\./);
    // The shell now comes with its assignment and a same-origin write base.
    const shell = await (await savedFetch(`${deviceBase(first)}/warehouse/`, { headers: { accept: 'text/html', cookie: cookie! } })).text();
    expect(shell).toContain('"workerId":"u-worker"');
    expect(shell).toContain('window.laneWriteBase = "";');

    const { status, acks } = await postBatch(first, cookie, [{ key: e.idempotencyKey, event: e }]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'wh-move:mv-1', status: 'accepted' }]);
    expect(await recordsOn(first)).toEqual([{ idempotencyKey: 'wh-move:mv-1', type: 'WarehouseMovementApplied' }]);
    expect((await binAt(c.h)).occupancyMinor).toBe(0); // nothing at head office yet — the box has it

    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(0);
    expect((await binAt(c.h)).occupancyMinor).toBe(6);
    expect((await statusOf(first, cookie!, ['wh-move:mv-1']))[0]?.state).toBe('posted');

    expect((await postBatch(first, cookie, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'wh-move:mv-1', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    // After a restart the enrolment still holds (the register is on the disk) and the record is still known.
    const second = await c.start();
    expect((await postBatch(second, cookie, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'wh-move:mv-1', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect((await binAt(c.h)).occupancyMinor).toBe(6);
    expect(second.enrolments!.enrolled().map((d) => d.deviceId)).toEqual(['hh-01']);
  });

  it('a receiving scan whose cloud reply is lost is retried and settles to ONE received movement at the store (RR-F02)', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    const s = scanned('recv-1');
    await postBatch(edge, cookie, [{ key: s.idempotencyKey, event: s }]);
    c.loseNextReply();
    const first = await edge.syncOnce!();
    expect(first.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('recv:grn-1:recv-1')).toMatchObject({ state: 'pending', attempts: 1 });
    expect(await onHandAt(c.h, 'p-rice')).toBe(1); // the cloud DID append it; the reply was what got lost
    const second = await edge.syncOnce!();
    expect(second.sent).toBe(1);
    expect(await onHandAt(c.h, 'p-rice')).toBe(1); // once
    expect(c.posts()).toBe(2);
    expect((await statusOf(edge, cookie!, ['recv:grn-1:recv-1']))[0]?.state).toBe('posted');
  });

  it('a movement head office refuses (a bin it does not have) is a visible dead-letter on the box with the code in its reason, survives a restart, and moved nothing', async () => {
    const c = await cloud();
    const first = await c.start();
    const { cookie } = await enrol(first);
    const bad = putAway('mv-2', { toBinId: 'BIN-Z' });
    expect((await postBatch(first, cookie, [{ key: bad.idempotencyKey, event: bad }])).acks[0]?.status).toBe('accepted');
    const pass = await first.syncOnce!();
    expect(pass.dead).toBe(1);
    const status = await statusOf(first, cookie!, ['wh-move:mv-2']);
    expect(status[0]?.state).toBe('refused');
    expect(status[0]?.reason).toMatch(/movement_unknown_bin/);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    const after = await statusOf(second, cookie!, ['wh-move:mv-2']);
    expect(after[0]?.state).toBe('refused');
    expect(after[0]?.reason).toMatch(/movement_unknown_bin/);
    expect((await binAt(c.h)).occupancyMinor).toBe(0);
  });

  it('a device head office blocks is refused at its next request, cookie or not — and its batch is never taken', async () => {
    const c = await cloud();
    const first = await c.start();
    const { cookie } = await enrol(first);
    await first.stop();
    cleanups.pop();
    // Head office blocked the handheld; the next pack says so.
    const second = await c.start('blocked');
    const e = putAway('mv-3');
    const refused = await postBatch(second, cookie, [{ key: e.idempotencyKey, event: e }]);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'device_not_active' });
    expect(await recordsOn(second)).toEqual([]);
    const shell = await savedFetch(`${deviceBase(second)}/warehouse/`, { headers: { accept: 'text/html', cookie: cookie! }, redirect: 'manual' });
    expect(shell.status).toBe(302);
    expect(shell.headers.get('location')).toBe('/device/enrol?why=device_not_active');
    // Nor can it enrol again while blocked.
    expect((await enrol(second)).body).toMatchObject({ enrolled: false, refusal: 'device_not_active' });
  });

  it('a box with no cloud takes the scans, holds them durably across a restart, counts them, and will not close the day over them', async () => {
    const dir = await tempDir('sre-wh-handheld-hold-');
    const first = await boxWithoutCloud(dir);
    const { cookie } = await enrol(first);
    const e = putAway('mv-4');
    const s = scanned('recv-4');
    expect((await postBatch(first, cookie, [{ key: e.idempotencyKey, event: e }, { key: s.idempotencyKey, event: s }])).acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    expect(first.syncStatus()).toMatchObject({ cloud: 'not_configured', unsent: 2 });
    expect((await first.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' })).closed).toBe(false);
    await first.stop();
    cleanups.pop();
    const second = await boxWithoutCloud(dir);
    expect(second.deviceEventsOutbox.pending().map((i) => i.key)).toEqual(['wh-move:mv-4', 'recv:grn-1:recv-4']);
    expect(second.syncStatus().unsent).toBe(2);
    expect((await postBatch(second, cookie, [{ key: s.idempotencyKey, event: s }])).acks).toEqual([{ key: 'recv:grn-1:recv-4', status: 'duplicate' }]);
  });

  it('a BLIND bin count and an adjustment REQUEST ride the same socket: head office reconciles the count against ITS bin and holds it, and posts the request ONCE only when a different person approves (SP-3b · W2 · W3 · §28)', async () => {
    const c = await cloud();
    const edge = await c.start();
    const { cookie } = await enrol(edge);
    // Head office's BIN-A comes to hold 6 of p-good (the put-away synced), and the store 1 of p-rice (the receiving scan).
    const e = putAway('mv-6');
    const r = scanned('recv-6');
    const count = makeEvent({
      id: 'count-cnt-1', type: 'StockCounted', occurredAt: AT, idempotencyKey: 'count-cnt-1', source: 'A-1',
      payload: { countId: 'cnt-1', productId: 'p-good', locationId: 'store-1', binId: 'BIN-A', uom: 'EA', countedMinor: 5, reasonCode: 'cycle_count', counterId: 'u-worker', at: AT, storeId: 'store-1', source: 'warehouse-handheld' },
    });
    const req = makeEvent({
      id: 'adj-req-adj-1', type: 'AdjustmentRequested', occurredAt: AT, idempotencyKey: 'adj-req:adj-1', source: 'A-1',
      payload: { requestId: 'adj-1', productId: 'p-rice', locationId: 'store-1', binId: null, deltaMinor: -1, uom: 'EA', reasonCode: 'damaged', note: 'torn bag', requestedBy: 'u-worker', at: AT, storeId: 'store-1', source: 'warehouse-handheld' },
    });
    const batch = await postBatch(edge, cookie, [e, r, count, req].map((ev) => ({ key: ev.idempotencyKey, event: ev })));
    expect(batch.acks.map((a) => a.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(4);
    expect(pass.dead).toBe(0);
    expect((await statusOf(edge, cookie!, ['count-cnt-1', 'adj-req:adj-1'])).map((i) => i.state)).toEqual(['posted', 'posted']);

    // The COUNT: head office expected 6 (ITS bin, never sent), counted 5 → −1; p-good has no cost at head office, so the
    // variance cannot be valued → HELD for a person, nothing applied, the bin still 6 (§28, #10).
    const counts = (await c.h.request({ method: 'GET', path: '/v1/inventory/counts', userId: 'u-owner', tenantId: A, query: { productId: 'p-good', locationId: 'store-1' } })).body as { counts: Record<string, unknown>[] };
    expect(counts.counts).toHaveLength(1);
    expect(counts.counts[0]).toMatchObject({ countId: 'cnt-1', binId: 'BIN-A', expectedMinor: 6, countedMinor: 5, varianceMinor: -1, pendingApproval: true, adjusted: false, counterId: 'u-worker', relayedBy: 'u-box' });
    expect(counts.counts[0]!['governanceFlags']).toContain('value_unknown');
    expect((await binAt(c.h)).occupancyMinor).toBe(6);

    // The REQUEST: pending, nothing moved; the raiser cannot decide it; the owner approves → ONE wasted movement; again → same.
    const pending = (await c.h.request({ method: 'GET', path: '/v1/inventory/adjustment-requests', userId: 'u-owner', tenantId: A, query: { status: 'pending' } })).body as { requests: { requestId: string; requestedBy: string; relayedBy: string; status: string }[] };
    expect(pending.requests).toEqual([expect.objectContaining({ requestId: 'adj-1', requestedBy: 'u-worker', relayedBy: 'u-box', status: 'pending' })]);
    expect(await onHandAt(c.h, 'p-rice')).toBe(1);
    const self = await c.h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/adj-1/decide', userId: 'u-worker', tenantId: A, idempotencyKey: 'd-self', body: { decision: 'approved', reason: 'it was me' } });
    expect(self.status).toBe(422);
    expect(await onHandAt(c.h, 'p-rice')).toBe(1);
    const approve = await c.h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/adj-1/decide', userId: 'u-owner', tenantId: A, idempotencyKey: 'd-1', body: { decision: 'approved', reason: 'saw the bag' } });
    expect(approve.status).toBe(200);
    expect(approve.body).toMatchObject({ status: 'posted', movementId: 'adj-req:adj-1' });
    expect(await onHandAt(c.h, 'p-rice')).toBe(0);
    const again = await c.h.request({ method: 'POST', path: '/v1/inventory/adjustment-requests/adj-1/decide', userId: 'u-owner', tenantId: A, idempotencyKey: 'd-1-again', body: { decision: 'approved', reason: 'saw the bag' } });
    expect(again.body).toMatchObject({ status: 'posted', alreadyDecided: true });
    expect(await onHandAt(c.h, 'p-rice')).toBe(0);
    // The handheld re-sending both after a lost reply is duplicate at the box — nothing reaches head office twice.
    expect((await postBatch(edge, cookie, [count, req].map((ev) => ({ key: ev.idempotencyKey, event: ev })))).acks.map((a) => a.status)).toEqual(['duplicate', 'duplicate']);
    await edge.syncOnce!();
    expect(c.posts()).toBe(4);
  });
});
