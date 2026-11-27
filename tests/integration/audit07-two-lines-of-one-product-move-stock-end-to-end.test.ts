import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';

/**
 * **Audit 27 Nov 2026, item 7 (OB-924 · OB-925 · D-141): two lines of the same product on one document move stock twice —
 * end to end, through the till, the real store computer and the real head office, in memory and on real PostgreSQL.**
 *
 * The till rings the same item on two lines and commits the sale to the REAL store edge (`startEdge`, its durable log
 * and sync agent); the edge relays it to the REAL API surface. The till's own local stock ledger (`packages/sale`) must
 * hold one movement per line, and head office's stock ledger (`services/pos/src/sale-stock.ts`, keyed by line position)
 * one `sold` movement per line. A return of two lines of one product (through the edge) and a goods receipt of two
 * batches of one product (the store computer's synced route) likewise. And the compatibility promise: the SAME sale
 * committed again — a till re-syncing after an upgrade, the edge replaying after a restart — posts nothing twice.
 * Synthetic data only (hard rule #7).
 */

const AT = '2026-11-27T10:00:00.000Z';
const KEY = ['audit', 'seven', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

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

interface Mv { movementId: string; kind: string; productId: string; quantityMinor: number; locationId: string; batchId?: string }
const movementsOf = async (h: ApiHarness, t: string, prefix: string): Promise<Mv[]> =>
  (await h.store.readStream(t, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as Mv).filter((m) => m.movementId.startsWith(prefix));
const onHand = async (h: ApiHarness, t: string, productId: string, locationId: string): Promise<number> => {
  const res = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: t, query: { productId } });
  return ((res.body as { rows: { locationId: string; onHandMinor: number }[] }).rows).filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);
};

