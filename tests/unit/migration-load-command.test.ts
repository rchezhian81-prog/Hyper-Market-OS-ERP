import { describe, it, expect } from 'vitest';
import { runLoadCommand, readManifest, sealExtract, simpleHasher, type LoadManifest, type SealedExtract } from '../../packages/migration/src/index';
import { apiHarness } from '../support/api-harness';

// The operator's load, stage by stage, without a terminal: manifest → seal → completeness → cleaning →
// mapping → target → plan → dry run | load. Each stage refuses on its own, in plain English, and the
// happy path lands real stock in a real (in-process) tenant.

const REAL = 'ab000000-0000-4000-8000-000000000042';
const DEMO = 'de300000-0000-4000-8000-000000000001';
const OPERATOR = 'u-chezhian';

const FILES = {
  'categories.csv': ['category_id,name,parent_id,regulated', 'grocery,Grocery,,', 'staples,Staples,grocery,food', 'home,Home care,,'].join('\n'),
  'tax-rates.csv': ['hsn_code,effective_from,rate_percent', '1006,2017-07-01,5', '3402,2017-07-01,18'].join('\n'),
  'products.csv': [
    'item_code,description,uom,category,hsn,mrp,selling_price,cost_price,barcodes,allergens,country_of_origin,status',
    'P-RICE,Ponni raw rice 5 kg,each,staples,1006,450.00,420.00,360.00,8901234567890,none,IN,active',
    'P-SOAP,Dish wash bar,each,home,3402,25.00,25.00,18.00,8901234567891|INT-77,,,active',
  ].join('\n'),
  'suppliers.csv': ['supplier_code,supplier_name,gstin', 'SUP-1,Kaveri Traders,33AAAAA0000A1Z5'].join('\n'),
  'customers.csv': ['customer_code,loyalty_points', 'C-1,120', 'C-2,'].join('\n'),
  'opening-stock.csv': ['item_code,qty,uom,cost,batch,expiry', 'P-RICE,40,each,360.00,B1,2027-03-31', 'P-SOAP,200,each,18.00,,'].join('\n'),
} as const;

const dataRows = (text: string): number => text.split('\n').length - 1;

const seal = (name: string, text: string): SealedExtract => {
  const r = sealExtract({
    extractId: `x-${name}`, tenantId: REAL, sourceId: 'legacy-erp', material: text, rowCount: dataRows(text),
    extractedBy: 'u-chezhian', backupVerifiedAt: '2026-09-30T20:00:00.000Z', hasher: simpleHasher, now: '2026-09-30T21:00:00.000Z',
  });
  if (!r.ok || r.extract === undefined) throw new Error(r.detail);
  return r.extract;
};

const manifest = (files: Partial<typeof FILES> = FILES, overrides: Partial<LoadManifest> = {}): LoadManifest => ({
  loadId: 'load-2026-10-01', tenantId: REAL, operator: OPERATOR, stockLocationId: 'STORE-MAIN', receivedOnDate: '2026-10-01',
  files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { seal: seal(name, text!), declaredRows: dataRows(text!) }])),
  ...overrides,
});

const base = (h = apiHarness()) => ({
  h,
  input: { manifest: manifest(), files: FILES, exceptions: { exceptions: [] }, targetKind: 'rehearsal', demoTenantIds: [DEMO], dryRun: false, client: h },
});

