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

const labelHeight = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/catalogue/label-height', userId, tenantId: A, query: q });

describe('GET /v1/catalogue/label-height — statutory character heights (B24)', () => {
  it('returns the Rule 9 minimum, validates a template, and gates on the catalogue read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // no catalogue.pack.read

    // 300 cm² panel → 2 mm minimum; 2.5 mm passes, 1.5 mm fails.
    const ok = (await labelHeight(h, 'u-owner', { principalPanelAreaCm2: '300', declaredHeightMm: '2.5' })).body as { valid: boolean; minHeightMm: number };
    expect(ok.valid).toBe(true);
    expect(ok.minHeightMm).toBe(2);
    expect(((await labelHeight(h, 'u-owner', { principalPanelAreaCm2: '300', declaredHeightMm: '1.5' })).body as { valid: boolean }).valid).toBe(false);

    // Refuses missing figures; the accountant (no catalogue.pack.read) is refused.
    expect((await labelHeight(h, 'u-owner', { principalPanelAreaCm2: '300' })).status).toBe(400);
    expect((await labelHeight(h, 'u-acct', { principalPanelAreaCm2: '300', declaredHeightMm: '2.5' })).status).toBe(403);
  });
});

const looseFood = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/catalogue/loose-food-label', userId, tenantId: A, query: q });

describe('GET /v1/catalogue/loose-food-label — FSSAI allergen + veg mark (B9)', () => {
  it('validates the mandatory declarations over the real pipeline and gates on the catalogue read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // no catalogue.pack.read

    // Complete → valid.
    expect(((await looseFood(h, 'u-owner', { vegClass: 'non_veg', allergenDeclarationProvided: 'true', allergensPresent: 'milk,eggs' })).body as { valid: boolean }).valid).toBe(true);
    // No veg mark → blocked.
    const noVeg = (await looseFood(h, 'u-owner', { allergenDeclarationProvided: 'true' })).body as { valid: boolean; problems: string[] };
    expect(noVeg.valid).toBe(false);
    expect(noVeg.problems.some((p) => p.startsWith('vegMark'))).toBe(true);
    // No allergen declaration → blocked.
    expect(((await looseFood(h, 'u-owner', { vegClass: 'veg' })).body as { valid: boolean }).valid).toBe(false);

    // The accountant is refused.
    expect((await looseFood(h, 'u-acct', { vegClass: 'veg', allergenDeclarationProvided: 'true' })).status).toBe(403);
  });
});