describe.each(backings)('audit item 7 — two lines of one product each move stock, end to end — on $name', ({ harness }) => {
  const savedFetch = globalThis.fetch;
  const dirs: string[] = [];
  afterEach(async () => {
    globalThis.fetch = savedFetch;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  /** Head office (real surface) behind `fetch`, and a fresh store-computer data folder. */
  const stand = async (): Promise<{ h: ApiHarness; t: string; env: Record<string, string> }> => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.provisionRole(t, 'u-mgr', 'store_manager');
    await h.provisionRole(t, 'u-sync', 'cashier'); // the store's sync identity (pos.sale.sync, pos.return.sync)
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-audit07-'));
    dirs.push(dir);
    return {
      h, t,
      env: { EDGE_DATA_DIR: dir, EDGE_TENANT_ID: t, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-sync', tenantId: t }) },
    };
  };

  /** The till: MILK rung on two lines (2 and 3) and BREAD once, committed to the store computer's disk. */
  const ringAtTheTill = async (edge: EdgeProcess, saleId: string) => {
    const stockLedger = new Ledger(new InMemoryLedgerStore());
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-sync', tradingDay: AT.slice(0, 10), currency: 'INR', defaultTaxRate: taxRateFromPercent(0) },
      stockLedger, new SyncOutbox(), (id, record) => edge.node.commit(id, record),
    );
    const ring = (productId: string, quantityMinor: number) => session.scan({
      productId, description: productId, unitPrice: money(2_500, 'INR'), quantityMinor, uom: 'ea', taxRate: taxRateFromPercent(0),
    });
    ring('MILK', 2);
    ring('BREAD', 1);
    ring('MILK', 3);
    const payable = session.totals().payable;
    await session.commit(saleId, `INV-${saleId}`, AT, [{ kind: 'cash', amount: payable, status: 'settled' }]);
    return stockLedger;
  };

  it('the till rings one item on two lines: its own stock ledger, the store computer and head office each take BOTH lines off stock — once, even when the sale is sent again', async () => {
    const { h, t, env } = await stand();
    const edge = (await startEdge(env, () => {}))!;
    const tillLedger = await ringAtTheTill(edge, 'S-A7');

    // The till's local ledger: one movement per line, MILK twice.
    const local = tillLedger.entries().map((r) => r.event.payload as { productId: string; deltaMinor: number });
    expect(local).toHaveLength(3);
    expect(local.filter((m) => m.productId === 'MILK').map((m) => m.deltaMinor)).toEqual([-2, -3]);

    await edge.syncOnce!();
    const sold = await movementsOf(h, t, 'sale-S-A7-');
    expect(sold.map((m) => [m.movementId, m.productId, m.quantityMinor])).toEqual([
      ['sale-S-A7-0', 'MILK', 2], ['sale-S-A7-1', 'BREAD', 1], ['sale-S-A7-2', 'MILK', 3],
    ]);
    expect(await onHand(h, t, 'MILK', 'unplaced-lane:lane-1')).toBe(-5);

    // The same sale committed to the store computer again (a till re-sending what it could not confirm) and the
    // store computer restarted (its outbox replayed from the log): head office still holds each line ONCE.
    await edge.stop();
    const back = (await startEdge(env, () => {}))!;
    await ringAtTheTill(back, 'S-A7');
    await back.syncOnce!();
    await back.stop();
    expect(await movementsOf(h, t, 'sale-S-A7-')).toHaveLength(3);
    expect(await onHand(h, t, 'MILK', 'unplaced-lane:lane-1')).toBe(-5);
  });

  it('an OLD single-line-per-product sale already recorded is re-sent after the upgrade: nothing posts twice', async () => {
    const { h, t, env } = await stand();
    // The sale as an older till build wrote it to the store computer's disk: one line per product.
    const old = JSON.stringify({
      id: 'S-OLD', number: 'INV-S-OLD', laneId: 'lane-1', cashierId: 'u-sync', tradingDay: AT.slice(0, 10), committedAt: AT,
      total: 7_500, currency: 'INR',
      lines: [
        { productId: 'MILK', quantityMinor: 2, uom: 'ea', unitPriceMinor: 2_500, lineTotalMinor: 5_000, taxRateBps: 0 },
        { productId: 'BREAD', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_500, lineTotalMinor: 2_500, taxRateBps: 0 },
      ],
      tenders: [{ kind: 'cash', amount: { minor: 7_500, currency: 'INR' }, status: 'settled' }],
    });
    const edge = (await startEdge(env, () => {}))!;
    expect((await edge.node.commit('S-OLD', old)).committed).toBe(true);
    await edge.syncOnce!();
    await edge.stop();
    expect(await movementsOf(h, t, 'sale-S-OLD-')).toHaveLength(2);

    // After the upgrade: the same record re-sent, twice, across a restart.
    const back = (await startEdge(env, () => {}))!;
    await back.node.commit('S-OLD', old);
    await back.node.commit('S-OLD', old);
    await back.syncOnce!();
    await back.stop();
    expect(await movementsOf(h, t, 'sale-S-OLD-')).toHaveLength(2);
    expect(await onHand(h, t, 'MILK', 'unplaced-lane:lane-1')).toBe(-2);
    expect(await onHand(h, t, 'BREAD', 'unplaced-lane:lane-1')).toBe(-1);
  });

  it('a return of two lines of the same product, through the store computer, puts BOTH back on the shelf — once', async () => {
    const { h, t, env } = await stand();
    const edge = (await startEdge(env, () => {}))!;
    await ringAtTheTill(edge, 'S-RET');
    await edge.syncOnce!();
    const refund = JSON.stringify({
      returnId: 'RT-A7', number: 'RT-A7', originalSaleId: 'S-RET', noReceipt: false, laneId: 'lane-1',
      processedBy: 'u-sync', approvedBy: 'u-mgr', reasonCode: 'customer_changed_mind',
      refundMinor: 5_000, currency: 'INR', refundTender: 'cash', refundStatus: 'settled', processedAt: AT,
      lines: [
        { productId: 'MILK', uom: 'ea', quantityMinor: 1, disposition: 'resell' },
        { productId: 'MILK', uom: 'ea', quantityMinor: 1, disposition: 'resell' },
      ],
    });
    expect((await edge.node.commitReturn('RT-A7', refund)).committed).toBe(true);
    await edge.syncOnce!();
    await edge.node.commitReturn('RT-A7', refund); // sent again
    await edge.syncOnce!();
    await edge.stop();
    const back = await movementsOf(h, t, 'return-RT-A7-');
    expect(back.map((m) => [m.movementId, m.productId, m.quantityMinor, m.kind])).toEqual([
      ['return-RT-A7-0', 'MILK', 1, 'returned'], ['return-RT-A7-1', 'MILK', 1, 'returned'],
    ]);
    expect(await onHand(h, t, 'MILK', 'unplaced-lane:lane-1')).toBe(-5 + 2);
  });

  it('a goods receipt of two batches of the same product, relayed by the store computer, puts BOTH batches into stock — once', async () => {
    const { h, t } = await stand();
    await h.provisionRole(t, 'u-box', 'store_computer', ['wh-store']);
    await h.store.append(t, STREAM.catalogue, makeEvent({
      id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: t, version: 1, builtAt: AT, scope: { tenantId: t, storeId: 'wh-store' },
        products: [{ productId: 'DAL', sku: 'DAL', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' }],
        barcodes: [] } },
    }));
    const body = {
      grnId: 'G-A7', number: 'DN-A7', poId: null, lineCount: 2, warehouseId: 'wh-store', receivedBy: 'u-mgr', receivedAt: AT,
      lines: [
        { productId: 'DAL', quantityMinor: 10, uom: 'ea', batchId: 'B-1' },
        { productId: 'DAL', quantityMinor: 15, uom: 'ea', batchId: 'B-2' },
      ],
      storeId: 'wh-store', source: 'manager-screen',
    };
    const relay = (key: string) => h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/G-A7/synced', userId: 'u-box', tenantId: t, idempotencyKey: key, body });
    expect((await relay('k-g-a7')).status).toBe(202);
    expect([200, 202]).toContain((await relay('k-g-a7-again')).status); // the store computer re-sends under a new key
    const received = await movementsOf(h, t, 'G-A7:');
    expect(received.map((m) => [m.productId, m.quantityMinor, m.batchId])).toEqual([['DAL', 10, 'B-1'], ['DAL', 15, 'B-2']]);
    expect(await onHand(h, t, 'DAL', 'wh-store')).toBe(25);
  });
});
