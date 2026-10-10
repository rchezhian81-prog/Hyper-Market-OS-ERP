import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { planLoad, executeLoad, type ExtractBundle, type LoadRequest, type LoadPlanOk } from '../../packages/migration/src/index';

// MG-05 — the ACTUAL load, end to end through the real API: a checked extract goes into a named, empty,
// non-demo tenant through the same routes a person uses on the screens (never table writes), as a named
// operator, and lands as products, barcodes, prices, a supplier, customers with points, and one opening
// goods receipt that IS the opening stock ledger. Re-running the same load is one load (idempotency on
// load-scoped keys), a route's refusal is a visible line, and the demo tenant is refused by id.

const REAL = 'ab000000-0000-4000-8000-000000000042';
const DEMO = 'de300000-0000-4000-8000-000000000001';
const OPERATOR = 'u-chezhian';

const bundle: ExtractBundle = {
  categories: [
    { categoryId: 'grocery', name: 'Grocery', parentId: null },
    { categoryId: 'staples', name: 'Staples', parentId: 'grocery', regulated: ['food'] },
    { categoryId: 'home', name: 'Home care', parentId: null },
  ],
  taxRates: [
    { hsnCode: '1006', effectiveFrom: '2017-07-01', rateBps: 500 },
    { hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 },
  ],
  products: [
    {
      productId: 'P-RICE', sku: 'RICE-5KG', name: 'Ponni raw rice 5 kg', baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006',
      lifecycle: 'active', safety: { allergens: [], countryOfOrigin: 'IN' },
      barcodes: [{ code: '8901234567890', kind: 'ean' }], priceMinor: 42_000, mrpMinor: 45_000, costMinor: 36_000, marginFloorBps: 0,
    },
    {
      productId: 'P-SOAP', sku: 'SOAP-1', name: 'Dish wash bar', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402',
      lifecycle: 'active', barcodes: [{ code: '8901234567891', kind: 'ean' }, { code: 'INT-77', kind: 'internal' }],
      priceMinor: 2_500, mrpMinor: 2_500, costMinor: 1_800, marginFloorBps: 500,
    },
  ],
  suppliers: [{ partnerId: 'SUP-1', name: 'Kaveri Traders', gstin: '33AAAAA0000A1Z9' }],
  customers: [{ customerId: 'C-1', loyaltyPoints: 120 }, { customerId: 'C-2' }],
  openingStock: [
    { productId: 'P-RICE', quantityMinor: 40, uom: 'each', unitCostMinor: 36_000, batchId: 'B1', expiry: '2027-03-31' },
    { productId: 'P-SOAP', quantityMinor: 200, uom: 'each', unitCostMinor: 1_800 },
  ],
};

const request = (overrides: Partial<LoadRequest> = {}): LoadRequest => ({
  target: { targetId: 'rehearsal-1', tenantId: REAL, kind: 'rehearsal', label: 'rehearsal tenant' },
  tenantId: REAL, demoTenantIds: [DEMO], operator: OPERATOR, targetProductCount: 0, extractSealed: true,
  blockingExceptionsOpen: 0, loadId: 'load-2026-10-01', stockLocationId: 'STORE-MAIN', receivedOnDate: '2026-10-01', currency: 'INR',
  ...overrides,
});

const plan = (b: ExtractBundle = bundle, r: LoadRequest = request()): LoadPlanOk => {
  const p = planLoad(b, r);
  if (!p.ok) throw new Error(`${p.refusedBecause}: ${p.detail} ${p.problems.join('; ')}`);
  return p;
};

interface Availability { productId: string; locationId: string; onHandMinor: number }
interface Valuation { productId: string; onHandMinor: number; value: { minor: number } }

