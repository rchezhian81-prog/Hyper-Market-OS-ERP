import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos, laneDurable } from '../../apps/pos/src/browser-entry';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import type { HttpResponse } from '../../services/kernel/src/index';

/**
 * **Prove the core on one lane: a sale rung with no internet reaches the books, exactly once.**
 *
 * This is the store's spine — scan, price, take payment, and have the sale end up in the cloud
 * ledger and on the owner's screen — driven end to end through the PRODUCTION pieces, with nothing
 * stubbed but the socket to the cloud:
 *
 *   • a real store edge (`startEdge`) with a real lane socket and a real file on a real disk;
 *   • a real `PosSession` ringing the sale through that socket (`bootPos` + `tenderCash`);
 *   • the real sync outbox, the real `SyncAgent`, and the real `httpTransport`;
 *   • the real cloud surface — the router, the permission check, the idempotency store, the POS
 *     intake rules and the append-only ledger (`apiHarness`).
 *
 * It exists because proving the core is what caught the break it now guards: the lane writes its
 * sale as `{ id, total, … }`, the cloud reads `{ saleId, totalMinor, packVersion, … }`, and until
 * the edge translated between them (`edge/store-edge/src/cloud-sale.ts`) every real rung sale posted
 * to `/v1/sales` was refused **400** and dead-lettered — the money in the drawer with no record in
 * the cloud. The last `it` holds that line: the raw till record is still refused; the translation is
 * what banks it.
 *
 * Unlike `the-shop-reaches-the-cloud` (which needs PostgreSQL and hand-builds the cloud shape), this
 * runs in-memory in the ordinary suite and rings the sale the way the lane actually does — so a
 * regression of the spine fails CI, not a nightly.
 */

