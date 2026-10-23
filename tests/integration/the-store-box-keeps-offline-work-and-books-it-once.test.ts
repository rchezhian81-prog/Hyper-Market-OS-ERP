import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

// OB-288 lane 2 · P2 — THE PROOF, through the REAL store box (`startEdge`) and the REAL head office (the API harness behind
// a `fetch` this test can cut, make lose a reply, or put a clock skew on). For every kind of offline store work — a
// production run, its quality release, a weigh-in/weigh-out, a food-safety check, a transfer sent and a transfer counted in:
//   1. with the NETWORK CUT the box takes the work durably (fsync'd before "accepted") and sends nothing;
//   2. a COLD RESTART of the box loses nothing: every item is still pending, a re-sent item is "duplicate";
//   3. on RECONNECT each is booked at head office ONCE — a lost reply and a re-send settle to one effect;
//   4. a CONFLICT (a transfer cancelled at head office while the van was loaded) is a visible refusal kept on the box,
//      across a restart (hard rules #6, #10), never last-write-wins.
// And the box's own copy of head office's work (the production board and recipes, the food-safety checks, the transfers)
// survives a cold restart with the cable out, and its clock is measured against head office's on every answer (OB-327).
// Synthetic data only (hard rule #7).

const S1 = 'S1'; const BACK = 'S1-BACK'; const KITCHEN = 'S1-KITCHEN'; const S2 = 'S2';
const KEY = ['p2', 'box', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
type Body = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function headOffice(harness: () => ApiHarness): Promise<{ h: ApiHarness; T: string; call: (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) => Promise<{ status: number; body: unknown }> }> {
  const h = harness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  for (const [u, r, b] of [['u-cook', 'store_manager', S1], ['u-qc', 'store_manager', S1], ['u-wh', 'store_manager', S1], ['u-wh2', 'store_manager', S2]] as const) await h.provisionRole(T, u, r, [b]);
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
    [BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: S1, companyId: 'C1' }], [KITCHEN, { kind: 'department', name: 'Cafe kitchen', parentId: S1, companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
  expect((await call('POST', '/v1/production/departments/cafe', 'u-owner', {})).status).toBeLessThan(300);
  expect((await call('POST', '/v1/production/recipes/r-cake', 'u-owner', { departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea', inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }], shelfLifeHours: 48 })).status).toBe(201);
  for (const m of [
    { movementId: 'seed-flour', productId: 'FLOUR', locationId: KITCHEN, kind: 'received', quantityMinor: 1_000, uom: 'g' },
    { movementId: 'seed-rice', productId: 'RICE', locationId: BACK, kind: 'received', quantityMinor: 40, uom: 'EA', unitCostMinor: 5_000 },
  ]) expect((await call('POST', '/v1/inventory/movements', 'u-owner', { ...m, occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner' })).status).toBeLessThan(300);
  // Two transfers proposed from store 1's back store to store 2: one to be sent, one head office will cancel.
  for (const id of ['t-send', 't-cancel']) expect((await call('POST', `/v1/warehouse/transfers/${id}`, 'u-owner', { fromLocationId: BACK, toLocationId: S2, lines: [{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }] })).status).toBe(201);
  const HOUR = 3_600_000;
  const startsAt = new Date(Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR).toISOString();
  expect((await call('POST', '/v1/facilities/food-safety/checks/chiller', 'u-owner', { branchId: S1, title: 'Dairy chiller', kind: 'temperature', everyMinutes: 60, startsAt, graceMinutes: 30, minTenthsC: 0, maxTenthsC: 50, assignedRole: 'store_manager', escalatesTo: 'u-owner' })).status).toBe(201);
  return { h, T, call };
}

/** The real cloud behind a controllable fetch (cut, lose the next reply, skew its clock), and a real box pointed at it. */
async function cloudAndBox(harness: () => ApiHarness) {
  const ho = await headOffice(harness);
  const dir = await mkdtemp(join(tmpdir(), 'sre-p2-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, JSON.stringify({
    version: 1, lossPreventionRules: [],
    policies: { tradingDayCutoff: '02:00', storeId: S1, branchId: S1, warehouseId: BACK },
    productionPolicy: { userId: 'u-cook', permissions: ['production.read', 'production.plan.commit', 'production.release'] },
    facilitiesPolicy: { userId: 'u-cook', permissions: ['facilities.overdue.read', 'facilities.task.record'] },
    warehouse: { assignmentId: 'a-1', workerId: 'u-wh', storeId: S1, bins: [] },
  }), 'utf8');
  const net = { up: true, loseNext: false, skewMs: 0, posts: 0 };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!net.up) throw new Error('ECONNREFUSED');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'POST') net.posts += 1;
    const res = await ho.h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (net.loseNext) { net.loseNext = false; throw new Error('ECONNRESET'); } // head office acted; the reply never came
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date(Date.now() + net.skewMs).toUTCString() } });
  }) as unknown as typeof globalThis.fetch;
  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: ho.T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: ho.T, branchId: S1 }), EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  // Store 2's own box — where the transfer is counted in.
  await ho.h.provisionRole(ho.T, 'u-box-2', 'store_computer', [S2]);
  const dir2 = await mkdtemp(join(tmpdir(), 'sre-p2-box2-'));
  cleanups.push(async () => { await rm(dir2, { recursive: true, force: true }); });
  const packFile2 = join(dir2, 'store-pack.json');
  await writeFile(packFile2, JSON.stringify({ version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: S2, branchId: S2 } }), 'utf8');
  const start2 = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir2, EDGE_TENANT_ID: ho.T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box-2', tenantId: ho.T, branchId: S2 }), EDGE_PACK_FILE: packFile2,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { ...ho, net, start, start2, dir };
}

