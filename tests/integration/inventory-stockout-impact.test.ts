import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **What the empty shelf cost, on the cloud (M08-FR-04, API-04, P-08).**
 *
 * The fourth stock-health number — and the only one of the four that cannot be projected from the
 * movement ledger, because a sale that never happened leaves no movement behind. Its three siblings
 * (ageing, turns, GMROI) were already live as GET routes fed from the ledger; this one takes the
 * figures the caller CAN know — how many days the shelf was empty and the product's normal rate of
 * sale — in the request body, and estimates the margin that never landed. It is stated as an
 * ESTIMATE and returned in its own field, never mixed into actuals (P-08). This drives the pure
 * `stockoutImpact` through the real authenticated surface.
 */

const TENANT = 't-sre';
const path = '/v1/inventory/stockout-impact';

describe('stockout-impact estimate on the API', () => {
  it('estimates the units and the margin the empty shelf cost, labelled as an estimate', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'so-1',
      body: {
        currency: 'INR',
        products: [
          { productId: 'milk', daysOutOfStock: 6, periodDays: 30, averageDailyUnits: 40, marginPerUnit: { minor: 500, currency: 'INR' } },
          { productId: 'rice', daysOutOfStock: 3, periodDays: 30, averageDailyUnits: 10, marginPerUnit: { minor: 1_200, currency: 'INR' } },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      rows: { productId: string; outOfStockBp: number; estimatedLostUnits: number; estimatedLostMargin: { minor: number; currency: string } }[];
      totalLostMargin: { minor: number; currency: string };
      asAt: string;
    };
    expect(body.rows[0]?.outOfStockBp).toBe(2_000);                       // milk empty 20% of the month
    expect(body.rows[0]?.estimatedLostUnits).toBe(240);                   // 6 days × 40 units
    expect(body.rows[0]?.estimatedLostMargin).toEqual({ minor: 120_000, currency: 'INR' }); // 240 × ₹5.00
    expect(body.totalLostMargin).toEqual({ minor: 156_000, currency: 'INR' }); // ₹1,560.00 across both
    expect(typeof body.asAt).toBe('string');                             // stamped, so staleness is visible
  });

  it('reports nothing lost when the shelf was never empty', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'so-0',
      body: { products: [{ productId: 'milk', daysOutOfStock: 0, periodDays: 30, averageDailyUnits: 40, marginPerUnit: { minor: 500, currency: 'INR' } }] },
    });
    expect(res.status).toBe(200);
    const body = res.body as { totalLostMargin: { minor: number }; rows: { outOfStockBp: number }[] };
    expect(body.totalLostMargin.minor).toBe(0);
    expect(body.rows[0]?.outOfStockBp).toBe(0);
  });

  it('refuses an unreadable analysis — days out of stock cannot exceed the period', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'so-bad',
      body: { products: [{ productId: 'milk', daysOutOfStock: 40, periodDays: 30, averageDailyUnits: 40, marginPerUnit: { minor: 500, currency: 'INR' } }] },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_stockout_analysis');
  });

  it('refuses a margin in a currency other than the one it is asked to report in — a mixed-currency sum would be a lie', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'so-cur',
      body: {
        currency: 'INR',
        products: [{ productId: 'milk', daysOutOfStock: 6, periodDays: 30, averageDailyUnits: 40, marginPerUnit: { minor: 500, currency: 'USD' } }],
      },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_stockout_analysis');
  });

  it('is closed to a caller without the inventory read permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-nobody', tenantId: TENANT, idempotencyKey: 'so-403',
      body: { products: [] },
    });
    expect(res.status).toBe(403);
  });
});
