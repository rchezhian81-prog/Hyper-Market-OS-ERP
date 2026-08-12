import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// D-2 forecast-driven order proposal on the live API (API-04). It forecasts demand (D-1) from the store's
// own banked sales over the supplier's next delivery window and sizes an order to cover it, rounded to whole
// cases, netting stock. A stateless read; advisory only.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const bankSale = (h: ApiHarness, u: string, saleId: string, productId: string, qty: number, tradingDay: string) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: `op-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T09:00:00Z`, totalMinor: qty * 100, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
      tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
    },
  });

const order = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/replenishment/order-proposal', userId: u, tenantId: A, idempotencyKey: key, body });

interface Proposal { reason: string; arrivesOn?: string; coversUntil?: string; coverDemand: number; suggestedQty: number; cases?: number }
const body = (res: { body: unknown }): Proposal => res.body as Proposal;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function seedSteadySales(h: ApiHarness): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  for (let i = 1; i <= 14; i += 1) await bankSale(h, 'u-owner', `D${i}`, 'MILK', 20, iso(-i)); // ~steady recent demand
}

describe('forecast-driven order proposal on the live API (D-2)', () => {
  it('sizes an order from the forecast to cover the supplier delivery window, rounded to whole cases', async () => {
    const h = apiHarness();
    await seedSteadySales(h);

    const p = body(await order(h, 'u-owner', { productId: 'MILK', onHand: 0, upcomingDeliveries: [iso(2), iso(5)], unitsPerCase: 12 }, 'op-1'));
    expect(p.reason).toBe('ordered');
    expect(p.arrivesOn).toBe(iso(2));
    expect(p.coversUntil).toBe(iso(5));
    expect(p.coverDemand).toBeGreaterThan(0);          // forecast from the banked sales
    expect(p.suggestedQty % 12).toBe(0);               // whole cases
    expect(p.suggestedQty).toBeGreaterThanOrEqual(p.coverDemand);
    expect(p.cases).toBe(p.suggestedQty / 12);
  });

  it('proposes nothing when stock already covers the window, and refuses without a supplier calendar', async () => {
    const h = apiHarness();
    await seedSteadySales(h);

    expect(body(await order(h, 'u-owner', { productId: 'MILK', onHand: 100_000, upcomingDeliveries: [iso(2), iso(5)] }, 'op-covered')).reason).toBe('covered');
    expect(body(await order(h, 'u-owner', { productId: 'MILK', onHand: 0, upcomingDeliveries: [iso(2)] }, 'op-nocal')).reason).toBe('no_supplier_calendar');
  });

  it('is authorized and refuses malformed input', async () => {
    const h = apiHarness();
    await seedSteadySales(h);
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.availability.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // does not

    expect((await order(h, 'u-mgr', { productId: 'MILK', onHand: 0, upcomingDeliveries: [iso(2), iso(5)] }, 'op-mgr')).status).toBe(200);
    expect((await order(h, 'u-cash', { productId: 'MILK', onHand: 0, upcomingDeliveries: [iso(2), iso(5)] }, 'op-cash')).status).toBe(403);

    expect(codeOf(await order(h, 'u-owner', { productId: 'MILK', upcomingDeliveries: [iso(2), iso(5)] }, 'op-bad1'))).toBe('not_readable_as_an_order_request'); // no onHand
    // Past delivery dates are filtered out; with <2 future dates left the engine reports no_supplier_calendar (a 200, not an error).
    expect(body(await order(h, 'u-owner', { productId: 'MILK', onHand: 0, upcomingDeliveries: ['2020-01-01', '2020-01-05'] }, 'op-bad2')).reason).toBe('no_supplier_calendar');
  });
});
