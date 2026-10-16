import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { acceptPack, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { CatalogueCache, RecalledItemError } from '../../packages/catalogue/src/catalogue';

/**
 * **WF-09 Expiry/recall — the whole lifecycle on REAL PostgreSQL (round 8 · M10-FR-03/04 · D05-FR-06 · M28 · P-08 ·
 * hard rules #2 #6).** "Detect → quarantine/block → identify stock/sales/customers → return/dispose → evidence → close", on
 * the real API over the same migrations production runs (and in memory), with a cold restart in the middle:
 *
 *   detect: a supplier notice on batch B-0412 of paneer — the batch is put on QUALITY HOLD, then a RECALL is initiated;
 *   block: head office says the block has not reached any till until the next signed pack, which the lane accepts and then
 *          refuses the product by name with no network (whole product, OB-25 "C"); curd sells on;
 *   identify: the stock still on hand of the batch, and every sale of it — the customer named where the stored-value ledger
 *          links one, the walk-in counted, never dropped;
 *   dispose: what is left of the batch is written off at its cost (a loss, on the ledger once);
 *   evidence / close: closing without evidence is refused; with it the recall closes and is RETAINED; the hold is released
 *          by a person; the block lifts on the next pack and the product sells again.
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
/** Each backing makes a harness, and a COLD RESTART of one: a fresh API over the same durable store. */
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); },
    restart: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); },
  });
}

