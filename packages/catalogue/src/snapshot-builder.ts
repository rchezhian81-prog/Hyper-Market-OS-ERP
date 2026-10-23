// Catalogue snapshot builder (M03 → M05 → the lane, §31) — produces the versioned
// snapshot a lane holds offline. It is the bridge between the master data and
// `CatalogueCache`: for every product it resolves the price the lane should charge
// using the SAME effective-dated precedence engine the rest of the system uses
// (`packages/price-list`: customer > channel > zone > store), attaches the tax class
// rate, and carries the recall flag and status through so the lane can refuse a
// scan safely offline.
//
// Two honesty rules matter here (P-08):
//   • a product with NO resolvable price is EXCLUDED from the snapshot and reported
//     with a reason — it is never shipped priced at zero or at a guessed price;
//   • a product whose price exceeds its MRP is excluded and reported — a lane must
//     never be able to charge above the legal ceiling (M05-FR-02).
// Draft/discontinued products are INCLUDED (marked), so scanning one tells the
// cashier "not sellable" rather than the misleading "unknown barcode".
//
// Pure and deterministic: the caller supplies `asOf` and the snapshot `version`,
// so the same inputs always build the same snapshot (rebuildable, auditable).

import { resolvePrice, type PriceEntry } from '../../price-list/src/price-list';
import { checkDemeritHoldover, readCessRate, type CessRate } from '../../finance/src/cess';
import type {
  CatalogueBarcode,
  CatalogueProduct,
  CatalogueSnapshot,
  EmbeddedBarcodeRule,
  ProductStatus,
} from './catalogue';

/** A product master record as the builder reads it (a slice of M03). */
export interface MasterProduct {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly baseUom: string;
  /** The department (the master's primary category), carried into the pack for the evening check (OB-263). */
  readonly categoryId?: string;
  readonly taxClassId: string;
  readonly status: ProductStatus;
  readonly mrpMinor?: number;
  readonly recallBlock?: boolean;
  /** SF-08 · OB-139 "A": the named batches the recall block comes from (absent = the whole product, whatever the code). */
  readonly blockedBatches?: readonly string[];
  /** M10-FR-01: the batches head office moved to the expired state, with their dates (refused on a batch-bearing code). */
  readonly expiredBatches?: readonly { readonly batchId: string; readonly expiry: string }[];
  /** Lot/batch-tracked — the lane captures the batch on each sale line for recall traceability (M10-FR-03). */
  readonly batchTracked?: boolean;
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
  /** The product master's handling class (HA-2) — carried as given, absent when none was set. */
  readonly handling?: string;
}

/** Tax classes (HSN/GST) keyed by id, in basis points. */
/** A7: the compensation cess in force for each cess-liable HSN on the build date (absent HSN = not cess-liable). */
export type TaxClassCess = Readonly<Record<string, CessRate>>;

export type TaxClassRates = Readonly<Record<string, number>>;

/** Where this snapshot is for — drives price precedence (M05-FR-01). Declared with the snapshot it scopes. */
export type { SnapshotScope } from './catalogue';
import type { SnapshotScope } from './catalogue';

export interface BuildSnapshotInput {
  readonly scope: SnapshotScope;
  /** Monotonic snapshot version the lane will report. */
  readonly version: number;
  /** ISO-8601 UTC: both the build stamp and the price-effectiveness instant. */
  readonly asOf: string;
  readonly products: readonly MasterProduct[];
  readonly barcodes: readonly CatalogueBarcode[];
  readonly priceEntries: readonly PriceEntry[];
  readonly taxClasses: TaxClassRates;
  readonly embeddedRules?: readonly EmbeddedBarcodeRule[];
  /** A7: the cess per HSN on the build date. Absent → no product carries a cess (every pack built before A7). */
  readonly taxClassCess?: TaxClassCess;
}

export type ExclusionReason = 'no_price' | 'no_tax_class' | 'price_above_mrp'
  /** A7 · GST 2.0: a cess-liable good on the 40% demerit slab would be taxed twice — never shipped to a lane. */
  | 'cess_on_demerit_slab'
  /** B16 (COTPA s.7 · OB-140 "A"): a tobacco product with no named person's confirmation for the warning picture in force. */
  | 'tobacco_warning_not_confirmed';

export interface ExcludedProduct {
  readonly productId: string;
  readonly sku: string;
  readonly reason: ExclusionReason;
}

export interface BuildSnapshotResult {
  readonly snapshot: CatalogueSnapshot;
  /** Products deliberately left out, each with its reason — never silent (P-08). */
  readonly excluded: readonly ExcludedProduct[];
  readonly includedCount: number;
  /** Barcodes dropped because their product was excluded or unknown. */
  readonly droppedBarcodes: number;
}

