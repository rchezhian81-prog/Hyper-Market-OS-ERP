import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

// A5 — GSTR-1 Table 12 folded straight from the store's own banked B2C till sales (no re-keying). The GST
// is pulled BACK OUT of each MRP-inclusive line total against the product→{HSN, rate} table, which DEFAULTS
// from the published catalogue (Option A) and can be OVERRIDDEN per product in the body. A sold product
// with no mapping is surfaced in `unmapped`, never silently off the return. Proven end-to-end over the real
// sale-intake → sales stream → finance fold pipeline.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SMALL = 1_000_000; // < ₹5cr → 4-digit HSN accepted

// Publish a catalogue pack carrying each product's HSN (tax class) and rate — the DEFAULT tax table.
const seedCatalogue = (h: ApiHarness, products: { productId: string; hsnCode: string; taxBps: number }[]) =>
  h.store.append(A, STREAM.catalogue, makeEvent({
    id: 'pack-hsn', type: 'CataloguePublished', occurredAt: '2026-08-01T00:00:00Z',
    idempotencyKey: `catalogue-${A}-vhsn`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: '2026-08-01T00:00:00Z', products, barcodes: [] } },
  }));

// A banked sale: what the till charged (the MRP-inclusive line total). No HSN or tax split on the line,
// unless the lane stamped the frozen tax facts (hsnCode + taxRateBps) — passed through `frozen`.
const bankSale = (h: ApiHarness, u: string, saleId: string, productId: string, lineTotalMinor: number, tradingDay: string, frozen: { hsnCode?: string; taxRateBps?: number } = {}) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: `gs-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T09:00:00Z`, totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: 1, uom: 'each', unitPriceMinor: lineTotalMinor, lineTotalMinor, ...frozen }],
      tenders: [{ kind: 'cash', amountMinor: lineTotalMinor }],
    },
  });

const fromSales = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/finance/gstr1/from-sales/table-12', userId: u, tenantId: A, idempotencyKey: key, body });

// Record a return against a banked sale, through the real API (which appends the returns projection).
const recordReturn = (h: ApiHarness, u: string, saleId: string, returnId: string, productId: string, quantityMinor: number, refundMinor: number, processedAt: string) =>
  h.request({
    method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: u, tenantId: A, idempotencyKey: `ret-${returnId}`,
    body: {
      returnId, number: returnId, processedBy: u, reasonCode: 'changed_mind', refundMinor, refundTender: 'cash',
      approvalThresholdMinor: 10_000_000, processedAt,
      lines: [{ productId, quantityMinor, uom: 'each', disposition: 'resell' }],
    },
  });

interface Row { hsnCode: string; rateBps: number; taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; b2cTaxableMinor: number }
interface NetRow { hsnCode: string; rateBps: number; salesTaxableMinor: number; returnsTaxableMinor: number; netTaxableMinor: number; netTaxMinor: number }
interface Table12Body {
  from: string; to: string; soldLineCount: number; returnedLineCount: number; mappedLineCount: number; taxTableSize: number; overrideCount: number; frozenLineCount: number;
  table12: { rows: Row[]; totalTaxableMinor: number; totalTaxMinor: number; b2bTaxableMinor: number; b2cTaxableMinor: number };
  returns: { rows: Row[]; totalTaxableMinor: number; totalTaxMinor: number };
  net: { rows: NetRow[]; salesTaxableMinor: number; returnsTaxableMinor: number; netTaxableMinor: number; netTaxMinor: number };
  gstn?: { gstin: string; fp: string; b2cs: { sply_ty: string; rt: number; txval: number; camt: number; samt: number; iamt: number }[]; hsn: { data: { hsn_sc: string; rt: number; txval: number }[] } };
  unmapped: { productId: string; quantityMinor: number; reason: string }[];
}

const MILK = [{ productId: 'MILK', hsnCode: '0401', rateBps: 1800 }];

