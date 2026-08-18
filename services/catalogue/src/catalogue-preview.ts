// API-02 Catalogue pack ASSEMBLY / preview (M03 → M05 → the lane, §31, slice 2) — folds the four cloud
// master-data stores this session built (the product master M03-FR-01, the price lists M05, the barcode
// register M03-FR-02, and the tax-class GST-rate schedules M03-FR-03/A6) into ONE catalogue snapshot for a
// named store, through the tested `buildCatalogueSnapshot` engine. It is the join the pack build has waited
// for: until now the cloud pack carried the previous set forward because the master data had nowhere to live.
//
// This is the READ-ONLY assembly + preview: it shows exactly what the signed pack WOULD contain for a store
// on a date, and — the honest half (P-08) — which products are LEFT OUT and why (no price, no tax class, or
// a price above MRP; a lane must never be handed a product it cannot price safely or that breaks the MRP
// ceiling). Flipping the signed publish path to build from this is the deliberate next slice; keeping the
// assembly read-only first proves the fold without touching the working publish contract.
//
// Gated `catalogue.pack.read` — it is a preview of the catalogue, not a change to it. Stateless over the
// tested engines (`buildCatalogueSnapshot`, `resolveGstRate`, `mrpOn`): this file maps the stored shapes to
// the engine's inputs and reports its output.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  buildCatalogueSnapshot, type MasterProduct,
} from '../../../packages/catalogue/src/snapshot-builder';
import type { CatalogueBarcode, ProductStatus } from '../../../packages/catalogue/src/catalogue';
import { mrpOn, type ProductRecord, type BarcodeAssignment } from '../../../packages/product/src/index';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';
import { resolveGstRate, InvalidRateSchedule, type GstRatePeriod } from '../../../packages/finance/src/rate';

export interface CataloguePreviewDeps {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly priceEntries: (tenantId: string, productId: string) => Promise<readonly PriceEntry[]> | readonly PriceEntry[];
  readonly barcodes: (tenantId: string) => Promise<readonly BarcodeAssignment[]> | readonly BarcodeAssignment[];
  readonly taxSchedule: (tenantId: string, hsnCode: string) => Promise<readonly GstRatePeriod[]> | readonly GstRatePeriod[];
  readonly now: () => string;
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A published product master is 'new' when first published; in catalogue terms that is a sellable, active
 * product (the snapshot builder only distinguishes draft/active/clearance/discontinued). */
const statusOf = (lifecycle: ProductRecord['lifecycle']): ProductStatus =>
  lifecycle === 'new' ? 'active' : lifecycle;

function toMaster(r: ProductRecord, asOf: string): MasterProduct {
  const mrp = mrpOn(r, asOf); // the MRP in force on the build date (a future MRP does not apply early)
  return {
    productId: r.productId,
    sku: r.sku,
    name: r.name,
    baseUom: r.baseUom,
    taxClassId: r.taxClass ?? '', // null/absent → no rate resolvable → excluded 'no_tax_class' by the engine
    status: statusOf(r.lifecycle),
    ...(mrp !== undefined ? { mrpMinor: mrp.minor } : {}),
    ...(r.recallBlocked !== undefined ? { recallBlock: r.recallBlocked } : {}),
  };
}

export function cataloguePreviewRoutes(deps: CataloguePreviewDeps): readonly Route[] {
  return [
    {
      // Assemble the pack for a store as of a date (?storeId= required, ?asOf= optional, defaults to now).
      // Body-less read: returns the snapshot that WOULD be published + the products left out, each with a reason.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/pack/preview',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const storeId = ctx.query['storeId'];
        if (!isStr(storeId)) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack_preview',
            whatHappened: 'Assembling a catalogue pack needs the store it is for: ?storeId=. A pack carries the price each lane in that store should charge, which is resolved per store.',
            wasItSaved: 'unknown',
            nextSafeAction: 'Add ?storeId=<the store> (optionally ?asOf=YYYY-MM-DD) to the request.',
          });
        }
        const asOfQ = ctx.query['asOf'];
        if (asOfQ !== undefined && !isDate(asOfQ)) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack_preview',
            whatHappened: 'asOf must be a valid YYYY-MM-DD date — the pack is assembled as of a moment (prices and tax rates are effective-dated).',
            wasItSaved: 'unknown',
            nextSafeAction: 'Send ?asOf=2026-08-18, or omit it to build as of today.',
          });
        }
        const asOf = asOfQ ?? deps.now();
        const asOfDate = asOf.slice(0, 10); // date part, for the effective-dated tax + MRP lookups

        const records = await deps.products(ctx.tenantId);

        // Prices: every entry for every product (the engine resolves the one that applies at this store/date).
        const priceEntries: PriceEntry[] = [];
        for (const r of records) priceEntries.push(...(await deps.priceEntries(ctx.tenantId, r.productId)));

        // Tax rates: resolve each distinct tax class's rate in force on the date. An HSN with no schedule (or
        // a gap before its earliest rate) is left unset — the engine then excludes its products as
        // 'no_tax_class' rather than shipping an untaxed line (never a guessed rate).
        const taxClasses: Record<string, number> = {};
        for (const hsn of new Set(records.map((r) => r.taxClass).filter((c): c is string => isStr(c)))) {
          const schedule = await deps.taxSchedule(ctx.tenantId, hsn);
          if (schedule.length === 0) continue;
          try {
            taxClasses[hsn] = resolveGstRate({ schedule, supplyDate: asOfDate }).rateBps;
          } catch (err) {
            if (!(err instanceof InvalidRateSchedule)) throw err; // a gap → leave unset; anything else is a real fault
          }
        }

        // Barcodes: the register, mapped to the snapshot shape (the engine drops any whose product is
        // excluded). The register records SYMBOLOGY (gtin/ean/upc/internal/case/embedded); the catalogue
        // `kind` is how the LANE reads the code, where a plain product code is 'standard'. Embedded
        // weight/price barcodes are driven by per-tenant `EmbeddedBarcodeRule` (a separate pack input not
        // yet sourced on the cloud), so every register code is carried here as 'standard' for now.
        const barcodes: CatalogueBarcode[] = (await deps.barcodes(ctx.tenantId)).map((b) => ({
          code: b.code, productId: b.productId, kind: 'standard' as const,
        }));

        const result = buildCatalogueSnapshot({
          scope: { tenantId: ctx.tenantId, storeId },
          version: 0, // a preview is not a published version; the signed publish assigns the real version
          asOf,
          products: records.map((r) => toMaster(r, asOf)),
          barcodes,
          priceEntries,
          taxClasses,
        });

        return {
          status: 200,
          body: {
            storeId,
            asOf,
            snapshot: result.snapshot,
            includedCount: result.includedCount,
            excluded: result.excluded, // each with productId + sku + reason (no_price / no_tax_class / price_above_mrp)
            droppedBarcodes: result.droppedBarcodes,
          },
        };
      },
    },
  ];
}
