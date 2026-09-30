import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import type { StoredMatch, SupplierInvoiceRecord } from '../../services/purchase/src/index';

/**
 * **A supplier invoice captured on the buyer's screen reaches head office through the store computer — the SAME path as
 * the manager's decisions and deliveries, durably at every hop, exactly once, every refusal visible (SP-7a · F02 · F04 ·
 * M07-FR-04 · §31 · hard rules #1/#4/#6/#10).**
 *
 * The REAL box (`startEdge` with its lane socket, its fsync'd device-events log, its sync agent) against the REAL cloud
 * (the API harness behind a `fetch` the test can cut or make lose a reply):
 *
 *   • a `SupplierInvoiceCaptured` from the buyer's queue is on the box's disk and queued BEFORE the screen hears `accepted`;
 *     one sync pass records it at head office under the box's credential with the CAPTURER and the CHECKER named and
 *     re-verified, the box beside them as relay; the match then runs over the STORED order and the receipt folded into it
 *     — never a figure from the screen; the same batch again — before AND after a box restart — is `duplicate`;
 *   • an invoice whose cloud reply is lost is retried and settles to ONE record;
 *   • an invoice head office refuses (its lines do not add up to the printed total) is a visible dead-letter on the box,
 *     with the code in its reason, and nothing is on file for it;
 *   • a box with no cloud holds the invoice and will not close the day over it.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['buyer', 'invoice', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T10:00:00.000Z';
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [] });

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** What the buyer's screen queues (`apps/web-erp/src/buying-session` `SupplierInvoiceCaptured`, SP-7a shape). */
const invoiceEvent = (invoiceId: string, over: Record<string, unknown> = {}) => makeEvent({
  id: `invoice:${invoiceId}`, type: 'SupplierInvoiceCaptured', occurredAt: AT, idempotencyKey: `invoice:${invoiceId}`, source: 'web-erp/buying',
  payload: {
    invoiceId, supplierId: 'sup-1', poId: 'po-1',
    lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 5000, lineTotalMinor: 50_000 }],
    declaredTotalMinor: 50_000, capturedBy: 'u-buyer', capturedAt: AT, approvedBy: 'u-mgr', approvedAt: AT, storeId: 'store-1', source: 'buyer-screen', ...over,
  },
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
const recordsOn = async (edge: EdgeProcess): Promise<string[]> =>
  (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => (JSON.parse(r.ok ? r.record : '{}') as { idempotencyKey: string }).idempotencyKey);

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function boxWithoutCloud(): Promise<EdgeProcess> {
  const d = await tempDir('sre-buyer-invoice-nocloud-');
  const packFile = join(d, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');
  const edge = (await startEdge({ EDGE_DATA_DIR: d, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_PACK_FILE: packFile }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return edge;
}

/** A real cloud — the cast, an ISSUED order (10 × ₹50 of p1) and a delivery of 8 against it — behind a controllable `fetch`. */
async function cloud(): Promise<{ h: ApiHarness; start: () => Promise<EdgeProcess>; loseNextReply: () => void; posts: () => number }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-buyer', 'store_manager');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-1', userId: 'u-buyer', tenantId: A, idempotencyKey: 'k-po-1', body: { supplierId: 'sup-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 5000, currency: 'INR' } }] } })).status).toBe(201);
  expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/po-1/approval', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-po-1-ok', body: { reason: 'within budget' } })).status).toBe(200);
  expect((await h.request({
    method: 'POST', path: '/v1/inventory/goods-receipt/grn-1', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-grn-1',
    body: { warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1', lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: 8, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' }, condition: 'good' }] },
  })).status).toBe(201);
  const dir = await tempDir('sre-buyer-invoice-cloud-');
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');

  let lose = false;
  let posts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/purchase/') && (init.method ?? 'GET') === 'POST') posts += 1;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    if (lose) { lose = false; throw new Error('ECONNRESET'); }
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, start, loseNextReply: () => { lose = true; }, posts: () => posts };
}

const invoiceAt = async (h: ApiHarness, invoiceId: string) => h.request({ method: 'GET', path: `/v1/purchase/invoices/${invoiceId}`, userId: 'u-owner', tenantId: A });