async function seedAugustSales(h: ApiHarness): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  await bankSale(h, 'u-owner', 's1', 'MILK', 11_800, '2026-08-05'); // ₹118 incl @18% → taxable 100
  await bankSale(h, 'u-owner', 's2', 'MILK', 11_800, '2026-08-06');
  await bankSale(h, 'u-owner', 's3', 'MILK', 11_800, '2026-08-20');
  await bankSale(h, 'u-owner', 'sjul', 'MILK', 99_900, '2026-07-31'); // out of period — must not appear
}

describe('GSTR-1 Table 12 folded from banked till sales (A5)', () => {
  it('pulls GST out of the MRP-inclusive line totals and folds the period sales into a B2C Table-12', async () => {
    const h = apiHarness();
    await seedAugustSales(h);

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, products: MILK }, 'fs-1')).body as Table12Body;
    expect(r.soldLineCount).toBe(3);   // July excluded by trading day
    expect(r.mappedLineCount).toBe(3);
    expect(r.unmapped).toEqual([]);
    expect(r.table12.rows).toHaveLength(1);
    const row = r.table12.rows[0]!;
    expect(row.hsnCode).toBe('0401');
    expect(row.taxableMinor).toBe(30_000); // 3 × 10000
    expect(row.cgstMinor).toBe(2_700);     // 3 × 900
    expect(row.sgstMinor).toBe(2_700);
    expect(row.igstMinor).toBe(0);
    expect(r.table12.b2cTaxableMinor).toBe(30_000); // counter sales are all B2C
    expect(r.table12.b2bTaxableMinor).toBe(0);
    // A9 invariant end-to-end: taxable + tax reconciles to the gross the till charged (3 × 11800).
    expect(row.taxableMinor + row.cgstMinor + row.sgstMinor + row.igstMinor).toBe(35_400);
  });

  it('surfaces a sold product that has no tax mapping — counted, named, and NOT on the return', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'm1', 'MILK', 11_800, '2026-08-05');
    await bankSale(h, 'u-owner', 'b1', 'BREAD', 4_000, '2026-08-05'); // not in the tax table

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, products: MILK }, 'fs-unmapped')).body as Table12Body;
    expect(r.soldLineCount).toBe(2);
    expect(r.mappedLineCount).toBe(1);              // only MILK filed
    expect(r.table12.totalTaxableMinor).toBe(10_000);
    expect(r.unmapped).toHaveLength(1);
    expect(r.unmapped[0]!.productId).toBe('BREAD');
    expect(r.unmapped[0]!.reason).toBe('no_tax_mapping');
  });

  it('is gated on the finance GSTR read — owner and manager may fold; the till may not', async () => {
    const h = apiHarness();
    await seedAugustSales(h);
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds finance.gstr.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // does not

    const body = { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, products: MILK };
    expect((await fromSales(h, 'u-mgr', body, 'fs-mgr')).status).toBe(200);
    expect((await fromSales(h, 'u-cash', body, 'fs-cash')).status).toBe(403);
  });

  it('refuses a malformed request — a bad period, a missing turnover, and a bad product-override row', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await fromSales(h, 'u-owner', { from: '2026-08-31', to: '2026-08-01', annualTurnoverMinor: SMALL, products: MILK }, 'fs-badperiod')).status).toBe(400); // to before from
    expect((await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', products: MILK }, 'fs-noturn')).status).toBe(400); // no turnover
    expect((await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, products: [{ productId: 'X', rateBps: 500 }] }, 'fs-badrow')).status).toBe(422); // no hsnCode
  });

  // ── Option A: the tax table DEFAULTS from the published catalogue — no hand-keyed products[] needed. ──

  it('builds the return from the catalogue HSN/rate mapping when no products[] is supplied', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedCatalogue(h, [{ productId: 'MILK', hsnCode: '0401', taxBps: 1800 }]); // HSN + rate from the master
    await bankSale(h, 'u-owner', 'c1', 'MILK', 11_800, '2026-08-05');
    await bankSale(h, 'u-owner', 'c2', 'MILK', 11_800, '2026-08-06');

    // No products[] in the body — the route sources the mapping from the catalogue.
    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL }, 'fs-catalogue')).body as Table12Body;
    expect(r.overrideCount).toBe(0);
    expect(r.taxTableSize).toBe(1);   // MILK came from the catalogue
    expect(r.mappedLineCount).toBe(2);
    expect(r.unmapped).toEqual([]);
    expect(r.table12.rows[0]!.hsnCode).toBe('0401');
    expect(r.table12.rows[0]!.taxableMinor).toBe(20_000);
  });

  it('lets a supplied products[] override the catalogue mapping for a product', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedCatalogue(h, [{ productId: 'MILK', hsnCode: '0401', taxBps: 1800 }]);
    await bankSale(h, 'u-owner', 'o1', 'MILK', 11_800, '2026-08-05');

    // The filer files MILK under a corrected HSN for this period — the override wins over the catalogue.
    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, products: [{ productId: 'MILK', hsnCode: '040110', rateBps: 1800 }] }, 'fs-override')).body as Table12Body;
    expect(r.overrideCount).toBe(1);
    expect(r.table12.rows).toHaveLength(1);
    expect(r.table12.rows[0]!.hsnCode).toBe('040110'); // the override, not the catalogue's 0401
  });

  // ── Freeze-at-supply: a sale can carry the HSN/rate it was actually sold under, and the return honours it. ──

  it('files a sale under the tax facts FROZEN on its line, with no catalogue or products[] at all', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // No catalogue, no products[] — but the lane stamped the HSN + rate it charged.
    await bankSale(h, 'u-owner', 'fz1', 'MILK', 11_800, '2026-08-05', { hsnCode: '0401', taxRateBps: 1800 });

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL }, 'fs-frozen')).body as Table12Body;
    expect(r.frozenLineCount).toBe(1);
    expect(r.mappedLineCount).toBe(1);
    expect(r.unmapped).toEqual([]);
    expect(r.table12.rows[0]!.hsnCode).toBe('0401');
    expect(r.table12.rows[0]!.taxableMinor).toBe(10_000);
  });

  it('files a mid-period rate change correctly — each sale under the rate it was sold at', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // The catalogue now says 12% (the new rate), but the earlier sale was frozen at 5% when it happened.
    await seedCatalogue(h, [{ productId: 'X', hsnCode: '1006', taxBps: 1200 }]);
    await bankSale(h, 'u-owner', 'mp1', 'X', 10_500, '2026-08-05', { hsnCode: '1006', taxRateBps: 500 });  // sold at 5%
    await bankSale(h, 'u-owner', 'mp2', 'X', 11_200, '2026-08-20', { hsnCode: '1006', taxRateBps: 1200 }); // sold at 12%

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL }, 'fs-midperiod')).body as Table12Body;
    expect(r.frozenLineCount).toBe(2);
    expect(r.table12.rows).toHaveLength(2); // 1006@500 and 1006@1200 kept apart, not blended to the catalogue's 12%
    const byRate = Object.fromEntries(r.table12.rows.map((row) => [row.rateBps, row.taxableMinor]));
    expect(byRate[500]).toBe(10_000);
    expect(byRate[1200]).toBe(10_000);
  });

  // ── Returns netting: a return issued in the period reverses the tax it was charged (CGST s.34). ──

  it('nets a return against the outward supplies, reversing the tax at the rate it was sold', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Sold 3 × ₹118 (MILK 0401 @18%); one is returned this period. The return reverses ₹10000 taxable / ₹1800 tax.
    await bankSale(h, 'u-owner', 'ns1', 'MILK', 11_800, '2026-08-05', { hsnCode: '0401', taxRateBps: 1800 });
    await bankSale(h, 'u-owner', 'ns2', 'MILK', 11_800, '2026-08-06', { hsnCode: '0401', taxRateBps: 1800 });
    await bankSale(h, 'u-owner', 'ns3', 'MILK', 11_800, '2026-08-07', { hsnCode: '0401', taxRateBps: 1800 });
    expect((await recordReturn(h, 'u-owner', 'ns1', 'RET-1', 'MILK', 1, 11_800, '2026-08-10T10:00:00Z')).status).toBeLessThan(300);

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL }, 'fs-net')).body as Table12Body;
    expect(r.soldLineCount).toBe(3);
    expect(r.returnedLineCount).toBe(1);
    expect(r.table12.totalTaxableMinor).toBe(30_000);   // sales
    expect(r.returns.totalTaxableMinor).toBe(10_000);    // the one return, reversed at 18%
    expect(r.net.netTaxableMinor).toBe(20_000);          // 30000 − 10000
    expect(r.net.netTaxMinor).toBe(3_600);               // 5400 − 1800
    const netRow = r.net.rows.find((row) => row.hsnCode === '0401')!;
    expect(netRow.salesTaxableMinor).toBe(30_000);
    expect(netRow.returnsTaxableMinor).toBe(10_000);
    expect(netRow.netTaxableMinor).toBe(20_000);
  });

  it('excludes a return processed outside the period', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'nx1', 'MILK', 11_800, '2026-08-05', { hsnCode: '0401', taxRateBps: 1800 });
    // Return processed in September — must not appear in the August return.
    await recordReturn(h, 'u-owner', 'nx1', 'RET-SEP', 'MILK', 1, 11_800, '2026-09-02T10:00:00Z');

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL }, 'fs-net-oob')).body as Table12Body;
    expect(r.returnedLineCount).toBe(0);
    expect(r.net.returnsTaxableMinor).toBe(0);
    expect(r.net.netTaxableMinor).toBe(10_000); // unchanged by the out-of-period return
  });

  // ── The GSTN portal file: the actual JSON uploaded to the government, from real sales net of returns. ──

  it('emits the GSTN portal JSON (net of returns) when a gstin + filing period are supplied', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'gx1', 'MILK', 11_800, '2026-08-05', { hsnCode: '0401', taxRateBps: 1800 });
    await bankSale(h, 'u-owner', 'gx2', 'MILK', 11_800, '2026-08-06', { hsnCode: '0401', taxRateBps: 1800 });
    await bankSale(h, 'u-owner', 'gx3', 'MILK', 11_800, '2026-08-07', { hsnCode: '0401', taxRateBps: 1800 });
    await recordReturn(h, 'u-owner', 'gx1', 'RET-GX', 'MILK', 1, 11_800, '2026-08-10T10:00:00Z');

    const r = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, gstin: '33ABCDE1234F1Z5', fp: '082026' }, 'fs-gstn')).body as Table12Body;
    const gstn = r.gstn!;
    expect(gstn.gstin).toBe('33ABCDE1234F1Z5');
    expect(gstn.fp).toBe('082026');
    // 3 sold − 1 returned = net ₹200 taxable, CGST ₹18, SGST ₹18 (in rupees on the portal file).
    expect(gstn.b2cs).toHaveLength(1);
    expect(gstn.b2cs[0]).toMatchObject({ sply_ty: 'INTRA', rt: 18, txval: 200, camt: 18, samt: 18, iamt: 0 });
    expect(gstn.hsn.data[0]).toMatchObject({ hsn_sc: '0401', rt: 18, txval: 200 });
  });

  it('omits the GSTN file by default and refuses a half-supplied export', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'gy1', 'MILK', 11_800, '2026-08-05', { hsnCode: '0401', taxRateBps: 1800 });

    const summaryOnly = (await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL }, 'fs-nogstn')).body as Table12Body;
    expect(summaryOnly.gstn).toBeUndefined(); // no gstin/fp → summary only
    // gstin without fp → refused (both are needed for the portal file).
    expect((await fromSales(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', annualTurnoverMinor: SMALL, gstin: '33ABCDE1234F1Z5' }, 'fs-halfgstn')).status).toBe(400);
  });
});
