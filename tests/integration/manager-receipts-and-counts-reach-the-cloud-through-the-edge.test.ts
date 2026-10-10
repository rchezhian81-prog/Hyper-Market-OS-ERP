import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **A delivery and a blind count from the manager's screen reach head office through the store computer — the SAME
 * path as a decision, durably at every hop, exactly once, every refusal visible (SP-2b · F11 · M07-FR-01 · M09-FR-04 ·
 * §31 · hard rules #1/#2/#6/#10).**
 *
 * SP-2a proved the mechanism with the approval decision; this proves the two records F11 said were lost on it, against
 * the REAL box (`startEdge`) and the REAL cloud (the API harness behind a `fetch` the test can cut or make lose a reply):
 *
 *   • a `GoodsReceived` from the device is on the box's disk and queued BEFORE the device hears `accepted`; one sync
 *     pass makes it a cloud GRN under the box's credential with the RECEIVER named and the relay beside them, and stock
 *     rises by exactly the delivery; the same batch again — before AND after a box restart — is `duplicate`, nothing is
 *     re-sent, stock does not double;
 *   • a `StockCounted` carries only what the counter saw; head office computes the expected figure against its own ledger
 *     and corrects at once (immaterial); a reply lost between cloud and box is retried and settles to ONE record;
 *   • a receipt head office refuses (a tracked line with no batch → 422) is a visible dead-letter on the box, with the
 *     code in its reason, that survives a restart — and no stock moved;
 *   • a box with no cloud holds both, counts them, and will not close the day over them.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['manager', 'receipts', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T10:00:00.000Z';
const WH = 'wh-store';
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [] });

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** What the manager's screen queues for a delivery (`packages/receiving` `GoodsReceived`, SP-2b shape). */
const receiptEvent = (id: string, over: Record<string, unknown> = {}) => makeEvent({
  id: `grn:${id}`, type: 'GoodsReceived', occurredAt: AT, idempotencyKey: `grn:${id}`, source: 'web-erp/manager',
  payload: {
    grnId: id, number: `DN-${id}`, poId: 'po-1', lineCount: 1, warehouseId: WH, receivedBy: 'u-mgr', receivedAt: AT,
    lines: [{ productId: 'p1', quantityMinor: 10, uom: 'ea', batchId: null }],
    storeId: 'store-1', source: 'manager-screen', ...over,
  },
});
/** What the manager's screen queues for a blind count — only what the counter saw. */
const countEvent = (id: string, countedMinor: number) => makeEvent({
  id: `count-${id}`, type: 'StockCounted', occurredAt: AT, idempotencyKey: `count-${id}`, source: 'web-erp/manager',
  payload: { countId: id, productId: 'p1', locationId: WH, uom: 'ea', countedMinor, reasonCode: 'cycle_count', counterId: 'u-mgr', at: AT, storeId: 'store-1', source: 'manager-screen' },
});

