// API-02 the three product-master check reports (OB-625, owner, 1 Nov 2026: read-only, before the pilot · M03 reporting).
//
//   GET /v1/catalogue/reports/product-checks   every sellable product with no tax mapping, with allergen or ingredient
//                                               details missing where its category needs them, or with no barcode
//
// Read-only: it folds head office's own registers — the product master, the category list, the barcode register and each
// HSN code's GST rate schedule — through the tested `productChecks`. A rate schedule head office could not read is said so
// for that product ("not read"), never taken as "no rate". Nothing here writes; a person fixes a gap on the product's own
// page, and the product leaves the report on the next read.

import type { Route } from '../../kernel/src/index';
import { productChecks, type ProductRecord, type Category, type BarcodeAssignment } from '../../../packages/product/src/index';
import type { GstRatePeriod } from '../../../packages/finance/src/rate';

export interface ProductCheckDeps {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]>;
  readonly categories: (tenantId: string) => Promise<readonly Category[]>;
  readonly barcodes: (tenantId: string) => Promise<readonly BarcodeAssignment[]>;
  readonly gstSchedule: (tenantId: string, hsnCode: string) => Promise<readonly GstRatePeriod[]>;
  /** The shop's day, YYYY-MM-DD (its calendar — never the UTC date). */
  readonly today: (tenantId: string) => Promise<string>;
  readonly now: () => string;
}

export function productCheckRoutes(deps: ProductCheckDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/reports/product-checks',
      // A report for the people who run the shop (owner, manager, accountant), not the till: a cashier holds the catalogue
      // read only to see name, price and barcode (OB-569).
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const [products, categories, barcodes, onDay] = await Promise.all([
          deps.products(ctx.tenantId), deps.categories(ctx.tenantId), deps.barcodes(ctx.tenantId), deps.today(ctx.tenantId),
        ]);
        const codes = [...new Set(products.map((p) => (p.taxClass ?? '').trim()).filter((c) => c !== ''))].sort();
        const gstSchedules = new Map<string, readonly GstRatePeriod[] | null>();
        for (const code of codes) {
          try { gstSchedules.set(code, await deps.gstSchedule(ctx.tenantId, code)); } catch { gstSchedules.set(code, null); }
        }
        const report = productChecks({ products, categories, barcodes, gstSchedules, onDay });
        return { status: 200, body: { ...report, onDay, readOnly: true, asAt: deps.now() } };
      },
    },
  ];
}