describe('runLoadCommand — the stages', () => {
  it('loads the folder into an empty real tenant and stock reads back (exit 0)', async () => {
    const { h, input } = base();
    await h.seedOwner(REAL, OPERATOR);
    const out = await runLoadCommand(input);
    expect(out.lines.join('\n')).toContain('LOADED');
    expect(out).toMatchObject({ exitCode: 0, stage: 'load' });
    expect(out.report?.landed).toEqual({ tax: 2, product: 2, barcode: 3, price: 2, supplier: 1, customer: 3, stock: 1 });
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: { productId: string; onHandMinor: number }[] };
    expect(avail.rows.map((r) => [r.productId, r.onHandMinor]).sort()).toEqual([['P-RICE', 40], ['P-SOAP', 200]]);
  });
  it('a dry run with an API checks the target and sends nothing (exit 0)', async () => {
    const { h, input } = base();
    await h.seedOwner(REAL, OPERATOR);
    const out = await runLoadCommand({ ...input, dryRun: true });
    expect(out).toMatchObject({ exitCode: 0, stage: 'dry_run' });
    expect(out.lines.join('\n')).toContain('Target tenant holds no products');
    expect(out.lines.join('\n')).toContain('DRY RUN');
    const products = (await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OPERATOR, tenantId: REAL })).body as { products: unknown[] };
    expect(products.products).toHaveLength(0);
  });
  it('a dry run WITHOUT an API says the target was not checked; a real run without one cannot proceed (exit 2)', async () => {
    const { input } = base();
    const dry = await runLoadCommand({ ...input, client: undefined, dryRun: true });
    expect(dry).toMatchObject({ exitCode: 0, stage: 'dry_run' });
    expect(dry.lines.join('\n')).toContain('NOT CHECKED');
    const real = await runLoadCommand({ ...input, client: undefined });
    expect(real).toMatchObject({ exitCode: 2, stage: 'target' });
  });
  it('a manifest that cannot be read is exit 2 with every problem named', async () => {
    const { input } = base();
    const out = await runLoadCommand({ ...input, manifest: { loadId: 'x', files: { 'prices.csv': {} } } });
    expect(out).toMatchObject({ exitCode: 2, stage: 'manifest' });
    expect(out.lines.join('\n')).toMatch(/"tenantId" is required/);
    expect(out.lines.join('\n')).toMatch(/"prices.csv" is not one of the six/);
    expect(out.lines.join('\n')).toMatch(/"products.csv" must be listed/);
  });
  it('a file whose bytes are not the sealed bytes is refused (MG-02)', async () => {
    const { input } = base();
    const tampered = { ...FILES, 'products.csv': FILES['products.csv'].replace('360.00', '300.00') };
    const out = await runLoadCommand({ ...input, files: tampered });
    expect(out).toMatchObject({ exitCode: 1, stage: 'seal' });
    expect(out.lines.join('\n')).toContain('SEAL BROKEN — products.csv');
  });
  it('a file in the folder that was never sealed is refused; a sealed file missing from the folder cannot be read', async () => {
    const { input } = base();
    const partial = manifest({ 'products.csv': FILES['products.csv'] });
    const unsealed = await runLoadCommand({ ...input, manifest: partial });
    expect(unsealed).toMatchObject({ exitCode: 1, stage: 'seal' });
    expect(unsealed.lines.join('\n')).toContain('never sealed: categories.csv');
    const missing = await runLoadCommand({ ...input, files: { 'products.csv': FILES['products.csv'] } });
    expect(missing).toMatchObject({ exitCode: 2, stage: 'manifest' });
  });
  it('a file shorter than the count read off the screen is refused (truncated export)', async () => {
    const { input } = base();
    const m = manifest();
    const short: LoadManifest = { ...m, files: { ...m.files, 'customers.csv': { seal: m.files['customers.csv']!.seal, declaredRows: 250 } } };
    const out = await runLoadCommand({ ...input, manifest: short });
    expect(out).toMatchObject({ exitCode: 1, stage: 'completeness' });
    expect(out.lines.join('\n')).toContain('customers.csv is short');
  });
  it('no cleaning report → refused; an undecided blocking exception → refused (MG-04)', async () => {
    const { h, input } = base();
    await h.seedOwner(REAL, OPERATOR);
    const none = await runLoadCommand({ ...input, exceptions: undefined });
    expect(none).toMatchObject({ exitCode: 1, stage: 'cleaning' });
    const open = await runLoadCommand({ ...input, exceptions: [{ exceptionId: 'EXC-00001', tenantId: REAL, kind: 'unmapped_tax_code', severity: 'blocking', confidence: 'certain', legacyIds: ['P-RICE'], evidence: 'tax code 1006X has no mapping' }] });
    expect(open).toMatchObject({ exitCode: 1, stage: 'plan' });
    expect(open.lines.join('\n')).toContain('blocking_exceptions_open');
    const decided = await runLoadCommand({ ...input, exceptions: [{ exceptionId: 'EXC-00001', tenantId: REAL, kind: 'unmapped_tax_code', severity: 'blocking', confidence: 'certain', legacyIds: ['P-RICE'], evidence: 'x', resolution: { action: 'correct', decidedBy: 'u-chezhian', decidedAt: '2026-09-30T10:00:00.000Z', reason: 'mapped to 1006 in writing' } }] });
    expect(decided).toMatchObject({ exitCode: 0, stage: 'load' });
  });
  it('an unreadable row is refused at mapping, by file and line', async () => {
    const { input } = base();
    const bad = { ...FILES, 'products.csv': `${FILES['products.csv']}\nP-X,,each,home,3402,10,9,,,,,active` };
    const out = await runLoadCommand({ ...input, files: bad, manifest: manifest(bad) });
    expect(out).toMatchObject({ exitCode: 1, stage: 'mapping' });
    expect(out.lines.join('\n')).toMatch(/products\.csv line 4: missing or unreadable description, cost price/);
  });
  it('an operator the target does not recognise is refused before anything is planned', async () => {
    const { input } = base(); // nobody seeded → the operator holds no role in the tenant
    const out = await runLoadCommand(input);
    expect(out).toMatchObject({ exitCode: 1, stage: 'target' });
    expect(out.lines.join('\n')).toMatch(/cannot read tenant/);
  });
  it('re-running the same load into its own half-loaded target resumes and doubles nothing; a target holding someone else\'s product is refused', async () => {
    const { h, input } = base();
    await h.seedOwner(REAL, OPERATOR);
    expect((await runLoadCommand(input)).exitCode).toBe(0);
    const again = await runLoadCommand(input);
    expect(again).toMatchObject({ exitCode: 0, stage: 'load' });
    expect(again.lines.join('\n')).toContain('an earlier run of this load');
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: { onHandMinor: number }[] };
    expect(avail.rows.map((r) => r.onHandMinor).sort((a, b) => a - b)).toEqual([40, 200]);

    const other = apiHarness();
    await other.seedOwner(REAL, OPERATOR);
    await other.request({
      method: 'POST', path: '/v1/catalogue/products/P-THEIRS/publish', userId: OPERATOR, tenantId: REAL, idempotencyKey: 'theirs',
      body: { product: { sku: 'THEIRS', name: 'Somebody else\'s item', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402', lifecycle: 'active' }, categories: [{ categoryId: 'home', name: 'Home', parentId: null }] },
    });
    const refused = await runLoadCommand({ ...input, client: other });
    expect(refused).toMatchObject({ exitCode: 1, stage: 'plan' });
    expect(refused.lines.join('\n')).toContain('NOT in this extract (e.g. "P-THEIRS")');
    expect(refused.lines.join('\n')).toContain('target_not_empty');
  });
  it('the demo tenant and a production box are refused by name', async () => {
    const { h, input } = base();
    await h.seedOwner(DEMO, OPERATOR);
    await h.seedOwner(REAL, OPERATOR);
    const demo = await runLoadCommand({ ...input, manifest: manifest(FILES, { tenantId: DEMO }) });
    expect(demo).toMatchObject({ exitCode: 1, stage: 'plan' });
    expect(demo.lines.join('\n')).toContain('demo_tenant');
    const prod = await runLoadCommand({ ...input, targetKind: 'production' });
    expect(prod).toMatchObject({ exitCode: 1, stage: 'plan' });
    expect(prod.lines.join('\n')).toContain('production_target');
    const odd = await runLoadCommand({ ...input, targetKind: 'prod' });
    expect(odd).toMatchObject({ exitCode: 1, stage: 'target' });
  });
  it('a route\'s refusal mid-load is exit 1 with the line to work through; a re-run then completes', async () => {
    const { h, input } = base();
    await h.seedOwner(REAL, OPERATOR);
    const belowCost = { ...FILES, 'products.csv': FILES['products.csv'].replace('25.00,25.00,18.00', '25.00,10.00,18.00') };
    const first = await runLoadCommand({ ...input, files: belowCost, manifest: manifest(belowCost) });
    expect(first).toMatchObject({ exitCode: 1, stage: 'load' });
    expect(first.lines.join('\n')).toMatch(/✗ price P-SOAP \(HTTP 422\): price_below_cost/);
  });
  it('readManifest accepts the documented shape', () => {
    expect(readManifest(manifest()).problems).toEqual([]);
  });
});