const postBatch = async (edge: EdgeProcess, items: unknown[], source = 'manager'): Promise<{ status: number; acks: DeviceAck[] }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
    body: JSON.stringify({ source, items }),
  });
  const body = (await res.json()) as { acks: DeviceAck[] };
  return { status: res.status, acks: body.acks };
};
const statusOf = async (edge: EdgeProcess, keys: string[]): Promise<BoxItemStatus[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`);
  return ((await res.json()) as { items: BoxItemStatus[] }).items;
};
const recordsOn = async (edge: EdgeProcess): Promise<{ idempotencyKey: string; type: string }[]> =>
  (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => {
    const p = JSON.parse(r.ok ? r.record : '{}') as { idempotencyKey: string; type: string };
    return { idempotencyKey: p.idempotencyKey, type: p.type };
  });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function boxWithoutCloud(dir?: string): Promise<EdgeProcess> {
  const d = dir ?? await tempDir('sre-mgr-receipts-nocloud-');
  const packFile = join(d, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');
  const edge = (await startEdge({
    EDGE_DATA_DIR: d, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_PACK_FILE: packFile,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

/** A real cloud — cast, product master (p1 untracked, p2 tracked), a costed prior delivery, a purchase order — behind a controllable `fetch`. */
async function cloud(): Promise<{
  h: ApiHarness; dir: string; start: () => Promise<EdgeProcess>;
  setOnline: (v: boolean) => void; loseNextReply: () => void; posts: () => number;
}> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await approvedSuppliers(h, A, 'sup-1'); // OB-32: an order needs an approved supplier
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: {
      tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
      products: [
        { productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
        { productId: 'p2', sku: 'p2', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: true },
      ],
      barcodes: [],
    } },
  }));
  expect((await h.request({
    method: 'POST', path: '/v1/inventory/goods-receipt/grn-seed', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-seed',
    body: {
      warehouseId: WH, receivedOnDate: '2026-09-01', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 100, countedMinor: 100, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' }, condition: 'good' }],
    },
  })).status).toBe(201);
  // The order the manager's delivery is booked in against — ISSUED by a second person, so the receipt folds into it (SP-6 · F01).
  expect((await h.request({
    method: 'POST', path: '/v1/purchase/orders/po-1', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-po-1',
    body: { supplierId: 'sup-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 5000, currency: 'INR' } }] },
  })).status).toBe(201);
  expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-1/approval', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-po-1-ok', body: { reason: 'within budget' } })).status).toBe(200);
  const dir = await tempDir('sre-mgr-receipts-cloud-');
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');

  let online = true;
  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/inventory/') && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'],
      path,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); } // the cloud acted; the reply never arrived
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test',
      CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
      EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, dir, start, setOnline: (v) => { online = v; }, loseNextReply: () => { lose = true; }, posts: () => posts };
}

const onHandAt = async (h: ApiHarness, productId: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === WH).reduce((s, r) => s + r.onHandMinor, 0);
const grnAt = async (h: ApiHarness, grnId: string) => h.request({ method: 'GET', path: `/v1/inventory/goods-receipt/${grnId}`, userId: 'u-owner', tenantId: A });
const countsAt = async (h: ApiHarness) => (await h.request({ method: 'GET', path: '/v1/inventory/counts', userId: 'u-owner', tenantId: A, query: { productId: 'p1', locationId: WH } }))
  .body as { correctedOnHandMinor: number; counts: { countId: string; expectedMinor: number; varianceMinor: number; adjusted: boolean; relayedBy?: string }[] };

describe('the manager\'s delivery and count: device → box (durable) → head office (once), on the decision\'s own path', () => {
  it('a delivery is on the box\'s disk before the device hears accepted, becomes a cloud GRN in one pass naming receiver and relay, raises stock once, and is duplicate before and after a restart', async () => {
    const c = await cloud();
    const first = await c.start();
    const e = receiptEvent('g1');

    const { status, acks } = await postBatch(first, [{ key: e.idempotencyKey, event: e }]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'grn:g1', status: 'accepted' }]);
    expect(await recordsOn(first)).toEqual([{ idempotencyKey: 'grn:g1', type: 'GoodsReceived' }]);
    expect((await statusOf(first, ['grn:g1']))[0]).toMatchObject({ state: 'pending' });
    expect(await onHandAt(c.h, 'p1')).toBe(100); // nothing at head office yet — the box has it

    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(0);
    const grn = await grnAt(c.h, 'g1');
    expect(grn.status).toBe(200);
    expect((grn.body as { grn: Record<string, unknown> }).grn).toMatchObject({ grnId: 'g1', receivedBy: 'u-mgr', relayedBy: 'u-box', source: 'manager-screen', storeId: 'store-1', availableMinor: 10, governanceFlags: ['default_policy'], poReceipt: { receiptId: 'g1', receivedByProduct: { p1: 10 } } });
    expect(await onHandAt(c.h, 'p1')).toBe(110);
    // SP-6 (F01): the delivery booked in at the store closed the order at head office in the same pass — 10 ordered, 10 received.
    const po = await c.h.request({ method: 'GET', path: '/v1/purchase/orders/po-1', userId: 'u-owner', tenantId: A });
    expect(po.body).toMatchObject({ order: { receivedByProduct: { p1: 10 } }, openCommitment: { totalOpenValue: { minor: 0 }, fullyReceived: true } });
    expect((await statusOf(first, ['grn:g1']))[0]?.state).toBe('posted');

    // The device retries (a lost ack on the LAN): duplicate now…
    expect((await postBatch(first, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'grn:g1', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    // …and after a restart, with nothing re-sent and stock still 110.
    const second = await c.start();
    expect((await postBatch(second, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'grn:g1', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect(await onHandAt(c.h, 'p1')).toBe(110);
    expect(await recordsOn(second)).toHaveLength(1);
  });

  it('a blind count carries only what was seen; head office computes the expected figure and corrects; a lost reply settles to ONE record (RR-F02)', async () => {
    const c = await cloud();
    const edge = await c.start();
    const e = countEvent('c1', 98);
    expect(Object.keys(e.payload as object)).not.toEqual(expect.arrayContaining(['expectedMinor']));
    await postBatch(edge, [{ key: e.idempotencyKey, event: e }]);

    c.loseNextReply();
    const first = await edge.syncOnce!();
    expect(first.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('count-c1')).toMatchObject({ state: 'pending', attempts: 1 });
    // The cloud DID reconcile it — against ITS ledger (100 at the store's warehouse) — the reply was what got lost.
    let reg = await countsAt(c.h);
    expect(reg.counts).toHaveLength(1);
    expect(reg.counts[0]).toMatchObject({ countId: 'c1', expectedMinor: 100, varianceMinor: -2, adjusted: true, relayedBy: 'u-box' });
    expect(reg.correctedOnHandMinor).toBe(98);

    const second = await edge.syncOnce!();
    expect(second.sent).toBe(1);
    expect(edge.deviceEventsOutbox.find('count-c1')?.state).toBe('acknowledged');
    reg = await countsAt(c.h);
    expect(reg.counts).toHaveLength(1); // one record, the correction applied once
    expect(reg.correctedOnHandMinor).toBe(98);
    expect(c.posts()).toBe(2);
    expect((await statusOf(edge, ['count-c1']))[0]?.state).toBe('posted');
  });

  it('a receipt head office refuses (a tracked line with no batch, 422) is a visible dead-letter on the box with the code in its reason, survives a restart, and moved no stock', async () => {
    const c = await cloud();
    const first = await c.start();
    const bad = receiptEvent('g2', { poId: null, lines: [{ productId: 'p2', quantityMinor: 20, uom: 'ea', batchId: null }] });
    expect((await postBatch(first, [{ key: bad.idempotencyKey, event: bad }])).acks[0]?.status).toBe('accepted');
    const pass = await first.syncOnce!();
    expect(pass.dead).toBe(1);
    const status = await statusOf(first, ['grn:g2']);
    expect(status[0]?.state).toBe('refused');
    expect(status[0]?.reason).toMatch(/receipt_line_incomplete/);
    expect(first.syncStatus().deadLettered).toBe(1);
    await first.stop();
    cleanups.pop();

    const second = await c.start();
    const after = await statusOf(second, ['grn:g2']);
    expect(after[0]?.state).toBe('refused');
    expect(after[0]?.reason).toMatch(/receipt_line_incomplete/);
    expect((await grnAt(c.h, 'g2')).status).toBe(404);
    expect(await onHandAt(c.h, 'p2')).toBe(0);
  });

  it('a cut line keeps both on the box — pending, not refused — and they go when the line is back', async () => {
    const c = await cloud();
    const edge = await c.start();
    const g = receiptEvent('g3');
    const k = countEvent('c3', 110); // counted after the delivery: 100 + 10 expected once g3 lands
    await postBatch(edge, [{ key: g.idempotencyKey, event: g }, { key: k.idempotencyKey, event: k }]);
    c.setOnline(false);
    const offline = await edge.syncOnce!();
    expect(offline.sent).toBe(0);
    expect(offline.dead).toBe(0);
    expect((await statusOf(edge, ['grn:g3', 'count-c3'])).map((s) => s.state)).toEqual(['pending', 'pending']);
    c.setOnline(true);
    expect((await edge.syncOnce!()).sent).toBe(2);
    expect((await statusOf(edge, ['grn:g3', 'count-c3'])).map((s) => s.state)).toEqual(['posted', 'posted']);
    // In order: the delivery landed first, so the count that followed it matches exactly.
    expect((await countsAt(c.h)).counts[0]).toMatchObject({ countId: 'c3', expectedMinor: 110, varianceMinor: 0 });
  });

  it('a box with no cloud takes both, holds them durably, counts them and will not close the day over them', async () => {
    const dir = await tempDir('sre-mgr-receipts-hold-');
    const first = await boxWithoutCloud(dir);
    const g = receiptEvent('g4');
    const k = countEvent('c4', 5);
    expect((await postBatch(first, [{ key: g.idempotencyKey, event: g }, { key: k.idempotencyKey, event: k }])).acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    expect(first.syncStatus()).toMatchObject({ cloud: 'not_configured', unsent: 2 });
    const close = await first.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' });
    expect(close.closed).toBe(false);
    await first.stop();
    cleanups.pop();

    const second = await boxWithoutCloud(dir);
    expect(second.deviceEventsOutbox.pending().map((i) => i.key)).toEqual(['grn:g4', 'count-c4']);
    expect(second.syncStatus().unsent).toBe(2);
    expect((await postBatch(second, [{ key: k.idempotencyKey, event: k }])).acks).toEqual([{ key: 'count-c4', status: 'duplicate' }]);
  });
});
