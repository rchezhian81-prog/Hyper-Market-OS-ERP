import { describe, it, expect } from 'vitest';
import { dataImportRoutes, type DataImportDeps } from '../../services/purchase/src/data-import';
import { supplierInvoiceTemplate, SUPPLIER_INVOICE_SPEC, type SupplierInvoiceImportDeps } from '../../services/purchase/src/import-templates';

/**
 * SF-06-a — the supported invoice template's own rules, and the commit's one rule no seeded role reaches today: an uploader
 * who may import but may NOT capture invoices cannot load invoices (loading them IS capturing them).
 */

const NOW = '2026-10-09T09:00:00.000Z';
const deps = (over: Partial<SupplierInvoiceImportDeps> = {}): SupplierInvoiceImportDeps => ({
  productIds: async () => ['P1', 'P2'], supplierIds: async () => ['S-1'], invoiceIdUsed: async () => false,
  purchaseOrder: () => undefined, permissionsOfUser: () => ['purchase.invoice.match'], invoiceMatched: async () => false, ...over,
});
const row = (o: Record<string, string>) => ({ invoiceId: 'I-1', supplierId: 'S-1', poId: '', line: '1', productId: 'P1', quantity: '2', unitPriceMinor: '100', lineTotalMinor: '200', invoiceTotalMinor: '200', ...o });

describe('supplier-invoice-v1 — the invoice register\'s rules, by line', () => {
  it('a clean invoice raises nothing; its effect is a captured invoice with the importer and the checker', async () => {
    const t = supplierInvoiceTemplate(deps());
    expect(await t.check('t', [row({})], [2], 200)).toEqual([]);
    const [e] = await t.effects('t', [row({})], { jobId: 'J', uploadedBy: 'u-a', approvedBy: 'u-b', approvedAt: NOW, at: NOW });
    expect(e!.kind === 'supplier_invoice' && e!.invoice).toMatchObject({ invoiceId: 'I-1', capturedBy: 'u-a', approvedBy: 'u-b', source: 'import/J', totalMinor: 200, governanceFlags: ['no_purchase_order'] });
  });

  it('a checker who may not check invoices leaves the invoice captured and flagged as not yet checked', async () => {
    const t = supplierInvoiceTemplate(deps({ permissionsOfUser: () => ['purchase.import.record'] }));
    const [e] = await t.effects('t', [row({})], { jobId: 'J', uploadedBy: 'u-a', approvedBy: 'u-b', approvedAt: NOW, at: NOW });
    expect(e!.kind === 'supplier_invoice' && e!.invoice).toMatchObject({ approvedBy: null, governanceFlags: ['no_approval', 'no_purchase_order'] });
  });

  it('zero quantity, a line that does not multiply, a header that changes within an invoice, and an invoice already held', async () => {
    const t = supplierInvoiceTemplate(deps({ invoiceIdUsed: async (_, id) => id === 'I-OLD' }));
    const errors = await t.check('t', [
      row({ quantity: '0', lineTotalMinor: '0', invoiceTotalMinor: '0' }),
      row({ invoiceId: 'I-2', line: '1', lineTotalMinor: '201', invoiceTotalMinor: '400' }),
      row({ invoiceId: 'I-2', line: '2', supplierId: 'S-2', invoiceTotalMinor: '400' }),
      row({ invoiceId: 'I-OLD' }),
    ], [2, 3, 4, 5], undefined);
    expect(errors.map((e) => `${e.line}:${e.column}`)).toEqual(expect.arrayContaining([
      '1:declared total', '2:quantity', '3:lineTotalMinor', '4:supplierId', '5:invoiceId',
    ]));
    expect(errors.every((e) => e.kind === 'target_rule')).toBe(true);
  });

  it('OB-31: a weighed product\'s line is grams at the per-kg price — 2500 g at 4500 is 11250, not 11250000; recorded with its unit', async () => {
    const t = supplierInvoiceTemplate(deps({ productUom: (_, p) => (p === 'P2' ? 'KG' : 'ea') }));
    const kgRow = (o: Record<string, string>) => row({ productId: 'P2', quantity: '2500', unitPriceMinor: '4500', ...o });
    expect(await t.check('t', [kgRow({ lineTotalMinor: '11250', invoiceTotalMinor: '11250' })], [2], 11_250)).toEqual([]);
    const wrong = await t.check('t', [kgRow({ lineTotalMinor: '11250000', invoiceTotalMinor: '11250000' })], [2], 11_250_000);
    expect(wrong).toEqual([expect.objectContaining({ line: 2, column: 'lineTotalMinor', message: '2500 g at 4500 a kg is 11250, but the line says 11250000.' })]);
    // An item is unchanged.
    expect(await t.check('t', [row({})], [2], 200)).toEqual([]);
    const [e] = await t.effects('t', [kgRow({ lineTotalMinor: '11250', invoiceTotalMinor: '11250' })], { jobId: 'J', uploadedBy: 'u-a', approvedBy: 'u-b', approvedAt: NOW, at: NOW });
    expect(e!.kind === 'supplier_invoice' && e!.invoice.lines).toEqual([expect.objectContaining({ productId: 'P2', quantity: 2_500, lineTotalMinor: 11_250, uom: 'kg' })]);
  });

  it('a matched invoice blocks the rollback of its load, by name', async () => {
    const t = supplierInvoiceTemplate(deps({ invoiceMatched: async (_, id) => id === 'I-1' }));
    expect(await t.blocksRollback('t', [{ kind: 'supplier_invoice', ref: 'I-1' }, { kind: 'supplier_invoice', ref: 'I-2' }])).toEqual(['invoice I-1 has already been matched against its order and delivery']);
  });
});

describe('the commit refuses an uploader without the target module\'s own authority', () => {
  it('may import, may not capture invoices → 403 import_target_not_permitted, nothing written', async () => {
    let written = 0;
    const d: DataImportDeps = {
      commits: () => [], recordCommit: () => { written += 1; }, now: () => NOW,
      templates: [supplierInvoiceTemplate(deps())],
      permissionsOfUser: () => ['purchase.import.record'],
    };
    const route = dataImportRoutes(d).find((r) => r.path === '/v1/import/commit')!;
    const text = [SUPPLIER_INVOICE_SPEC.columns.map((c) => c.name).join(','), 'I-1,S-1,,1,P1,2,100,200,200'].join('\n');
    await expect(route.handler({
      tenantId: 't1', userId: 'u-a', traceId: 'x', params: {}, query: {}, headers: {},
      body: { jobId: 'J', templateId: 'supplier-invoice-v1', text, declaredTotalMinor: 200, approvalId: 'a-1' },
    } as never)).rejects.toMatchObject({ status: 403, body: { code: 'import_target_not_permitted' } });
    expect(written).toBe(0);
  });
});
