import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **FUL-05 — one fulfilment command (M18-FR-01/02 · M19-FR-02/03/04 · M20-FR-03 · P-02 · P-08).** The order's lifecycle
 * advances from the RECORDED pack, manifest and door outcome — on its own after each one; the goods the customer kept
 * become ONE sale through the till's own pipeline (stock leaves through the one ledger, the day book reads it); the
 * order's holds are released; what was paid and not delivered is a refund DUE; a cash-on-delivery remainder stays
 * visible; a re-run posts nothing twice. Partial (with the hand-back counted), returned-to-origin and COD remainder are
 * covered, and the customer's own view re-reads the order. In memory and, with DATABASE_URL, on real PostgreSQL.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const AT = new Date().toISOString();
const PROOF = { kind: 'otp', ref: 'OTP-1234' };

describe.each(backings)('FUL-05 — one command advances the order and posts stock and money once — on $name', ({ harness }) => {
  const shop = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'delivery');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const call = (method: 'GET' | 'POST', path: string, body?: unknown, user = 'u-owner') =>
      h.request({ method, path, userId: user, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `${path}-${JSON.stringify(body ?? {})}`, body: body ?? {} } : {}) });
    // FUL-04 (Batch 2): the desk packs under HEAD OFFICE's rules — the handling class from the product master, name and
    // price from the published catalogue, quantities from the order register. The desk sends only what it observed.
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: AT, scope: { tenantId: T, storeId: 'store-1' }, barcodes: [], products: [
        { productId: 'MILK', sku: 'MILK', name: 'Milk', unitPriceMinor: 6_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
        { productId: 'DAL', sku: 'DAL', name: 'Dal', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
      ] } },
    }));
    for (const [id, name] of [['MILK', 'Milk'], ['DAL', 'Dal']] as const) {
      expect((await call('POST', `/v1/catalogue/products/${id}/publish`, {
        product: { sku: id, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      })).status).toBe(201);
    }
    for (const [id, productId, qty] of [['r-milk', 'MILK', 10], ['r-dal', 'DAL', 10]] as const) {
      expect((await call('POST', '/v1/inventory/movements', { movementId: id, productId, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: AT, enteredBy: 'u-owner', unitCostMinor: 3_000 })).status).toBeLessThan(300);
    }
    const stock = async () => {
      const moves = (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { productId: string; kind: string; quantityMinor: number });
      const sold = (p: string) => moves.filter((m) => m.productId === p && m.kind === 'sold').reduce((n, m) => n + m.quantityMinor, 0);
      return { MILK: sold('MILK'), DAL: sold('DAL') };
    };
    const reservations = async () => ((await h.request({ method: 'GET', path: '/v1/orders/reservations', userId: 'u-owner', tenantId: T, query: { locationId: 'store-1' } })).body as { outstanding: unknown[] }).outstanding.length;
    const sales = async () => (await h.store.readStream(T, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as { saleId: string; totalMinor: number; tenders: { kind: string; amountMinor: number }[]; lines: { productId: string; quantityMinor: number; lineTotalMinor: number }[] });
    /** Place, (optionally pay), confirm, pack and dispatch an order: 2 milk at ₹60 and 1 dal at ₹160. */
    const outForDelivery = async (orderId: string, paidMinor?: number) => {
      expect((await call('POST', `/v1/orders/${orderId}/promise`, { lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'DAL', quantityMinor: 1 }], locationId: 'store-1' })).status).toBe(200);
      if (paidMinor !== undefined) expect((await call('POST', `/v1/orders/${orderId}/payment`, { providerRef: `tok_${orderId}`, amountMinor: paidMinor, result: 'authorised' }, 'u-mgr')).status).toBeLessThan(300);
      expect((await call('POST', `/v1/orders/${orderId}/transition`, { event: 'confirm' })).status).toBe(200);
      const packed = await call('POST', `/v1/fulfilment/orders/${orderId}/pack`, {
        lines: [{ productId: 'MILK', pickedMinor: 2 }, { productId: 'DAL', pickedMinor: 1 }],
        crateAssignment: { MILK: 'c1', DAL: 'c1' },
      }, 'u-mgr');
      expect(packed.status).toBe(200);
      expect(packed.body).toMatchObject({ fulfilment: { state: 'packed', steps: [{ event: 'pick' }, { event: 'pack' }], waiting: 'no_door_outcome' } });
      const sent = await call('POST', `/v1/fulfilment/orders/${orderId}/dispatch`, { manifestId: `m-${orderId}`, locationId: 'store-1', seals: { c1: 's1' } }, 'u-mgr');
      expect(sent.body).toMatchObject({ dispatched: true, fulfilment: { state: 'dispatched' } });
      expect((await call('POST', `/v1/delivery/orders/${orderId}/transition`, { event: 'depart' })).status).toBe(200);
    };
    return { h, T, call, stock, reservations, sales, outForDelivery };
  };

  it('a prepaid order delivered in full: the order is delivered, ONE sale carries the stock and money, holds released; a re-run changes nothing', async () => {
    const s = await shop();
    await s.outForDelivery('o-full', 28_000);
    expect(await s.reservations()).toBe(2);
    const door = await s.call('POST', '/v1/delivery/orders/o-full/transition', { event: 'deliver', proof: PROOF });
    expect(door.body).toMatchObject({ state: 'delivered', fulfilment: { state: 'delivered', settlement: { outcome: 'delivered', saleId: 'order-o-full', keptMinor: 28_000, refundDueMinor: 0, codDueMinor: 0 } } });
    expect((await s.call('GET', '/v1/orders/o-full')).body).toMatchObject({ state: 'delivered' });
    expect(await s.sales()).toEqual([expect.objectContaining({ saleId: 'order-o-full', totalMinor: 28_000, tenders: [expect.objectContaining({ kind: 'online_prepaid', amountMinor: 28_000 })] })]);
    expect(await s.stock()).toEqual({ MILK: 2, DAL: 1 });
    expect(await s.reservations()).toBe(0);
    // Again — by hand: nothing twice.
    expect((await s.call('POST', '/v1/fulfilment/orders/o-full/apply', {}, 'u-mgr')).body).toMatchObject({ alreadySettled: true });
    expect(await s.sales()).toHaveLength(1);
    expect(await s.stock()).toEqual({ MILK: 2, DAL: 1 });
  });

  it('a partial delivery waits for the hand-back count, then posts only what was kept and the rest as a refund due', async () => {
    const s = await shop();
    await s.outForDelivery('o-part', 28_000);
    const door = await s.call('POST', '/v1/delivery/orders/o-part/transition', { event: 'deliver_partial', proof: PROOF });
    expect(door.body).toMatchObject({ fulfilment: { waiting: 'awaiting_handback' } });
    expect(await s.sales()).toHaveLength(0);
    // One milk came back to the store.
    const back = await s.call('POST', '/v1/fulfilment/orders/o-part/handback', { lines: [{ lineId: 'MILK', quantityMinor: 1 }] }, 'u-mgr');
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ applied: { state: 'delivered', settlement: { outcome: 'partially_delivered', keptMinor: 22_000, refundDueMinor: 6_000 } } });
    expect(await s.stock()).toEqual({ MILK: 1, DAL: 1 });
    expect(await s.reservations()).toBe(0);
    expect((await s.call('GET', '/v1/fulfilment/orders/o-part/settlement', undefined, 'u-mgr')).body).toMatchObject({ refundDueMinor: 6_000 });
  });

  it('returned to origin: no sale, no stock out, holds released, everything paid is due back', async () => {
    const s = await shop();
    await s.outForDelivery('o-rto', 28_000);
    expect((await s.call('POST', '/v1/delivery/orders/o-rto/transition', { event: 'arrive' })).status).toBe(200);
    expect((await s.call('POST', '/v1/delivery/orders/o-rto/transition', { event: 'fail' })).body).toMatchObject({ fulfilment: { waiting: 'no_door_outcome' } });
    const rto = await s.call('POST', '/v1/delivery/orders/o-rto/transition', { event: 'rto' });
    expect(rto.body).toMatchObject({ fulfilment: { state: 'returned', settlement: { outcome: 'returned', keptMinor: 0, refundDueMinor: 28_000 } } });
    expect(await s.sales()).toHaveLength(0);
    expect(await s.stock()).toEqual({ MILK: 0, DAL: 0 });
    expect(await s.reservations()).toBe(0);
  });

  it('cash on delivery with a remainder: the cash the door took is the tender, the rest stays owed and visible', async () => {
    const s = await shop();
    await s.outForDelivery('o-cod');
    // The driver's attempt records ₹200 cash of ₹280 expected, then the door outcome.
    expect((await s.call('POST', '/v1/delivery/attempts', { attemptId: 'a-cod', orderId: 'o-cod', driverId: 'u-owner', attemptedAt: AT, outcome: 'delivered', proofRef: 'OTP-9', cashCollectedMinor: 20_000, codExpectedMinor: 28_000 })).status).toBe(201);
    const door = await s.call('POST', '/v1/delivery/orders/o-cod/transition', { event: 'deliver', proof: PROOF });
    expect(door.body).toMatchObject({ fulfilment: { settlement: { outcome: 'delivered', keptMinor: 28_000, codDueMinor: 8_000, refundDueMinor: 0 } } });
    expect((await s.sales())[0]!.tenders).toEqual([{ kind: 'cash', amountMinor: 20_000 }, { kind: 'cod_due', amountMinor: 8_000 }]);
  });

  it('an order no one confirmed is not advanced: the desk cannot pack it, and nothing is posted', async () => {
    // Integration of FUL-04 and FUL-05 (10 Oct 2026): head office refuses to pack an order nobody confirmed (FUL-04's
    // rule) — the order is not advanced and no stock or money moves, which is what FUL-05 required of it.
    const s = await shop();
    expect((await s.call('POST', '/v1/orders/o-new/promise', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'store-1' })).status).toBe(200);
    const packed = await s.call('POST', '/v1/fulfilment/orders/o-new/pack', { lines: [{ productId: 'MILK', pickedMinor: 1 }], crateAssignment: { MILK: 'c1' } }, 'u-mgr');
    expect(packed.status).toBe(409);
    expect((packed.body as { error?: { code?: string } }).error?.code).toBe('order_not_packable');
    expect((await s.call('GET', '/v1/orders/o-new')).body).toMatchObject({ state: 'placed' });
    expect(await s.sales()).toHaveLength(0);
    expect(await s.stock()).toEqual({ MILK: 0, DAL: 0 });
  });
});
