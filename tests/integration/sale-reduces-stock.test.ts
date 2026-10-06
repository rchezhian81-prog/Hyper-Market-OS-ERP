import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

// A banked sale IS a stock movement (M08-FR-01: "a movement (receive/sell/…) appends an event"), proven
// end to end through the real API. Before this, `POST /v1/sales` appended only a `SaleCommitted`, so
// on-hand, valuation and COGS never learned a sale had happened — the hosted-demo finding H-13 ("a till
// sale did not reduce on-hand stock"). Now every banked sale appends its `sold` movements in the SAME
// atomic batch, keyed on the sale, so a resent sale is one sale and one set of movements (M08-FR-01
// acceptance: "replaying the same movement five times yields one balance change").

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-28T09:00:00.000Z';
const SOLD_AT = '2026-09-28T10:15:00.000Z';

interface Availability { productId: string; locationId: string; onHandMinor: number; movements: number }
interface Valuation { productId: string; locationId: string; onHandMinor: number; value: { minor: number }; cogs: { minor: number } }
interface Negative { productId: string; locationId: string; onHandMinor: number }

const receive = (h: ApiHarness, tenantId: string, movementId: string, productId: string, qty: number, unitCostMinor: number) =>
  h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId, idempotencyKey: `mv-${movementId}`,
    body: { movementId, productId, locationId: 'L1', kind: 'received', quantityMinor: qty, unitCostMinor, uom: 'each', occurredAt: AT, enteredBy: 'u-owner' },
  });

/** A till's sale, exactly as `POST /v1/sales` reads it; `extra` adds the optional stock location or a batch. */
const sell = (
  h: ApiHarness, tenantId: string, saleId: string, productId: string, qty: number, key: string,
  extra: { locationId?: string; batchId?: string; laneId?: string } = {},
) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId, idempotencyKey: key,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: extra.laneId ?? 'lane-1', cashierId: 'u-owner',
      tradingDay: SOLD_AT.slice(0, 10), committedAt: SOLD_AT, totalMinor: qty * 2500, currency: 'INR', packVersion: 1,
      ...(extra.locationId === undefined ? {} : { locationId: extra.locationId }),
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 2500, lineTotalMinor: qty * 2500, ...(extra.batchId === undefined ? {} : { batchId: extra.batchId }) }],
      tenders: [{ kind: 'cash', amountMinor: qty * 2500 }],
    },
  });

const availability = async (h: ApiHarness, tenantId: string, productId: string): Promise<Availability[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId, query: { productId } })).body as { rows: Availability[] }).rows;

const valuation = async (h: ApiHarness, tenantId: string, productId: string): Promise<Valuation[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: 'u-owner', tenantId, query: { productId } })).body as { rows: Valuation[] }).rows;

