import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Sales-history demand read (M09, API-04) end to end through the real API. The store already keeps every
// sale as an append-only SaleCommitted event; this read folds those banked lines into per-product demand
// and the avgDailyDemand the reorder engine (D-3) consumes. A stateless read — it never writes.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Bank a one-line sale of `productId × qty`, booked to `tradingDay`. */
const bankSale = (h: ApiHarness, u: string, saleId: string, productId: string, qty: number, tradingDay: string) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: `sh-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T10:00:00Z`, totalMinor: qty * 100, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
      tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
    },
  });

const history = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/inventory/sales-history', userId: u, tenantId: A, query });

interface ProductDemand { productId: string; totalQtyMinor: number; sellingDays: number; avgDailyDemandMinor: number; byDay: { day: string; qtyMinor: number }[] }
interface History { from: string; to: string; windowDays: number; products: ProductDemand[] }
const body = (res: { body: unknown }): History => res.body as History;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('sales-history demand read on the live API (M09)', () => {
  it('folds banked sales into per-product demand and average daily demand over the window', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    await bankSale(h, 'u-owner', 'S1', 'RICE', 10, '2026-08-02');
    await bankSale(h, 'u-owner', 'S2', 'RICE', 20, '2026-08-04');
    await bankSale(h, 'u-owner', 'S3', 'MILK', 7, '2026-08-03');
    await bankSale(h, 'u-owner', 'S4', 'RICE', 5, '2026-07-30'); // before the window — excluded

    const out = body(await history(h, 'u-owner', { from: '2026-08-01', to: '2026-08-07' }));
    expect(out.windowDays).toBe(7);
    expect(out.products.map((p) => p.productId)).toEqual(['MILK', 'RICE']);

    const rice = out.products.find((p) => p.productId === 'RICE')!;
    expect(rice.totalQtyMinor).toBe(30); // the July sale is not counted
    expect(rice.sellingDays).toBe(2);
    expect(rice.avgDailyDemandMinor).toBe(4); // round(30 / 7)
    expect(rice.byDay).toEqual([{ day: '2026-08-02', qtyMinor: 10 }, { day: '2026-08-04', qtyMinor: 20 }]);

    const milk = out.products.find((p) => p.productId === 'MILK')!;
    expect(milk.avgDailyDemandMinor).toBe(1); // round(7 / 7)
  });

  it('scopes to one product with ?productId=', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'S1', 'RICE', 10, '2026-08-02');
    await bankSale(h, 'u-owner', 'S2', 'MILK', 7, '2026-08-03');

    const out = body(await history(h, 'u-owner', { from: '2026-08-01', to: '2026-08-07', productId: 'RICE' }));
    expect(out.products.map((p) => p.productId)).toEqual(['RICE']);
  });

  it('is authorized and refuses a bad window', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.availability.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // does not

    expect((await history(h, 'u-mgr', { from: '2026-08-01', to: '2026-08-07' })).status).toBe(200);
    expect((await history(h, 'u-cash', { from: '2026-08-01', to: '2026-08-07' })).status).toBe(403);

    expect(codeOf(await history(h, 'u-owner', { from: '2026-08-07', to: '2026-08-01' }))).toBe('invalid_demand_window');
    expect(codeOf(await history(h, 'u-owner', { from: 'notadate', to: '2026-08-07' }))).toBe('not_a_date_window');
  });
});
