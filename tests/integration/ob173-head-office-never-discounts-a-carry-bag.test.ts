import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **OB-173 "A" (owner, 17 Oct 2026, "Never discount bags") · B19 at head office — on the in-memory store and on PostgreSQL.**
 *
 *   • Head office's own price check (`POST /v1/promotions/evaluate`) never lets an offer reach a carry bag: which line is a
 *     bag is the PRODUCT MASTER's word, never the body's; a basket-wide 10% leaves the bag at its ₹5 and is spread over the
 *     other lines exactly.
 *   • A sale that reaches head office with a carry bag charged below its list price (an old till, a hand-edited record) is
 *     banked — the goods are gone, hard rule #1 — and raised CRITICAL `unlawful_plastic_sold`; the owner's clean 10% basket
 *     raises nothing.
 *   • F1 kept: an offer that names a bag is still refused when it is defined.
 * Synthetic data only (hard rule #7).
 */

const backings = useBackings();
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: null };
const SNAPSHOT = (tenantId: string): CatalogueSnapshot => ({
  tenantId, version: 1, builtAt: NOW, scope: { tenantId, storeId: 'S1' },
  products: [
    { productId: 'p-rice', sku: 'RICE1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 500, status: 'active' },
    { productId: 'p-bag', sku: 'BAG120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
  ],
  barcodes: [],
});
interface Banked { banked: boolean; exceptions: { kind: string; severity: string; productId?: string; detail: string }[] }

describe.each(backings)('OB-173 — head office never discounts a carry bag — on $name', ({ harness }) => {
  async function headOffice() {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner') =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: NOW, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue', payload: { snapshot: SNAPSHOT(T) },
    }));
    const product = (sku: string, safety: Record<string, unknown>) => ({ sku, name: sku, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '63053300', lifecycle: 'draft', safety });
    const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
    expect((await call('POST', '/v1/catalogue/products/p-bag/publish', { product: product('BAG120', { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 }), categories: [GROCERY] })).status).toBe(201);
    expect((await call('POST', '/v1/catalogue/products/p-rice/publish', { product: product('RICE1', {}), categories: [GROCERY] })).status).toBe(201);
    return { call };
  }

  it('the price check: a basket-wide 10% leaves the bag at ₹5 (the master says it is a bag), spread exactly over the rice; an offer naming the bag is still refused', async () => {
    const { call } = await headOffice();
    const defined = await call('POST', '/v1/promotions/PR-TEN/definition', { kind: 'percent_off', startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', percentBps: 1_000 });
    expect(defined.status, JSON.stringify(defined.body)).toBe(201);
    // Switched on by its governed launch (SF-01: the margin check; a margin-positive offer needs no second person).
    const launch = await call('POST', '/v1/promotions/PR-TEN/launch', { description: 'offer', normalPrice: { minor: 10_000, currency: 'INR' }, promoPrice: { minor: 9_000, currency: 'INR' }, unitCost: { minor: 5_000, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 });
    expect(launch.status, JSON.stringify(launch.body)).toBe(201);
    const quote = await call('POST', '/v1/promotions/evaluate', {
      at: NOW, currency: 'INR',
      // The body does not say which line is a bag: head office's product master does.
      lines: [
        { lineId: 'L1', productId: 'p-rice', unitPrice: { minor: 70_00, currency: 'INR' }, qty: 3 },
        { lineId: 'L2', productId: 'p-bag', unitPrice: { minor: 5_00, currency: 'INR' }, qty: 1 },
      ],
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const body = quote.body as { discount: { minor: number }; netTotal: { minor: number }; perLine: { lineId: string; discountMinor: number }[] };
    expect(body.perLine).toEqual([{ lineId: 'L1', discountMinor: 21_00 }, { lineId: 'L2', discountMinor: 0 }]);
    expect(body.netTotal.minor).toBe(194_00);
    const bagOffer = await call('POST', '/v1/promotions/PR-BAG/definition', { kind: 'amount_off', startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', amountOffMinor: 1_00, productIds: ['p-bag'] });
    expect(bagOffer.body).toMatchObject({ error: { code: 'promotion_targets_a_carry_bag' } });
  });

  it('a sale with the bag charged below its list price is banked and raised CRITICAL `unlawful_plastic_sold`; the clean 10% basket raises nothing', async () => {
    const { call } = await headOffice();
    const sale = (lines: Record<string, unknown>[]) => {
      const total = lines.reduce((n, l) => n + (l['lineTotalMinor'] as number), 0);
      return {
        saleId: `S-${randomUUID()}`, receiptNumber: `R-${randomUUID().slice(0, 8)}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: day(0), committedAt: NOW,
        totalMinor: total, currency: 'INR', packVersion: 1, locationId: 'S1', lines, tenders: [{ kind: 'cash', amountMinor: total }],
      };
    };
    const bad = await call('POST', '/v1/sales', sale([
      { productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 63_00, taxRateBps: 500 },
      { productId: 'p-bag', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 4_50, taxRateBps: 1800 },
    ]), 'u-box');
    expect(bad.status, JSON.stringify(bad.body)).toBeLessThan(300);
    const found = (bad.body as Banked).exceptions.filter((x) => x.kind === 'unlawful_plastic_sold');
    expect((bad.body as Banked).banked).toBe(true);
    expect(found.map((x) => [x.severity, x.productId])).toEqual([['critical', 'p-bag']]);
    expect(found[0]!.detail).toMatch(/never discounted/);
    const good = await call('POST', '/v1/sales', sale([
      { productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 63_00, taxRateBps: 500 },
      { productId: 'p-bag', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 5_00, taxRateBps: 1800 },
    ]), 'u-box');
    expect((good.body as Banked).exceptions.filter((x) => x.kind === 'unlawful_plastic_sold')).toEqual([]);
  });
});
