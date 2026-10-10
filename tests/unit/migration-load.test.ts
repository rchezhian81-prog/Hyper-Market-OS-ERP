import { describe, it, expect } from 'vitest';
import {
  planLoad, validateBundle, executeLoad, bundleFromFiles, moneyToMinor, percentToBps, quantityToMinor, inferBarcodeKind,
  type ExtractBundle, type LoadRequest, type LoadPlanOk, type LoadClient,
} from '../../packages/migration/src/index';

// MG-05 — the actual load, planned as an ordered list of idempotent route calls behind the guards
// (hard rule #7, gate G4, MG-02, MG-04, an empty prepared target, a named operator). Pure, so every
// refusal and every step is provable without I/O.

const DEMO = 'de300000-0000-4000-8000-000000000001';
const REAL = 'ab000000-0000-4000-8000-000000000042';

const bundle: ExtractBundle = {
  categories: [
    { categoryId: 'grocery', name: 'Grocery', parentId: null },
    { categoryId: 'staples', name: 'Staples', parentId: 'grocery', regulated: ['food', 'packed'] },
    { categoryId: 'home', name: 'Home care', parentId: null },
  ],
  taxRates: [
    { hsnCode: '1006', effectiveFrom: '2017-07-01', rateBps: 500 },
    { hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 },
  ],
  products: [
    {
      productId: 'P-RICE', sku: 'RICE-5KG', name: 'Ponni raw rice 5 kg', baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006',
      lifecycle: 'active', brand: 'SRE', safety: { allergens: [], countryOfOrigin: 'IN', netQuantity: '5 kg', packerDetails: 'SRE Hyper Market, Tamil Nadu' },
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

const req: LoadRequest = {
  target: { targetId: 'rehearsal-1', tenantId: REAL, kind: 'rehearsal', label: 'rehearsal tenant' },
  tenantId: REAL, demoTenantIds: [DEMO], operator: 'u-chezhian', targetProductCount: 0, extractSealed: true,
  blockingExceptionsOpen: 0, loadId: 'load-2026-10-01', stockLocationId: 'STORE-MAIN', receivedOnDate: '2026-10-01', currency: 'INR',
};

const okPlan = (r: LoadRequest = req, b: ExtractBundle = bundle): LoadPlanOk => {
  const plan = planLoad(b, r);
  if (!plan.ok) throw new Error(`expected a plan, got ${plan.refusedBecause}: ${plan.detail} ${plan.problems.join('; ')}`);
  return plan;
};

describe('planLoad — the guards (each refusal is its own reason, so the operator fixes exactly one thing)', () => {
  it('refuses a production target whatever its label says (hard rule #7)', () => {
    const plan = planLoad(bundle, { ...req, target: { ...req.target, kind: 'production', label: 'rehearsal (honest, we promise)' } });
    expect(plan).toMatchObject({ ok: false, refusedBecause: 'production_target' });
  });
  it('refuses the demo tenant by id (gate G4: demo and real data never mix)', () => {
    const plan = planLoad(bundle, { ...req, tenantId: DEMO, target: { ...req.target, tenantId: DEMO } });
    expect(plan).toMatchObject({ ok: false, refusedBecause: 'demo_tenant' });
  });
  it('refuses a tenant that is not the target\'s tenant', () => {
    expect(planLoad(bundle, { ...req, tenantId: 'cc000000-0000-4000-8000-000000000001' })).toMatchObject({ ok: false, refusedBecause: 'tenant_mismatch' });
  });
  it('refuses a load with nobody\'s name on it', () => {
    expect(planLoad(bundle, { ...req, operator: '   ' })).toMatchObject({ ok: false, refusedBecause: 'no_operator' });
  });
  it('refuses a target that already holds products (a load goes into a PREPARED, EMPTY tenant)', () => {
    expect(planLoad(bundle, { ...req, targetProductCount: 3 })).toMatchObject({ ok: false, refusedBecause: 'target_not_empty' });
  });
  it('refuses an extract whose seal was not verified (MG-02)', () => {
    expect(planLoad(bundle, { ...req, extractSealed: false })).toMatchObject({ ok: false, refusedBecause: 'extract_not_sealed' });
  });
  it('refuses while blocking exceptions are undecided (MG-04)', () => {
    expect(planLoad(bundle, { ...req, blockingExceptionsOpen: 2 })).toMatchObject({ ok: false, refusedBecause: 'blocking_exceptions_open' });
  });
  it('refuses malformed rows and names EVERY one, so the file is fixed once', () => {
    const bad: ExtractBundle = {
      ...bundle,
      products: [
        ...bundle.products,
        { ...bundle.products[1]!, productId: 'P-X', sku: 'SOAP-1', taxClass: '9999', priceMinor: 9_000, mrpMinor: 8_000, barcodes: [{ code: '8901234567890', kind: 'ean' }] },
        // a FOOD item with no allergen declaration — the product engine's rule, surfaced in the plan
        { ...bundle.products[0]!, productId: 'P-DAL', sku: 'DAL-1', barcodes: [], safety: { countryOfOrigin: 'IN', netQuantity: '1 kg', packerDetails: 'SRE' } },
      ],
      openingStock: [...bundle.openingStock, { productId: 'P-GHOST', quantityMinor: 0, uom: 'each', unitCostMinor: 100 }],
    };
    const plan = planLoad(bad, req);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusedBecause).toBe('malformed_rows');
    expect(plan.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('SKU "SOAP-1" already belongs to "P-SOAP"'),
      expect.stringContaining('HSN / tax class "9999" has no rate'),
      expect.stringContaining('above MRP'),
      expect.stringContaining('barcode "8901234567890": shared by'),
      expect.stringContaining('product "P-DAL": '),
      expect.stringContaining('product "P-GHOST" is not in the extract'),
      expect.stringContaining('quantity must be a positive whole number'),
    ]));
    expect(plan.problems.some((p) => p.startsWith('product "P-DAL"') && /allergen/i.test(p))).toBe(true);
  });
  it('validateBundle is empty for a bundle the routes will accept', () => {
    expect(validateBundle(bundle)).toEqual([]);
  });
  it('a category with an unknown regulated kind is a problem, not a silently dropped flag', () => {
    const b: ExtractBundle = { ...bundle, categories: [...bundle.categories, { categoryId: 'x', name: 'X', parentId: null, regulated: ['fireworks'] }] };
    expect(validateBundle(b)).toEqual([expect.stringContaining('regulated kind "fireworks"')]);
  });
});

