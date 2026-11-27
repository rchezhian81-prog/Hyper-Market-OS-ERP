import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM } from '../../services/api/src/adapters';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { openDeviceOutbox, type DeviceStore } from '../../packages/sync/src/device-outbox';
import { drainToBox } from '../../packages/sync/src/device-drain';
import { WarehouseSession, type WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import { withTillPeople, issueTillPins, signInOnPhone, type TillPerson } from '../support/till-operator';
import { deviceBase as boxDoor, trustTheBoxes } from '../support/box-tls';

/**
 * **D-031 (pending list 27 Nov, item 3): a receiving scan on the warehouse handheld reaches head office's stock only when the
 * person sends the receipt — end to end, phone → the REAL store computer → the REAL head office, in memory and on real
 * PostgreSQL (P-01 · P-08 · M07-FR-01 · hard rules #2 #6 #10).**
 *
 * The phone is the real `WarehouseSession` over a phone's storage; the store computer is `startEdge` with its device door,
 * durable log and sync agent; head office is the API surface behind a `fetch` the test can cut or make lose a reply.
 *
 *   • scans are HELD on the phone: a sync pass carries nothing to the store computer, and head office's stock is untouched;
 *   • the page reloaded keeps them; a wrong scan is removed before sending and the removal is kept on the receipt;
 *   • "send" with the store computer unreachable keeps everything on the phone and says so; the next pass hands it over;
 *   • head office books ONE receipt with all its lines, once — a lost reply retried posts nothing twice;
 *   • an OLD phone's scans (one record per scan, then the completion) are still booked exactly as before;
 *   • a phone updated mid-delivery: its old scans and its held ones end up on one receipt, each counted once.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['d031', 'held', 'scans', 'signing', 'key'].join('-').padEnd(48, '0');
const AT = '2026-11-27T09:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PHONE_PEOPLE: readonly TillPerson[] = [{ userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] }];

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
  bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  grnId: 'grn-1', poId: 'po-1',
  ordered: [{ productId: 'p-rice', quantityMinor: 10, unitCost: { minor: 4000, currency: 'INR' } }],
  barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
  packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }],
};

const packJson = (): string => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: ASSIGNMENT.bins, grnId: 'grn-1', poId: 'po-1' },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, PHONE_PEOPLE));

/** A phone's storage: keys that outlive any one page. */
function phoneStorage() {
  const keys = new Map<string, string>();
  const store = (key: string): DeviceStore => ({ read: () => keys.get(key) ?? null, write: (v) => { keys.set(key, v); } });
  return { keys, outbox: store('outbox'), held: store('held') };
}
/** Open the handheld page on that storage (a reload, or the browser opened again). */
function openPage(phone: ReturnType<typeof phoneStorage>) {
  const outbox = openDeviceOutbox(phone.outbox, () => {});
  const s = new WarehouseSession(ASSIGNMENT, outbox, { now: () => AT, held: phone.held } as ConstructorParameters<typeof WarehouseSession>[2]);
  return { outbox, s };
}
const scan = (s: WarehouseSession, commandId: string, qty: number) =>
  s.receive({ commandId, grnId: 'grn-1', barcode: '890RICE', scannedQuantity: qty, source: 'po' });

describe.each(backings)('D-031 — held scans reach head office only when the receipt is sent — on $name', ({ harness }) => {
  const savedFetch = trustTheBoxes(globalThis.fetch);
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    globalThis.fetch = savedFetch;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function setup() {
    const A = randomUUID();
    const h = harness();
    await h.seedOwner(A, 'u-owner');
    await approvedSuppliers(h, A, 's-1');
    await deliveryPlaces(h, A, 'store-1');
    await h.provisionRole(A, 'u-worker', 'store_manager');
    await h.provisionRole(A, 'u-box', 'store_computer', ['store-1']);
    expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-1', userId: 'u-worker', tenantId: A, idempotencyKey: 'po-1', body: { supplierId: 's-1', deliverToLocationId: 'store-1', lines: [{ productId: 'p-rice', orderedQty: 10, unitCost: { minor: 4000, currency: 'INR' } }] } })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-1/approval', userId: 'u-owner', tenantId: A, idempotencyKey: 'po-1-approve', body: { reason: 'fixture' } })).status).toBe(200);
    const dir = await mkdtemp(join(tmpdir(), 'sre-d031-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    let lose = false;
    let posts = 0;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('https://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const path = new URL(url).pathname;
      if (path.startsWith('/v1/inventory/') && (init.method ?? 'GET') === 'POST') posts += 1;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      if (lose) { lose = false; throw new Error('ECONNRESET'); }
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, packJson(), 'utf8');
    await issueTillPins(dir, KEY, PHONE_PEOPLE.map((p) => p.userId));
    const edge: EdgeProcess = (await startEdge({
      EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_DATA_DIR: dir, EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'store-1' }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    const base = boxDoor(edge);
    const enrolled = await savedFetch(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    const device = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    const cookie = await signInOnPhone(base, device, 'u-worker', 'warehouse');
    let boxReachable = true;
    /** The phone's hand-over pass to the store computer (the page does this every few seconds). */
    const handOver = (outbox: ReturnType<typeof openPage>['outbox']) => drainToBox({
      outbox, boxBase: base, source: 'warehouse',
      fetch: (async (url: string, init: RequestInit) => {
        if (!boxReachable) throw new Error('Failed to fetch');
        return savedFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
      }) as unknown as typeof fetch,
    });
    const onHand = async (): Promise<number> =>
      ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId: 'p-rice' } })).body as { rows: { locationId: string; onHandMinor: number }[] })
        .rows.filter((r) => r.locationId === 'store-1').reduce((n, r) => n + r.onHandMinor, 0);
    const receipt = async () => h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-1', userId: 'u-owner', tenantId: A });
    const scansAtHeadOffice = async () => ((await h.request({ method: 'GET', path: '/v1/inventory/receiving-scans', userId: 'u-owner', tenantId: A, query: { grnId: 'grn-1' } })).body as { scans: { commandId: string; governanceFlags: string[] }[] }).scans;
    const received = async () => (await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' }))
      .map((e) => e.event.payload as { movementId: string; quantityMinor: number }).filter((m) => m.movementId.startsWith('recv:grn-1:'));
    return {
      A, h, edge, handOver, onHand, receipt, scansAtHeadOffice, received, cookie, base,
      setBoxReachable: (v: boolean) => { boxReachable = v; }, loseNextReply: () => { lose = true; }, posts: () => posts,
    };
  }

  it('held on the phone until "send": nothing reaches the store computer or head office before; a reload keeps them; a wrong scan is removed; an unreachable store computer keeps everything; then ONE receipt, booked once even when its reply is lost', async () => {
    const c = await setup();
    const phone = phoneStorage();
    let page = openPage(phone);
    expect(scan(page.s, 'recv-1', 4).signal.code).toBe('received');
    expect(scan(page.s, 'recv-2', 3).signal.code).toBe('received');
    expect(scan(page.s, 'recv-wrong', 2).signal.code).toBe('received');
    // The page's hand-over runs as usual: nothing is handed over, nothing reaches head office.
    await c.handOver(page.outbox);
    await c.edge.syncOnce!();
    expect(c.edge.deviceEventsOutbox.all()).toHaveLength(0);
    expect(await c.onHand()).toBe(0);
    expect(await c.scansAtHeadOffice()).toEqual([]);
    expect((await c.receipt()).status).toBe(404);

    // The browser closed and opened again: the same three scans are held; the wrong one is removed before sending.
    page = openPage(phone);
    const held = (page.s as unknown as { heldReceipt(g: string): { scans: { commandId: string }[] } }).heldReceipt('grn-1');
    expect(held.scans.map((x) => x.commandId)).toEqual(['recv-1', 'recv-2', 'recv-wrong']);
    expect((page.s as unknown as { removeHeldScan(i: { grnId: string; commandId: string; at: string }): { removed: boolean } }).removeHeldScan({ grnId: 'grn-1', commandId: 'recv-wrong', at: AT }).removed).toBe(true);

    // "Send" with the store computer out of reach: the receipt is kept on the phone and the pass says it is offline.
    expect(page.s.completeReceiving({ grnId: 'grn-1', at: AT }).accepted).toBe(true);
    c.setBoxReachable(false);
    expect((await c.handOver(page.outbox)).offline).toBe(true);
    expect(page.outbox.unsentCount()).toBe(1);
    expect(c.edge.deviceEventsOutbox.all()).toHaveLength(0);
    // Back in reach (after another reload): ONE record goes to the store computer.
    c.setBoxReachable(true);
    page = openPage(phone);
    expect((await c.handOver(page.outbox)).handed).toBe(1);
    expect(c.edge.deviceEventsOutbox.all().map((i) => i.event.type)).toEqual(['ReceivingCompleted']);

    // Head office: the first reply is lost; the retry books nothing twice.
    c.loseNextReply();
    expect((await c.edge.syncOnce!()).sent).toBe(0);
    expect((await c.edge.syncOnce!()).sent).toBe(1);
    expect(await c.onHand()).toBe(7);
    expect((await c.received()).map((m) => [m.movementId, m.quantityMinor])).toEqual([['recv:grn-1:recv-1', 4], ['recv:grn-1:recv-2', 3]]);
    const grn = (await c.receipt()).body as { grn: Record<string, unknown> };
    expect(grn.grn).toMatchObject({
      grnId: 'grn-1', poId: 'po-1', receivedBy: 'u-worker', availableMinor: 7,
      poReceipt: { receivedByProduct: { 'p-rice': 7 } },
      assembledFrom: { scanCount: 2, commandIds: ['recv-1', 'recv-2'], removedOnPhone: [expect.objectContaining({ commandId: 'recv-wrong', quantityMinor: 2, removedBy: 'u-worker', removedAt: AT })] },
    });
    // The phone sending it again (a lost reply on the phone's side) is a duplicate at the store computer; nothing new.
    await c.handOver(page.outbox);
    await c.edge.syncOnce!();
    expect(await c.onHand()).toBe(7);
    expect(((await c.h.request({ method: 'GET', path: '/v1/inventory/goods-receipt', userId: 'u-owner', tenantId: c.A })).body as { count: number }).count).toBe(1);
  }, 60_000);

  it('an OLD phone (one record per scan, then the completion) is still booked exactly as before; a phone updated mid-delivery puts its old and held scans on one receipt, each once', async () => {
    const c = await setup();
    // The old phone's records, as its queue held them before the update.
    const oldScan = (id: string, qty: number) => makeEvent({
      id: `recv-grn-1-${id}`, type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: `recv:grn-1:${id}`, source: 'A-1',
      payload: { grnId: 'grn-1', commandId: id, productId: 'p-rice', batchId: null, quantityMinor: qty, uom: 'EA', source: 'po', poId: 'po-1', state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT },
    });
    const phone = phoneStorage();
    const before = openDeviceOutbox(phone.outbox, () => {});
    before.enqueue(oldScan('old-1', 2));
    // Updated: the page opens on the same queue; the old scan still travels on its own, as before.
    const page = openPage(phone);
    expect(page.s.receivingOpen('grn-1')).toBe(true);
    expect(scan(page.s, 'new-1', 5).signal.code).toBe('received');
    await c.handOver(page.outbox);
    await c.edge.syncOnce!();
    expect(await c.onHand()).toBe(2); // the old scan was booked on arrival, as an old scan always was; the held one was not
    expect(page.s.completeReceiving({ grnId: 'grn-1', at: AT }).accepted).toBe(true);
    await c.handOver(page.outbox);
    await c.edge.syncOnce!();
    expect(await c.onHand()).toBe(7);
    expect((await c.received()).map((m) => m.movementId)).toEqual(['recv:grn-1:old-1', 'recv:grn-1:new-1']);
    const grn = (await c.receipt()).body as { grn: Record<string, unknown> };
    expect(grn.grn).toMatchObject({ availableMinor: 7, assembledFrom: { scanCount: 2, commandIds: ['old-1', 'new-1'] } });
  }, 60_000);

  it('all or nothing: a receipt with one line head office cannot read books NONE of its lines — the store computer keeps it as a visible dead letter', async () => {
    const c = await setup();
    const line = (id: string, qty: number) => ({ commandId: id, productId: 'p-rice', batchId: null, quantityMinor: qty, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy: 'u-worker', at: AT });
    const receipt = makeEvent({
      id: 'recv-done-grn-1', type: 'ReceivingCompleted', occurredAt: AT, idempotencyKey: 'recv-done:grn-1', source: 'A-1',
      payload: { grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 2, commandIds: ['a', 'b'], source: 'warehouse-handheld', scans: [line('a', 2), line('b', 0)] },
    });
    const res = await savedFetch(`${c.base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookie }, body: JSON.stringify({ source: 'warehouse', items: [{ key: receipt.idempotencyKey, event: receipt }] }) });
    expect(res.status).toBe(200);
    expect((await c.edge.syncOnce!()).dead).toBe(1);
    expect(c.edge.deviceEventsOutbox.deadLetters().map((i) => i.key)).toEqual(['recv-done:grn-1']);
    expect(await c.onHand()).toBe(0);
    expect(await c.scansAtHeadOffice()).toEqual([]);
    expect((await c.receipt()).status).toBe(404);
  }, 60_000);

  it('a receipt carrying a scan by somebody who never held this phone is refused at the store computer, by name', async () => {
    const c = await setup();
    const receipt = makeEvent({
      id: 'recv-done-grn-1', type: 'ReceivingCompleted', occurredAt: AT, idempotencyKey: 'recv-done:grn-1', source: 'A-1',
      payload: { grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 1, commandIds: ['a'], source: 'warehouse-handheld',
        scans: [{ commandId: 'a', productId: 'p-rice', batchId: null, quantityMinor: 2, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy: 'u-stranger', at: AT }] },
    });
    const res = await savedFetch(`${c.base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookie }, body: JSON.stringify({ source: 'warehouse', items: [{ key: receipt.idempotencyKey, event: receipt }] }) });
    const body = (await res.json()) as { acks: { key: string; status: string; reason?: string }[] };
    expect(body.acks).toEqual([{ key: 'recv-done:grn-1', status: 'refused', reason: expect.stringMatching(/u-stranger, who has not been signed in on this phone/) }]);
    expect(c.edge.deviceEventsOutbox.all()).toHaveLength(0);
  }, 60_000);

  it('OB-623 holds for the lines inside a receipt too: a scan by a Warehouse user (who may not receive) refuses the whole receipt at head office — nothing booked', async () => {
    const c = await setup();
    await c.h.provisionRole(c.A, 'u-wh', 'warehouse_user', ['store-1']);
    const line = (id: string, by: string) => ({ commandId: id, productId: 'p-rice', batchId: null, quantityMinor: 2, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy: by, at: AT });
    const res = await c.h.request({
      method: 'POST', path: '/v1/inventory/goods-receipt/grn-1/assembled', userId: 'u-box', tenantId: c.A, idempotencyKey: 'recv-done:grn-1',
      body: { grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 2, commandIds: ['a', 'b'], source: 'warehouse-handheld', scans: [line('a', 'u-worker'), line('b', 'u-wh')] },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'not_your_kind_of_stock_movement' } });
    expect(await c.onHand()).toBe(0);
    expect(await c.scansAtHeadOffice()).toEqual([]);
  }, 60_000);

  it('the largest receipt (300 scans) goes through the store computer as one record and is booked once', async () => {
    const c = await setup();
    const phone = phoneStorage();
    const big: WarehouseAssignment = { ...ASSIGNMENT, ordered: [{ productId: 'p-rice', quantityMinor: 1000, unitCost: { minor: 4000, currency: 'INR' } }] };
    const outbox = openDeviceOutbox(phone.outbox, () => {});
    const s = new WarehouseSession(big, outbox, { now: () => AT, held: phone.held } as ConstructorParameters<typeof WarehouseSession>[2]);
    for (let i = 0; i < 300; i += 1) expect(scan(s, `big-${String(i).padStart(3, '0')}`, 1).signal.code).toBe('received');
    expect(scan(s, 'big-300', 1).signal.code).toBe('receipt_full');
    expect(s.completeReceiving({ grnId: 'grn-1', at: AT }).accepted).toBe(true);
    expect((await c.handOver(outbox)).handed).toBe(1);
    expect((await c.edge.syncOnce!()).sent).toBe(1);
    expect(await c.onHand()).toBe(300);
    expect((await c.received())).toHaveLength(300);
  }, 180_000);

  it('an OLD phone with no held scans at all: its scans and its completion (no lines inside) are booked as before', async () => {
    const c = await setup();
    const res = await savedFetch(`${c.base}/lane/outbox`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookie },
      body: JSON.stringify({ source: 'warehouse', items: [
        makeEvent({ id: 'recv-grn-1-o1', type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: 'recv:grn-1:o1', source: 'A-1', payload: { grnId: 'grn-1', commandId: 'o1', productId: 'p-rice', batchId: null, quantityMinor: 3, uom: 'EA', source: 'po', poId: 'po-1', state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT } }),
        makeEvent({ id: 'recv-done-grn-1', type: 'ReceivingCompleted', occurredAt: AT, idempotencyKey: 'recv-done:grn-1', source: 'A-1', payload: { grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 1, commandIds: ['o1'], source: 'warehouse-handheld' } }),
      ].map((event) => ({ key: event.idempotencyKey, event })) }),
    });
    expect(res.status).toBe(200);
    expect((await c.edge.syncOnce!()).sent).toBe(2);
    expect(await c.onHand()).toBe(3);
    const grn = (await c.receipt()).body as { grn: Record<string, unknown> };
    expect(grn.grn).toMatchObject({ availableMinor: 3, assembledFrom: { scanCount: 1, commandIds: ['o1'] } });
  }, 60_000);
});