const STORE = 'store-01';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const signer = hmacSigner(TEST_PACK_KEY);
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('a recall runs its whole lifecycle — on $name (WF-09)', ({ harness, restart }) => {
  it('detect → hold + recall → block on the offline till → trace stock, sales and customers → dispose → close with evidence → sells again', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-qc', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    for (const [id, sku, name, code] of [['p-paneer', 'SKU-PANEER', 'Paneer 200g', '8901000000011'], ['p-curd', 'SKU-CURD', 'Curd 400g', '8901000000028']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [GROCERY] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
    }
    for (const [p, b] of [['p-paneer', 'B-0412'], ['p-paneer', 'B-0413'], ['p-curd', 'C-0001']] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${b}`, productId: p, locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: b, expiry: '2030-07-01', unitCostMinor: 6_000 }), `receive ${b}`);
    }
    // Two sales of B-0412 before the notice: one by a member (linked through the stored-value ledger), one walk-in.
    const sell = (saleId: string, qty: number) => ok(req('POST', '/v1/sales', {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: STORE, cashierId: 'u-owner', tradingDay: '2030-05-20', committedAt: '2030-05-20T10:00:00Z',
      totalMinor: qty * 9_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-paneer', quantityMinor: qty, uom: 'EA', unitPriceMinor: 9_000, lineTotalMinor: qty * 9_000, batchId: 'B-0412' }],
      tenders: [{ kind: 'cash', amountMinor: qty * 9_000 }],
    }), `sale ${saleId}`);
    await sell('S-MEMBER', 3);
    await sell('S-WALKIN', 2);
    await ok(req('POST', '/v1/stored-value/instruments', { instrumentId: 'GC-1', kind: 'gift_card', ownerRef: 'cust-42', faceValueMinor: 100_000 }), 'gift card');
    await ok(req('POST', '/v1/stored-value/instruments/GC-1/redeem', { movementId: 'mv-gc-1', amountMinor: 500, channel: 'store', saleId: 'S-MEMBER', customerRef: 'cust-42' }), 'member link');

    let published = 0;
    const publish = async (): Promise<SignedPack> => {
      published += 1;
      await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), `pack ${published}`);
      return (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    };
    const lane = (incoming: SignedPack, held?: SignedPack) => {
      const accepted = acceptPack({ incoming, ...(held === undefined ? {} : { held }), signer, tenantId: T });
      expect(accepted.accepted).toBe(true);
      return { cache: new CatalogueCache(accepted.tradingOn!.snapshot), pack: accepted.tradingOn! };
    };
    const v1 = lane(await publish());
    expect(v1.cache.scan('8901000000011').product.productId).toBe('p-paneer');

    // ── DETECT → QUARANTINE + RECALL ─────────────────────────────────────────────────────────────────────────────────
    expect((await req('POST', '/v1/quality/recalls/B-0412', { reason: 'x' }, 'u-till')).status).toBe(403);
    await ok(req('POST', '/v1/quality/holds/B-0412', { productId: 'p-paneer', reason: 'supplier contamination notice — set aside' }), 'hold');
    await ok(req('POST', '/v1/quality/recalls/B-0412', { reason: 'supplier contamination notice SN-2030-17' }), 'recall');
    const blocks = async () => (await req('GET', '/v1/quality/sale-blocks')).body as { blocks: { productId: string | null; batchId: string; kind: string; state: string }[]; blockedProducts: string[]; notYetOnPack: number };
    expect((await blocks()).notYetOnPack).toBe(2); // the hold and the recall — neither on any till yet, and said
    expect((await blocks()).blockedProducts).toEqual(['p-paneer']);

    // ── A COLD RESTART: everything above is rebuilt from the store ──────────────────────────────────────────────────
    h = restart(h);
    expect(((await req('GET', '/v1/quality/recalls/B-0412')).body as { recall: { status: string } }).recall.status).toBe('open');

    // ── BLOCK: the next signed pack carries it; the lane refuses paneer by name, offline; curd sells on ───────────────
    const v2 = lane(await publish(), v1.pack);
    expect(() => v2.cache.scan('8901000000011')).toThrow(RecalledItemError);
    expect(() => v2.cache.scan('8901000000011')).toThrow(/Paneer 200g/);
    expect(v2.cache.scan('8901000000028').product.productId).toBe('p-curd');
    expect((await blocks()).blocks.every((b) => b.state === 'on_pack')).toBe(true);

    // ── IDENTIFY: what is still on hand of the batch, and who bought it ─────────────────────────────────────────────
    const onHandOf = async (batchId: string) => (((await h.request({ method: 'GET', path: '/v1/inventory/batches', userId: 'u-owner', tenantId: T, query: { locationId: STORE, productId: 'p-paneer' } })).body as { batches: { batchId: string | null; onHandMinor: number }[] }).batches.find((b) => b.batchId === batchId)?.onHandMinor ?? 0);
    expect(await onHandOf('B-0412')).toBe(15);
    const sold = (await req('GET', '/v1/quality/lot-trace/B-0412/sold')).body as { saleCount: number; identifiedRecipientCount: number; anonymousSaleCount: number; outbound: { saleId: string; quantityMinor: number; customerId?: string }[] };
    expect(sold).toMatchObject({ saleCount: 2, identifiedRecipientCount: 1, anonymousSaleCount: 1 });
    expect(sold.outbound.find((o) => o.saleId === 'S-MEMBER')).toMatchObject({ quantityMinor: 3, customerId: 'cust-42' });
    expect(sold.outbound.find((o) => o.saleId === 'S-WALKIN')?.customerId).toBeUndefined();

    // ── DISPOSE: the 15 left are written off at their cost — a loss, once ──────────────────────────────────────────────
    // A loss this size needs evidence and a second person (the tenant's threshold): the store manager raises it, the owner
    // approves it in their own session; the batch named, so the batch's own stock falls to nothing.
    const loss = { productId: 'p-paneer', locationId: STORE, qty: 15, uom: 'EA', lossType: 'destruction', reasonCode: 'recall', evidenceRef: 'DESTRUCTION-CERT-17', batchId: 'B-0412' };
    const body = await approvedBody(h, T, 'u-qc', 'u-owner', 'stock_write_off', 'wo-recall', loss, { writeOffId: 'wo-recall' }, 90_000);
    const wo = await h.request({ method: 'POST', path: '/v1/inventory/write-off/wo-recall', userId: 'u-qc', tenantId: T, idempotencyKey: 'wo-recall', body });
    expect(wo.status, JSON.stringify(wo.body)).toBe(201);
    expect(wo.body).toMatchObject({ valueMinor: 90_000, requiredApproval: true });
    expect(await onHandOf('B-0412')).toBe(0);
    expect(await onHandOf('B-0413')).toBe(20); // the other batch is untouched
    // The same write-off again is one loss, not two.
    await h.request({ method: 'POST', path: '/v1/inventory/write-off/wo-recall', userId: 'u-qc', tenantId: T, idempotencyKey: 'wo-recall', body });
    expect(await onHandOf('B-0413') + await onHandOf('B-0412')).toBe(20);

    // ── EVIDENCE → CLOSE: refused without it; closed and RETAINED with it; the hold released by a person ──────────────
    const bare = await req('POST', '/v1/quality/recalls/B-0412/closure', {});
    expect(bare.status).toBe(422);
    expect(codeOf(bare)).toBe('recall_needs_evidence');
    await ok(req('POST', '/v1/quality/recalls/B-0412/closure', { evidenceRef: 'RECALL-B-0412: customers contacted (1 named), 15 destroyed DESTRUCTION-CERT-17' }), 'close');
    expect(((await req('GET', '/v1/quality/recalls/B-0412')).body as { recall: { status: string; evidenceRef: string } }).recall).toMatchObject({ status: 'closed', evidenceRef: expect.stringMatching(/^RECALL-B-0412/) });
    expect((await blocks()).blockedProducts).toEqual(['p-paneer']); // the hold still stands — the block stays until it is released too
    await ok(req('POST', '/v1/quality/holds/B-0412/release', {}, 'u-qc'), 'hold released');
    expect((await blocks()).blockedProducts).toEqual([]);
    const v3 = lane(await publish(), v2.pack);
    expect(v3.cache.scan('8901000000011').product.productId).toBe('p-paneer');
    // The recall stays on the record, closed (hard rule #6) — the list still has it.
    expect(((await req('GET', '/v1/quality/recalls')).body as { recalls: { batchId: string; status: string }[] }).recalls).toEqual([expect.objectContaining({ batchId: 'B-0412', status: 'closed' })]);
  }, 60_000);
});