describe('planLoad — the ordered steps', () => {
  it('orders tax → products → barcodes → prices → suppliers → customers → one opening receipt, with load-scoped keys', () => {
    const plan = okPlan();
    expect(plan.steps.map((s) => s.group)).toEqual([
      'tax', 'tax', 'product', 'product', 'barcode', 'barcode', 'barcode', 'price', 'price', 'supplier', 'customer', 'customer', 'customer', 'stock',
    ]);
    expect(plan.counts).toEqual({ tax: 2, product: 2, barcode: 3, price: 2, supplier: 1, customer: 3, stock: 1 });
    expect(plan.steps.every((s) => s.idempotencyKey.startsWith('load-2026-10-01-'))).toBe(true);
    expect(new Set(plan.steps.map((s) => s.idempotencyKey)).size).toBe(plan.steps.length);
  });
  it('publishes each product with the FULL category list, so the engine can find its home and its regulated rules', () => {
    const product = okPlan().steps.find((s) => s.group === 'product' && s.what === 'product P-RICE')!;
    expect(product.path).toBe('/v1/catalogue/products/P-RICE/publish');
    const body = product.body as { product: Record<string, unknown>; categories: { categoryId: string; regulated?: string[] }[] };
    expect(body.categories.map((c) => c.categoryId)).toEqual(['grocery', 'staples', 'home']);
    expect(body.categories[1]!.regulated).toEqual(['food', 'packed']);
    expect(body.product).toMatchObject({ sku: 'RICE-5KG', taxClass: '1006', lifecycle: 'active', brand: 'SRE' });
    expect(body.product).not.toHaveProperty('productId');
  });
  it('prices carry the extract\'s cost and floor and the loaded store (SF-01); the route decides below-cost, never the loader', () => {
    const price = okPlan().steps.find((s) => s.what === 'price P-SOAP')!;
    expect(price.body).toEqual({ productId: 'P-SOAP', priceMinor: 2_500, mrpMinor: 2_500, costMinor: 1_800, currency: 'INR', marginFloorBps: 500, storeId: 'STORE-MAIN' });
  });
  it('GT-06: a migrated supplier goes into the SUPPLIER MASTER with its name and GSTIN — never only portal configuration; NO portal grants and NO logins are created', () => {
    const supplier = okPlan().steps.find((s) => s.group === 'supplier')!;
    expect(supplier.path).toBe('/v1/purchase/suppliers/SUP-1');
    expect(supplier.body).toEqual({ name: 'Kaveri Traders', gstin: '33AAAAA0000A1Z9' });
    expect(okPlan().steps.some((s) => s.path.startsWith('/v1/supplier-portal/'))).toBe(false);
  });
  it('GT-06: a malformed or mistyped GSTIN, and one GSTIN on two supplier codes, are named problems before anything is sent', () => {
    const withSuppliers = (suppliers: { partnerId: string; name: string; gstin?: string }[]) => validateBundle({ ...bundle, suppliers });
    expect(withSuppliers([{ partnerId: 'SUP-1', name: 'Kaveri Traders', gstin: '33AAAAA0000A1Z5' }]).join(' ')).toMatch(/SUP-1.*check character/);
    expect(withSuppliers([{ partnerId: 'SUP-1', name: 'Kaveri Traders', gstin: 'GST-UNKNOWN' }]).join(' ')).toMatch(/SUP-1.*15 characters/);
    expect(withSuppliers([{ partnerId: 'SUP-1', name: 'Kaveri Traders', gstin: '33AAAAA0000A1Z9' }, { partnerId: 'SUP-2', name: 'Kaveri Traders (old code)', gstin: '33aaaaa0000a1z9' }]).join(' '))
      .toMatch(/SUP-2.*also supplier "SUP-1"/);
    expect(withSuppliers([{ partnerId: 'SUP-1', name: 'Kaveri Traders' }])).toEqual([]);
  });
  it('a migrated customer arrives with consent recorded as NOT given, with the evidence stated; points only when there are some', () => {
    const steps = okPlan().steps.filter((s) => s.group === 'customer');
    expect(steps.map((s) => s.what)).toEqual(['customer C-1', 'customer points C-1', 'customer C-2']);
    expect(steps[0]!.body).toMatchObject({ purpose: 'marketing', given: false });
    expect((steps[0]!.body as { evidence: string }).evidence).toContain('no consent on record');
    expect(steps[1]!.body).toMatchObject({ kind: 'earn', points: 120, movementId: 'load-2026-10-01-opening-C-1' });
  });
  it('the opening receipt goes through the real receiving gate with the counted lines ONLY — batch + expiry where both are present; no rules, no policy in the body (F03)', () => {
    const plan = okPlan();
    const stock = plan.steps.find((s) => s.group === 'stock')!;
    expect(stock.path).toBe('/v1/inventory/goods-receipt/opening-load-2026-10-01');
    const body = stock.body as { warehouseId: string; lines: Record<string, unknown>[] };
    expect(body.warehouseId).toBe('STORE-MAIN');
    // Since SP-4 (ii) the gate refuses a body that names its own rules or tolerances: what is batch-tracked is the
    // product master's word, the tolerances the tenant's policy.
    expect(body).not.toHaveProperty('rules');
    expect(body).not.toHaveProperty('policy');
    expect(body.lines[0]).toMatchObject({ lineId: 'L1', productId: 'P-RICE', orderedMinor: 40, countedMinor: 40, batchId: 'B1', expiry: '2027-03-31', condition: 'good', unitCost: { minor: 36_000, currency: 'INR' } });
    expect(body.lines[1]).not.toHaveProperty('batchId');
    expect(plan.warnings).toEqual([]);
  });
  it('a receiving policy on the request is SET first, as its own step, then the receipt follows — never carried on the receipt', () => {
    const plan = okPlan({ ...req, receivingPolicy: { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 } });
    const stock = plan.steps.filter((s) => s.group === 'stock');
    expect(stock.map((s) => s.path)).toEqual(['/v1/inventory/receipt-policy', '/v1/inventory/goods-receipt/opening-load-2026-10-01']);
    expect(stock[0]!.body).toEqual({ excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 });
    expect(stock[1]!.body).not.toHaveProperty('policy');
    expect(plan.counts.stock).toBe(2);
    expect(new Set(plan.steps.map((s) => s.idempotencyKey)).size).toBe(plan.steps.length);
  });
  it('a batch without an expiry is loaded unbatched and SAID, never silently (P-08)', () => {
    const plan = okPlan(req, { ...bundle, openingStock: [{ productId: 'P-SOAP', quantityMinor: 10, uom: 'each', unitCostMinor: 1_800, batchId: 'LOT-9' }] });
    expect(plan.warnings).toEqual([expect.stringContaining('batch "LOT-9": loaded WITHOUT its batch')]);
    const body = plan.steps.find((s) => s.group === 'stock')!.body as { lines: Record<string, unknown>[] };
    expect(body.lines[0]).not.toHaveProperty('batchId');
    expect(body.lines[0]).not.toHaveProperty('expiry');
  });
  it('no opening stock → no receipt step', () => {
    expect(okPlan(req, { ...bundle, openingStock: [] }).counts.stock).toBe(0);
  });
});

