import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { r3OpsBackings } from '../support/r3-ops-backings';
import { approvedSuppliers } from '../support/approved-supplier';
import type { HttpRequest } from '../../services/kernel/src/index';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { asPhoneHolder } from '../../edge/store-edge/src/handheld-sign-in';
import type { StorePackEnvelope } from '../../services/platform/src/store-packs';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import { DsdDoorSession, type DsdDoorData } from '../../apps/warehouse-app/src/dsd-door';

/**
 * **R3 D-11 (signed): "a DSD delivery is checked in against its vendor and PO or route" — the ROUTE half, on the handheld.**
 *
 * Until now head office kept the vendors' route sheets (`POST /v1/inventory/dsd-routes/:routeId`) but the store computer
 * never served them, so the door check-in on the warehouse phone could be made against a purchase order only. On the real
 * API (in memory and, with DATABASE_URL, on real PostgreSQL) and a REAL store computer:
 *   • head office's store pack carries the store's route sheets — the latest version of each, this store's only — and the
 *     box's warehouse page serves them to the phone, the same way it serves the open orders;
 *   • offline, the phone offers the route beside the orders, checks the van in against it and closes with the signed note:
 *     ONE record, for the place the sheet names;
 *   • the box keeps it while head office is unreachable and across its own restart, then relays it once;
 *   • head office judges it against ITS route sheet and keeps the existing rule: everything kept from a route sheet (no
 *     purchase order) is HELD, nothing on the ledger, until a SECOND person decides — the receiver cannot (§28), and that
 *     holds across head office's cold restart.
 */
const backings = r3OpsBackings();
const STORE = 'S1';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'WH' };
type Body = Record<string, unknown>;

const savedFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { globalThis.fetch = savedFetch; for (const c of cleanups.splice(0).reverse()) await c(); });

