import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { productMasterAdapter } from '../../services/api/src/adapters';

/**
 * **B18 · OB-310 ("sell no medicines; category stays blocked") — like the liquor rule, through the real routes**, on the
 * in-memory store and (with DATABASE_URL) real PostgreSQL, each with a cold restart:
 *   • PUBLISH: a medicine is refused by name (`medicine_not_sold`) by its mark, its `drug` (pharmacy) category or its HSN
 *     3003/3004 — and nothing is kept. A bandage (HSN 3005) is not a medicine and publishes;
 *   • PACK: a medicine kept from before the rule is left out of every pack, and said;
 *   • HEAD OFFICE'S INTAKE: a bill that reached head office with a medicine on it (an old till) is banked — it happened —
 *     and raised critical (`medicine_sold`), judged by the HSN the till froze on the line (a medicine never reaches a pack).
 * The till's own refusal (offline, from the pack and the line) is proved in the unit test of the same name.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const HOME = { categoryId: 'home', name: 'Home care', parentId: null };
const PHARMACY = { categoryId: 'pharmacy', name: 'Pharmacy', parentId: null, regulated: ['drug'] };

const post = (h: ApiHarness, T: string, path: string, body: unknown, userId = 'u-owner') =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, path: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path, userId: 'u-owner', tenantId: T, query });
const publish = (h: ApiHarness, T: string, productId: string, product: Record<string, unknown>, categories: unknown[] = [HOME]) =>
  post(h, T, `/v1/catalogue/products/${productId}/publish`, { product: { baseUom: 'each', lifecycle: 'active', taxClass: '3401', primaryCategoryId: 'home', sku: `SKU-${productId}`, name: productId, ...product }, categories });

const bill = (saleId: string, lines: readonly Record<string, unknown>[], totalMinor: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor, currency: 'INR', packVersion: 1, lines, tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});

describe.each(backings)('B18 · OB-310: a medicine is refused at publish, left out of the pack, and raised at head office — on $name', ({ harness }) => {
  it('publish: refused by its mark, its pharmacy category or HSN 3003/3004 — nothing kept; a bandage (3005) publishes', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const cases: [string, Record<string, unknown>, unknown[]][] = [
      ['its mark', { safety: { medicine: true } }, [HOME]],
      ['its category', { primaryCategoryId: 'pharmacy' }, [HOME, PHARMACY]],
      ['HSN 3004', { taxClass: '30049099' }, [HOME]],
      ['HSN 3003', { taxClass: '3003.90' }, [HOME]],
    ];
    for (const [why, product, cats] of cases) {
      const res = await publish(h, T, `p-med-${why.replace(/\W/g, '')}`, { name: 'Paracetamol 500mg', ...product }, cats);
      expect(res.status, why).toBe(422);
      expect(codeOf(res), why).toBe('medicine_not_sold');
      expect((res.body as { error: { whatHappened: string } }).error.whatHappened, why).toMatch(/OB-310/);
    }
    expect((await publish(h, T, 'p-bandage', { name: 'Crepe bandage', taxClass: '30059040' })).status).toBe(201);
    const again = harness(h); // ── COLD RESTART ──
    for (const [why] of cases) expect((await get(again, T, `/v1/catalogue/products/p-med-${why.replace(/\W/g, '')}`)).status, why).toBe(404);
    expect((await get(again, T, '/v1/catalogue/products/p-bandage')).status).toBe(200);
  }, 120_000);

  it('pack: a medicine kept from before the rule is left out of every pack, and said', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    // Written straight to the master, as a product published before the medicine rule existed would be.
    await productMasterAdapter({ store: h.store, now: () => new Date().toISOString() }).publish(T, {
      productId: 'p-para', tenantId: T, sku: 'SKU-PARA', name: 'Paracetamol 500mg', baseUom: 'each', primaryCategoryId: 'home', taxClass: '30049099', lifecycle: 'active',
    }, 'legacy');
    expect((await publish(h, T, 'soap', {})).status).toBe(201);
    const preview = await get(harness(h), T, '/v1/catalogue/pack/preview', { storeId: 'store-1' });
    expect(preview.status).toBe(200);
    const body = preview.body as { notSold: { productId: string; reason: string; detail: string }[]; snapshot: { products: { productId: string }[] } };
    expect(body.notSold).toEqual([{ productId: 'p-para', sku: 'SKU-PARA', reason: 'medicine_not_sold', detail: expect.stringMatching(/30049099/) }]);
    expect(body.snapshot.products.some((p) => p.productId === 'p-para')).toBe(false);
  }, 120_000);

  it('head office: a bill with a medicine on it is banked and raised critical, from the HSN the till froze on the line', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await productMasterAdapter({ store: h.store, now: () => new Date().toISOString() }).publish(T, {
      productId: 'p-para', tenantId: T, sku: 'SKU-PARA', name: 'Paracetamol 500mg', baseUom: 'each', primaryCategoryId: 'home', taxClass: '30049099', lifecycle: 'active',
    }, 'legacy');
    const again = harness(h); // ── COLD RESTART ──
    const finding = async (saleId: string, line: Record<string, unknown>) => {
      const sold = await post(again, T, '/v1/sales', bill(saleId, [{ quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 3_000, ...line }], 3_000));
      expect(sold.status, JSON.stringify(sold.body)).toBeLessThan(300);
      return (sold.body as { exceptions: { kind: string; severity: string; detail: string }[] }).exceptions.find((e) => e.kind === 'medicine_sold');
    };
    // Never in a pack, so head office's intake judges the HSN the till froze on the line (an old till, an old pack).
    const held = await finding('S-MED-1', { productId: 'p-para', hsnCode: '30049099' });
    expect(held).toMatchObject({ severity: 'critical' });
    expect(held!.detail).toMatch(/OB-310/);
    const unknown = await finding('S-MED-2', { productId: 'p-cough', hsnCode: '3004' });
    expect(unknown).toMatchObject({ severity: 'critical' });
    // A bandage line is not a medicine.
    expect(await finding('S-MED-3', { productId: 'p-gauze', hsnCode: '3005' })).toBeUndefined();
  }, 120_000);
});
