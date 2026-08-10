import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Roadmap v2.1 B3 — the unit sale price a label must show (Legal Metrology), on the live API.
// GET /v1/catalogue/unit-price computes ₹ per kg/l/piece from MRP + net quantity, gated on the same
// catalogue read the label is printed from (owner / manager / cashier), not a finance permission.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const unitPrice = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/catalogue/unit-price', userId, tenantId: A, query: q });

interface UnitPrice { unitPriceMinor: number; per: string; exempt: boolean; exemptReason?: string }

describe('GET /v1/catalogue/unit-price — unit sale price on the label (B3)', () => {
  it('computes ₹/kg from a gram pack over the real pipeline', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const r = (await unitPrice(h, 'u-owner', { mrpMinor: '10000', netQuantity: '500', unit: 'g' })).body as UnitPrice;
    expect(r.per).toBe('kg');
    expect(r.unitPriceMinor).toBe(20000); // ₹200/kg
    expect(r.exempt).toBe(false);
  });

  it('flags the low-value exemption but still returns the figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const r = (await unitPrice(h, 'u-owner', { mrpMinor: '3000', netQuantity: '100', unit: 'g' })).body as UnitPrice; // ₹30 ≤ ₹35
    expect(r.exempt).toBe(true);
    expect(r.unitPriceMinor).toBeGreaterThan(0);
  });

  it('is readable by the catalogue roles (owner/manager/cashier) and refused to the accountant', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await h.provisionRole(A, 'u-acct', 'accountant'); // no catalogue.pack.read

    const q = { mrpMinor: '10000', netQuantity: '500', unit: 'g' };
    for (const u of ['u-owner', 'u-mgr', 'u-cash']) {
      expect((await unitPrice(h, u, q)).status).toBe(200);
    }
    expect((await unitPrice(h, 'u-acct', q)).status).toBe(403);
  });

  it('refuses missing/invalid figures and an unknown unit', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await unitPrice(h, 'u-owner', { netQuantity: '500', unit: 'g' })).status).toBe(400); // no mrp
    expect((await unitPrice(h, 'u-owner', { mrpMinor: '10000', netQuantity: '500', unit: 'dozen' })).status).toBe(400); // bad unit
    expect((await unitPrice(h, 'u-owner', { mrpMinor: '10000', netQuantity: '0', unit: 'g' })).status).toBe(400); // zero qty
  });
});
