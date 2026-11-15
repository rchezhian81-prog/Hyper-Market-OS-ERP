import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Daily-work defects (15 Nov 2026), head office's side, through the real API pipeline (in memory):
//   D-016 — the stock exceptions read names each negative item and the unit its quantity is counted in, so the Stock health
//           page can say "Marie biscuits −4 pieces" and "Loose rice −1.25 kg" (OB-31) instead of a code and 1/100th;
//   D-044 — a supplier bill whose lines do not add up is refused in RUPEES ("₹90.00 … ₹95.00"), never in paise.

const T = randomUUID();
const AT = '2026-11-15T09:00:00.000Z';
const ok = async (p: Promise<{ status: number; body: unknown }>, what: string): Promise<void> => {
  const r = await p;
  expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
};
const owner = (h: ApiHarness, method: 'GET' | 'POST', path: string, body?: unknown) =>
  h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
const product = (name: string, baseUom: string) => ({ sku: name.toUpperCase().replace(/\W+/g, '-'), name, baseUom, primaryCategoryId: 'grocery', taxClass: '19053100', lifecycle: 'active', mrpHistory: [{ value: { minor: 3_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] });

describe('D-016: head office names each negative item and its unit', () => {
  it('a sold-before-received biscuit (−4, pieces) and loose rice (−1.250 kg, in grams) come back with name and unit', async () => {
    const h = apiHarness();
    await h.seedOwner(T, 'u-owner');
    await ok(owner(h, 'POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
    await ok(owner(h, 'POST', '/v1/catalogue/tax-classes/19053100/rates/2017-07-01', { rateBps: 1800 }), 'tax rate');
    await ok(owner(h, 'POST', '/v1/catalogue/products/BISC/publish', { product: product('Marie biscuits 200 g', 'ea') }), 'biscuits');
    await ok(owner(h, 'POST', '/v1/catalogue/products/RICE/publish', { product: product('Loose ponni rice', 'kg') }), 'rice');
    await ok(owner(h, 'POST', '/v1/inventory/movements', { movementId: 'sale-b', productId: 'BISC', locationId: 'S1', kind: 'sold', quantityMinor: 4, uom: 'ea', occurredAt: AT, enteredBy: 'u-till' }), 'biscuits sold');
    await ok(owner(h, 'POST', '/v1/inventory/movements', { movementId: 'sale-r', productId: 'RICE', locationId: 'S1', kind: 'sold', quantityMinor: 1250, uom: 'kg', occurredAt: AT, enteredBy: 'u-till' }), 'rice sold');

    const res = await owner(h, 'GET', '/v1/inventory/exceptions');
    expect(res.status).toBe(200);
    const negative = (res.body as { negative: { productId: string; onHandMinor: number; name?: string; uom?: string }[] }).negative;
    expect(negative).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'BISC', onHandMinor: -4, name: 'Marie biscuits 200 g', uom: 'ea' }),
      expect.objectContaining({ productId: 'RICE', onHandMinor: -1250, name: 'Loose ponni rice', uom: 'kg' }),
    ]));
  });
});