const negatives = async (h: ApiHarness, tenantId: string): Promise<Negative[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/exceptions', userId: 'u-owner', tenantId })).body as { negative: Negative[] }).negative;

/** Every `sold` movement the ledger holds for one sale (by the sale-keyed movement ids). */
const soldMovementsOf = async (h: ApiHarness, tenantId: string, saleId: string) =>
  (await h.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => e.event.payload as { movementId: string; kind: string; locationId: string; batchId?: string; reason?: string })
    .filter((m) => m.movementId.startsWith(`sale-${saleId}-`));

/** A published pack that names the store it was built for (the lane priced this sale from it). */
const publishScopedPack = (h: ApiHarness, tenantId: string, storeId: string, productId: string) =>
  h.store.append(tenantId, STREAM.catalogue, makeEvent({
    id: `pack-${tenantId}-1`, type: 'CataloguePublished', occurredAt: AT,
    idempotencyKey: `catalogue-${tenantId}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId, version: 1, builtAt: AT, scope: { tenantId, storeId },
        products: [{ productId, sku: productId, name: productId, unitPriceMinor: 2500, taxBps: 500, status: 'active', uom: 'each' }],
        barcodes: [],
      },
    },
  }));

describe('a banked sale reduces on-hand stock (M08-FR-01, H-13)', () => {
  it('appends one `sold` movement per line at the location the lane declared — on-hand, value and COGS all move', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await receive(h, A, 'r1', 'MILK', 100, 1000)).status).toBe(202);

    expect((await sell(h, A, 'S1', 'MILK', 30, 'k-s1', { locationId: 'L1', batchId: 'B-7' })).status).toBe(202);

    const row = (await availability(h, A, 'MILK')).find((r) => r.locationId === 'L1');
    expect(row).toMatchObject({ onHandMinor: 70, movements: 2 });

    // Valuation folds the same ledger: 70 left at ₹10.00 WAC, 30 issued at cost.
    const v = (await valuation(h, A, 'MILK')).find((r) => r.locationId === 'L1');
    expect(v).toMatchObject({ onHandMinor: 70, value: { minor: 70_000 }, cogs: { minor: 30_000 } });

    // The captured batch rides on the movement (ADR-0006: a captured batch always beats an estimate).
    const moves = await soldMovementsOf(h, A, 'S1');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ movementId: 'sale-S1-0', kind: 'sold', locationId: 'L1', batchId: 'B-7' });
    expect(moves[0]?.reason).toBeUndefined();
  });

  it('a resent sale is ONE sale and ONE set of movements, whatever key the transport used (M08-FR-01 acceptance)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await receive(h, A, 'r1', 'RICE', 100, 1000);
    await sell(h, A, 'S2', 'RICE', 10, 'k-s2', { locationId: 'L1' });
    // The till resends what it could not confirm — same key, then different keys, five arrivals in all.
    for (const key of ['k-s2', 'k-s2-retry-1', 'k-s2-retry-2', 'k-s2-retry-3']) {
      expect((await sell(h, A, 'S2', 'RICE', 10, key, { locationId: 'L1' })).status).toBe(202);
    }
    expect((await availability(h, A, 'RICE')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 90, movements: 2 });
    expect(await soldMovementsOf(h, A, 'S2')).toHaveLength(1);
  });

  it('with no declared location, the sale draws from the store its pack was published for', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await publishScopedPack(h, A, 'L1', 'BREAD');
    await receive(h, A, 'r1', 'BREAD', 50, 800);
    expect((await sell(h, A, 'S3', 'BREAD', 5, 'k-s3')).status).toBe(202);

    expect((await availability(h, A, 'BREAD')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 45 });
    expect((await soldMovementsOf(h, A, 'S3'))[0]).toMatchObject({ locationId: 'L1' });
    expect((await soldMovementsOf(h, A, 'S3'))[0]?.reason).toBeUndefined();
  });

  it('with neither, the sale draws from its lane and SAYS SO — and the shelf gone negative is a visible exception, never a refusal', async () => {
    const h = apiHarness();
    await h.seedOwner(B, 'u-owner');
    // No pack, no declared location, nothing received: the sale still banks (hard rule #1).
    expect((await sell(h, B, 'S4', 'SOAP', 2, 'k-s4', { laneId: 'lane-9' })).status).toBe(202);

    const move = (await soldMovementsOf(h, B, 'S4'))[0];
    expect(move).toMatchObject({ locationId: 'lane-9', kind: 'sold' });
    expect(move?.reason).toContain('assumed from lane lane-9');

    expect((await availability(h, B, 'SOAP')).find((r) => r.locationId === 'lane-9')).toMatchObject({ onHandMinor: -2 });
    expect(await negatives(h, B)).toContainEqual(expect.objectContaining({ productId: 'SOAP', locationId: 'lane-9', onHandMinor: -2 }));
  });

  it('a line that cannot be a movement is skipped and the sale still banks (hard rule #1)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await receive(h, A, 'r1', 'TEA', 10, 500);
    const res = await h.request({
      method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-s5',
      body: {
        saleId: 'S5', receiptNumber: 'R-S5', laneId: 'lane-1', cashierId: 'u-owner', locationId: 'L1',
        tradingDay: SOLD_AT.slice(0, 10), committedAt: SOLD_AT, totalMinor: 2500, currency: 'INR', packVersion: 1,
        lines: [
          { productId: 'TEA', quantityMinor: 0, uom: 'each', unitPriceMinor: 0, lineTotalMinor: 0 },
          { productId: 'TEA', quantityMinor: 1, uom: 'each', unitPriceMinor: 2500, lineTotalMinor: 2500 },
        ],
        tenders: [{ kind: 'cash', amountMinor: 2500 }],
      },
    });
    expect(res.status).toBe(202);
    expect((await soldMovementsOf(h, A, 'S5')).map((m) => m.movementId)).toEqual(['sale-S5-1']);
    expect((await availability(h, A, 'TEA')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 9 });
  });
});

/** A return against a banked sale, through the real desk route (u-mgr approves in their own session — ADR-0022; u-owner
 *  processes and names that approval). */
const returnAgainst = async (h: ApiHarness, tenantId: string, saleId: string, returnId: string, qty: number, disposition: string, key: string) =>
  h.request({
    method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: 'u-owner', tenantId, idempotencyKey: key,
    body: await withApprovals(h, tenantId, 'u-owner', saleId, {
      returnId, number: returnId, reasonCode: 'changed_mind', refundMinor: qty * 2500, refundTender: 'cash', approvedBy: 'u-mgr',
      processedAt: '2026-09-29T11:00:00.000Z',
      lines: [{ productId: 'MILK', quantityMinor: qty, uom: 'each', disposition }],
    }),
  });

const returnedMovementsOf = async (h: ApiHarness, tenantId: string, returnId: string) =>
  (await h.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => e.event.payload as { movementId: string; kind: string; locationId: string })
    .filter((m) => m.movementId.startsWith(`return-${returnId}-`));

describe('a resold return puts stock back (M08-FR-01 "return", A2)', () => {
  it('a RESELL return re-enters on-hand at the location the sale drew from, valued at the running average; a DAMAGED one does not', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await receive(h, A, 'r1', 'MILK', 100, 1000);
    await sell(h, A, 'S1', 'MILK', 30, 'k-s1', { locationId: 'L1' });
    expect((await availability(h, A, 'MILK')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 70 });

    expect((await returnAgainst(h, A, 'S1', 'RET-1', 10, 'resell', 'k-ret1')).status).toBe(201);
    expect((await availability(h, A, 'MILK')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 80, movements: 3 });
    // Back on the shelf at ₹10.00 WAC: value 80,000; the 30 issued stay in COGS (the performance read nets resold returns itself).
    expect((await valuation(h, A, 'MILK')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 80, value: { minor: 80_000 }, cogs: { minor: 30_000 } });
    expect(await returnedMovementsOf(h, A, 'RET-1')).toEqual([expect.objectContaining({ movementId: 'return-RET-1-0', kind: 'returned', locationId: 'L1' })]);

    // Damaged goods do not re-enter sellable stock — they go to the governed hold / write-off paths.
    expect((await returnAgainst(h, A, 'S1', 'RET-2', 5, 'damaged', 'k-ret2')).status).toBe(201);
    expect((await availability(h, A, 'MILK')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 80 });
    expect(await returnedMovementsOf(h, A, 'RET-2')).toEqual([]);
  });

  it('a lane retrying an unconfirmed refund appends the movement once', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await receive(h, A, 'r1', 'MILK', 100, 1000);
    await sell(h, A, 'S1', 'MILK', 30, 'k-s1', { locationId: 'L1' });
    await returnAgainst(h, A, 'S1', 'RET-1', 10, 'resell', 'k-ret1');
    await returnAgainst(h, A, 'S1', 'RET-1', 10, 'resell', 'k-ret1-retry');
    expect((await availability(h, A, 'MILK')).find((r) => r.locationId === 'L1')).toMatchObject({ onHandMinor: 80 });
    expect(await returnedMovementsOf(h, A, 'RET-1')).toHaveLength(1);
  });
});