describe('the buyer\'s invoice: device queue → box (durable) → head office (once) → matched over what head office holds', () => {
  it('is on the box\'s disk before accepted, is ONE record at head office with both people re-verified, matches against the STORED order and receipt, and is duplicate before and after a restart', async () => {
    const c = await cloud();
    const first = await c.start();
    const e = invoiceEvent('INV-1');
    const { status, acks } = await postBatch(first, [{ key: e.idempotencyKey, event: e }]);
    expect(status).toBe(200);
    expect(acks).toEqual([{ key: 'invoice:INV-1', status: 'accepted' }]);
    expect(await recordsOn(first)).toEqual(['invoice:INV-1']);
    expect((await invoiceAt(c.h, 'INV-1')).status).toBe(404); // nothing at head office yet — the box has it

    const pass = await first.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(pass.dead).toBe(0);
    expect((await statusOf(first, ['invoice:INV-1']))[0]?.state).toBe('posted');
    const read = (await invoiceAt(c.h, 'INV-1')).body as { invoice: SupplierInvoiceRecord; match: StoredMatch | null };
    expect(read.invoice).toMatchObject({ invoiceId: 'INV-1', supplierId: 'sup-1', poId: 'po-1', totalMinor: 50_000, capturedBy: 'u-buyer', approvedBy: 'u-mgr', relayedBy: 'u-box', source: 'buyer-screen', storeId: 'store-1', governanceFlags: [] });
    expect(read.match).toBeNull();

    // The match at head office: 10 ordered, 8 received (the GRN folded into the order — SP-6), 10 invoiced → pay 8 × ₹50, hold ₹100.
    const m = (await c.h.request({ method: 'POST', path: '/v1/purchase/invoices/INV-1/match', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-m1', body: {} })).body as StoredMatch;
    expect(m).toMatchObject({ blocked: true, payableMinor: 40_000, invoicedMinor: 50_000, withheldMinor: 10_000, flags: [], sources: { order: { status: 'issued' }, received: 'goods_receipts_folded_into_the_order' } });
    expect(m.lines).toEqual([expect.objectContaining({ productId: 'p1', quantityDifference: 2, status: 'blocked', payableMinor: 40_000 })]);

    // The screen re-sending after a lost reply: duplicate at the box, nothing re-sent — before and after a restart.
    expect((await postBatch(first, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'invoice:INV-1', status: 'duplicate' }]);
    await first.stop();
    cleanups.pop();
    const second = await c.start();
    expect((await postBatch(second, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'invoice:INV-1', status: 'duplicate' }]);
    await second.syncOnce!();
    expect(c.posts()).toBe(1);
    expect(((await c.h.request({ method: 'GET', path: '/v1/purchase/invoices', userId: 'u-owner', tenantId: A })).body as { count: number }).count).toBe(1);
  });

  it('a reply lost between cloud and box is retried and settles to ONE record (RR-F02); an invoice whose lines do not add up is a visible dead-letter with the code in its reason, and nothing is on file', async () => {
    const c = await cloud();
    const edge = await c.start();
    const good = invoiceEvent('INV-2');
    expect((await postBatch(edge, [{ key: good.idempotencyKey, event: good }])).acks.map((a) => a.status)).toEqual(['accepted']);
    c.loseNextReply();
    const first = await edge.syncOnce!();
    expect(first.sent).toBe(0);
    expect(edge.deviceEventsOutbox.find('invoice:INV-2')).toMatchObject({ state: 'pending', attempts: 1 });
    expect((await invoiceAt(c.h, 'INV-2')).status).toBe(200); // the cloud DID record it; the reply was what got lost
    const second = await edge.syncOnce!();
    expect(second.sent).toBe(1);
    expect((await statusOf(edge, ['invoice:INV-2']))[0]?.state).toBe('posted');
    expect(c.posts()).toBe(2); // asked twice, recorded once
    // An invoice whose lines do not add up to its printed total: head office refuses it by name, the box keeps it visibly.
    const bad = invoiceEvent('INV-3', { declaredTotalMinor: 49_000 });
    expect((await postBatch(edge, [{ key: bad.idempotencyKey, event: bad }])).acks[0]?.status).toBe('accepted');
    const third = await edge.syncOnce!();
    expect(third.dead).toBe(1);
    const refused = (await statusOf(edge, ['invoice:INV-3']))[0];
    expect(refused?.state).toBe('refused');
    expect(refused?.reason).toMatch(/does_not_add_up_to_the_invoice_total/);
    expect((await invoiceAt(c.h, 'INV-3')).status).toBe(404);
    expect(((await c.h.request({ method: 'GET', path: '/v1/purchase/invoices', userId: 'u-owner', tenantId: A })).body as { count: number }).count).toBe(1);
  });

  it('a box with no cloud takes the invoice, holds it durably, counts it, and will not close the day over it', async () => {
    const edge = await boxWithoutCloud();
    const e = invoiceEvent('INV-4');
    expect((await postBatch(edge, [{ key: e.idempotencyKey, event: e }])).acks).toEqual([{ key: 'invoice:INV-4', status: 'accepted' }]);
    expect(edge.syncStatus()).toMatchObject({ cloud: 'not_configured', unsent: 1 });
    expect((await edge.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' })).closed).toBe(false);
    // A handheld may not send an invoice: it is the ERP screen's record.
    expect((await postBatch(edge, [{ key: 'invoice:INV-5', event: invoiceEvent('INV-5') }], 'warehouse')).acks[0]?.status).toBe('refused');
  });
});