describe.each(backings)('a vendor\'s route sheet reaches the warehouse handheld through the box — on $name (R3 D-11)', ({ harness, restart }) => {
  it('head office\'s route sheet → the store pack → the box\'s warehouse page → a route check-in offline → the box → held for a second person', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    await approvedSuppliers(h, T, 'sup-bake', 'sup-other');
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/WH', { kind: 'warehouse', name: 'Back store', parentId: 'C1', companyId: 'C1' }), 'back store');
    await ok(req('POST', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/org/nodes/S2', { kind: 'branch', name: 'Second store', parentId: 'C1', companyId: 'C1' }), 'store 2');
    await ok(req('POST', `/v1/stores/${STORE}/settings`, SETTINGS), 'settings');
    // The catalogue the phone scans against: bread has a barcode.
    await h.store.append(T, STREAM.catalogue, makeEvent({ id: 'cat-1', type: 'CataloguePublished', occurredAt: new Date().toISOString(), idempotencyKey: `cat-${T}-1`, source: 'test', payload: { snapshot: {
      tenantId: T, version: 1, builtAt: new Date().toISOString(), scope: { tenantId: T, storeId: STORE },
      products: [{ productId: 'p-bread', sku: 'BREAD', name: 'Bread 400g', unitPriceMinor: 4_500, taxBps: 0, status: 'active', baseUom: 'each' }],
      barcodes: [{ code: '890BREAD', productId: 'p-bread' }],
    }, signature: 'x', publishedBy: 'u-owner', publishedAt: new Date().toISOString() } }));

    // ── head office keeps the route sheets: a cashier cannot; a second version replaces the first; another store's is not ours ──
    const sheet = { supplierId: 'sup-bake', storeId: STORE, lines: [{ productId: 'p-bread', expectedMinor: 30, unitCostMinor: 2_000 }] };
    expect((await req('POST', '/v1/inventory/dsd-routes/r-bread', sheet, 'u-till')).status).toBe(403);
    await ok(req('POST', '/v1/inventory/dsd-routes/r-bread', sheet, 'u-recv'), 'route sheet v1');
    await ok(req('POST', '/v1/inventory/dsd-routes/r-bread', { ...sheet, lines: [{ productId: 'p-bread', expectedMinor: 24, unitCostMinor: 2_000 }] }, 'u-recv'), 'route sheet v2');
    await ok(req('POST', '/v1/inventory/dsd-routes/r-s2', { supplierId: 'sup-other', storeId: 'S2', lines: [{ productId: 'p-bread', expectedMinor: 5 }] }, 'u-owner'), 'another store\'s route');

    // ── the real cloud behind a fetch the test can cut; a real store computer pointed at it, serving its screens ──
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname + new URL(url).search,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-dsd-route-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const boot = async (): Promise<EdgeProcess> => {
      const e = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE }),
        EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      }, () => {}))!;
      cleanups.push(async () => { await e.stop(); });
      return e;
    };
    let edge = await boot();
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const pack = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    const routesInPack = (pack.sections['warehouse'] as { dsdRoutes: unknown[] }).dsdRoutes;
    expect(routesInPack).toEqual([{ routeId: 'r-bread', supplierId: 'sup-bake', storeId: STORE, version: 2, lines: [{ productId: 'p-bread', expectedMinor: 24, unitCostMinor: 2_000, uom: 'ea' }] }]);

    // The box's warehouse page carries them to the phone, beside the orders (none are open here).
    const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}/warehouse`)).text();
    const m = new RegExp(`<script>window\\.${GLOBAL_FOR['warehouse']} = ([\\s\\S]*?);</script>`).exec(html);
    expect(m, html.slice(0, 300)).not.toBeNull();
    const served = JSON.parse(m![1]!) as Body;
    expect(served['dsdRoutes']).toEqual(routesInPack);
    expect(served['openDeliveries']).toEqual([]);

    // ── OFFLINE at the back door: the phone (signed in as the receiver) checks the van in against the route ──
    online = false;
    const outbox = new SyncOutbox();
    const phone = new DsdDoorSession(asPhoneHolder('warehouse', served, 'u-recv') as unknown as DsdDoorData, outbox, () => '2030-06-01T06:30:00.000Z');
    expect(phone.choices()).toEqual({ orders: [], routes: [{ routeId: 'r-bread', supplierId: 'sup-bake' }] });
    expect(phone.start({ checkInId: 'door-1', routeId: 'r-bread', driverName: 'mobile 9876543210' }).code).toBe('dsd_started');
    for (const id of ['b1', 'b2', 'b3']) expect(phone.scan(id, '890BREAD').code).toBe('dsd_scanned');
    const view = phone.view()!;
    expect(view.lines).toEqual([expect.objectContaining({ productId: 'p-bread', expectedMinor: 24, scannedMinor: 3, keptMinor: 3, receivableMinor: 0, heldMinor: 3 })]);
    expect(view.discrepancies).toEqual([{ productId: 'p-bread', kind: 'short', expectedMinor: 24, scannedMinor: 3, differenceMinor: -21 }]);
    expect(phone.close({ noteRef: 'NOTE-BAKE-1', driverSignedName: 'mobile 9876543210' }).code).toBe('dsd_closed');
    expect(outbox.unsentCount()).toBe(1);
    const queued = outbox.all()[0]!.event;
    expect(queued.payload).toMatchObject({ routeId: 'r-bread', supplierId: 'sup-bake', storeId: STORE, receivedBy: 'u-recv' });

    // Handed to the box; the box keeps it while head office is unreachable, and across its own restart.
    const hand = async (e: EdgeProcess): Promise<DeviceAck | undefined> => {
      const res = await savedFetch(`http://127.0.0.1:${e.lane!.port}/lane/outbox`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
        body: JSON.stringify({ source: 'warehouse', items: [{ key: queued.idempotencyKey, event: queued }] }),
      });
      return ((await res.json()) as { acks: DeviceAck[] }).acks[0];
    };
    const statusOf = async (e: EdgeProcess): Promise<BoxItemStatus | undefined> =>
      ((await (await savedFetch(`http://127.0.0.1:${e.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(queued.idempotencyKey)}`)).json()) as { items: BoxItemStatus[] }).items[0];
    expect((await hand(edge))?.status).toBe('accepted');
    expect((await edge.syncOnce!()).sent).toBe(0);
    expect(await statusOf(edge)).toMatchObject({ state: 'pending' });
    await edge.stop(); cleanups.pop();
    edge = await boot();
    expect(await statusOf(edge)).toMatchObject({ state: 'pending' });
    expect((await req('GET', '/v1/inventory/dsd-checkins/door-1')).status).toBe(404);

    // ── the line returns: relayed once, judged against head office's own sheet, everything kept HELD ──
    online = true;
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await statusOf(edge))?.state).toBe('posted');
    expect((await hand(edge))?.status).toBe('duplicate');
    const onHand = async (p: string) => ((await req('GET', '/v1/inventory/availability', undefined, 'u-owner', { productId: p })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
    type Rec = { checkIn: { via: string; against: { kind: string; routeId?: string }; storeId: string; receivedBy: string; flags: string[]; status: string; held: { state: string; lines: { productId: string; quantityMinor: number }[] }; deliveryNote: { noteRef: string } } };
    const rec = (await ok(req('GET', '/v1/inventory/dsd-checkins/door-1'), 'the relayed check-in')).body as Rec;
    expect(rec.checkIn).toMatchObject({ via: 'relayed', against: { kind: 'route', routeId: 'r-bread' }, storeId: STORE, receivedBy: 'u-recv', flags: [], status: 'closed', held: { state: 'pending', lines: [{ productId: 'p-bread', quantityMinor: 3 }] }, deliveryNote: { noteRef: 'NOTE-BAKE-1' } });
    expect(await onHand('p-bread')).toBe(0);

    // ── head office's COLD RESTART: the hold is still there; the receiver cannot decide it; a second person does ──
    h = restart(h);
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    const after = (await ok(req('GET', '/v1/inventory/dsd-checkins/door-1'), 'after restart')).body as Rec;
    expect(after.checkIn.held.state).toBe('pending');
    const self = await req('POST', '/v1/inventory/dsd-checkins/door-1/held/decide', { decision: 'approved', reason: 'mine' }, 'u-recv');
    expect((self.body as { error?: { code?: string } }).error?.code).toBe('self_approval');
    expect((await req('POST', '/v1/inventory/dsd-checkins/door-1/held/decide', { decision: 'approved', reason: 'mine' }, 'u-till')).status).toBe(403);
    expect(await onHand('p-bread')).toBe(0);
    await ok(req('POST', '/v1/inventory/dsd-checkins/door-1/held/decide', { decision: 'approved', reason: 'on the bakery route' }, 'u-mgr2'), 'second person');
    expect(await onHand('p-bread')).toBe(3);
  }, 90_000);

  it('head office with no route sheets for the store: the pack says so with an empty list, and the phone offers orders only', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    const post = (path: string, body: unknown) => h.request({ method: 'POST', path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    expect((await post('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await post(`/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await post(`/v1/stores/${STORE}/settings`, { ...SETTINGS, warehouseId: STORE })).status).toBe(201);
    const pack = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: 'u-box', tenantId: T });
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    const w = (pack.body as StorePackEnvelope).sections['warehouse'] as Body;
    expect(w['dsdRoutes']).toEqual([]);
    const phone = new DsdDoorSession({ ...(w as object), workerId: 'u-recv' } as unknown as DsdDoorData, new SyncOutbox());
    expect(phone.choices().routes).toEqual([]);
  });
});
