// The supported invoice import (SF-06-a · OB-23 "C") as tests drive it: head office's own products and supplier, seeded
// through the real adapters, and an invoice file in the shape the `supplier-invoice-v1` template reads — one row per
// invoice line, the invoice's header repeated on each row. Synthetic data only.

import type { ApiHarness } from './api-harness';
import { productMasterAdapter, supplierMasterAdapter } from '../../services/api/src/adapters';
import { SUPPLIER_INVOICE_SPEC, SUPPLIER_INVOICE_LABEL, templateView } from '../../services/purchase/src/import-templates';
import type { ProductRecord } from '../../packages/product/src/index';

/** The template as the screen holds it (the server reads only its id). */
export const INVOICE_TEMPLATE = templateView({ spec: SUPPLIER_INVOICE_SPEC, label: SUPPLIER_INVOICE_LABEL, financial: true });

export const IMPORT_PRODUCTS = ['P1', 'P2', 'P3', 'P4', 'P5'] as const;
export const IMPORT_SUPPLIER = 'S-1';

/** Head office's own product master and supplier master hold what the files refer to. */
export async function seedImportTargets(h: ApiHarness, tenantId: string): Promise<void> {
  const now = () => '2026-10-09T09:00:00.000Z';
  const products = productMasterAdapter({ store: h.store, now });
  for (const id of IMPORT_PRODUCTS) {
    await products.publish(tenantId, { productId: id, tenantId, sku: id, name: `Item ${id}`, baseUom: 'ea', primaryCategoryId: 'c-1', taxClass: 'GST5', lifecycle: 'active' } as ProductRecord, `seed-${id}`);
  }
  await supplierMasterAdapter({ store: h.store, now }).recordSupplier(tenantId, {
    supplierId: IMPORT_SUPPLIER, name: 'Synthetic Wholesale', gstin: null, phone: null, email: null, address: null, paymentTermsDays: 30, documents: [],
    status: 'active', createdBy: 'seed', createdAt: now(), updatedBy: 'seed', updatedAt: now(), approvedBy: 'seed-2', approvedAt: now(), possibleDuplicates: [], version: 1,
  });
}

/** One invoice line: [invoiceId, productId, quantity, unitPriceMinor]. Quantities may be a string to make a bad row. */
export type InvoiceLine = readonly [string, string, number | string, number];

/** An invoice file and its declared total (the sum of every line) — each invoice's own total is the sum of its lines. */
export function invoiceFile(lines: readonly InvoiceLine[]): { text: string; declaredTotalMinor: number } {
  const totals = new Map<string, number>();
  const lineTotal = (l: InvoiceLine) => (typeof l[2] === 'number' ? l[2] * l[3] : 0);
  for (const l of lines) totals.set(l[0], (totals.get(l[0]) ?? 0) + lineTotal(l));
  const seq = new Map<string, number>();
  const rows = lines.map((l) => {
    const n = (seq.get(l[0]) ?? 0) + 1;
    seq.set(l[0], n);
    return [l[0], IMPORT_SUPPLIER, '', n, l[1], l[2], l[3], lineTotal(l), totals.get(l[0])].join(',');
  });
  return {
    text: [SUPPLIER_INVOICE_SPEC.columns.map((c) => c.name).join(','), ...rows].join('\n'),
    declaredTotalMinor: [...totals.values()].reduce((s, v) => s + v, 0),
  };
}