describe('MG-05 actual load — a checked extract lands in an empty real tenant through the real routes', () => {
  it('loads everything as the named operator, and every truth reads back through the API', async () => {
    const h = apiHarness();
    await h.seedOwner(REAL, OPERATOR);
    const report = await executeLoad(h, plan());
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.landed).toEqual({ tax: 2, product: 2, barcode: 3, price: 2, supplier: 1, customer: 3, stock: 1 });

    const products = await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OPERATOR, tenantId: REAL });
    expect(products.status).toBe(200);
    expect(((products.body as { products: { productId: string; lifecycle: string }[] }).products).map((p) => p.productId).sort()).toEqual(['P-RICE', 'P-SOAP']);

    const barcode = await h.request({ method: 'GET', path: '/v1/catalogue/barcodes/INT-77', userId: OPERATOR, tenantId: REAL });
    expect(barcode.status).toBe(200);
    expect(barcode.body).toMatchObject({ barcode: { productId: 'P-SOAP', kind: 'internal' } });

    const rate = await h.request({ method: 'GET', path: '/v1/catalogue/tax-classes/1006/rate', userId: OPERATOR, tenantId: REAL, query: { on: '2026-10-01' } });
    expect(rate.status).toBe(200);
    expect(rate.body).toMatchObject({ rate: { rateBps: 500 } });

    const grn = await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/opening-load-2026-10-01', userId: OPERATOR, tenantId: REAL });
    expect(grn.status).toBe(200);
    expect(grn.body).toMatchObject({ grn: { warehouseId: 'STORE-MAIN', receivedBy: OPERATOR, availableMinor: 240 } });

    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: Availability[] };
    expect(avail.rows.map((r) => [r.productId, r.locationId, r.onHandMinor]).sort()).toEqual([['P-RICE', 'STORE-MAIN', 40], ['P-SOAP', 'STORE-MAIN', 200]]);

    // Opening stock is VALUED at the extract's cost — the opening books can be reconciled against it (MG-06).
    const valuation = (await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: OPERATOR, tenantId: REAL })).body as { rows: Valuation[] };
    expect(valuation.rows.map((r) => [r.productId, r.value.minor]).sort()).toEqual([['P-RICE', 40 * 36_000], ['P-SOAP', 200 * 1_800]]);

    const points = await h.request({ method: 'GET', path: '/v1/customers/C-1/points', userId: OPERATOR, tenantId: REAL });
    expect(points.status).toBe(200);
    expect(points.body).toMatchObject({ pointsBalance: 120 });

    const consent = await h.request({ method: 'GET', path: '/v1/customers/C-2/consent', userId: OPERATOR, tenantId: REAL });
    expect((consent.body as { records: { purpose: string; given: boolean }[] }).records).toEqual([expect.objectContaining({ purpose: 'marketing', given: false })]);

    // GT-06: the supplier reads back through the SUPPLIER MASTER with its name and GSTIN — proposed, awaiting a second
    // person's approval (§28) — and is the supplier a purchase order then names.
    const supplier = await h.request({ method: 'GET', path: '/v1/purchase/suppliers/SUP-1', userId: OPERATOR, tenantId: REAL });
    expect(supplier.status).toBe(200);
    expect(supplier.body).toMatchObject({ supplier: { supplierId: 'SUP-1', name: 'Kaveri Traders', gstin: '33AAAAA0000A1Z9', status: 'proposed', createdBy: OPERATOR } });
    const po = await h.request({ method: 'POST', path: '/v1/purchase/orders/PO-MIG-1', userId: OPERATOR, tenantId: REAL, idempotencyKey: 'po-mig-1', body: { supplierId: 'SUP-1', lines: [{ productId: 'P-RICE', orderedQty: 10, unitCost: { minor: 36_000, currency: 'INR' } }] } });
    expect(po.status).toBe(201);
    const list = (await h.request({ method: 'GET', path: '/v1/purchase/suppliers', userId: OPERATOR, tenantId: REAL })).body as { suppliers: { supplierId: string; name: string | null; status: string }[] };
    expect(list.suppliers).toEqual([expect.objectContaining({ supplierId: 'SUP-1', name: 'Kaveri Traders', status: 'proposed' })]);
  });

  it('re-running the same load is ONE load: nothing doubles (idempotent keys, never-double-count receipt)', async () => {
    const h = apiHarness();
    await h.seedOwner(REAL, OPERATOR);
    const first = await executeLoad(h, plan());
    expect(first.ok).toBe(true);
    const again = await executeLoad(h, plan());
    expect(again.ok).toBe(true);
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: Availability[] };
    expect(avail.rows.map((r) => r.onHandMinor).sort((a, b) => a - b)).toEqual([40, 200]);
    const points = await h.request({ method: 'GET', path: '/v1/customers/C-1/points', userId: OPERATOR, tenantId: REAL });
    expect(points.body).toMatchObject({ pointsBalance: 120 });
    const products = (await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OPERATOR, tenantId: REAL })).body as { products: unknown[] };
    expect(products.products).toHaveLength(2);
    // GT-06: a rerun leaves ONE supplier, at its first version.
    const suppliers = (await h.request({ method: 'GET', path: '/v1/purchase/suppliers', userId: OPERATOR, tenantId: REAL })).body as { suppliers: { supplierId: string }[] };
    expect(suppliers.suppliers.map((s) => s.supplierId)).toEqual(['SUP-1']);
    expect((await h.request({ method: 'GET', path: '/v1/purchase/suppliers/SUP-1', userId: OPERATOR, tenantId: REAL })).body).toMatchObject({ supplier: { version: 1 } });
  });

  it('a route\'s own refusal (a price below cost with no approver) is a visible failed line; the rest still land', async () => {
    const h = apiHarness();
    await h.seedOwner(REAL, OPERATOR);
    const belowCost: ExtractBundle = { ...bundle, products: [bundle.products[0]!, { ...bundle.products[1]!, priceMinor: 1_000 }] };
    const report = await executeLoad(h, plan(belowCost));
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual({ tax: 0, product: 0, barcode: 0, price: 1, supplier: 0, customer: 0, stock: 0 });
    const failed = report.steps.find((s) => !s.ok)!;
    expect(failed).toMatchObject({ group: 'price', what: 'price P-SOAP', status: 422 });
    expect(failed.detail).toMatch(/price_below_cost/);
    // Everything else landed — the operator works the one line, not the whole file.
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: Availability[] };
    expect(avail.rows).toHaveLength(2);
  });

  it('a person without the permissions cannot run a load — master-data steps are refused 403 and no catalogue or stock lands', async () => {
    const h = apiHarness();
    await h.seedOwner(REAL, OPERATOR);
    await h.provisionRole(REAL, 'u-cashier', 'cashier');
    const report = await executeLoad(h, { ...plan(), operator: 'u-cashier' });
    expect(report.ok).toBe(false);
    // A cashier may earn a customer's points (their till job) — every OTHER step is a permission refusal.
    const refused = report.steps.filter((s) => !s.what.startsWith('customer points'));
    expect(refused.length).toBeGreaterThan(10);
    expect(refused.every((s) => s.status === 403)).toBe(true);
    const products = (await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OPERATOR, tenantId: REAL })).body as { products: unknown[] };
    expect(products.products).toHaveLength(0);
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: unknown[] };
    expect(avail.rows).toEqual([]);
  });

  it('the demo tenant is refused BEFORE any call is made (gate G4)', async () => {
    const refused = planLoad(bundle, request({ tenantId: DEMO, target: { targetId: 'demo', tenantId: DEMO, kind: 'rehearsal', label: 'pilot-demo' } }));
    expect(refused).toMatchObject({ ok: false, refusedBecause: 'demo_tenant' });
  });

  it('a second real tenant is fully isolated from the first (P-02 one truth per business, hard rule: tenant isolation)', async () => {
    const h = apiHarness();
    const OTHER = 'cd000000-0000-4000-8000-000000000077';
    await h.seedOwner(REAL, OPERATOR);
    await h.seedOwner(OTHER, 'u-other');
    expect((await executeLoad(h, plan())).ok).toBe(true);
    const other = (await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: 'u-other', tenantId: OTHER })).body as { products: unknown[] };
    expect(other.products).toHaveLength(0);
    const otherStock = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-other', tenantId: OTHER })).body as { rows: unknown[] };
    expect(otherStock.rows).toEqual([]);
  });
});