describe('executeLoad — every step\'s outcome is a visible line', () => {
  const clientThat = (decide: (path: string) => number): LoadClient & { calls: { path: string; key: string; userId: string; tenantId: string }[] } => {
    const calls: { path: string; key: string; userId: string; tenantId: string }[] = [];
    return {
      calls,
      request: async ({ path, idempotencyKey, userId, tenantId }) => {
        calls.push({ path, key: idempotencyKey, userId, tenantId });
        const status = decide(path);
        return { status, body: status >= 400 ? { error: { code: 'price_below_cost', whatHappened: 'The price is below cost and needs a separate approver\'s sign-off with a reason.' } } : {} };
      },
    };
  };
  it('runs every step as the named operator in the named tenant and reports landed counts', async () => {
    const client = clientThat(() => 201);
    const report = await executeLoad(client, okPlan());
    expect(report.ok).toBe(true);
    expect(report.landed).toEqual({ tax: 2, product: 2, barcode: 3, price: 2, supplier: 1, customer: 3, stock: 1 });
    expect(client.calls.every((c) => c.userId === 'u-chezhian' && c.tenantId === REAL)).toBe(true);
    expect(client.calls.map((c) => c.key)).toEqual(okPlan().steps.map((s) => s.idempotencyKey));
  });
  it('a route\'s refusal is a failed line with the route\'s own words; the rest still run', async () => {
    const client = clientThat((path) => (path === '/v1/prices/changes' ? 422 : 201));
    const report = await executeLoad(client, okPlan());
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual({ tax: 0, product: 0, barcode: 0, price: 2, supplier: 0, customer: 0, stock: 0 });
    expect(report.steps.filter((s) => !s.ok).map((s) => s.detail)).toEqual([
      expect.stringContaining('price_below_cost: The price is below cost'),
      expect.stringContaining('price_below_cost'),
    ]);
    expect(report.steps).toHaveLength(14);
  });
  it('stopOnFirstFailure halts at the first refused step', async () => {
    const client = clientThat((path) => (path.includes('/publish') ? 422 : 201));
    const report = await executeLoad(client, okPlan(), { stopOnFirstFailure: true });
    expect(report.ok).toBe(false);
    expect(report.steps).toHaveLength(3);
    expect(report.landed.tax).toBe(2);
  });
});