const hand = async (edge: EdgeProcess, source: string, events: readonly DomainEvent[]): Promise<DeviceAck[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
    body: JSON.stringify({ source, items: events.map((e) => ({ key: e.idempotencyKey, event: e })) }),
  });
  return ((await res.json()) as { acks: DeviceAck[] }).acks;
};
const statusOf = async (edge: EdgeProcess, keys: readonly string[]): Promise<BoxItemStatus[]> =>
  ((await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`)).json()) as { items: BoxItemStatus[] }).items;
const served = async (edge: EdgeProcess, screen: 'production' | 'facilities' | 'warehouse' | 'manager'): Promise<Body> => {
  const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}/${screen}/`)).text();
  const m = new RegExp(`<script>window\\.${GLOBAL_FOR[screen]} = ([\\s\\S]*?);</script>`).exec(html);
  expect(m, html.slice(0, 200)).not.toBeNull();
  return JSON.parse(m![1]!) as Body;
};

const ev = (type: string, key: string, source: string, payload: Body): DomainEvent => makeEvent({ id: key, type, occurredAt: String(payload['at'] ?? new Date().toISOString()), idempotencyKey: key, source, payload });
const MADE = new Date(Date.now() - 2 * 3_600_000).toISOString();

const backings = useBackings();

describe.each(backings)('the store box keeps offline work through a cut and a cold restart, and head office books it once (OB-288 lane 2 · P2 · §31) — head office on $name', ({ harness }) => {
  it('a run, its release, a weigh, a food-safety check, a transfer sent and counted in: kept with the cable out and across a restart, booked once on reconnect — a lost reply settles to one', async () => {
    const c = await cloudAndBox(harness);
    const slot = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000).toISOString();
    const work = [
      ev('ProductionRunCaptured', 'run:r-1', 'web-erp/production', { runId: 'r-1', storeId: S1, recipeId: 'r-cake', batches: 2, actualOutputMinor: 2, outputBatchId: 'CAKE-1', locationId: KITCHEN, producedBy: 'u-cook', at: MADE, source: 'production-screen' }),
      ev('ProductionReleaseDecided', 'release:r-1', 'web-erp/production', { runId: 'r-1', storeId: S1, qcPassed: true, releasedBy: 'u-qc', at: new Date(Date.parse(MADE) + 600_000).toISOString(), source: 'production-screen' }),
      ev('WeighedRunCaptured', 'weighed:w-1', 'web-erp/production', { runId: 'w-1', storeId: S1, departmentId: 'meat', inputs: [{ productId: 'CHICKEN', weightGrams: 2_000 }], outputs: [{ productId: 'CUTS', weightGrams: 1_500 }], weighedBy: 'u-cook', at: MADE, source: 'production-screen' }),
      ev('FoodSafetyCheckRecorded', 'food-safety:fs-1', 'web-erp/facilities', { recordId: 'fs-1', checkId: 'chiller', storeId: S1, performedBy: 'u-cook', at: new Date(Date.parse(slot) + 300_000).toISOString(), slotDueAt: slot, readingTenthsC: 35, source: 'facilities-screen' }),
    ];
    const sent = ev('TransferDispatchRecorded', 'transfer-dispatch:t-send', 'warehouse-app', { transferId: 't-send', storeId: S1, dispatchedBy: 'u-wh', at: MADE, source: 'warehouse-handheld' });
    const keys = [...work, sent].map((e) => e.idempotencyKey);

    // ── 1. the cable is out: everything is taken durably, nothing reaches head office ──
    c.net.up = false;
    const first = await c.start();
    expect((await hand(first, 'manager', work)).map((a) => a.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect((await hand(first, 'warehouse', [sent]))[0]?.status).toBe('accepted');
    // A handheld record may not ride the manager's screen surface (the allow-list), and vice versa.
    expect((await hand(first, 'manager', [ev('TransferDispatchRecorded', 'transfer-dispatch:x', 'x', { transferId: 'x' })]))[0]?.status).toBe('refused');
    expect((await first.syncOnce!()).sent).toBe(0);
    expect((await statusOf(first, keys)).map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    expect(c.net.posts).toBe(0);

    // ── 2. cold restart, still offline: nothing lost, a re-sent item is the same item ──
    await first.stop(); cleanups.pop();
    const second = await c.start();
    expect((await statusOf(second, keys)).map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    expect((await hand(second, 'manager', work.slice(0, 1)))[0]?.status).toBe('duplicate');

    // ── 3. the line is back — one reply is lost on the way; the next pass settles everything to ONE effect ──
    c.net.up = true;
    c.net.loseNext = true;
    await second.syncOnce!();
    for (let i = 0; i < 4; i += 1) await second.syncOnce!();
    expect((await statusOf(second, keys)).map((s) => s.state)).toEqual(['posted', 'posted', 'posted', 'posted', 'posted']);
    const runs = ((await c.call('GET', '/v1/production/runs', 'u-owner')).body as { runs: { runId: string; released: boolean; producedBy: string; releasedBy: string | null }[] }).runs;
    expect(runs).toEqual([expect.objectContaining({ runId: 'r-1', producedBy: 'u-cook', released: true, releasedBy: 'u-qc' })]);
    const onHand = async (p: string, l: string) => (((await c.call('GET', '/v1/inventory/availability', 'u-owner')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows.find((r) => r.productId === p && r.locationId === l)?.onHandMinor ?? 0);
    expect(await onHand('FLOUR', KITCHEN)).toBe(800);
    expect(await onHand('CAKE', KITCHEN)).toBe(2);
    expect(await onHand('RICE', BACK)).toBe(30);
    expect(((await c.call('GET', '/v1/production/weighed-runs', 'u-owner')).body as { runs: unknown[] }).runs).toHaveLength(1);
    const fs = (await c.call('GET', '/v1/facilities/food-safety/status', 'u-owner', undefined, { branchId: S1 })).body as { slots: { slotDueAt: string; state: string; performedBy?: string }[] };
    expect(fs.slots.find((s) => s.slotDueAt === slot)).toMatchObject({ state: 'done', performedBy: 'u-cook' });
    expect(((await c.call('GET', '/v1/warehouse/transfers/t-send', 'u-owner')).body as Body)).toMatchObject({ state: 'in_transit', approvedBy: 'u-wh', dispatchRelay: { relayedBy: 'u-box' } });

    // Re-sent after posting, and after another restart: duplicate, and head office still holds one of each.
    expect((await hand(second, 'manager', work)).map((a) => a.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    await second.stop(); cleanups.pop();
    const third = await c.start();
    expect((await hand(third, 'warehouse', [sent]))[0]?.status).toBe('duplicate');
    await third.syncOnce!();
    expect(((await c.call('GET', '/v1/production/runs', 'u-owner')).body as { runs: unknown[] }).runs).toHaveLength(1);
    expect(await onHand('RICE', BACK)).toBe(30);

    // ── the same at the other end: store 2's box counts it in with the line down, restarts, and books it once ──
    c.net.up = false;
    const counted = ev('TransferReceiptRecorded', 'transfer-receipt:t-send', 'warehouse-app', { transferId: 't-send', storeId: S2, receivedBy: 'u-wh2', at: new Date().toISOString(), counted: [{ productId: 'RICE', batchId: null, quantityMinor: 9 }], source: 'warehouse-handheld' });
    const s2 = await c.start2();
    expect((await hand(s2, 'warehouse', [counted]))[0]?.status).toBe('accepted');
    expect((await s2.syncOnce!()).sent).toBe(0);
    await s2.stop(); cleanups.pop();
    const s2again = await c.start2();
    expect((await statusOf(s2again, [counted.idempotencyKey]))[0]?.state).toBe('pending');
    c.net.up = true;
    c.net.loseNext = true;
    await s2again.syncOnce!();
    await s2again.syncOnce!();
    expect((await statusOf(s2again, [counted.idempotencyKey]))[0]?.state).toBe('posted');
    expect(await onHand('RICE', S2)).toBe(9);
    const exceptions = (await c.call('GET', '/v1/inventory/exceptions', 'u-owner')).body as { transferShortfalls: { transferId: string }[] };
    expect(exceptions.transferShortfalls.filter((x) => x.transferId === 't-send')).toHaveLength(1);
  });

  it('a transfer cancelled at head office while the box sent it offline is a visible refusal kept on the box across a restart; the store\'s work feeds survive a cold restart offline; the clock is measured (OB-327)', async () => {
    const c = await cloudAndBox(harness);
    // Head office's word on the store's work reaches the box while the line is up — and its clock is 6 minutes ahead of the box.
    c.net.skewMs = 6 * 60_000;
    const box = await c.start();
    const outcomes = await box.refreshWorkFeeds!();
    expect(outcomes.map((o) => [o.name, o.status])).toEqual([['production', 'updated'], ['food-safety', 'updated'], ['transfers', 'updated'], ['quality-holds', 'updated']]);
    const mgr = await served(box, 'manager');
    expect(mgr['clock']).toMatchObject({ verdict: 'flag_bills', offsetSeconds: 360, thresholds: { warnSeconds: 120, flagSeconds: 300, by: 'owner_decision_ob327' }, needsAttention: true });

    // Head office cancels t-cancel; the box — offline — sends it anyway from the handheld.
    expect((await c.call('POST', '/v1/warehouse/transfers/t-cancel/cancel', 'u-owner', { reason: 'store 2 is full' })).status).toBe(200);
    c.net.up = false;
    await box.stop(); cleanups.pop();
    const cold = await c.start();
    // Cold restart with the cable out: the production board, the recipes, the checks and the transfers are still served.
    const prod = await served(cold, 'production');
    expect((prod['board'] as Body)['recipes']).toEqual([expect.objectContaining({ recipeId: 'r-cake', shelfLifeHours: 48 })]);
    expect((prod['board'] as Body)['enabledDepartments']).toEqual(['cafe']);
    const fac = await served(cold, 'facilities');
    expect(((fac['foodSafety'] as Body)['checks'] as Body[]).map((x) => x['checkId'])).toEqual(['chiller']);
    const wh = await served(cold, 'warehouse');
    expect(((wh['transfers'] as Body)['toSend'] as Body[]).map((t) => t['transferId']).sort()).toEqual(['t-cancel', 't-send']);
    // The clock verdict is still said after the restart (from the box's own clock log), as last checked.
    expect((await served(cold, 'manager'))['clock']).toMatchObject({ verdict: 'flag_bills', offsetSeconds: 360 });

    const late = ev('TransferDispatchRecorded', 'transfer-dispatch:t-cancel', 'warehouse-app', { transferId: 't-cancel', storeId: S1, dispatchedBy: 'u-wh', at: new Date().toISOString(), source: 'warehouse-handheld' });
    expect((await hand(cold, 'warehouse', [late]))[0]?.status).toBe('accepted');
    c.net.up = true;
    c.net.skewMs = 0;
    const pass = await cold.syncOnce!();
    expect([pass.sent, pass.dead]).toEqual([0, 1]);
    const [refused] = await statusOf(cold, [late.idempotencyKey]);
    expect(refused).toMatchObject({ state: 'refused' });
    expect(refused?.reason).toContain('transfer_cancelled');
    expect(await (async () => (((await c.call('GET', '/v1/inventory/availability', 'u-owner')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows.find((r) => r.productId === 'RICE' && r.locationId === BACK)?.onHandMinor))()).toBe(40);
    // In step again once head office's clock agrees.
    expect((await served(cold, 'manager'))['clock']).toMatchObject({ verdict: 'in_step' });
    await cold.stop(); cleanups.pop();
    const again = await c.start();
    expect((await statusOf(again, [late.idempotencyKey]))[0]).toMatchObject({ state: 'refused' }); // hard rule #6: kept
  });
});