/**
 * Build the lane's catalogue snapshot. Resolves each product's price through the
 * effective-dated precedence engine at `asOf`, attaches its tax rate, and carries
 * status/recall/age flags. Products that cannot be priced safely are excluded and
 * reported. Barcodes for excluded (or unknown) products are dropped, so a lane can
 * never scan into a product it doesn't hold.
 */
export function buildCatalogueSnapshot(input: BuildSnapshotInput): BuildSnapshotResult {
  const products: CatalogueProduct[] = [];
  const excluded: ExcludedProduct[] = [];

  for (const master of input.products) {
    const taxBps = input.taxClasses[master.taxClassId];
    if (taxBps === undefined) {
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'no_tax_class' });
      continue;
    }

    // A7: the cess the HSN carries today, and the GST 2.0 holdover guard — a cess-liable good on the 40% demerit slab
    // would be taxed twice, so it is left out and said (P-08) rather than billed wrong.
    const cess = readCessRate(input.taxClassCess?.[master.taxClassId]);
    if (cess !== undefined && !checkDemeritHoldover({ cessLiable: true, gstRateBps: taxBps }).ok) {
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'cess_on_demerit_slab' });
      continue;
    }

    const priceEntry = resolvePrice(input.priceEntries, {
      productId: master.productId,
      at: input.asOf,
      storeId: input.scope.storeId,
      zoneId: input.scope.zoneId,
      channel: input.scope.channel,
    });
    if (priceEntry === null) {
      // No effective price for this lane — never ship a guessed or zero price.
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'no_price' });
      continue;
    }

    const unitPriceMinor = priceEntry.price.minor;
    if (master.mrpMinor !== undefined && unitPriceMinor > master.mrpMinor) {
      // A lane must never be able to charge above MRP (M05-FR-02).
      excluded.push({ productId: master.productId, sku: master.sku, reason: 'price_above_mrp' });
      continue;
    }

    // D-20: each batch under an approved markdown, resolved by the same precedence engine at the same instant — charged only
    // when the barcode carries that batch. A batch price above the MRP is never shipped (M05-FR-02); the product still is.
    const batchIds = [...new Set(input.priceEntries
      .filter((e) => e.productId === master.productId && typeof e.batchId === 'string' && e.batchId !== '')
      .map((e) => e.batchId as string))].sort();
    const batchPrices = batchIds.flatMap((batchId) => {
      const entry = resolvePrice(input.priceEntries, {
        productId: master.productId, at: input.asOf, storeId: input.scope.storeId, zoneId: input.scope.zoneId, channel: input.scope.channel, batchId,
      });
      if (entry === null || (master.mrpMinor !== undefined && entry.price.minor > master.mrpMinor)) return [];
      return [{ batchId, unitPriceMinor: entry.price.minor }];
    });

    products.push({
      productId: master.productId,
      sku: master.sku,
      name: master.name,
      baseUom: master.baseUom,
      ...(master.categoryId === undefined || master.categoryId === '' ? {} : { categoryId: master.categoryId }),
      unitPriceMinor,
      taxBps,
      hsnCode: master.taxClassId, // carry the HSN / tax-class code through for GST-return assembly (A5)
      mrpMinor: master.mrpMinor,
      status: master.status,
      recallBlock: master.recallBlock,
      ...(master.recallBlock === true && master.blockedBatches !== undefined && master.blockedBatches.length > 0
        ? { blockedBatches: [...master.blockedBatches].sort() } : {}),
      ...(batchPrices.length === 0 ? {} : { batchPrices }),
      ...(master.expiredBatches === undefined || master.expiredBatches.length === 0 ? {}
        : { expiredBatches: [...master.expiredBatches].sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0)) }),
      batchTracked: master.batchTracked,
      regulatedFlags: master.regulatedFlags,
      ...(master.handling === undefined ? {} : { handling: master.handling }),
      ...(cess === undefined ? {} : { cess }),
    });
  }

  // Keep only barcodes whose product made it into the snapshot.
  const includedIds = new Set(products.map((p) => p.productId));
  const barcodes = input.barcodes.filter((b) => includedIds.has(b.productId));

  return {
    snapshot: {
      tenantId: input.scope.tenantId,
      version: input.version,
      builtAt: input.asOf,
      // The store this pack is for rides on the snapshot, so a sale priced from it knows where its stock lives.
      scope: input.scope,
      products,
      barcodes,
      embeddedRules: input.embeddedRules,
    },
    excluded,
    includedCount: products.length,
    droppedBarcodes: input.barcodes.length - barcodes.length,
  };
}