const KEY = ['core', 'one', 'lane', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const TILL = 'u-till';

// A moment today (past, so the intake raises no future-dated finding) and its trading day, so the
// banked sale lands inside the owner dashboard's "today" window.
const COMMITTED_AT = new Date(Date.now() - 60_000).toISOString();
const TRADING_DAY = COMMITTED_AT.slice(0, 10);
const TOTAL_MINOR = 75_520; // ₹640.00 unit + 18% tax, one unit

/** A `fetch` that carries the sync agent's POST to the real cloud surface as the till principal. */
function cloudFetch(h: ApiHarness): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const res: HttpResponse = await h.request({
      method: 'POST',
      path: new URL(url).pathname,
      userId: TILL,
      tenantId: TENANT,
      body: JSON.parse(String(init.body)) as unknown,
      ...(headers['idempotency-key'] === undefined ? {} : { idempotencyKey: headers['idempotency-key'] }),
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
}

const bankedSales = async (h: ApiHarness): Promise<readonly { saleId: string; totalMinor: number }[]> =>
  (await h.store.readStream(TENANT, STREAM.sales, { type: 'SaleCommitted' }))
    .map((e) => e.event.payload as { saleId: string; totalMinor: number });

const salesTodayMinor = async (h: ApiHarness): Promise<number | undefined> => {
  const res = await h.request({ method: 'GET', path: '/v1/reports/dashboard', userId: TILL, tenantId: TENANT });
  const figures = (res.body as { figures: { name: string; valueMinor?: number }[] }).figures;
  return figures.find((f) => f.name === 'Sales today')?.valueMinor;
};

describe('the core, on one lane, end to end', () => {
  let dir: string;
  let edge: EdgeProcess;
  let h: ApiHarness;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sre-core-lane-'));
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    }, () => {}))!;

    h = apiHarness();
    // One principal that both syncs a sale (pos.sale.sync) and reads the owner dashboard
    // (reporting.dashboard.read) — the owner. Seeded through the guarded genesis path.
    await h.seedOwner(TENANT, TILL);

    // Ring one sale on the lane, through the loopback socket to this till's own disk — no cloud call.
    const view = bootPos({ laneId: 'lane-1', tradingDay: TRADING_DAY, durable: laneDurable(edge.lane!.port) });
    view.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
    const receipt = await view.tenderCash('S-1', 'R-0001', COMMITTED_AT);
    expect(receipt).toBe('R-0001');
  });

  afterAll(async () => {
    await edge?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('offline first: the sale is on the disk and queued, and the cloud has seen nothing', async () => {
    // On the disk, whole and readable — the sale exists before any network.
    const records = await readLog(edge.log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && (JSON.parse(records[0].record) as { id: string }).id).toBe('S-1');

    // Queued for the cloud, and NOTHING banked yet. The shop traded with the line untouched (P-01).
    expect(edge.outbox.unsentCount()).toBe(1);
    expect(await bankedSales(h)).toHaveLength(0);
  });

  it('the raw till record — untranslated — is what /v1/sales refuses (the break this guards)', async () => {
    // The record exactly as the till wrote it to disk, posted straight to the cloud. This is the
    // shape the outbox used to carry, and it is refused 400 → the agent would dead-letter it.
    const first = (await readLog(edge.log.path))[0];
    const raw = JSON.parse(first?.ok === true ? first.record : '{}') as unknown;
    const res = await h.request({ method: 'POST', path: '/v1/sales', userId: TILL, tenantId: TENANT, body: raw, idempotencyKey: 'raw-probe' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_sale');
    // And it was NOT banked — the refusal left the ledger empty, which is exactly the danger.
    expect(await bankedSales(h)).toHaveLength(0);
  });

  it('drained through the real sync agent, the translated sale is banked and on the owner dashboard', async () => {
    const agent = new SyncAgent(edge.outbox, httpTransport({
      baseUrl: 'https://cloud.example.test', token: 'edge-token', fetch: cloudFetch(h),
    }));
    const result = await agent.drain({ at: COMMITTED_AT });

    // The outbox emptied: delivered, acknowledged, nothing left, nothing dead-lettered.
    expect(result.acknowledged).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(edge.outbox.unsentCount()).toBe(0);

    // Banked in the cloud ledger, under the sale's own id and its real total (translated from the
    // till's `id`/`total`). This is the line that was 400 before the seam existed.
    const banked = await bankedSales(h);
    expect(banked).toHaveLength(1);
    expect(banked[0]).toMatchObject({ saleId: 'S-1', totalMinor: TOTAL_MINOR });

    // One commerce truth (P-02): the owner's morning screen shows the takings.
    expect(await salesTodayMinor(h)).toBe(TOTAL_MINOR);
  });

  it('a resend after the edge forgets the sale does not bank it twice (§31.1)', async () => {
    // The hard case: the edge restarted and lost its outbox, so it re-queues a sale it already sent.
    // Nothing at the edge can tell. The idempotency key was minted at the lane, so the cloud collapses
    // it to one — the day is not double-counted.
    const forgetful = new SyncOutbox();
    forgetful.enqueue({
      id: 'edge-sale-S-1', type: 'SaleCommitted', occurredAt: COMMITTED_AT, version: 1,
      idempotencyKey: `edge-${TENANT}-S-1`, source: 'edge/lane',
      payload: {
        saleId: 'S-1', receiptNumber: 'R-0001', laneId: 'lane-1', cashierId: 'cashier',
        tradingDay: TRADING_DAY, committedAt: COMMITTED_AT, totalMinor: TOTAL_MINOR, currency: 'INR',
        packVersion: 0,
        lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 64_000, lineTotalMinor: TOTAL_MINOR, taxRateBps: 1800 }],
        tenders: [{ kind: 'cash', amountMinor: TOTAL_MINOR }],
      },
    });
    const agent = new SyncAgent(forgetful, httpTransport({
      baseUrl: 'https://cloud.example.test', token: 'edge-token', fetch: cloudFetch(h),
    }));
    const result = await agent.drain({ at: COMMITTED_AT });
    expect(result.acknowledged).toBe(1); // the transport got a success (the cloud deduped underneath)

    // Still exactly one sale banked, and the dashboard figure has not moved.
    expect(await bankedSales(h)).toHaveLength(1);
    expect(await salesTodayMinor(h)).toBe(TOTAL_MINOR);
  });
});
