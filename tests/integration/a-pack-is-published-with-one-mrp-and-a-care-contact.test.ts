import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';

/**
 * **Round 6 · B2 · B4 (roadmap v2.1 addendum, M03) — the real publish path, not the stateless check routes.**
 *
 *   B2  a pack carries ONE active MRP: a second, different MRP taking effect on a date that already has one is REJECTED at
 *       master-data commit (`dual_mrp_rejected`, 422) — whether it arrives beside the first in one record, or alone after
 *       the first was stored (head office judges its OWN stored history with the new one; a cold restart in between). A
 *       later-dated MRP is a normal price move and is published.
 *   B4  a packed product is not published without its consumer-care contact (nor, for a packed non-food, its country of
 *       origin) — `product_not_publishable`, named. (The manufacture date is an open owner decision: not judged here.)
 * On the in-memory store and on real PostgreSQL. Synthetic data only.
 */

const A = randomUUID(); // a fresh shop per run — the PostgreSQL database outlives the run
const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const CARE = 'Synthetic Care Desk, 1800-000-0000';
const inr = (minor: number) => ({ minor, currency: 'INR' });
const DETERGENT = {
  sku: 'SKU-DET-1', name: 'Synthetic detergent 1kg', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'draft',
  safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers, Chennai', countryOfOrigin: 'India', consumerCareContact: CARE },
};
const backings = r3OpsBackings();

describe.each(backings)('a pack is published with one MRP and its consumer-care contact — on $name (B2 · B4)', ({ harness, restart }) => {
  it('refuses a missing care contact and a second MRP on one date, by name; a later MRP passes; head office judges its own stored history after a restart', async () => {
    let h: ApiHarness = harness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const { req, code } = tenantClient(() => h, A);
    const publish = (productId: string, product: unknown, userId = 'u-owner') => req('POST', `/v1/catalogue/products/${productId}/publish`, { product, categories: [PACKED] }, userId);

    // B4: no consumer-care contact — refused, nothing stored.
    const noCare = { ...DETERGENT.safety, consumerCareContact: undefined };
    const refusedCare = await publish('p-det', { ...DETERGENT, safety: noCare });
    expect(refusedCare.status).toBe(422);
    expect(code(refusedCare)).toBe('product_not_publishable');
    expect(JSON.stringify(refusedCare.body)).toContain('no consumer-care contact');
    // B4: a packed non-food with no country of origin — refused too.
    const noOrigin = { ...DETERGENT.safety, countryOfOrigin: undefined };
    expect(JSON.stringify((await publish('p-det', { ...DETERGENT, safety: noOrigin })).body)).toContain('no country of origin');
    expect((await req('GET', '/v1/catalogue/products/p-det')).status).toBe(404);

    // B2: two different MRPs from the same date in one record — refused by name.
    const twoInOne = await publish('p-det', { ...DETERGENT, mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-11-01' }, { value: inr(125_00), effectiveFrom: '2026-11-01' }] });
    expect(twoInOne.status).toBe(422);
    expect(code(twoInOne)).toBe('dual_mrp_rejected');
    expect(JSON.stringify(twoInOne.body)).toContain('₹120.00 and ₹125.00');

    // A cashier may not publish at all.
    expect((await publish('p-det', DETERGENT, 'u-cash')).status).toBe(403);

    // The complete pack, one MRP — published.
    expect((await publish('p-det', { ...DETERGENT, mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-11-01' }] })).status).toBe(201);

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────────────

    // The stored MRP is judged with the new one: a different MRP for 2026-11-01 sent ALONE is still a second MRP.
    const swapped = await publish('p-det', { ...DETERGENT, mrpHistory: [{ value: inr(130_00), effectiveFrom: '2026-11-01' }] });
    expect(swapped.status).toBe(422);
    expect(code(swapped)).toBe('dual_mrp_rejected');
    const kept = (await req('GET', '/v1/catalogue/products/p-det')).body as { product: { mrpHistory: { value: { minor: number }; effectiveFrom: string }[] } };
    expect(kept.product.mrpHistory).toEqual([{ value: inr(120_00), effectiveFrom: '2026-11-01' }]);

    // A later-dated MRP is a normal price move — published, the history kept whole.
    const moved = await publish('p-det', { ...DETERGENT, mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-11-01' }, { value: inr(130_00), effectiveFrom: '2027-01-01' }] });
    expect(moved.status).toBe(201);
    const after = (await req('GET', '/v1/catalogue/products/p-det')).body as { product: { mrpHistory: unknown[]; safety: { consumerCareContact: string } } };
    expect(after.product.mrpHistory).toHaveLength(2);
    expect(after.product.safety.consumerCareContact).toBe(CARE);
  });
});