describe('bundleFromFiles — the CSV extract, every conversion stated', () => {
  it('money, percent, quantity and barcode kinds convert the way the file says', () => {
    expect(moneyToMinor('123.45')).toBe(12_345);
    expect(moneyToMinor('₹ 1,250')).toBe(125_000);
    expect(moneyToMinor('12.5')).toBe(1_250);
    expect(moneyToMinor('abc')).toBeUndefined();
    expect(moneyToMinor(undefined)).toBeUndefined();
    expect(percentToBps('5')).toBe(500);
    expect(percentToBps('12.5%')).toBe(1_250);
    expect(percentToBps('0.25')).toBe(25);
    expect(quantityToMinor('40', 'each')).toBe(40);
    expect(quantityToMinor('2.5', 'kg')).toBe(2_500);
    expect(quantityToMinor('1.2345', 'kg')).toBeUndefined(); // finer than a gram is not a quantity we can hold
    expect(quantityToMinor('3.5', 'each')).toBeUndefined();
    expect(inferBarcodeKind('8901234567890')).toBe('ean');
    expect(inferBarcodeKind('2100012345678')).toBe('embedded');
    expect(inferBarcodeKind('012345678905')).toBe('upc');
    expect(inferBarcodeKind('10012345678902')).toBe('gtin');
    expect(inferBarcodeKind('12345670')).toBe('ean');
    expect(inferBarcodeKind('SHELF-A1')).toBe('internal');
  });
  it('maps the six files into a bundle; columns match regardless of case, spaces, dashes or underscores', () => {
    const rows = (headers: string[], data: string[][]) => ({ headers, rows: data.map((d) => Object.fromEntries(headers.map((h, i) => [h, d[i] ?? '']))) });
    const mapped = bundleFromFiles({
      categories: rows(['Category ID', 'Name', 'Parent', 'Regulated'], [['grocery', 'Grocery', '', ''], ['staples', 'Staples', 'grocery', 'food|packed']]),
      taxRates: rows(['HSN Code', 'Effective From', 'Rate %'], [['1006', '2017-07-01', '5']]),
      products: rows(
        ['Item Code', 'Description', 'UOM', 'Category', 'HSN', 'MRP', 'Selling Price', 'Cost Price', 'Barcodes', 'Allergens', 'Country of Origin', 'Net Quantity', 'Packer', 'Status', 'Brand'],
        [['P-RICE', 'Ponni rice 5 kg', 'each', 'staples', '1006', '450.00', '420', '360.00', '8901234567890|INT-1', '', 'IN', '5 kg', 'SRE Hyper Market', 'Active', 'SRE'],
         ['P-BAD', '', 'each', 'staples', '1006', '10', '9', '', '', '', '', '', '', '', '']],
      ),
      suppliers: rows(['supplier_code', 'supplier_name', 'GSTIN'], [['SUP-1', 'Kaveri Traders', '33AAAAA0000A1Z9']]),
      customers: rows(['customer-code', 'loyalty points'], [['C-1', '120'], ['C-2', ''], ['C-3', 'lots']]),
      openingStock: rows(['item_code', 'qty', 'uom', 'cost', 'batch', 'expiry'], [['P-RICE', '40', 'each', '360', 'B1', '2027-03-31'], ['P-RICE', 'x', 'each', '360', '', '']]),
    });
    expect(mapped.bundle.categories).toEqual([
      { categoryId: 'grocery', name: 'Grocery', parentId: null },
      { categoryId: 'staples', name: 'Staples', parentId: 'grocery', regulated: ['food', 'packed'] },
    ]);
    expect(mapped.bundle.taxRates).toEqual([{ hsnCode: '1006', effectiveFrom: '2017-07-01', rateBps: 500 }]);
    expect(mapped.bundle.products).toEqual([{
      productId: 'P-RICE', sku: 'P-RICE', name: 'Ponni rice 5 kg', baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'active', brand: 'SRE',
      safety: { countryOfOrigin: 'IN', netQuantity: '5 kg', packerDetails: 'SRE Hyper Market' },
      barcodes: [{ code: '8901234567890', kind: 'ean' }, { code: 'INT-1', kind: 'internal' }],
      priceMinor: 42_000, mrpMinor: 45_000, costMinor: 36_000, marginFloorBps: 0,
    }]);
    expect(mapped.bundle.suppliers).toEqual([{ partnerId: 'SUP-1', name: 'Kaveri Traders', gstin: '33AAAAA0000A1Z9' }]);
    expect(mapped.bundle.customers).toEqual([{ customerId: 'C-1', loyaltyPoints: 120 }, { customerId: 'C-2' }]);
    expect(mapped.bundle.openingStock).toEqual([{ productId: 'P-RICE', quantityMinor: 40, uom: 'each', unitCostMinor: 36_000, batchId: 'B1', expiry: '2027-03-31' }]);
    expect(mapped.problems).toEqual([
      expect.stringMatching(/^products\.csv line 3: missing or unreadable description, cost price/),
      expect.stringContaining('customers.csv line 4: loyalty points "lots"'),
      expect.stringMatching(/^opening-stock\.csv line 3: needs an item code, a quantity/),
    ]);
    // An empty allergen column is NOT a declaration of "none": the plan then refuses the food item, by name.
    expect(validateBundle(mapped.bundle)).toEqual([expect.stringMatching(/product "P-RICE": .*allergen/i)]);
  });
  it('an explicit "none" allergen declaration is the empty list the engine accepts', () => {
    const mapped = bundleFromFiles({
      categories: { headers: [], rows: [{ category_id: 'staples', name: 'Staples', parent_id: '', regulated: 'food' }] },
      taxRates: { headers: [], rows: [{ hsn: '1006', from: '2017-07-01', rate: '5' }] },
      products: { headers: [], rows: [{ item_code: 'P-1', description: 'Rice', category: 'staples', hsn: '1006', mrp: '10', price: '10', cost: '8', allergens: 'none', origin: 'IN', net_quantity: '1 kg', age_restricted: 'yes' }] },
    });
    expect(mapped.problems).toEqual([]);
    expect(mapped.bundle.products[0]!.safety).toEqual({ allergens: [], countryOfOrigin: 'IN', netQuantity: '1 kg', minimumAge: 18 });
    expect(validateBundle(mapped.bundle)).toEqual([]);
  });
});
